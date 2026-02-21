/**
 * @file Unified entry gate logic for both paper and live trading.
 *
 * This is a pure function — no I/O, no side effects. Both the PaperExecutor
 * and LiveExecutor call this with identical arguments to get the same set of
 * entry blockers.
 *
 * Extracted from:
 *   - src/paper_trading/trader.js processSignals() lines 110-776
 *   - src/live_trading/trader.js processSignals() lines 102-801
 */

/** @import { TradeSide } from './types.js' */

// ─── helpers ───────────────────────────────────────────────────────

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Detect Pacific-time weekend and current day/hour.
 * @returns {{ isWeekend: boolean, wd: string, hour: number }}
 */
export function getPacificTimeInfo() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = get('weekday');
  const hour = Number(get('hour'));
  const isWeekend = wd === 'Sat' || wd === 'Sun';

  return { isWeekend, wd, hour };
}

/**
 * Compute effective entry thresholds with weekend/MID/inferred boosts applied.
 *
 * @param {Object} config - Trading config
 * @param {boolean} isWeekend
 * @param {string} phase - 'EARLY' | 'MID' | 'LATE'
 * @param {boolean} sideInferred
 * @param {boolean} strictRec
 * @returns {{ minProb: number, edgeThreshold: number }}
 */
export function computeEffectiveThresholds(config, isWeekend, phase, sideInferred, strictRec) {
  let minProb, edgeThreshold;

  if (phase === 'EARLY') {
    minProb = config.minProbEarly ?? 0.52;
    edgeThreshold = config.edgeEarly ?? 0.02;
  } else if (phase === 'MID') {
    minProb = config.minProbMid ?? 0.53;
    edgeThreshold = config.edgeMid ?? 0.03;
  } else {
    minProb = config.minProbLate ?? 0.55;
    edgeThreshold = config.edgeLate ?? 0.05;
  }

  const weekendTightening =
    Boolean(config.weekendTighteningEnabled ?? true) && isWeekend;

  if (weekendTightening) {
    minProb += config.weekendProbBoost ?? 0;
    edgeThreshold += config.weekendEdgeBoost ?? 0;
  }

  if (phase === 'MID') {
    minProb += config.midProbBoost ?? 0;
    edgeThreshold += config.midEdgeBoost ?? 0;
  }

  if (!strictRec && sideInferred) {
    minProb += config.inferredProbBoost ?? 0;
    edgeThreshold += config.inferredEdgeBoost ?? 0;
  }

  return { minProb, edgeThreshold };
}

// ─── main entry ────────────────────────────────────────────────────

/**
 * Compute all entry blockers. Returns an array of human-readable blocker strings.
 * If the array is empty, entry is allowed.
 *
 * @param {Object} signals       - The unified signals bundle
 * @param {Object} config        - The merged trading config (paperTrading keys, possibly overlaid by liveTrading)
 * @param {Object} state         - TradingState instance (or plain object with matching shape)
 * @param {number} candleCount   - Number of 1m candles available
 * @returns {{ blockers: string[], effectiveSide: TradeSide|null, sideInferred: boolean }}
 */
