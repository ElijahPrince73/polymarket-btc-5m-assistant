function bucketEntryPrice(trade) {
  const px = trade?.entryPrice;
  if (typeof px !== 'number' || !Number.isFinite(px)) return 'unknown';
  const cents = px * 100;
  if (cents < 0.5) return '<0.5¢';
  if (cents < 1) return '0.5–1¢';
  if (cents < 2) return '1–2¢';
  if (cents < 5) return '2–5¢';
  if (cents < 10) return '5–10¢';
  return '10¢+';
}

export function groupSummary(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const key = String(keyFn(t) ?? 'unknown');
    const cur = map.get(key) || { key, count: 0, pnl: 0 };
    cur.count += 1;
    cur.pnl += (typeof t.pnl === 'number' && Number.isFinite(t.pnl)) ? t.pnl : 0;
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
}

function bucketTimeLeftMin(trade) {
  const t = trade?.timeLeftMinAtEntry;
  if (typeof t !== 'number' || !Number.isFinite(t)) return 'unknown';
  if (t < 2) return '<2m';
  if (t < 5) return '2–5m';
  if (t < 10) return '5–10m';
  return '10m+';
}

function bucketProb(trade) {
  const p = trade?.modelProbAtEntry;
  if (typeof p !== 'number' || !Number.isFinite(p)) return 'unknown';
  if (p < 0.55) return '<0.55';
  if (p < 0.60) return '0.55–0.60';
  if (p < 0.65) return '0.60–0.65';
  if (p < 0.70) return '0.65–0.70';
  return '0.70+';
}

function bucketLiquidity(trade) {
  const l = trade?.liquidityAtEntry;
  if (typeof l !== 'number' || !Number.isFinite(l)) return 'unknown';
  if (l < 1000) return '<1k';
  if (l < 5000) return '1k–5k';
  if (l < 10000) return '5k–10k';
  if (l < 25000) return '10k–25k';
  if (l < 50000) return '25k–50k';
  if (l < 100000) return '50k–100k';
  return '100k+';
}

function bucketSpread(trade) {
  const s = trade?.spreadAtEntry;
  if (typeof s !== 'number' || !Number.isFinite(s)) return 'unknown';
  const c = s * 100;
  if (c < 0.5) return '<0.5¢';
  if (c < 1) return '0.5–1¢';
  if (c < 2) return '1–2¢';
  if (c < 5) return '2–5¢';
  return '5¢+';
}

function bucketMarketVolume(trade) {
  const v = trade?.volumeNumAtEntry;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'unknown';
  if (v < 25000) return '<25k';
  if (v < 50000) return '25k–50k';
  if (v < 100000) return '50k–100k';
  if (v < 200000) return '100k–200k';
  return '200k+';
}

function bucketEdge(trade) {
  const e = trade?.edgeAtEntry;
  if (typeof e !== 'number' || !Number.isFinite(e)) return 'unknown';
  if (e < 0.04) return '<0.04';
  if (e < 0.08) return '0.04–0.08';
  if (e < 0.12) return '0.08–0.12';
  if (e < 0.16) return '0.12–0.16';
  return '0.16+';
}

function bucketVwapDist(trade) {
  const d = trade?.vwapDistAtEntry;
  if (typeof d !== 'number' || !Number.isFinite(d)) return 'unknown';
  const pct = d * 100;
  if (pct < -0.20) return '<-0.20%';
  if (pct < -0.05) return '-0.20–-0.05%';
  if (pct <= 0.05) return '-0.05–0.05%';
  if (pct <= 0.20) return '0.05–0.20%';
  return '>0.20%';
}

function bucketRsi(trade) {
  const r = trade?.rsiAtEntry;
  if (typeof r !== 'number' || !Number.isFinite(r)) return 'unknown';
  if (r < 30) return '<30';
  if (r < 45) return '30–45';
  if (r < 55) return '45–55';
  if (r < 70) return '55–70';
  return '70+';
}

function bucketHoldTime(trade) {
  if (!trade?.entryTime || !trade?.exitTime) return 'unknown';
  const ms = new Date(trade.exitTime).getTime() - new Date(trade.entryTime).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const min = ms / 60000;
  if (min < 2) return '<2m';
  if (min < 5) return '2–5m';
  if (min < 10) return '5–10m';
  return '10m+';
}

function bucketMAE(trade) {
  const x = trade?.minUnrealizedPnl;
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'unknown';
  if (x > -10) return '> -$10';
  if (x > -25) return '-$10–-$25';
  if (x > -50) return '-$25–-$50';
  if (x > -100) return '-$50–-$100';
  return '<= -$100';
}

function bucketMFE(trade) {
  const x = trade?.maxUnrealizedPnl;
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'unknown';
  if (x < 10) return '<$10';
  if (x < 25) return '$10–$25';
  if (x < 50) return '$25–$50';
  if (x < 100) return '$50–$100';
  return '$100+';
}

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
    })
  };
}
