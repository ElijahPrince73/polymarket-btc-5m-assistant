import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';

import { initializeLedger, getLedger } from '../paper_trading/ledger.js';
import { initializeLiveLedger } from '../live_trading/ledger.js';
import { readLiquiditySamples, computeLiquidityStats } from '../analytics/liquiditySampler.js';

import { computeAnalytics } from '../services/analyticsService.js';
import { runBacktest } from '../services/backtestService.js';
import { gridSearch, generateParamRanges, DEFAULT_PARAM_RANGES } from '../domain/optimizer.js';
import { assembleStatus } from '../services/statusService.js';
import { fetchLiveTrades, fetchLiveOpenOrders, fetchLivePositions, fetchLiveAnalytics } from '../services/liveService.js';
import { TradingState } from '../application/TradingState.js';
import { CONFIG } from '../config.js';
import { getPacificTimeInfo } from '../domain/entryGate.js';
import { generateSuggestions } from '../services/suggestionService.js';

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || process.env.UI_PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

function ok(data) { return { success: true, data }; }
function fail(msg) { return { success: false, error: msg }; }

// ── Trade Store (Supabase) initialization ────────────────────────────
let _tradeStoreAvailable = false;

async function initTradeStore() {
  try {
    const { getSupabaseTradeStore } = await import('../infrastructure/persistence/supabaseTradeStore.js');
    const store = getSupabaseTradeStore();

    // Expose for global access by backtestService etc
    globalThis.__tradeStore_getTradeStore = () => store;

    // Migrate from JSON ledger if Supabase is empty
    const count = await store.getTradeCount();
    if (count === 0) {
      const ledger = getLedger();
      if (ledger && Array.isArray(ledger.trades) && ledger.trades.length > 0) {
        const result = await store.migrateFromLedger(ledger, 'paper');
        console.log(`[TradeStore] Migration: ${result.migrated} migrated, ${result.skipped} skipped`);
      }
    } else {
      console.log(`[TradeStore] Supabase already has ${count} trades`);
    }

    _tradeStoreAvailable = true;
    console.log('[TradeStore] Supabase initialized successfully');
    return store;
  } catch (err) {
    console.warn('[TradeStore] Supabase not available, using JSON ledger fallback:', err.message);
    _tradeStoreAvailable = false;
    return null;
  }
}

/**
 * Get trades from Supabase (primary) or JSON ledger (fallback).
 * @returns {Promise<Object[]>}
 */
async function getTradesFromStore() {
  if (_tradeStoreAvailable && globalThis.__tradeStore_getTradeStore) {
    try {
      const store = globalThis.__tradeStore_getTradeStore();
      return await store.getAllTrades();
    } catch {
      // fallback
    }
  }
  const ledger = getLedger();
  return Array.isArray(ledger.trades) ? ledger.trades : [];
}

/**
 * Sync a new/updated trade to Supabase (fire-and-forget).
 * Called whenever the JSON ledger is updated so Supabase stays in sync.
 */
async function syncTradeToStore(trade, mode = 'paper') {
  if (!_tradeStoreAvailable || !globalThis.__tradeStore_getTradeStore) return;
  try {
    const store = globalThis.__tradeStore_getTradeStore();
    await store.insertTrade(trade, mode);
  } catch (err) {
    console.warn('[TradeStore] Sync error:', err.message);
  }
}

