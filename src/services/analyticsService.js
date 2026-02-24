import { CONFIG } from '../config.js';

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function bucketEntryPrice(trade) {
  const px = trade?.entryPrice;
  if (typeof px !== 'number' || !Number.isFinite(px)) return 'unknown';
  const cents = px * 100;
  if (cents < 0.5) return '<0.5\u00A2';
  if (cents < 1) return '0.5\u20131\u00A2';
  if (cents < 2) return '1\u20132\u00A2';
  if (cents < 5) return '2\u20135\u00A2';
  if (cents < 10) return '5\u201310\u00A2';
  return '10\u00A2+';
}

export function groupSummary(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const key = String(keyFn(t) ?? 'unknown');
    const cur = map.get(key) || { key, count: 0, pnl: 0, wins: 0, losses: 0 };
    const pnl = (typeof t.pnl === 'number' && Number.isFinite(t.pnl)) ? t.pnl : 0;
    cur.count += 1;
    cur.pnl += pnl;
    if (pnl > 0) cur.wins += 1;
    else if (pnl < 0) cur.losses += 1;
    map.set(key, cur);
  }
  const result = Array.from(map.values()).map(bucket => ({
    ...bucket,
    winRate: bucket.count > 0 ? bucket.wins / bucket.count : null,
    avgPnl: bucket.count > 0 ? bucket.pnl / bucket.count : null,
  }));
  return result.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
}

function bucketTimeLeftMin(trade) {
  const t = trade?.timeLeftMinAtEntry;
  if (typeof t !== 'number' || !Number.isFinite(t)) return 'unknown';
  if (t < 2) return '<2m';
  if (t < 5) return '2\u20135m';
  if (t < 10) return '5\u201310m';
  return '10m+';
}

function bucketProb(trade) {
  const p = trade?.modelProbAtEntry;
  if (typeof p !== 'number' || !Number.isFinite(p)) return 'unknown';
  if (p < 0.55) return '<0.55';
  if (p < 0.60) return '0.55\u20130.60';
  if (p < 0.65) return '0.60\u20130.65';
  if (p < 0.70) return '0.65\u20130.70';
  return '0.70+';
}

function bucketLiquidity(trade) {
  const l = trade?.liquidityAtEntry;
  if (typeof l !== 'number' || !Number.isFinite(l)) return 'unknown';
  if (l < 1000) return '<1k';
  if (l < 5000) return '1k\u20135k';
  if (l < 10000) return '5k\u201310k';
  if (l < 25000) return '10k\u201325k';
  if (l < 50000) return '25k\u201350k';
  if (l < 100000) return '50k\u2013100k';
  return '100k+';
}

function bucketSpread(trade) {
  const s = trade?.spreadAtEntry;
  if (typeof s !== 'number' || !Number.isFinite(s)) return 'unknown';
  const c = s * 100;
  if (c < 0.5) return '<0.5\u00A2';
  if (c < 1) return '0.5\u20131\u00A2';
  if (c < 2) return '1\u20132\u00A2';
  if (c < 5) return '2\u20135\u00A2';
  return '5\u00A2+';
}

function bucketMarketVolume(trade) {
  const v = trade?.volumeNumAtEntry;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'unknown';
  if (v < 25000) return '<25k';
  if (v < 50000) return '25k\u201350k';
  if (v < 100000) return '50k\u2013100k';
  if (v < 200000) return '100k\u2013200k';
  return '200k+';
}

function bucketEdge(trade) {
  const e = trade?.edgeAtEntry;
  if (typeof e !== 'number' || !Number.isFinite(e)) return 'unknown';
  if (e < 0.04) return '<0.04';
  if (e < 0.08) return '0.04\u20130.08';
  if (e < 0.12) return '0.08\u20130.12';
  if (e < 0.16) return '0.12\u20130.16';
  return '0.16+';
}

function bucketVwapDist(trade) {
  const d = trade?.vwapDistAtEntry;
  if (typeof d !== 'number' || !Number.isFinite(d)) return 'unknown';
  const pct = d * 100;
  if (pct < -0.20) return '<-0.20%';
  if (pct < -0.05) return '-0.20\u2013-0.05%';
  if (pct <= 0.05) return '-0.05\u20130.05%';
  if (pct <= 0.20) return '0.05\u20130.20%';
  return '>0.20%';
}

function bucketRsi(trade) {
  const r = trade?.rsiAtEntry;
  if (typeof r !== 'number' || !Number.isFinite(r)) return 'unknown';
  if (r < 30) return '<30';
  if (r < 45) return '30\u201345';
  if (r < 55) return '45\u201355';
  if (r < 70) return '55\u201370';
  return '70+';
}

function bucketHoldTime(trade) {
  if (!trade?.entryTime || !trade?.exitTime) return 'unknown';
  const ms = new Date(trade.exitTime).getTime() - new Date(trade.entryTime).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const min = ms / 60000;
  if (min < 2) return '<2m';
  if (min < 5) return '2\u20135m';
  if (min < 10) return '5\u201310m';
  return '10m+';
}