export function computeEntryBlockers(signals, config, state, candleCount) {
  const blockers = [];

  // ── 1. Rec gating ───────────────────────────────────────────────
  const rec = signals?.rec;
  const strictRec = String(config.recGating || 'loose') === 'strict';

  if (strictRec && rec?.action !== 'ENTER') {
    blockers.push(`Rec=${rec?.action || 'NONE'} (strict)`);
    return { blockers, effectiveSide: null, sideInferred: false };
  }

  // Non-strict: note the rec action but continue checking
  if (!strictRec && rec?.action !== 'ENTER') {
    blockers.push(`Rec=${rec?.action || 'NONE'} (loose)`);
  }

  // ── 2. Side resolution (inference in loose mode) ─────────────────
  let effectiveSide = rec?.side ?? null;
  let sideInferred = false;

  if (!effectiveSide && !strictRec) {
    const upP = isNum(signals.modelUp) ? signals.modelUp : null;
    const downP = isNum(signals.modelDown) ? signals.modelDown : null;
    if (upP !== null && downP !== null) {
      effectiveSide = upP >= downP ? 'UP' : 'DOWN';
      sideInferred = true;
    }
  }

  if (!effectiveSide) {
    blockers.push('Missing side');
    return { blockers, effectiveSide: null, sideInferred };
  }

  // ── 3. Polymarket price resolution ──────────────────────────────
  const poly = signals.polyMarketSnapshot;
  const rawUpC = signals.polyPricesCents?.UP ?? null;
  const rawDownC = signals.polyPricesCents?.DOWN ?? null;

  const obUpAsk = poly?.orderbook?.up?.bestAsk;
  const obUpBid = poly?.orderbook?.up?.bestBid;
  const obDownAsk = poly?.orderbook?.down?.bestAsk;
  const obDownBid = poly?.orderbook?.down?.bestBid;

  const fallbackUp =
    isNum(obUpAsk) && obUpAsk > 0 ? obUpAsk * 100
      : isNum(obUpBid) && obUpBid > 0 ? obUpBid * 100
        : null;
  const fallbackDown =
    isNum(obDownAsk) && obDownAsk > 0 ? obDownAsk * 100
      : isNum(obDownBid) && obDownBid > 0 ? obDownBid * 100
        : null;

  const upC = isNum(rawUpC) && rawUpC > 0 ? rawUpC : fallbackUp;
  const downC = isNum(rawDownC) && rawDownC > 0 ? rawDownC : fallbackDown;

  const upCok = isNum(upC) && upC > 0;
  const downCok = isNum(downC) && downC > 0;
  const polyPricesSane = upCok && downCok;

  const effectivePolyPrices = {
    UP: upCok ? upC / 100 : null,
    DOWN: downCok ? downC / 100 : null,
  };

  const currentPolyPrice = effectivePolyPrices[effectiveSide];

  if (currentPolyPrice === null || currentPolyPrice === undefined) {
    blockers.push('Missing Polymarket price');
    return { blockers, effectiveSide, sideInferred };
  }

  if (!polyPricesSane) {
    blockers.push('Market data sanity: invalid Polymarket prices (gamma 0/NaN and no valid orderbook quotes)');
  }

  // ── 4. Settlement time gate ─────────────────────────────────────
  const endDate = signals.market?.endDate ?? poly?.market?.endDate ?? null;
  const settlementLeftMin = endDate
    ? (new Date(endDate).getTime() - Date.now()) / 60000
    : null;
  const timeLeftForEntry =
    isNum(settlementLeftMin) ? settlementLeftMin : (signals.timeLeftMin ?? null);

  const noEntryFinal = config.noEntryFinalMinutes ?? 1.5;
  if (isNum(timeLeftForEntry) && timeLeftForEntry < noEntryFinal) {
    blockers.push(`Too late (<${noEntryFinal}m to settlement)`);
  }

  // ── 5. Candle warmup ───────────────────────────────────────────
  const minCandles = config.minCandlesForEntry ?? 12;
  if (candleCount < minCandles) {
    blockers.push(`Warmup: candles ${candleCount}/${minCandles}`);
  }

  // ── 6. Indicator readiness ──────────────────────────────────────
  const ind = signals.indicators ?? {};
  const hasRsi = isNum(ind.rsiNow);
  const hasVwap = isNum(ind.vwapNow);
  const hasVwapSlope = isNum(ind.vwapSlope);
  const hasMacd = isNum(ind.macd?.hist);
  const hasHeiken = typeof ind.heikenColor === 'string' && ind.heikenColor.length > 0
    && isNum(ind.heikenCount);
  const indicatorsPopulated = hasRsi && hasVwap && hasVwapSlope && hasMacd && hasHeiken;

  if (!indicatorsPopulated) {
    blockers.push('Indicators not ready');
  }

  // ── 7. Cooldowns ────────────────────────────────────────────────
  const lossCooldownSec = config.lossCooldownSeconds ?? 0;
  const winCooldownSec = config.winCooldownSeconds ?? 0;
  const now = Date.now();

  if (lossCooldownSec > 0 && state.lastLossAtMs && (now - state.lastLossAtMs < lossCooldownSec * 1000)) {
    blockers.push(`Loss cooldown (${lossCooldownSec}s)`);
  }
  if (winCooldownSec > 0 && state.lastWinAtMs && (now - state.lastWinAtMs < winCooldownSec * 1000)) {
    blockers.push(`Win cooldown (${winCooldownSec}s)`);
  }

  // ── 8. Skip market after max loss ──────────────────────────────
  const marketSlug = signals.market?.slug;
  const skipAfterMaxLoss = config.skipMarketAfterMaxLoss ?? false;
  if (skipAfterMaxLoss && state.skipMarketUntilNextSlug && marketSlug
      && state.skipMarketUntilNextSlug === marketSlug) {
    blockers.push('Skip market after Max Loss (wait for next 5m)');
  }

  // ── 9. Has open position ───────────────────────────────────────
  if (state.hasOpenPosition) {
    blockers.push('Trade already open');
  }

  // ── 10. Schedule (weekdays, Friday cutoff, Sunday allowance) ──────
  const { isWeekend, wd, hour } = getPacificTimeInfo();
  const weekdaysOnly = config.weekdaysOnly ?? false;

  if (weekdaysOnly) {
    const allowSundayAfterHour = config.allowSundayAfterHour;
    const isSundayAllowed =
      wd === 'Sun' && isNum(allowSundayAfterHour) && allowSundayAfterHour >= 0 && hour >= allowSundayAfterHour;

    const noEntryAfterFridayHour = config.noEntryAfterFridayHour;
    const isFridayAfter =
      wd === 'Fri' && isNum(noEntryAfterFridayHour) && noEntryAfterFridayHour >= 0 && hour >= noEntryAfterFridayHour;

    if ((isWeekend && !isSundayAllowed) || isFridayAfter) {
      blockers.push('Outside schedule (weekdays only / Friday cutoff)');
    }
  }

  // ── 11. Weekend tightening state ────────────────────────────────
  const weekendTightening = Boolean(config.weekendTighteningEnabled ?? true) && isWeekend;

  // ── 12. Market quality: liquidity ──────────────────────────────
  const liquidityNum = signals.market?.liquidityNum ?? null;
  const effectiveMinLiquidity = weekendTightening
    ? (config.weekendMinLiquidity ?? config.minLiquidity)
    : (config.minLiquidity ?? 0);

  const liquidityOk = isNum(liquidityNum) && liquidityNum > 0;
  if (!liquidityOk) {
    blockers.push('Market data sanity: liquidity missing/0');
  } else if (liquidityNum < effectiveMinLiquidity) {
    blockers.push(`Low liquidity (<${effectiveMinLiquidity})`);
  }

  // ── 13. Market quality: spread ─────────────────────────────────
  const spreadUp = poly?.orderbook?.up?.spread;
  const spreadDown = poly?.orderbook?.down?.spread;
  const effectiveMaxSpread = weekendTightening
    ? (config.weekendMaxSpread ?? config.maxSpread)
    : config.maxSpread;

  if ((isNum(spreadUp) && spreadUp > effectiveMaxSpread) ||
      (isNum(spreadDown) && spreadDown > effectiveMaxSpread)) {
    blockers.push('High spread');
  }

  // ── 14. Market quality: volume ─────────────────────────────────
  const marketVolumeNum = signals.market?.volumeNum ?? null;
  const minMarketVolumeNum = config.minMarketVolumeNum ?? 0;
  if (isNum(marketVolumeNum) && minMarketVolumeNum > 0 && marketVolumeNum < minMarketVolumeNum) {
    blockers.push(`Low market volume (<${minMarketVolumeNum})`);
  }

  // ── 15. BTC volume filters ─────────────────────────────────────
  const volumeRecent = signals.indicators?.volumeRecent ?? null;
  const volumeAvg = signals.indicators?.volumeAvg ?? null;
  const minVolumeRecent = config.minVolumeRecent ?? 0;
  const minVolumeRatio = config.minVolumeRatio ?? 0;

  const isLowVolumeAbsolute = minVolumeRecent > 0 && isNum(volumeRecent) && volumeRecent < minVolumeRecent;
  const isLowVolumeRelative = minVolumeRatio > 0 && isNum(volumeRecent) && isNum(volumeAvg)
    && volumeRecent < volumeAvg * minVolumeRatio;
  if (isLowVolumeAbsolute || isLowVolumeRelative) {
    blockers.push('Low volume');
  }

  // ── 16. Confidence (model max prob) ────────────────────────────
  const upP0 = isNum(signals.modelUp) ? signals.modelUp : null;
  const downP0 = isNum(signals.modelDown) ? signals.modelDown : null;
  const baseMinModelMaxProb = config.minModelMaxProb ?? 0;
  const effectiveMinModelMaxProb = weekendTightening
    ? (config.weekendMinModelMaxProb ?? baseMinModelMaxProb)
    : baseMinModelMaxProb;

  if (effectiveMinModelMaxProb > 0 && upP0 !== null && downP0 !== null) {
    const m = Math.max(upP0, downP0);
    if (m < effectiveMinModelMaxProb) {
      blockers.push(`Low conviction (maxProb ${(m * 100).toFixed(1)}% < ${(effectiveMinModelMaxProb * 100).toFixed(1)}%)`);
    }
  }

  // ── 17. Volatility (rangePct20 chop filter) ────────────────────
  const rangePct20 = signals.indicators?.rangePct20 ?? null;
  const baseMinRangePct20 = config.minRangePct20 ?? 0;
  const effectiveMinRangePct20 = weekendTightening
    ? (config.weekendMinRangePct20 ?? baseMinRangePct20)
    : baseMinRangePct20;

  if (isNum(rangePct20) && effectiveMinRangePct20 > 0 && rangePct20 < effectiveMinRangePct20) {
    blockers.push(`Choppy (range20 ${(rangePct20 * 100).toFixed(2)}% < ${(effectiveMinRangePct20 * 100).toFixed(2)}%)`);
  }

  // ── 18. BTC spot impulse ───────────────────────────────────────
  const minImpulse = config.minBtcImpulsePct1m ?? 0;
  const spotDelta1mPct = signals.spot?.delta1mPct ?? null;

  if (isNum(minImpulse) && minImpulse > 0) {
    if (!(isNum(spotDelta1mPct))) {
      blockers.push('Spot impulse unavailable');
    } else if (Math.abs(spotDelta1mPct) < minImpulse) {
      blockers.push(`Low impulse (spot1m ${(spotDelta1mPct * 100).toFixed(3)}% < ${(minImpulse * 100).toFixed(3)}%)`);
    }
  }

  // ── 19. RSI regime filter ──────────────────────────────────────
  const rsiNow = signals.indicators?.rsiNow ?? null;
  const noTradeRsiMin = config.noTradeRsiMin;
  const noTradeRsiMax = config.noTradeRsiMax;

  if (isNum(rsiNow) && isNum(noTradeRsiMin) && isNum(noTradeRsiMax)) {
    if (rsiNow >= noTradeRsiMin && rsiNow < noTradeRsiMax) {
      blockers.push(`RSI in no-trade band (${rsiNow.toFixed(1)} in [${noTradeRsiMin},${noTradeRsiMax}))`);
    }
  }

  // ── 20. Polymarket price bounds ────────────────────────────────
  const minPoly = config.minPolyPrice ?? 0.002;
  const maxPoly = config.maxPolyPrice ?? 0.98;

  if (!isNum(currentPolyPrice) || currentPolyPrice < minPoly || currentPolyPrice > maxPoly) {
    blockers.push(`Poly price out of bounds (${((currentPolyPrice ?? NaN) * 100).toFixed(2)}¢)`);
  }

  // ── 21. Entry price cap ────────────────────────────────────────
  const maxEntryPx = config.maxEntryPolyPrice ?? null;
  if (isNum(maxEntryPx) && isNum(currentPolyPrice) && currentPolyPrice > maxEntryPx) {
    blockers.push(`Entry price too high (${(currentPolyPrice * 100).toFixed(2)}¢ > ${(maxEntryPx * 100).toFixed(2)}¢)`);
  }

  // ── 22. Opposite side sanity ───────────────────────────────────
  const minOpp = config.minOppositePolyPrice ?? 0;
  if (isNum(minOpp) && minOpp > 0) {
    const oppSide = effectiveSide === 'UP' ? 'DOWN' : 'UP';
    const oppPx = effectivePolyPrices[oppSide] ?? signals.polyPrices?.[oppSide] ?? null;
    if (isNum(oppPx) && oppPx < minOpp) {
      blockers.push(`Opposite price too low (${oppSide} ${(oppPx * 100).toFixed(2)}¢ < ${(minOpp * 100).toFixed(2)}¢)`);
    }
  }

  // ── 23. Phase-based thresholds ─────────────────────────────────
  const phase = rec?.phase;
  if (phase && rec?.side) {
    const { minProb, edgeThreshold } = computeEffectiveThresholds(
      config, isWeekend, phase, sideInferred, strictRec,
    );

    const modelProb = effectiveSide === 'UP' ? signals.modelUp : signals.modelDown;
    const edge = rec?.edge ?? 0;

    if (isNum(modelProb) && modelProb < minProb) {
      blockers.push(`Prob ${modelProb.toFixed(3)} < ${minProb}`);
    }
    if ((edge || 0) < edgeThreshold) {
      blockers.push(`Edge ${(edge || 0).toFixed(3)} < ${edgeThreshold}`);
    }
  }

  // ── 24. Circuit breaker (consecutive losses) ─────────────────
  const cbMaxLosses = config.circuitBreakerConsecutiveLosses ?? 0;
  const cbCooldownMs = config.circuitBreakerCooldownMs ?? 5 * 60_000;

  if (cbMaxLosses > 0 && typeof state.checkCircuitBreaker === 'function') {
    const cb = state.checkCircuitBreaker(cbMaxLosses, cbCooldownMs);
    if (cb.tripped) {
      blockers.push(`Circuit breaker (${cbMaxLosses} losses, ${(cb.remaining / 1000).toFixed(0)}s left)`);
    }
  }

  // ── 25. Daily loss kill-switch (was live-only, now unified) ────
  const maxDailyLossUsd = config.maxDailyLossUsd ?? null;
  if (isNum(maxDailyLossUsd) && maxDailyLossUsd > 0 && isNum(state.todayRealizedPnl)) {
    if (state.todayRealizedPnl <= -Math.abs(maxDailyLossUsd)) {
      blockers.push(`Daily loss kill-switch hit ($${state.todayRealizedPnl.toFixed(2)} <= -$${Math.abs(maxDailyLossUsd).toFixed(2)})`);
    }
  }

  return { blockers, effectiveSide, sideInferred };
}