// Expose syncTradeToStore globally for PaperExecutor to call
globalThis.__syncTradeToStore = syncTradeToStore;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static UI files
const uiPath = path.join(__dirname, '..', 'ui');
if (!fs.existsSync(uiPath)) {
  fs.mkdirSync(uiPath);
}
app.use(express.static(uiPath, { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));

// --- API Routes ---

app.get('/api/status', async (req, res) => {
  try {
    const data = await assembleStatus();
    res.json(ok(data));
  } catch (error) {
    console.error('Error fetching status:', error.message);
    res.status(500).json(fail('Failed to fetch status data.'));
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    await initializeLedger();
    const trades = await getTradesFromStore();
    res.json(ok(trades));
  } catch (error) {
    console.error('Error fetching trades:', error.message);
    res.status(500).json(fail('Failed to fetch trades data.'));
  }
});

app.get('/api/analytics', async (req, res) => {
  try {
    await initializeLedger();
    const trades = await getTradesFromStore();
    const analytics = computeAnalytics(trades);

    const rows = readLiquiditySamples({ limit: 20000 });
    const liquidity = {
      last1h: computeLiquidityStats(rows, { windowHours: 1 }),
      last6h: computeLiquidityStats(rows, { windowHours: 6 }),
      last24h: computeLiquidityStats(rows, { windowHours: 24 })
    };

    res.json(ok({ ...analytics, liquidity }));
  } catch (error) {
    console.error('Error fetching analytics:', error.message);
    res.status(500).json(fail('Failed to fetch analytics data.'));
  }
});

// ─── Backtest endpoint ───────────────────────────────────────────
const BACKTEST_ALLOWED_KEYS = new Set([
  'minProbMid', 'edgeMid', 'noTradeRsiMin', 'noTradeRsiMax',
  'maxSpreadThreshold', 'minLiquidity', 'minSpotImpulse', 'maxEntryPolyPrice',
]);

app.post('/api/backtest', async (req, res) => {
  try {
    const params = req.body?.params;

    // Empty or missing params is valid: runs backtest with base config
    if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
      return res.status(400).json(fail('params must be a plain object'));
    }

    // Whitelist and validate override keys
    const validatedParams = {};
    if (params && typeof params === 'object') {
      for (const [key, value] of Object.entries(params)) {
        if (!BACKTEST_ALLOWED_KEYS.has(key)) continue; // silently ignore non-whitelisted keys
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return res.status(400).json(fail(`Invalid value for ${key}: must be a finite number`));
        }
        validatedParams[key] = value;
      }
    }

    const result = await runBacktest(validatedParams);

    if (result?.error) {
      return res.status(500).json(fail(result.message || 'Backtest failed'));
    }

    res.json(ok(result));
  } catch (error) {
    console.error('Error running backtest:', error.message);
    res.status(500).json(fail('Failed to run backtest.'));
  }
});

app.get('/api/live/trades', async (req, res) => {
  try {
    const trades = await fetchLiveTrades();
    res.json(ok(trades));
  } catch (error) {
    console.error('Error fetching LIVE trades:', error.message);
    res.status(500).json(fail('Failed to fetch live trades.'));
  }
});

app.get('/api/live/open-orders', async (req, res) => {
  try {
    const orders = await fetchLiveOpenOrders();
    res.json(ok(orders));
  } catch (error) {
    console.error('Error fetching LIVE open orders:', error.message);
    res.setHeader('x-openorders-warning', 'clob_unavailable');
    res.json(ok([]));
  }
});

app.get('/api/live/positions', async (req, res) => {
  try {
    const positions = await fetchLivePositions();
    res.json(ok(positions));
  } catch (error) {
    console.error('Error fetching LIVE positions:', error.message);
    res.status(500).json(fail('Failed to fetch live positions.'));
  }
});

app.get('/api/live/analytics', async (req, res) => {
  try {
    const analytics = await fetchLiveAnalytics();
    res.json(ok(analytics));
  } catch (error) {
    console.error('Error fetching LIVE analytics:', error.message);
    res.status(500).json(fail('Failed to fetch live analytics.'));
  }
});

app.get('/api/markets', (req, res) => {
  try {
    const catalog = globalThis.__marketCatalog;
    if (!catalog) {
      return res.json(ok({ market: null, tokenIds: [], note: 'MarketCatalog not initialized' }));
    }
    res.json(ok(catalog.getSnapshot()));
  } catch (error) {
    console.error('Error fetching markets:', error.message);
    res.status(500).json(fail('Failed to fetch markets.'));
  }
});

app.get('/api/live/approvals', (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    const approvalService = engine?.executor?.approvalService;
    if (!approvalService) {
      return res.json(ok({ collateral: null, conditional: {}, note: 'ApprovalService not available (paper mode or not initialized)' }));
    }
    res.json(ok(approvalService.getStatus()));
  } catch (error) {
    console.error('Error fetching approvals:', error.message);
    res.status(500).json(fail('Failed to fetch approval status.'));
  }
});

