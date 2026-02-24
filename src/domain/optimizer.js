/**
 * @file Grid search optimizer for exhaustive parameter testing.
 *
 * Domain layer -- no I/O, no side effects.
 * Follows the same pattern as entryGate.js, exitEvaluator.js, sizing.js, backtester.js.
 *
 * Purpose: Test all combinations of configurable entry thresholds via backtester
 * replay, ranking them by profitability metrics to find optimal parameter sets.
 */

import { replayTrades } from './backtester.js';

// ─── Default param ranges ─────────────────────────────────────────

export const DEFAULT_PARAM_RANGES = {
  minProbMid: { min: 0.50, max: 0.58, step: 0.01 },
  edgeMid: { min: 0.01, max: 0.06, step: 0.01 },
  noTradeRsiMin: { min: 25, max: 40, step: 5 },
  noTradeRsiMax: { min: 40, max: 55, step: 5 },
  maxEntryPolyPrice: { min: 0.004, max: 0.008, step: 0.001 },
};

// ─── helpers ──────────────────────────────────────────────────────

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

// ─── generateParamRanges ──────────────────────────────────────────

/**
 * Convert range config (min/max/step) into explicit arrays of values.
 * Uses integer multiples of step to avoid floating point accumulation errors.
 *
 * @param {Object} rangeConfig - { paramName: { min, max, step }, ... }
 * @returns {Object} { paramName: [val1, val2, ...], ... }
 */
export function generateParamRanges(rangeConfig) {
  if (!rangeConfig || typeof rangeConfig !== 'object') return {};

  const result = {};

  for (const [param, range] of Object.entries(rangeConfig)) {
    if (!range || typeof range !== 'object') continue;
    const { min, max, step } = range;

    if (!isNum(min) || !isNum(max) || !isNum(step) || step <= 0) continue;
    if (min > max) continue;

    const values = [];

    // Use integer multiples to avoid floating point accumulation
    // Determine decimal precision from step
    const stepStr = String(step);
    const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
    const multiplier = Math.pow(10, decimalPlaces);

    const minInt = Math.round(min * multiplier);
    const maxInt = Math.round(max * multiplier);
    const stepInt = Math.round(step * multiplier);

    for (let i = minInt; i <= maxInt; i += stepInt) {
      values.push(i / multiplier);
    }

    result[param] = values;
  }

  return result;
}

// ─── cartesianProduct ─────────────────────────────────────────────

/**
 * Compute Cartesian product of parameter value arrays.
 * Iterative implementation (not recursive) to avoid stack overflow on large grids.
 *
 * @param {Object} paramRanges - { paramName: [val1, val2, ...], ... }
 * @returns {Array<Array>} Array of combination arrays, each sub-array is one combination
 *   Each element is { paramName: value, ... }
 */
export function cartesianProduct(paramRanges) {
  if (!paramRanges || typeof paramRanges !== 'object') return [{}];

  const paramNames = Object.keys(paramRanges);
  if (paramNames.length === 0) return [{}];

  const arrays = paramNames.map(name => {
    const vals = paramRanges[name];
    return Array.isArray(vals) ? vals : [vals];
  });

  // Iterative Cartesian product
  let combinations = [[]];

  for (const array of arrays) {
    const next = [];
    for (const combo of combinations) {
      for (const value of array) {
        next.push([...combo, value]);
      }
    }
    combinations = next;
  }

  // Convert from arrays of values to objects with param names
  return combinations.map(combo => {
    const obj = {};
    for (let i = 0; i < paramNames.length; i++) {
      obj[paramNames[i]] = combo[i];
    }
    return obj;
  });
}

// ─── gridSearch ───────────────────────────────────────────────────

/**
 * Run exhaustive grid search over parameter combinations.
 *
 * For each combination, replays historical trades with modified thresholds
 * and collects performance metrics. Skips combinations that produce too
 * few trades (prevents overfitting on small samples).
 *
 * @param {Array} trades - Historical trade array from ledger
 * @param {Object} baseConfig - Base config values (defaults)
 * @param {Object} paramRanges - { paramName: [val1, val2, ...], ... }
 * @param {number} [minTradesPerCombo=30] - Minimum trades per combo to include in results
 * @returns {Object} { results, totalCombinations, skippedCombinations, paramNames }
 */
export function gridSearch(trades, baseConfig, paramRanges, minTradesPerCombo = 30) {
  if (!paramRanges || typeof paramRanges !== 'object') {
    return { results: [], totalCombinations: 0, skippedCombinations: 0, paramNames: [] };
  }

  const paramNames = Object.keys(paramRanges);
  const combinations = cartesianProduct(paramRanges);
  const totalCombinations = combinations.length;

  // Safety: reject grids > 10,000 combinations (per RESEARCH.md Pitfall 4)
  if (totalCombinations > 10000) {
    throw new Error(
      `Grid search would test ${totalCombinations} combinations (max 10,000). ` +
      `Reduce parameter ranges or use coarser step sizes. ` +
      `Current params: ${paramNames.join(', ')}`
    );
  }

  const results = [];
  let skippedCombinations = 0;

  for (const combo of combinations) {
    const replay = replayTrades(trades, combo, baseConfig);

    // Skip combinations with too few trades (prevents overfitting)
    if (replay.tradeCount < minTradesPerCombo) {
      skippedCombinations++;
      continue;
    }

    results.push({
      params: combo,
      tradeCount: replay.tradeCount,
      filteredCount: replay.filteredCount,
      winRate: replay.winRate,
      profitFactor: replay.profitFactor,
      totalPnl: replay.totalPnl,
      maxDrawdown: replay.maxDrawdown,
      avgWin: replay.avgWin,
      avgLoss: replay.avgLoss,
      expectancy: replay.expectancy,
    });
  }

  // Sort by profitFactor descending (primary), winRate descending (secondary)
  results.sort((a, b) => {
    const pfA = a.profitFactor ?? -Infinity;
    const pfB = b.profitFactor ?? -Infinity;
    if (pfA !== pfB) return pfB - pfA;
    const wrA = a.winRate ?? -Infinity;
    const wrB = b.winRate ?? -Infinity;
    return wrB - wrA;
  });

  return {
    results,
    totalCombinations,
    skippedCombinations,
    paramNames,
  };
}