function bucketMAE(trade) {
  const x = trade?.minUnrealizedPnl;
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'unknown';
  if (x > -10) return '> -$10';
  if (x > -25) return '-$10\u2013-$25';
  if (x > -50) return '-$25\u2013-$50';
  if (x > -100) return '-$50\u2013-$100';
  return '<= -$100';
}

function bucketMFE(trade) {
  const x = trade?.maxUnrealizedPnl;
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'unknown';
  if (x < 10) return '<$10';
  if (x < 25) return '$10\u2013$25';
  if (x < 50) return '$25\u2013$50';
  if (x < 100) return '$50\u2013$100';
  return '$100+';
}

// ─── Period grouping functions ──────────────────────────────────────

const _ptDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Group by Pacific time day. Returns 'YYYY-MM-DD' or 'unknown'.
 */
export function dayKeyFromTrade(trade) {
  const ts = trade?.exitTime || trade?.timestamp;
  if (!ts) return 'unknown';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return 'unknown';
    return _ptDayFmt.format(d);
  } catch {
    return 'unknown';
  }
}

/**
 * Group by ISO week. Returns 'YYYY-Wnn' or 'unknown'.
 */
export function weekKeyFromTrade(trade) {
  const ts = trade?.exitTime || trade?.timestamp;
  if (!ts) return 'unknown';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return 'unknown';
    // ISO week calculation
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    // Set to nearest Thursday: current date + 4 - current day number (ISO: Mon=1..Sun=7)
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  } catch {
    return 'unknown';
  }
}

/**
 * Group by BTC trading session based on UTC hour.
 * Asia (0-8), London (8-13), NY (13-21), Off-hours (21-0).
 */
export function sessionKeyFromTrade(trade) {
  const ts = trade?.entryTime || trade?.timestamp;
  if (!ts) return 'unknown';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return 'unknown';
    const hour = d.getUTCHours();
    if (hour < 8) return 'Asia';
    if (hour < 13) return 'London';
    if (hour < 21) return 'NY';
    return 'Off-hours';
  } catch {
    return 'unknown';
  }
}

// ─── Financial metrics functions ────────────────────────────────────

/**
 * Groups PnL by day (Pacific time), converts to daily returns.
 * @param {Array} closedTrades
 * @param {number} startingBalance
 * @returns {number[]} Array of daily return values
 */
export function computeDailyReturns(closedTrades, startingBalance) {
  const dailyPnl = new Map();
  for (const t of closedTrades) {
    const dk = dayKeyFromTrade(t);
    if (dk === 'unknown') continue;
    const pnl = (typeof t.pnl === 'number' && isNum(t.pnl)) ? t.pnl : 0;
    dailyPnl.set(dk, (dailyPnl.get(dk) || 0) + pnl);
  }
  const bal = isNum(startingBalance) && startingBalance > 0 ? startingBalance : 1000;
  return Array.from(dailyPnl.values()).map(pnl => pnl / bal);
}

/**
 * Sharpe ratio: (mean excess return / std dev) * sqrt(252).
 * @param {number[]} dailyReturns
 * @param {number} riskFreeRate
 * @returns {number|null}
 */
export function computeSharpeRatio(dailyReturns, riskFreeRate = 0) {
  if (!Array.isArray(dailyReturns) || dailyReturns.length < 2) return null;
  const n = dailyReturns.length;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / n;
  const excessMean = mean - riskFreeRate;
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;
  return (excessMean / stdDev) * Math.sqrt(252);
}

/**
 * Sortino ratio: (mean excess return / downside deviation) * sqrt(252).
 * @param {number[]} dailyReturns
 * @param {number} riskFreeRate
 * @returns {number|null}
 */
export function computeSortinoRatio(dailyReturns, riskFreeRate = 0) {
  if (!Array.isArray(dailyReturns) || dailyReturns.length < 2) return null;
  const n = dailyReturns.length;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / n;
  const excessMean = mean - riskFreeRate;
  const negReturns = dailyReturns.filter(r => r < 0);
  if (negReturns.length === 0) return null; // No downside
  const downsideVariance = negReturns.reduce((s, r) => s + r ** 2, 0) / n;
  const downsideDev = Math.sqrt(downsideVariance);
  if (downsideDev === 0) return null;
  return (excessMean / downsideDev) * Math.sqrt(252);
}

/**
 * Compute drawdown series from closed trades.
 * @param {Array} closedTrades
 * @param {number} startingBalance
 * @returns {Array<{ tradeIndex: number, equity: number, peak: number, drawdown: number, drawdownPct: number }>}
 */
export function computeDrawdownSeries(closedTrades, startingBalance) {
  const bal = isNum(startingBalance) && startingBalance > 0 ? startingBalance : 1000;
  let equity = bal;
  let peak = bal;
  const series = [];
  for (let i = 0; i < closedTrades.length; i++) {
    const pnl = (typeof closedTrades[i].pnl === 'number' && isNum(closedTrades[i].pnl))
      ? closedTrades[i].pnl : 0;
    equity += pnl;
    peak = Math.max(peak, equity);
    const dd = equity - peak;
    const ddPct = peak > 0 ? dd / peak : 0;
    series.push({ tradeIndex: i, equity, peak, drawdown: dd, drawdownPct: ddPct });
  }
  return series;
}