app.get('/api/portfolio', async (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    const executor = engine?.executor;

    // Collateral
    let collateral = null;
    if (executor?.getBalance) {
      try {
        const snap = await executor.getBalance();
        collateral = snap;
      } catch {
        collateral = { error: 'Failed to fetch balance' };
      }
    }

    // Open orders
    const openOrders = executor?.orderManager?.getSnapshot?.() ?? { total: 0, orders: [] };

    // Fees
    const fees = executor?.feeService?.getSnapshot?.() ?? null;

    // Approvals
    const approvals = executor?.approvalService?.getStatus?.() ?? null;

    // Daily PnL from state
    const dailyPnl = engine?.state?.todayRealizedPnl ?? null;

    // Reserved amount (sum of open order notional)
    let reservedAmount = 0;
    const pendingOrders = executor?.orderManager?.getPendingOrders?.({ status: 'pending' }) ?? [];
    const openOrdersList = executor?.orderManager?.getPendingOrders?.({ status: 'open' }) ?? [];
    for (const o of [...pendingOrders, ...openOrdersList]) {
      reservedAmount += (o.price || 0) * (o.size || 0);
    }

    res.json(ok({
      collateral,
      openOrders,
      fees,
      approvals,
      reservedAmount: Math.round(reservedAmount * 100) / 100,
      realizedPnl: {
        today: typeof dailyPnl === 'number' ? dailyPnl : null,
      },
      mode: executor?.getMode?.() ?? 'unknown',
      tradingEnabled: engine?.tradingEnabled ?? false,
    }));
  } catch (error) {
    console.error('Error fetching portfolio:', error.message);
    res.status(500).json(fail('Failed to fetch portfolio.'));
  }
});

app.get('/api/orders', (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    const orderManager = engine?.executor?.orderManager;
    if (!orderManager) {
      return res.json(ok({ total: 0, orders: [], note: 'OrderManager not available' }));
    }
    const statusFilter = req.query.status || null;
    if (statusFilter) {
      const orders = orderManager.getPendingOrders({ status: statusFilter });
      res.json(ok({ total: orders.length, orders }));
    } else {
      res.json(ok(orderManager.getSnapshot()));
    }
  } catch (error) {
    console.error('Error fetching orders:', error.message);
    res.status(500).json(fail('Failed to fetch orders.'));
  }
});

app.delete('/api/orders/:id', async (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    const orderManager = engine?.executor?.orderManager;
    if (!orderManager) {
      return res.status(503).json(fail('OrderManager not available'));
    }
    const result = await orderManager.cancelOrder(req.params.id);
    if (result.cancelled) {
      res.json(ok({ cancelled: true, orderId: req.params.id }));
    } else {
      res.status(400).json(fail(result.error || 'Cancel failed'));
    }
  } catch (error) {
    console.error('Error cancelling order:', error.message);
    res.status(500).json(fail('Failed to cancel order.'));
  }
});

app.get('/api/metrics', (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    const executor = engine?.executor;
    const polyService = globalThis.__polymarketService;
    const rateLimiter = globalThis.__clobRateLimiter;

    res.json(ok({
      uptime: process.uptime(),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
      tradingEnabled: engine?.tradingEnabled ?? false,
      mode: executor?.getMode?.() ?? 'unknown',
      state: {
        consecutiveLosses: engine?.state?.consecutiveLosses ?? 0,
        circuitBreakerTripped: engine?.state?.circuitBreakerTrippedAtMs !== null && engine?.state?.circuitBreakerTrippedAtMs !== undefined,
        todayRealizedPnl: engine?.state?.todayRealizedPnl ?? 0,
        hasOpenPosition: engine?.state?.hasOpenPosition ?? false,
      },
      services: polyService?.getStatus?.() ?? null,
      rateLimiter: rateLimiter?.getStats?.() ?? null,
      persistence: {
        supabase: _tradeStoreAvailable,
        tradeCount: null, // async — not included in sync metrics snapshot
      },
    }));
  } catch (error) {
    console.error('Error fetching metrics:', error.message);
    res.status(500).json(fail('Failed to fetch metrics.'));
  }
});

