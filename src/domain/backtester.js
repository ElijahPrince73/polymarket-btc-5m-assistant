/**
 * @file Pure-function backtester for replaying historical trades with modified thresholds.
 *
 * Domain layer -- no I/O, no side effects, no external imports.
 * Follows the same pattern as entryGate.js, exitEvaluator.js, sizing.js.
 *
 * Purpose: Re-evaluate historical trades against modified entry thresholds to answer
 * "what if I had used different parameters?" without look-ahead bias.
 */

// ─── helpers ───────────────────────────────────────────────────────

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

// ─── evaluateHistoricalEntry ───────────────────────────────────────

/**
 * Re-evaluate whether a historical trade would have passed entry gate
 * thresholds with the given config overrides.
 *
 * Only checks configurable threshold-based blockers, NOT time-dependent
 * or state-dependent ones (trading disabled, market closed, already in position).
 * This enables near-miss analysis for threshold tuning.
 *
 * CRITICAL: Never uses exit-time data (exitPrice, exitReason, pnl) to decide
 * entry. Only entry-time (*AtEntry) fields are used, preventing look-ahead bias.
 *
 * @param {Object} trade - Historical trade with *AtEntry enrichment fields
 * @param {Object} config - Merged config with threshold overrides
 * @returns {boolean} true if trade would have entered, false if filtered out
 */
export function evaluateHistoricalEntry(trade, config) {
  if (!trade || !config) return false;

  // 1. Probability threshold: modelProbAtEntry vs minProbMid
  const prob = trade.modelProbAtEntry;
  const minProb = config.minProbMid;
  if (isNum(prob) && isNum(minProb)) {
    if (prob < minProb) return false;
  }

  // 2. Edge threshold: edgeAtEntry vs edgeMid
  const edge = trade.edgeAtEntry;
  const edgeMid = config.edgeMid;
  if (isNum(edge) && isNum(edgeMid)) {
    if (edge < edgeMid) return false;
  }

  // 3. RSI no-trade band: rsiAtEntry vs noTradeRsiMin / noTradeRsiMax
  const rsi = trade.rsiAtEntry;
  const rsiMin = config.noTradeRsiMin;
  const rsiMax = config.noTradeRsiMax;
  if (isNum(rsi) && isNum(rsiMin) && isNum(rsiMax)) {
    if (rsi >= rsiMin && rsi < rsiMax) return false;
  }

  // 4. Spread threshold: spreadAtEntry vs maxSpreadThreshold
  const spread = trade.spreadAtEntry;
  const maxSpread = config.maxSpreadThreshold;
  if (isNum(spread) && isNum(maxSpread)) {
    if (spread > maxSpread) return false;
  }

  // 5. Liquidity threshold: liquidityAtEntry vs minLiquidity
  const liquidity = trade.liquidityAtEntry;
  const minLiquidity = config.minLiquidity;
  if (isNum(liquidity) && isNum(minLiquidity)) {
    if (liquidity < minLiquidity) return false;
  }

  // 6. Spot impulse threshold: spotImpulsePctAtEntry vs minSpotImpulse
  const impulse = trade.spotImpulsePctAtEntry;
  const minImpulse = config.minSpotImpulse;
  if (isNum(impulse) && isNum(minImpulse)) {
    if (Math.abs(impulse) < minImpulse) return false;
  }

  // All checked thresholds passed (or were skipped due to null/missing data)
  return true;
}

// ─── replayTrades ──────────────────────────────────────────────────

/**
 * Replay historical trades with modified entry thresholds.
 *
 * Filters to CLOSED trades, re-evaluates each through evaluateHistoricalEntry(),
 * and computes aggregate metrics on the resulting subset.
 *
 * @param {Array} trades - Array of trade objects from the ledger
 * @param {Object} overrideConfig - Parameter overrides to test
 * @param {Object} baseConfig - Base config values (defaults)
 * @returns {Object} Replay result with metrics
 */
export function replayTrades(trades, overrideConfig, baseConfig) {
  const safeTrades = Array.isArray(trades) ? trades : [];
  const safeOverride = overrideConfig && typeof overrideConfig === 'object' ? overrideConfig : {};
  const safeBase = baseConfig && typeof baseConfig === 'object' ? baseConfig : {};

  // Merge config: overrides take precedence
  const config = { ...safeBase, ...safeOverride };

  // Filter to closed trades only
  const closedTrades = safeTrades.filter(t => t && t.status === 'CLOSED');

  const entered = [];
  const filtered = [];

  for (const trade of closedTrades) {
    if (evaluateHistoricalEntry(trade, config)) {
      entered.push(trade);
    } else {
      filtered.push(trade);
    }
  }

  // Compute metrics from entered trades
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let winPnlSum = 0;
  let lossPnlSum = 0;

  for (const trade of entered) {
    const pnl = isNum(trade.pnl) ? trade.pnl : 0;
    totalPnl += pnl;
    if (pnl > 0) {
      wins += 1;
      winPnlSum += pnl;
    } else if (pnl < 0) {
      losses += 1;
      lossPnlSum += pnl;
    }
  }

  const tradeCount = entered.length;

  // Derived metrics
  const winRate = tradeCount > 0 ? wins / tradeCount : null;
  const profitFactor = losses > 0 ? winPnlSum / Math.abs(lossPnlSum) : null;
  const avgWin = wins > 0 ? winPnlSum / wins : null;
  const avgLoss = losses > 0 ? lossPnlSum / losses : null;
  const expectancy = tradeCount > 0 ? totalPnl / tradeCount : null;

  // Max drawdown from entered trades (pure computation, no imports)
  const maxDrawdown = computeMaxDrawdownFromTrades(entered);

  return {
    entered,
    filtered,
    totalPnl,
    wins,
    losses,
    winRate,
    profitFactor,
    maxDrawdown,
    avgWin,
    avgLoss,
    expectancy,
    tradeCount,
    filteredCount: filtered.length,
  };
}

// ─── drawdown helper (copied from analyticsService pattern, pure) ──

/**
 * Compute max drawdown from a sequence of trades.
 * Uses a running equity curve approach.
 *
 * @param {Array} trades - Ordered array of trades with pnl field
 * @param {number} [startingBalance=1000] - Starting equity for drawdown calc
 * @returns {{ maxDrawdownUsd: number, maxDrawdownPct: number }}
 */
function computeMaxDrawdownFromTrades(trades, startingBalance = 1000) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { maxDrawdownUsd: 0, maxDrawdownPct: 0 };
  }

  let equity = startingBalance;
  let peak = startingBalance;
  let maxDD = 0;
  let maxDDPct = 0;

  for (const trade of trades) {
    const pnl = isNum(trade.pnl) ? trade.pnl : 0;
    equity += pnl;
    peak = Math.max(peak, equity);
    const dd = peak - equity; // positive value = drawdown magnitude
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDD) maxDD = dd;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }

  return { maxDrawdownUsd: maxDD, maxDrawdownPct: maxDDPct };
}