/**
 * Compute max drawdown from closed trades.
 * @param {Array} closedTrades
 * @param {number} startingBalance
 * @returns {{ maxDrawdownUsd: number, maxDrawdownPct: number }}
 */
export function computeMaxDrawdown(closedTrades, startingBalance) {
  const series = computeDrawdownSeries(closedTrades, startingBalance);
  let maxDD = 0;
  let maxDDPct = 0;
  for (const s of series) {
    const dd = Math.abs(s.drawdown);
    const ddPct = Math.abs(s.drawdownPct);
    if (dd > maxDD) maxDD = dd;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }
  return { maxDrawdownUsd: maxDD, maxDrawdownPct: maxDDPct };
}

// ─── Main analytics computation ─────────────────────────────────────

export function computeAnalytics(allTrades) {
  const trades = Array.isArray(allTrades) ? allTrades : [];
  const closed = trades.filter((t) => t && t.status === 'CLOSED');

  const wins = closed.filter((t) => (typeof t.pnl === 'number' && t.pnl > 0));
  const losses = closed.filter((t) => (typeof t.pnl === 'number' && t.pnl < 0));

  const sum = (arr) => arr.reduce((acc, t) => acc + (typeof t.pnl === 'number' ? t.pnl : 0), 0);
  const totalPnL = sum(closed);
  const winPnL = sum(wins);
  const lossPnL = sum(losses);

  const avgWin = wins.length ? (winPnL / wins.length) : null;
  const avgLoss = losses.length ? (lossPnL / losses.length) : null;
  const winRate = closed.length ? (wins.length / closed.length) : null;
  const profitFactor = (lossPnL !== 0) ? (winPnL / Math.abs(lossPnL)) : null;
  const expectancy = closed.length ? (totalPnL / closed.length) : null;

  // Compute advanced metrics
  const startingBalance = CONFIG?.paperTrading?.startingBalance ?? 1000;
  const dailyReturns = computeDailyReturns(closed, startingBalance);
  const drawdownSeries = computeDrawdownSeries(closed, startingBalance);
  const maxDD = computeMaxDrawdown(closed, startingBalance);

  return {
    overview: {
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      totalPnL,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      expectancy
    },
    byExitReason: groupSummary(closed, (t) => t.exitReason || 'unknown'),
    byEntryPhase: groupSummary(closed, (t) => t.entryPhase || 'unknown'),
    byEntryPriceBucket: groupSummary(closed, (t) => bucketEntryPrice(t)),
    byEntryTimeLeftBucket: groupSummary(closed, (t) => bucketTimeLeftMin(t)),
    byEntryProbBucket: groupSummary(closed, (t) => bucketProb(t)),
    byEntryLiquidityBucket: groupSummary(closed, (t) => bucketLiquidity(t)),
    byEntryMarketVolumeBucket: groupSummary(closed, (t) => bucketMarketVolume(t)),
    byEntrySpreadBucket: groupSummary(closed, (t) => bucketSpread(t)),
    byEntryEdgeBucket: groupSummary(closed, (t) => bucketEdge(t)),
    byEntryVwapDistBucket: groupSummary(closed, (t) => bucketVwapDist(t)),
    byEntryRsiBucket: groupSummary(closed, (t) => bucketRsi(t)),
    byHoldTimeBucket: groupSummary(closed, (t) => bucketHoldTime(t)),
    byMAEBucket: groupSummary(closed, (t) => bucketMAE(t)),
    byMFEBucket: groupSummary(closed, (t) => bucketMFE(t)),
    bySide: groupSummary(closed, (t) => t.side || 'unknown'),
    byRecActionAtEntry: groupSummary(closed, (t) => t.recActionAtEntry || 'unknown'),
    bySideInferred: groupSummary(closed, (t) => {
      if (t.sideInferred === true) return 'inferred';
      if (t.sideInferred === false) return 'explicit';
      return 'unknown';
    }),

    // Period groupings
    byDay: groupSummary(closed, dayKeyFromTrade),
    byWeek: groupSummary(closed, weekKeyFromTrade),
    bySession: groupSummary(closed, sessionKeyFromTrade),

    // Advanced metrics
    advancedMetrics: {
      sharpeRatio: computeSharpeRatio(dailyReturns),
      sortinoRatio: computeSortinoRatio(dailyReturns),
      maxDrawdownUsd: maxDD.maxDrawdownUsd,
      maxDrawdownPct: maxDD.maxDrawdownPct,
      drawdownSeries,
      dailyReturns,
      dailyReturnCount: dailyReturns.length,
      metricsConfidence: dailyReturns.length >= 30 ? 'HIGH' : 'LOW',
    }
  };
}