app.get('/api/diagnostics', (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    if (!engine) return res.status(503).json(fail('Engine not initialized'));

    const state = engine.state;
    const summary = state?.getBlockerSummary?.(25) ?? { total: 0, topBlockers: [] };
    const currentBlockers = engine.lastEntryStatus?.blockers ?? [];
    const config = engine.config || {};

    const { isWeekend, wd, hour } = getPacificTimeInfo();
    const weekendTightening = Boolean(config.weekendTighteningEnabled ?? true) && isWeekend;

    res.json(ok({
      blockerSummary: summary,
      currentBlockers,
      tradingEnabled: engine.tradingEnabled,
      mode: engine.executor?.getMode?.() ?? 'unknown',
      weekendTightening,
      dayOfWeek: wd,
      hourPt: hour,
      effectiveThresholds: {
        minLiquidity: weekendTightening
          ? (config.weekendMinLiquidity ?? config.minLiquidity ?? 500)
          : (config.minLiquidity ?? 500),
        maxSpread: weekendTightening
          ? (config.weekendMaxSpread ?? config.maxSpread ?? 0.012)
          : (config.maxSpread ?? 0.012),
        minModelMaxProb: weekendTightening
          ? (config.weekendMinModelMaxProb ?? config.minModelMaxProb ?? 0.53)
          : (config.minModelMaxProb ?? 0.53),
        minRangePct20: weekendTightening
          ? (config.weekendMinRangePct20 ?? config.minRangePct20 ?? 0.0012)
          : (config.minRangePct20 ?? 0.0012),
        maxEntryPolyPrice: config.maxEntryPolyPrice ?? 0.65,
        minBtcImpulsePct1m: config.minBtcImpulsePct1m ?? 0.0003,
        noTradeRsiRange: [config.noTradeRsiMin ?? 30, config.noTradeRsiMax ?? 45],
        minCandlesForEntry: config.minCandlesForEntry ?? 12,
        noEntryFinalMinutes: config.noEntryFinalMinutes ?? 1.5,
        probThresholds: {
          early: config.minProbEarly ?? 0.52,
          mid: (config.minProbMid ?? 0.53) + (config.midProbBoost ?? 0.01) + (weekendTightening ? (config.weekendProbBoost ?? 0.03) : 0),
          late: config.minProbLate ?? 0.55,
        },
        edgeThresholds: {
          early: config.edgeEarly ?? 0.02,
          mid: (config.edgeMid ?? 0.03) + (config.midEdgeBoost ?? 0.01) + (weekendTightening ? (config.weekendEdgeBoost ?? 0.03) : 0),
          late: config.edgeLate ?? 0.05,
        },
      },
    }));
  } catch (error) {
    console.error('Error fetching diagnostics:', error.message);
    res.status(500).json(fail('Failed to fetch diagnostics.'));
  }
});

// ─── Optimizer endpoint ─────────────────────────────────────────

const OPTIMIZER_ALLOWED_KEYS = new Set([
  'minProbMid', 'edgeMid', 'noTradeRsiMin', 'noTradeRsiMax',
  'maxSpreadThreshold', 'minLiquidity', 'minSpotImpulse', 'maxEntryPolyPrice',
]);

