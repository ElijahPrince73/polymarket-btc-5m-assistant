/**
 * @file Service/orchestration layer for backtesting.
 *
 * Connects the pure-function backtester (domain layer) to I/O sources
 * (trade store / ledger data, config). Application layer -- no direct external API calls.
 *
 * Phase 6: Reads from Supabase trade store (primary) with JSON ledger fallback.
 */

import { initializeLedger, getLedger } from '../paper_trading/ledger.js';
import { CONFIG } from '../config.js';
import { replayTrades } from '../domain/backtester.js';

/**
 * Load trades from Supabase trade store (primary) with JSON ledger fallback.
 * @returns {Promise<Object[]>}
 */
async function loadTrades() {
  try {
    if (globalThis.__tradeStore_getTradeStore) {
      const store = globalThis.__tradeStore_getTradeStore();
      return await store.getAllTrades();
    }
  } catch {
    // Fallback to JSON ledger if Supabase unavailable
  }

  const ledger = getLedger();
  return Array.isArray(ledger.trades) ? ledger.trades : [];
}

/**
 * Extract the relevant threshold values from base config for comparison display.
 * These are the configurable thresholds that the backtester evaluates.
 *
 * @param {Object} config - Paper trading config section
 * @returns {Object} Threshold values from base config
 */
function extractBaseThresholds(config) {
  return {
    minProbMid: config.minProbMid ?? null,
    edgeMid: config.edgeMid ?? null,
    noTradeRsiMin: config.noTradeRsiMin ?? null,
    noTradeRsiMax: config.noTradeRsiMax ?? null,
    maxSpreadThreshold: config.maxSpread ?? null,
    minLiquidity: config.minLiquidity ?? null,
    minSpotImpulse: config.minBtcImpulsePct1m ?? null,
    maxEntryPolyPrice: config.maxEntryPolyPrice ?? null,
  };
}

/**
 * Count how many trades have non-null enrichment fields.
 * Indicates data quality / how useful the backtest will be.
 *
 * @param {Array} trades - Array of trade objects
 * @returns {number} Count of trades with at least one enrichment field
 */
function countEnrichedTrades(trades) {
  const enrichmentFields = [
    'modelProbAtEntry', 'edgeAtEntry', 'rsiAtEntry',
    'spreadAtEntry', 'liquidityAtEntry', 'spotImpulsePctAtEntry',
  ];

  let count = 0;
  for (const trade of trades) {
    if (!trade) continue;
    const hasAny = enrichmentFields.some(field => {
      const val = trade[field];
      return val !== null && val !== undefined && typeof val === 'number' && Number.isFinite(val);
    });
    if (hasAny) count += 1;
  }
  return count;
}

/**
 * Run a backtest with the given parameter overrides.
 *
 * Loads trades from the trade store (or JSON ledger fallback), gets base config,
 * and calls the pure-function backtester. Returns the replay result enriched with
 * context metadata (base config, override config, trade counts).
 *
 * @param {Object} overrideConfig - Parameter overrides to test
 * @returns {Promise<Object>} Backtest result or error object
 */
export async function runBacktest(overrideConfig) {
  try {
    await initializeLedger();
  } catch (err) {
    return {
      error: true,
      message: 'Failed to initialize ledger: ' + (err?.message || String(err)),
    };
  }

  let trades;
  try {
    trades = await loadTrades();
  } catch (err) {
    return {
      error: true,
      message: 'Failed to load trades: ' + (err?.message || String(err)),
    };
  }

  const paperConfig = CONFIG.paperTrading || {};

  // Build base config in the shape the backtester expects
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

  const safeOverride = overrideConfig && typeof overrideConfig === 'object'
    ? overrideConfig
    : {};

  const result = replayTrades(trades, safeOverride, baseConfig);

  // Strip full trade arrays from response to keep payload small
  // (entered/filtered can be 100s of trades)
  const { entered, filtered, ...metrics } = result;

  return {
    ...metrics,
    baseConfig: extractBaseThresholds(paperConfig),
    overrideConfig: safeOverride,
    totalTradesInLedger: trades.length,
    enrichedTradeCount: countEnrichedTrades(trades),
  };
}
