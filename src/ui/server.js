import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';

import { initializeLedger, getLedger } from '../paper_trading/ledger.js';
import { initializeLiveLedger } from '../live_trading/ledger.js';
import { readLiquiditySamples, computeLiquidityStats } from '../analytics/liquiditySampler.js';

import { computeAnalytics } from '../services/analyticsService.js';
import { assembleStatus } from '../services/statusService.js';
import { fetchLiveTrades, fetchLiveOpenOrders, fetchLivePositions, fetchLiveAnalytics } from '../services/liveService.js';
import { TradingState } from '../application/TradingState.js';
import { CONFIG } from '../config.js';

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || process.env.UI_PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

function ok(data) { return { success: true, data }; }
function fail(msg) { return { success: false, error: msg }; }

// Middleware
app.use(cors());
app.use(express.json());

// Serve static UI files
const uiPath = path.join(__dirname, '..', 'ui');
if (!fs.existsSync(uiPath)) {
  fs.mkdirSync(uiPath);
}
app.use(express.static(uiPath));

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
    const ledgerData = getLedger();
    res.json(ok(Array.isArray(ledgerData.trades) ? ledgerData.trades : []));
  } catch (error) {
    console.error('Error fetching trades:', error.message);
    res.status(500).json(fail('Failed to fetch trades data.'));
  }
});

app.get('/api/analytics', async (req, res) => {
  try {
    await initializeLedger();
    const ledgerData = getLedger();
    const analytics = computeAnalytics(ledgerData.trades);

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
    }));
  } catch (error) {
    console.error('Error fetching metrics:', error.message);
    res.status(500).json(fail('Failed to fetch metrics.'));
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

app.get('/health', (req, res) => {
  res.json(ok({ status: 'ok', timestamp: new Date().toISOString() }));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(uiPath, 'index.html'));
});

export function startUIServer() {
  initializeLedger().catch((e) => console.error('UI server (paper) ledger init failed:', e.message));
  initializeLiveLedger().catch((e) => console.error('UI server (live) ledger init failed:', e.message));

  console.log(`Starting UI server on ${host}:${port}...`);
  const server = app.listen(port, host, () => {
    console.log(`UI server running on http://${host}:${port}`);
  });

  server.on('error', (err) => {
    console.error('UI server failed to bind/listen:', err.message);
  });

  return server;
}