app.post('/api/optimizer', async (req, res) => {
  try {
    const { paramRanges: userParamRanges, minTrades } = req.body || {};

    // Use user-provided ranges or defaults
    const rangeConfig = (userParamRanges && typeof userParamRanges === 'object')
      ? userParamRanges
      : DEFAULT_PARAM_RANGES;

    // Generate explicit value arrays from range config
    const paramRanges = generateParamRanges(rangeConfig);

    // Load trades from Supabase (primary) or JSON ledger (fallback)
    await initializeLedger();
    const trades = await getTradesFromStore();

    // Build base config
    const paperConfig = CONFIG.paperTrading || {};
    const baseConfig = {
      minProbMid: paperConfig.minProbMid,
      edgeMid: paperConfig.edgeMid,
      noTradeRsiMin: paperConfig.noTradeRsiMin,
      noTradeRsiMax: paperConfig.noTradeRsiMax,
      maxSpreadThreshold: paperConfig.maxSpread,
      minLiquidity: paperConfig.minLiquidity,
      minSpotImpulse: paperConfig.minBtcImpulsePct1m,
      maxEntryPolyPrice: paperConfig.maxEntryPolyPrice,
    };

    const minTradesPerCombo = (typeof minTrades === 'number' && Number.isFinite(minTrades) && minTrades > 0)
      ? minTrades : 30;

    const result = gridSearch(trades, baseConfig, paramRanges, minTradesPerCombo);

    // Include current config for comparison
    const currentConfig = { ...baseConfig };

    res.json(ok({ ...result, currentConfig }));
  } catch (error) {
    const msg = error?.message || String(error);
    if (msg.includes('10,000')) {
      return res.status(400).json(fail(msg));
    }
    console.error('Error running optimizer:', msg);
    res.status(500).json(fail('Failed to run optimizer.'));
  }
});

// ─── Config apply/revert endpoints ──────────────────────────────

app.post('/api/config', (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    if (!engine) return res.status(503).json(fail('Engine not initialized'));

    const params = req.body?.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return res.status(400).json(fail('params must be a plain object'));
    }

    // Whitelist allowed keys
    const validatedParams = {};
    for (const [key, value] of Object.entries(params)) {
      if (!OPTIMIZER_ALLOWED_KEYS.has(key)) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return res.status(400).json(fail(`Invalid value for ${key}: must be a finite number`));
      }
      validatedParams[key] = value;
    }

    if (Object.keys(validatedParams).length === 0) {
      return res.status(400).json(fail('No valid parameters to apply'));
    }

    // Store previous config for revert
    const previousConfig = {};
    for (const key of OPTIMIZER_ALLOWED_KEYS) {
      if (engine.config && key in engine.config) {
        previousConfig[key] = engine.config[key];
      }
    }
    globalThis.__previousConfig = previousConfig;

    // Apply to engine config
    Object.assign(engine.config, validatedParams);

    // Safety: warn if live mode is active
    const isLive = engine.executor?.getMode?.() === 'live';
    const response = {
      applied: validatedParams,
      revertAvailable: true,
    };
    if (isLive) {
      response.warning = 'Live mode active -- parameters affect real trading';
    }

    res.json(ok(response));
  } catch (error) {
    console.error('Error applying config:', error.message);
    res.status(500).json(fail('Failed to apply config.'));
  }
});

app.post('/api/config/revert', (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    if (!engine) return res.status(503).json(fail('Engine not initialized'));

    const previousConfig = globalThis.__previousConfig;
    if (!previousConfig || typeof previousConfig !== 'object' || Object.keys(previousConfig).length === 0) {
      return res.status(400).json(fail('No previous config available to revert'));
    }

    Object.assign(engine.config, previousConfig);
    globalThis.__previousConfig = null;

    res.json(ok({ reverted: true }));
  } catch (error) {
    console.error('Error reverting config:', error.message);
    res.status(500).json(fail('Failed to revert config.'));
  }
});

app.get('/api/config/current', (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    const config = engine?.config || CONFIG.paperTrading || {};

    const currentConfig = {};
    for (const key of OPTIMIZER_ALLOWED_KEYS) {
      if (key in config) {
        currentConfig[key] = config[key];
      }
    }

    // Also map alternative key names used in the config
    if (!('maxSpreadThreshold' in currentConfig) && 'maxSpread' in config) {
      currentConfig.maxSpreadThreshold = config.maxSpread;
    }
    if (!('minSpotImpulse' in currentConfig) && 'minBtcImpulsePct1m' in config) {
      currentConfig.minSpotImpulse = config.minBtcImpulsePct1m;
    }

    res.json(ok({
      currentConfig,
      revertAvailable: !!(globalThis.__previousConfig && Object.keys(globalThis.__previousConfig).length > 0),
    }));
  } catch (error) {
    console.error('Error fetching current config:', error.message);
    res.status(500).json(fail('Failed to fetch current config.'));
  }
});

// ─── Suggestion endpoints ─────────────────────────────────────────

