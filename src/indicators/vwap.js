export function computeSessionVwap(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let pv = 0;
  let v = 0;
  let tpSum = 0;
  let n = 0;

  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = typeof c.volume === "number" && Number.isFinite(c.volume) ? c.volume : 0;

    // Standard VWAP inputs
    pv += tp * vol;
    v += vol;

    // Fallback (no reliable volume): average typical price
    tpSum += tp;
    n += 1;
  }

  // If we don't have volume (e.g., Chainlink-derived candles), fall back to unweighted TP average.
  if (v === 0) return n ? (tpSum / n) : null;
  return pv / v;
}

export function computeVwapSeries(candles) {
  const series = [];
  for (let i = 0; i < candles.length; i += 1) {
    const sub = candles.slice(0, i + 1);
    series.push(computeSessionVwap(sub));
  }
  return series;
}