// Track suggestion state
globalThis.__lastSuggestionTradeCount = 0;
globalThis.__appliedSuggestions = [];

app.get('/api/suggestions', async (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    if (!engine) return res.status(503).json(fail('Engine not initialized'));

    const state = engine.state;
    const summary = state?.getBlockerSummary?.(25) ?? { total: 0, topBlockers: [] };

    // Guard: need enough blocker data
    if (summary.total < 100) {
      return res.json(ok({
        suggestions: [],
        insufficient: true,
        message: 'Need more blocker data (at least 100 entry checks)',
        totalEntryChecks: summary.total,
      }));
    }

    // Load trades from store
    await initializeLedger();
    const trades = await getTradesFromStore();
    const closedCount = trades.filter(t => t && t.status === 'CLOSED').length;

    // Build config objects
    const config = engine.config || {};
    const paperConfig = CONFIG.paperTrading || {};
    const currentConfig = {
      minProbMid: config.minProbMid ?? paperConfig.minProbMid,
      edgeMid: config.edgeMid ?? paperConfig.edgeMid,
      noTradeRsiMin: config.noTradeRsiMin ?? paperConfig.noTradeRsiMin,
      noTradeRsiMax: config.noTradeRsiMax ?? paperConfig.noTradeRsiMax,
      maxEntryPolyPrice: config.maxEntryPolyPrice ?? paperConfig.maxEntryPolyPrice,
      minLiquidity: config.minLiquidity ?? paperConfig.minLiquidity,
      maxSpreadThreshold: config.maxSpread ?? paperConfig.maxSpread,
      minSpotImpulse: config.minBtcImpulsePct1m ?? paperConfig.minBtcImpulsePct1m,
      minRangePct20: config.minRangePct20 ?? paperConfig.minRangePct20,
      minModelMaxProb: config.minModelMaxProb ?? paperConfig.minModelMaxProb,
    };

    const baseConfig = {
      minProbMid: paperConfig.minProbMid,
      edgeMid: paperConfig.edgeMid,
      noTradeRsiMin: paperConfig.noTradeRsiMin,
      noTradeRsiMax: paperConfig.noTradeRsiMax,
      maxSpreadThreshold: paperConfig.maxSpread,
      minLiquidity: paperConfig.minLiquidity,
      minSpotImpulse: paperConfig.minBtcImpulsePct1m,
      maxEntryPolyPrice: paperConfig.maxEntryPolyPrice,
    };

    const suggestions = generateSuggestions(trades, summary, currentConfig, baseConfig);

    const tradesSinceLastAnalysis = closedCount - globalThis.__lastSuggestionTradeCount;
    globalThis.__lastSuggestionTradeCount = closedCount;

    res.json(ok({
      suggestions,
      tradesSinceLastAnalysis,
      totalEntryChecks: summary.total,
      closedTradeCount: closedCount,
    }));
  } catch (error) {
    console.error('Error generating suggestions:', error.message);
    res.status(500).json(fail('Failed to generate suggestions.'));
  }
});

app.post('/api/suggestions/apply', async (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    if (!engine) return res.status(503).json(fail('Engine not initialized'));

    const { configKey, suggestedValue, projected } = req.body || {};

    if (!configKey || typeof configKey !== 'string') {
      return res.status(400).json(fail('configKey is required'));
    }
    if (typeof suggestedValue !== 'number' || !Number.isFinite(suggestedValue)) {
      return res.status(400).json(fail('suggestedValue must be a finite number'));
    }

    // Apply the config change (same pattern as POST /api/config)
    const previousConfig = {};
    for (const key of OPTIMIZER_ALLOWED_KEYS) {
      if (engine.config && key in engine.config) {
        previousConfig[key] = engine.config[key];
      }
    }
    globalThis.__previousConfig = previousConfig;

    // Map suggestion configKey to engine config key (some differ)
    const engineKeyMap = {
      maxSpreadThreshold: 'maxSpread',
      minSpotImpulse: 'minBtcImpulsePct1m',
    };
    const engineKey = engineKeyMap[configKey] || configKey;
    engine.config[engineKey] = suggestedValue;

    // Record tracking data
    await initializeLedger();
    const trades = await getTradesFromStore();
    const closedCount = trades.filter(t => t && t.status === 'CLOSED').length;

    globalThis.__appliedSuggestions.push({
      configKey,
      suggestedValue,
      projectedWR: projected?.winRate ?? null,
      projectedPF: projected?.profitFactor ?? null,
      appliedAt: Date.now(),
      tradeCountAtApply: closedCount,
    });

    res.json(ok({
      applied: { [configKey]: suggestedValue },
      revertAvailable: true,
    }));
  } catch (error) {
    console.error('Error applying suggestion:', error.message);
    res.status(500).json(fail('Failed to apply suggestion.'));
  }
});

app.get('/api/suggestions/tracking', async (req, res) => {
  try {
    const applied = globalThis.__appliedSuggestions || [];
    if (applied.length === 0) {
      return res.json(ok({ tracking: [] }));
    }

    await initializeLedger();
    const allTrades = await getTradesFromStore();

    const tracking = applied.map(entry => {
      // Find trades closed after apply time
      const tradesAfter = allTrades.filter(t => {
        if (!t || t.status !== 'CLOSED' || !t.exitTime) return false;
        const exitMs = new Date(t.exitTime).getTime();
        return exitMs > entry.appliedAt;
      });

      const tradesSinceApply = tradesAfter.length;
      let actualWR = null;
      let actualPF = null;

      if (tradesSinceApply > 0) {
        const wins = tradesAfter.filter(t => typeof t.pnl === 'number' && t.pnl > 0);
        const losses = tradesAfter.filter(t => typeof t.pnl === 'number' && t.pnl < 0);
        actualWR = wins.length / tradesSinceApply;
        const winSum = wins.reduce((s, t) => s + (t.pnl || 0), 0);
        const lossSum = losses.reduce((s, t) => s + Math.abs(t.pnl || 0), 0);
        actualPF = lossSum > 0 ? winSum / lossSum : null;
      }

      const isUnderperforming = (
        entry.projectedPF != null && actualPF != null &&
        actualPF < entry.projectedPF * 0.7
      );

      return {
        configKey: entry.configKey,
        suggestedValue: entry.suggestedValue,
        appliedAt: entry.appliedAt,
        projected: {
          winRate: entry.projectedWR,
          profitFactor: entry.projectedPF,
        },
        actual: {
          winRate: actualWR,
          profitFactor: actualPF,
        },
        tradesSinceApply,
        status: isUnderperforming ? 'underperforming' : 'on_track',
      };
    });

    res.json(ok({ tracking }));
  } catch (error) {
    console.error('Error fetching suggestion tracking:', error.message);
    res.status(500).json(fail('Failed to fetch suggestion tracking.'));
  }
});

// ─── Kill-switch endpoints (Phase 3) ──────────────────────────────

app.get('/api/kill-switch/status', (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    if (!engine) return res.status(503).json(fail('Engine not initialized'));

    const config = engine.config || {};
    const maxDailyLossUsd = config.maxDailyLossUsd ?? CONFIG.liveTrading?.maxDailyLossUsd ?? null;
    const status = engine.state?.getKillSwitchStatus?.(maxDailyLossUsd) ?? {
      active: false,
      overrideActive: false,
      overrideCount: 0,
      todayPnl: engine.state?.todayRealizedPnl ?? 0,
      limit: maxDailyLossUsd,
    };

    res.json(ok(status));
  } catch (error) {
    console.error('Error fetching kill-switch status:', error.message);
    res.status(500).json(fail('Failed to fetch kill-switch status.'));
  }
});

app.post('/api/kill-switch/override', (req, res) => {
  try {
    const engine = globalThis.__tradingEngine;
    if (!engine) return res.status(503).json(fail('Engine not initialized'));

    if (!engine.state?.overrideKillSwitch) {
      return res.status(503).json(fail('Kill-switch override not available'));
    }

    const result = engine.state.overrideKillSwitch();
    res.json(ok({
      overridden: true,
      overrideCount: result.overrideCount,
      note: 'Kill-switch overridden. Trading resumed with 10% additional loss buffer. Will re-trigger if losses continue.',
    }));
  } catch (error) {
    console.error('Error overriding kill-switch:', error.message);
    res.status(500).json(fail('Failed to override kill-switch.'));
  }
});

// --- Trading Controls ---

app.post('/api/trading/start', (req, res) => {
  const engine = globalThis.__tradingEngine;
  if (!engine) return res.status(503).json(fail('Engine not initialized'));
  engine.tradingEnabled = true;
  res.json(ok({ tradingEnabled: true }));
});

app.post('/api/trading/stop', (req, res) => {
  const engine = globalThis.__tradingEngine;
  if (!engine) return res.status(503).json(fail('Engine not initialized'));
  engine.tradingEnabled = false;
  res.json(ok({ tradingEnabled: false }));
});

app.post('/api/trading/kill', async (req, res) => {
  const engine = globalThis.__tradingEngine;
  if (!engine) return res.status(503).json(fail('Engine not initialized'));

  // 1. Stop trading immediately
  engine.tradingEnabled = false;

  // 2. Try to cancel all open orders (live mode only)
  let cancelResult = null;
  const executor = engine.executor;
  if (executor?.getMode?.() === 'live' && executor?.client?.cancelAll) {
    try {
      cancelResult = await executor.client.cancelAll();
    } catch (e) {
      cancelResult = { error: e?.message || String(e) };
    }
  }

  console.warn('KILL SWITCH activated via /api/trading/kill');
  res.json(ok({
    tradingEnabled: false,
    killSwitch: true,
    cancelResult,
    timestamp: new Date().toISOString(),
  }));
});

app.get('/api/trading/status', (req, res) => {
  const engine = globalThis.__tradingEngine;
  const mm = globalThis.__modeManager;
  res.json(ok({
    tradingEnabled: engine?.tradingEnabled ?? false,
    mode: mm?.getMode() ?? 'paper',
    liveAvailable: mm?.isLiveAvailable() ?? false,
  }));
});

app.post('/api/mode', (req, res) => {
  const mm = globalThis.__modeManager;
  const engine = globalThis.__tradingEngine;
  if (!mm || !engine) return res.status(503).json(fail('Not initialized'));

  const { mode } = req.body; // 'paper' or 'live'
  try {
    mm.switchMode(mode);
    // Update engine's executor and config
    engine.executor = mm.getActiveExecutor();
    engine.config = mode === 'live'
      ? { ...CONFIG.paperTrading, ...CONFIG.liveTrading }
      : { ...CONFIG.paperTrading };
    engine.tradingEnabled = false; // Safety: stop trading on mode switch
    engine.state = new TradingState(); // Fresh state on mode switch
    res.json(ok({ mode: mm.getMode(), tradingEnabled: false }));
  } catch (e) {
    res.status(400).json(fail(e.message));
  }
});

// ─── Health endpoint (Phase 4: INFRA-08) ──────────────────────────

app.get('/health', (req, res) => {
  const engine = globalThis.__tradingEngine;
  const uptime = process.uptime();
  const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;

  res.json(ok({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.round(uptime),
    lastTick: globalThis.__uiStatus?.lastUpdate ?? null,
    mode: engine?.executor?.getMode?.() ?? 'unknown',
    tradingEnabled: engine?.tradingEnabled ?? false,
    memoryMb: memMb,
    pid: process.pid,
    persistence: { supabase: _tradeStoreAvailable },
  }));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(uiPath, 'index.html'));
});

export function startUIServer() {
  initializeLedger().catch((e) => console.error('UI server (paper) ledger init failed:', e.message));
  initializeLiveLedger().catch((e) => console.error('UI server (live) ledger init failed:', e.message));

  // Initialize Supabase trade store and migrate JSON data (async — sets _tradeStoreAvailable when done)
  initTradeStore().catch(err => console.error('[TradeStore] Init failed:', err.message));

  console.log(`Starting UI server on ${host}:${port}...`);
  const server = app.listen(port, host, () => {
    console.log(`UI server running on http://${host}:${port}`);
  });

  server.on('error', (err) => {
    console.error('UI server failed to bind/listen:', err.message);
  });

  return server;
}
