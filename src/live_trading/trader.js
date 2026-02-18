import { CONFIG } from '../config.js';
import { getClobClient } from './clob.js';
import { appendLiveTrade, initializeLiveLedger } from './ledger.js';
import { OrderType } from '@polymarket/clob-client';
import { fetchClobPrice } from '../data/polymarket.js';
import { computePositionsFromTrades, enrichPositionsWithMarks } from './positions.js';
import { computeRealizedPnlAvgCost } from './pnl.js';

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function pickTokenId(market, label) {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : JSON.parse(market?.outcomes || '[]');
  const clobTokenIds = Array.isArray(market?.clobTokenIds) ? market.clobTokenIds : JSON.parse(market?.clobTokenIds || '[]');
  for (let i = 0; i < outcomes.length; i += 1) {
    if (String(outcomes[i]).toLowerCase() === String(label).toLowerCase()) {
      const tid = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
      if (tid) return tid;
    }
  }
  return null;
}

export class LiveTrader {
  constructor() {
    this.client = getClobClient();

    // open *order* we placed (may fill quickly, so open order can be null even when positions exist)
    this.open = null;

    // trailing PnL state by tokenID
    this.maxUnrealizedByToken = new Map();

    // Exit spam guard
    this._lastExitAttemptMsByToken = new Map();

    // Paper-parity entry/exit guards
    this.lastLossAtMs = null;
    this.lastWinAtMs = null;
    this.skipMarketUntilNextSlug = null;

    // Max-loss grace state (per tokenID)
    this._maxLossBreachAtMsByToken = new Map();
    this._maxLossGraceUsedByToken = new Map();

    // daily realized PnL (avg cost, best-effort)
    this.todayRealizedPnl = 0;
    this.todayKey = null;

    // throttle expensive calls
    this._lastTradesFetchMs = 0;
    this._cachedTrades = [];
  }

  async init() {
    await initializeLiveLedger();
  }

  // Midnight PT reset key
  _todayKey() {
    const d = new Date();
    // America/Los_Angeles is host timezone
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  _resetIfNeeded() {
    const k = this._todayKey();
    if (this.todayKey !== k) {
      this.todayKey = k;
      this.todayRealizedPnl = 0;
    }
  }

  async _collateralUsd() {
    const bal = await this.client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const base = Number(bal?.balance || 0);
    // 6 decimals
    return base / 1e6;
  }

  async processSignals(signals) {
    this._resetIfNeeded();

    if (!CONFIG.liveTrading?.enabled) return;

    const setEntryStatus = (blockers = []) => {
      this.lastEntryStatus = {
        at: new Date().toISOString(),
        eligible: blockers.length === 0,
        blockers
      };
    };

    const market = signals?.market;
    const marketSlug = market?.slug;
    const timeLeftMin = signals?.timeLeftMin;

    // Prefer Polymarket settlement timer (endDate) for exits; candle-window timeLeftMin can drift.
    const endDate = signals?.polyMarketSnapshot?.market?.endDate || market?.endDate || null;
    const settlementLeftMin = endDate ? ((new Date(endDate).getTime() - Date.now()) / 60000) : null;
    const timeLeftForExit = (typeof settlementLeftMin === 'number' && Number.isFinite(settlementLeftMin)) ? settlementLeftMin : timeLeftMin;

    if (!market || !marketSlug) {
      setEntryStatus(['No market loaded']);
      return;
    }

    // Pull trades periodically (used to infer positions + realized PnL)
    const now = Date.now();
    if (now - this._lastTradesFetchMs > 5_000) {
      try {
        this._cachedTrades = await this.client.getTrades();
        this._lastTradesFetchMs = now;
      } catch {
        // keep old cache
      }
    }

    // Only manage positions for the CURRENT live market tokens (prevents trying to sell old/expired tokens).
    const upTokenId = pickTokenId(market, CONFIG.polymarket.upOutcomeLabel);
    const downTokenId = pickTokenId(market, CONFIG.polymarket.downOutcomeLabel);
    const allowedTokenIDs = new Set([upTokenId, downTokenId].filter(Boolean));

    const allPositions = await enrichPositionsWithMarks(computePositionsFromTrades(this._cachedTrades));
    const positions = allPositions.filter((p) => allowedTokenIDs.has(p.tokenID));

    // Update daily realized PnL (avg-cost, best-effort)
    // NOTE: CLOB returns trades across days; compute today's realized using match_time day bucket.
    const tz = 'America/Los_Angeles';
    const dayKeyFromEpochSec = (epochSec) => {
      const d = new Date(Number(epochSec) * 1000);
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    };
    const todayKey = dayKeyFromEpochSec(Math.floor(Date.now() / 1000));
    const tradesToday = (Array.isArray(this._cachedTrades) ? this._cachedTrades : []).filter(t => {
      const mt = Number(t?.match_time || 0);
      if (!mt) return false;
      if (dayKeyFromEpochSec(mt) !== todayKey) return false;
      return true;
    });
    const pnlToday = computeRealizedPnlAvgCost(tradesToday);
    const baseline = Number(CONFIG.liveTrading?.dailyLossBaselineUsd ?? 0) || 0;
    this.todayRealizedPnl = (pnlToday.realizedTotal || 0) - baseline;

    // Daily loss kill-switch
    if (this.todayRealizedPnl <= -Math.abs(CONFIG.liveTrading.maxDailyLossUsd || 0)) {
      setEntryStatus([`Daily loss kill-switch hit ($${this.todayRealizedPnl.toFixed(2)} <= -$${Math.abs(CONFIG.liveTrading.maxDailyLossUsd || 0).toFixed(2)})`]);
      return;
    }

    // --- EXIT LOGIC (fill-now exits) ---
    // If we have any position, we manage exits first.
    if (positions.length) {
      setEntryStatus(['Position open']);
      const exitBefore = CONFIG.paperTrading.exitBeforeEndMinutes ?? 1;

      for (const p of positions) {
        const tokenID = p.tokenID;
        const qty = Number(p.qty || 0);
        if (!tokenID || !isNum(qty) || qty <= 0) continue;

        const u = (typeof p.unrealizedPnl === 'number' && Number.isFinite(p.unrealizedPnl)) ? p.unrealizedPnl : null;

        // Track MFE for trailing exits
        if (u !== null) {
          const prevMax = this.maxUnrealizedByToken.get(tokenID) ?? u;
          this.maxUnrealizedByToken.set(tokenID, Math.max(prevMax, u));
        }

        // 1) Pre-settlement exit
        if (isNum(timeLeftForExit) && timeLeftForExit <= exitBefore) {
          this.lastWinAtMs = Date.now();
          await this._sellPosition({ tokenID, qty, reason: 'Pre-settlement Exit' });
          continue;
        }

        // 2) Rollover exit (position token should be tied to a market; best-effort: if market slug changes, still ok)
        // (We don't have per-position slug mapping here; rely on pre-settlement mostly.)

        // 3) Hard max loss cap (with optional grace window)
        const maxLossUsd = CONFIG.paperTrading.maxLossUsdPerTrade ?? 15;
        const graceEnabled = CONFIG.paperTrading.maxLossGraceEnabled ?? false;
        const graceSeconds = CONFIG.paperTrading.maxLossGraceSeconds ?? 0;
        const recoverUsd = CONFIG.paperTrading.maxLossRecoverUsd ?? null;
        const requireModelSupport = CONFIG.paperTrading.maxLossGraceRequireModelSupport ?? false;

        if (u !== null && typeof maxLossUsd === 'number' && Number.isFinite(maxLossUsd) && maxLossUsd > 0) {
          const maxLossAbs = Math.abs(maxLossUsd);
          const breached = u <= -maxLossAbs;

          // model support: require side prob >= 0.55 and >= opposite
          const isUp = String(p.outcome || '').toLowerCase() === 'up';
          const sideProb = isUp ? signals.modelUp : signals.modelDown;
          const oppProb = isUp ? signals.modelDown : signals.modelUp;
          const modelSupports = (typeof sideProb === 'number' && Number.isFinite(sideProb) && typeof oppProb === 'number' && Number.isFinite(oppProb))
            ? (sideProb >= 0.55 && sideProb >= oppProb)
            : false;

          // don't grace near settlement
          const exitBeforeEndMin = CONFIG.paperTrading.exitBeforeEndMinutes ?? 1;
          const okTime = (typeof timeLeftForExit === 'number' && Number.isFinite(timeLeftForExit))
            ? (timeLeftForExit >= exitBeforeEndMin + 0.25)
            : true;

          // don't grace in obvious bad liquidity
          const liqNum = Number(signals?.market?.liquidityNum ?? NaN);
          const minLiq = Number(CONFIG.paperTrading.minLiquidity ?? 0);
          const isLowLiquidity = (Number.isFinite(minLiq) && minLiq > 0) ? (!(Number.isFinite(liqNum) && liqNum >= minLiq)) : false;

          const okForGrace = Boolean(
            graceEnabled &&
            Number.isFinite(graceSeconds) && graceSeconds > 0 &&
            okTime &&
            !isLowLiquidity &&
            (!requireModelSupport || modelSupports)
          );

          const recoverThresh = (typeof recoverUsd === 'number' && Number.isFinite(recoverUsd) && recoverUsd > 0)
            ? -Math.abs(recoverUsd)
            : (-maxLossAbs + 1);

          // If we're in grace and we recovered enough, cancel pending stop
          const breachAt = this._maxLossBreachAtMsByToken.get(tokenID) ?? null;
          if (breachAt && u > recoverThresh) {
            this._maxLossBreachAtMsByToken.delete(tokenID);
          }

          if (breached) {
            if (okForGrace) {
              const used = Boolean(this._maxLossGraceUsedByToken.get(tokenID));
              if (!used && !breachAt) {
                this._maxLossBreachAtMsByToken.set(tokenID, Date.now());
                this._maxLossGraceUsedByToken.set(tokenID, true);
              }

              const started = this._maxLossBreachAtMsByToken.get(tokenID) ?? null;
              if (started) {
                const elapsed = Date.now() - started;
                if (elapsed >= graceSeconds * 1000) {
                  this.lastLossAtMs = Date.now();
                  if (CONFIG.paperTrading.skipMarketAfterMaxLoss) this.skipMarketUntilNextSlug = marketSlug;
                  await this._sellPosition({ tokenID, qty, reason: `Max Loss ($${maxLossAbs.toFixed(2)})` });
                  continue;
                }
                // still within grace: do nothing this loop
              } else {
                // If we can't track breach time, fall back to exiting
                this.lastLossAtMs = Date.now();
                if (CONFIG.paperTrading.skipMarketAfterMaxLoss) this.skipMarketUntilNextSlug = marketSlug;
                await this._sellPosition({ tokenID, qty, reason: `Max Loss ($${maxLossAbs.toFixed(2)})` });
                continue;
              }
            } else {
              // no grace: exit immediately
              this.lastLossAtMs = Date.now();
              if (CONFIG.paperTrading.skipMarketAfterMaxLoss) this.skipMarketUntilNextSlug = marketSlug;
              await this._sellPosition({ tokenID, qty, reason: `Max Loss ($${maxLossAbs.toFixed(2)})` });
              continue;
            }
          }
        }

        // 4) High-price take-profit (regardless of time left)
        const tpPrice = CONFIG.liveTrading?.takeProfitPrice;
        if (isNum(tpPrice) && isNum(p.mark) && p.mark >= tpPrice) {
          this.lastWinAtMs = Date.now();
          await this._sellPosition({ tokenID, qty, reason: `Take Profit (mark >= ${(tpPrice * 100).toFixed(0)}¢)` });
          continue;
        }

        // 5) Time stop (paper parity): if a position can't go green within N seconds, cut it.
        const maxHoldSec = CONFIG.paperTrading.loserMaxHoldSeconds ?? 120;
        const lastTradeTimeSec = Number(p.lastTradeTime || 0);
        const nowSec = Math.floor(Date.now() / 1000);
        if (
          isNum(maxHoldSec) &&
          lastTradeTimeSec > 0 &&
          (nowSec - lastTradeTimeSec) >= maxHoldSec &&
          u !== null &&
          u <= 0
        ) {
          this.lastLossAtMs = Date.now();
          await this._sellPosition({ tokenID, qty, reason: `Time Stop (${Number(maxHoldSec).toFixed(0)}s)` });
          continue;
        }

        // 6) Trailing TP
        if (u !== null && (CONFIG.paperTrading.trailingTakeProfitEnabled ?? false)) {
          const start = CONFIG.paperTrading.trailingStartUsd ?? 20;
          const dd = CONFIG.paperTrading.trailingDrawdownUsd ?? 10;
          const maxU = this.maxUnrealizedByToken.get(tokenID) ?? null;
          if (isNum(start) && isNum(dd) && maxU !== null && maxU >= start) {
            const trail = maxU - dd;
            if (u <= trail) {
              this.lastWinAtMs = Date.now();
              await this._sellPosition({ tokenID, qty, reason: `Trailing TP (max $${maxU.toFixed(2)}; dd $${dd.toFixed(2)})` });
              continue;
            }
          }
        }
      }

      // If we have positions, do not enter new ones.
      return;
    }

    // From here on, compute entry blockers like paper and expose them in /api/status.
    const blockers = [];

    // --- ENTRY LOGIC (paper-parity gating) ---
    const rec = signals?.rec;
    if (!rec) {
      blockers.push('No rec');
      setEntryStatus(blockers);
      return;
    }

    const strictRec = String(CONFIG.paperTrading?.recGating || 'loose').toLowerCase() === 'strict';
    const wantsEnter = (rec.action === 'ENTER') || !strictRec;
    if (!wantsEnter) {
      blockers.push(`Rec=${rec.action || 'NONE'} (strict)`);
      setEntryStatus(blockers);
      return;
    }

    // Prefer Polymarket settlement timer for entry timing too.
    const timeLeftForEntry = (typeof settlementLeftMin === 'number' && Number.isFinite(settlementLeftMin)) ? settlementLeftMin : timeLeftMin;

    // Too late to enter
    const noEntryFinal = CONFIG.paperTrading.noEntryFinalMinutes ?? 1.5;
    const isTooLateToEnter = (typeof timeLeftForEntry === 'number' && Number.isFinite(timeLeftForEntry))
      ? (timeLeftForEntry < noEntryFinal)
      : false;
    if (isTooLateToEnter) {
      blockers.push(`Too late (<${noEntryFinal}m to settlement)`);
      setEntryStatus(blockers);
      return;
    }

    // Cooldowns
    const lossCooldownSec = CONFIG.paperTrading.lossCooldownSeconds ?? 0;
    const winCooldownSec = CONFIG.paperTrading.winCooldownSeconds ?? 0;
    const inLossCooldown = (lossCooldownSec > 0 && this.lastLossAtMs) ? ((Date.now() - this.lastLossAtMs) < (lossCooldownSec * 1000)) : false;
    const inWinCooldown = (winCooldownSec > 0 && this.lastWinAtMs) ? ((Date.now() - this.lastWinAtMs) < (winCooldownSec * 1000)) : false;
    if (inLossCooldown || inWinCooldown) {
      if (inLossCooldown) blockers.push(`Loss cooldown (${lossCooldownSec}s)`);
      if (inWinCooldown) blockers.push(`Win cooldown (${winCooldownSec}s)`);
      setEntryStatus(blockers);
      return;
    }

    // Skip this market after a max-loss stop until next slug
    const skipAfterMaxLoss = CONFIG.paperTrading.skipMarketAfterMaxLoss ?? false;
    const inSkipMarket = Boolean(skipAfterMaxLoss && this.skipMarketUntilNextSlug && marketSlug && this.skipMarketUntilNextSlug === marketSlug);
    if (inSkipMarket) {
      blockers.push('Skip market after Max Loss (wait for next 5m)');
      setEntryStatus(blockers);
      return;
    }

    // Warmup/indicator readiness
    const candleCount = signals?.indicators?.candleCount ?? signals?.indicators?.candles1mCount ?? signals?.indicators?.closesCount ?? null;
    const minCandles = CONFIG.paperTrading.minCandlesForEntry ?? 12;
    // If candleCount isn't provided, fall back to UI runtime candleCount via signals.kline presence.
    const effectiveCandleCount = (typeof candleCount === 'number' && Number.isFinite(candleCount)) ? candleCount : null;
    if (effectiveCandleCount !== null && effectiveCandleCount < minCandles) {
      blockers.push(`Warmup: candles ${effectiveCandleCount}/${minCandles}`);
      setEntryStatus(blockers);
      return;
    }

    const ind = signals.indicators ?? {};
    const hasRsi = typeof ind.rsiNow === 'number' && Number.isFinite(ind.rsiNow);
    const hasVwap = typeof ind.vwapNow === 'number' && Number.isFinite(ind.vwapNow);
    const hasVwapSlope = typeof ind.vwapSlope === 'number' && Number.isFinite(ind.vwapSlope);
    const hasMacd = typeof ind.macd?.hist === 'number' && Number.isFinite(ind.macd.hist);
    const hasHeiken = typeof ind.heikenColor === 'string' && ind.heikenColor.length > 0 && typeof ind.heikenCount === 'number' && Number.isFinite(ind.heikenCount);
    const indicatorsPopulated = hasRsi && hasVwap && hasVwapSlope && hasMacd && hasHeiken;
    if (!indicatorsPopulated) {
      blockers.push('Indicators not ready');
      setEntryStatus(blockers);
      return;
    }

    // Weekend tightening + schedule
    const weekdaysOnly = CONFIG.paperTrading.weekdaysOnly ?? false;
    const allowSundayAfterHour = CONFIG.paperTrading.allowSundayAfterHour ?? -1;
    const noEntryAfterFridayHour = CONFIG.paperTrading.noEntryAfterFridayHour ?? -1;
    const nowDt = new Date();
    const wd = nowDt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
    const hour = Number(nowDt.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Los_Angeles' }));
    const isWeekend = (wd === 'Sat' || wd === 'Sun');
    const isSundayAllowed = (wd === 'Sun' && Number.isFinite(allowSundayAfterHour) && allowSundayAfterHour >= 0 && hour >= allowSundayAfterHour);
    const isFridayAfter = (wd === 'Fri' && Number.isFinite(noEntryAfterFridayHour) && noEntryAfterFridayHour >= 0 && hour >= noEntryAfterFridayHour);
    if (weekdaysOnly && ((isWeekend && !isSundayAllowed) || isFridayAfter)) {
      blockers.push('Outside schedule (weekdays only / Friday cutoff)');
      setEntryStatus(blockers);
      return;
    }

    const weekendTightening = Boolean(CONFIG.paperTrading.weekendTighteningEnabled ?? true) && isWeekend;

    // Market quality: liquidity + spread
    const mkt = signals.market;
    const liq = Number(mkt?.liquidityNum ?? NaN);
    const minLiq = weekendTightening ? (CONFIG.paperTrading.weekendMinLiquidity ?? CONFIG.paperTrading.minLiquidity) : (CONFIG.paperTrading.minLiquidity ?? 0);
    if (Number.isFinite(minLiq) && minLiq > 0) {
      if (!(Number.isFinite(liq) && liq >= minLiq)) {
        blockers.push(`Low liquidity (<${minLiq})`);
        setEntryStatus(blockers);
        return;
      }
    }

    const spreadUp = signals.polyMarketSnapshot?.orderbook?.up?.spread ?? null;
    const spreadDown = signals.polyMarketSnapshot?.orderbook?.down?.spread ?? null;
    const maxSpread = weekendTightening ? (CONFIG.paperTrading.weekendMaxSpread ?? CONFIG.paperTrading.maxSpread) : (CONFIG.paperTrading.maxSpread ?? null);

    const side = rec.side;
    const currentSpread = side === 'DOWN' ? spreadDown : spreadUp;
    if (typeof maxSpread === 'number' && Number.isFinite(maxSpread) && typeof currentSpread === 'number' && Number.isFinite(currentSpread)) {
      if (currentSpread > maxSpread) {
        blockers.push('High spread');
        setEntryStatus(blockers);
        return;
      }
    }

    // Confidence + chop + impulse + RSI band
    const upP0 = (typeof signals.modelUp === 'number') ? signals.modelUp : null;
    const downP0 = (typeof signals.modelDown === 'number') ? signals.modelDown : null;
    const baseMinModelMaxProb = CONFIG.paperTrading.minModelMaxProb ?? 0;
    const effectiveMinModelMaxProb = weekendTightening ? (CONFIG.paperTrading.weekendMinModelMaxProb ?? baseMinModelMaxProb) : baseMinModelMaxProb;
    if (effectiveMinModelMaxProb > 0 && upP0 !== null && downP0 !== null) {
      const m = Math.max(upP0, downP0);
      if (m < effectiveMinModelMaxProb) {
        blockers.push(`Low conviction (maxProb ${(m * 100).toFixed(1)}% < ${(effectiveMinModelMaxProb * 100).toFixed(1)}%)`);
        setEntryStatus(blockers);
        return;
      }
    }

    const rangePct20 = signals.indicators?.rangePct20 ?? null;
    const baseMinRangePct20 = CONFIG.paperTrading.minRangePct20 ?? 0;
    const effectiveMinRangePct20 = weekendTightening ? (CONFIG.paperTrading.weekendMinRangePct20 ?? baseMinRangePct20) : baseMinRangePct20;
    if (typeof rangePct20 === 'number' && Number.isFinite(rangePct20) && effectiveMinRangePct20 > 0 && rangePct20 < effectiveMinRangePct20) {
      blockers.push(`Choppy (range20 ${(rangePct20 * 100).toFixed(2)}% < ${(effectiveMinRangePct20 * 100).toFixed(2)}%)`);
      setEntryStatus(blockers);
      return;
    }

    const minImpulse = CONFIG.paperTrading.minBtcImpulsePct1m ?? 0;
    const spotDelta1mPct = signals.spot?.delta1mPct ?? null;
    if (typeof minImpulse === 'number' && Number.isFinite(minImpulse) && minImpulse > 0) {
      if (!(typeof spotDelta1mPct === 'number' && Number.isFinite(spotDelta1mPct) && Math.abs(spotDelta1mPct) >= minImpulse)) {
        blockers.push('Low impulse');
        setEntryStatus(blockers);
        return;
      }
    }

    const rsiNow = signals.indicators?.rsiNow ?? null;
    const noTradeRsiMin = CONFIG.paperTrading.noTradeRsiMin;
    const noTradeRsiMax = CONFIG.paperTrading.noTradeRsiMax;
    if (typeof rsiNow === 'number' && Number.isFinite(rsiNow) && Number.isFinite(noTradeRsiMin) && Number.isFinite(noTradeRsiMax)) {
      if (rsiNow >= noTradeRsiMin && rsiNow < noTradeRsiMax) {
        blockers.push(`RSI in no-trade band (${rsiNow.toFixed(1)} in [${noTradeRsiMin},${noTradeRsiMax}))`);
        setEntryStatus(blockers);
        return;
      }
    }

    // Polymarket price sanity + profitability cap
    const currentPolyPrice = side === 'DOWN' ? signals.polyPrices?.DOWN : signals.polyPrices?.UP;
    const minPoly = CONFIG.paperTrading.minPolyPrice ?? 0.002;
    const maxPoly = CONFIG.paperTrading.maxPolyPrice ?? 0.98;
    if (!(typeof currentPolyPrice === 'number' && Number.isFinite(currentPolyPrice) && currentPolyPrice >= minPoly && currentPolyPrice <= maxPoly)) {
      blockers.push(`Poly price out of bounds (${(currentPolyPrice ?? NaN) * 100}¢)`);
      setEntryStatus(blockers);
      return;
    }

    const maxEntryPx = CONFIG.paperTrading.maxEntryPolyPrice ?? null;
    if (typeof maxEntryPx === 'number' && Number.isFinite(maxEntryPx) && currentPolyPrice > maxEntryPx) {
      blockers.push(`Entry price too high (${(currentPolyPrice * 100).toFixed(2)}¢ > ${(maxEntryPx * 100).toFixed(2)}¢)`);
      setEntryStatus(blockers);
      return;
    }

    const minOpp = CONFIG.paperTrading.minOppositePolyPrice ?? 0;
    if (typeof minOpp === 'number' && Number.isFinite(minOpp) && minOpp > 0) {
      const oppPx = side === 'DOWN' ? signals.polyPrices?.UP : signals.polyPrices?.DOWN;
      if (typeof oppPx === 'number' && Number.isFinite(oppPx) && oppPx < minOpp) {
        blockers.push(`Opposite price too low (${(oppPx * 100).toFixed(2)}¢ < ${(minOpp * 100).toFixed(2)}¢)`);
        setEntryStatus(blockers);
        return;
      }
    }

    // Thresholds (phase-based) — match paper.
    const phase = rec.phase;
    let minProbReq, edgeReq;
    if (phase === 'EARLY') { minProbReq = CONFIG.paperTrading.minProbEarly; edgeReq = CONFIG.paperTrading.edgeEarly; }
    else if (phase === 'MID') { minProbReq = CONFIG.paperTrading.minProbMid; edgeReq = CONFIG.paperTrading.edgeMid; }
    else { minProbReq = CONFIG.paperTrading.minProbLate; edgeReq = CONFIG.paperTrading.edgeLate; }

    if (weekendTightening) {
      minProbReq += (CONFIG.paperTrading.weekendProbBoost ?? 0);
      edgeReq += (CONFIG.paperTrading.weekendEdgeBoost ?? 0);
    }
    if (phase === 'MID') {
      minProbReq += (CONFIG.paperTrading.midProbBoost ?? 0);
      edgeReq += (CONFIG.paperTrading.midEdgeBoost ?? 0);
    }

    const modelProb = side === 'DOWN' ? signals.modelDown : signals.modelUp;
    const edge = rec.edge ?? 0;
    if (!(typeof modelProb === 'number' && Number.isFinite(modelProb) && modelProb >= minProbReq)) {
      blockers.push(`Prob ${modelProb?.toFixed ? modelProb.toFixed(3) : modelProb} < ${minProbReq}`);
      setEntryStatus(blockers);
      return;
    }
    if (!((edge || 0) >= edgeReq)) {
      blockers.push(`Edge ${(edge || 0).toFixed(3)} < ${edgeReq}`);
      setEntryStatus(blockers);
      return;
    }

    const tokenID = side === 'DOWN' ? downTokenId : upTokenId;
    if (!tokenID) {
      blockers.push('No tokenID for outcome');
      setEntryStatus(blockers);
      return;
    }

    // Eligible
    setEntryStatus([]);

    // Sizing
    const collateral = await this._collateralUsd();
    const maxPer = CONFIG.liveTrading.maxPerTradeUsd || 0;
    const usd = Math.min(maxPer, collateral, CONFIG.liveTrading.maxOpenExposureUsd || maxPer);
    if (!isNum(usd) || usd <= 0) return;

    // Price (BUY)
    let price = null;
    try {
      price = await fetchClobPrice({ tokenId: tokenID, side: 'buy' });
    } catch {
      price = null;
    }
    if (!isNum(price) || price <= 0) return;

    const size = Math.max(5, Math.floor(usd / price));

    try {
      const resp = await this.client.createAndPostOrder(
        { tokenID, price, size, side: 'BUY' },
        {},
        OrderType.GTC,
        false,
        Boolean(CONFIG.liveTrading.postOnly)
      );

      this.open = {
        openedAt: new Date().toISOString(),
        marketSlug,
        side,
        tokenID,
        price,
        size,
        orderID: resp?.orderID || null,
      };

      await appendLiveTrade({
        type: 'OPEN',
        ts: new Date().toISOString(),
        marketSlug,
        side,
        tokenID,
        price,
        size,
        usdNotional: price * size,
        orderID: resp?.orderID || null,
        resp,
      });
    } catch (e) {
      await appendLiveTrade({
        type: 'OPEN_FAILED',
        ts: new Date().toISOString(),
        marketSlug,
        side,
        tokenID,
        error: e?.response?.data || e?.message || String(e)
      });
    }
  }

  async _sellPosition({ tokenID, qty, reason }) {
    let size = Math.max(5, Math.floor(Number(qty)));

    // Cooldown to avoid spamming SELL attempts when allowance/balance is missing.
    const cooldownMs = 30_000;
    const now = Date.now();
    const last = this._lastExitAttemptMsByToken.get(tokenID) ?? 0;
    if (now - last < cooldownMs) return null;
    this._lastExitAttemptMsByToken.set(tokenID, now);

    // Ensure conditional token balance/allowance is sufficient for SELL.
    // NOTE: CLOB uses separate conditional token approvals.
    try {
      let ba = await this.client.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenID });
      let allowance = Number(ba?.allowance ?? 0);
      let balance = Number(ba?.balance ?? 0);

      if (!Number.isFinite(allowance) || allowance <= 0) {
        await this.client.updateBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenID });
        // re-fetch best-effort
        ba = await this.client.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenID });
        allowance = Number(ba?.allowance ?? 0);
        balance = Number(ba?.balance ?? 0);
      }

      // Reduce size to what we can actually sell
      const maxSell = Math.floor(Math.min(
        Number.isFinite(balance) ? balance : 0,
        Number.isFinite(allowance) ? allowance : 0,
        size
      ));

      if (maxSell < 5) {
        await appendLiveTrade({
          type: 'EXIT_SELL_SKIPPED',
          ts: new Date().toISOString(),
          tokenID,
          reason,
          note: `Insufficient conditional balance/allowance (bal=${balance}, allow=${allowance})`
        });
        return null;
      }

      // overwrite local sell size
      size = maxSell;
    } catch {
      // best-effort; proceed
    }

    // "fill-now" exit: use current sell quote (best bid) as a marketable limit.
    let price = null;
    try {
      price = await fetchClobPrice({ tokenId: tokenID, side: 'sell' });
    } catch {
      price = null;
    }
    if (!isNum(price) || price <= 0) {
      // fallback to something that will almost certainly fill
      price = 0.01;
    }

    try {
      const resp = await this.client.createAndPostOrder(
        { tokenID, price, size, side: 'SELL' },
        {},
        OrderType.GTC,
        false,
        false // postOnly OFF for exits
      );

      await appendLiveTrade({
        type: 'EXIT_SELL',
        ts: new Date().toISOString(),
        tokenID,
        price,
        size,
        reason,
        resp
      });

      // Reset trailing + max-loss grace state so we don't re-trigger exits
      this.maxUnrealizedByToken.delete(tokenID);
      this._maxLossBreachAtMsByToken.delete(tokenID);
      this._maxLossGraceUsedByToken.delete(tokenID);
      this.open = null;

      return resp;
    } catch (e) {
      await appendLiveTrade({
        type: 'EXIT_SELL_FAILED',
        ts: new Date().toISOString(),
        tokenID,
        price,
        size,
        reason,
        error: e?.response?.data || e?.message || String(e)
      });
      return null;
    }
  }

  async _close(reason) {
    if (!this.open) return;

    // Cancel open order (if any)
    const { orderID } = this.open;
    if (orderID) {
      try {
        const resp = await this.client.cancelOrder({ orderID });
        await appendLiveTrade({ type: 'CANCEL', ts: new Date().toISOString(), orderID, reason, resp });
      } catch (e) {
        await appendLiveTrade({ type: 'CANCEL_FAILED', ts: new Date().toISOString(), orderID, reason, error: e?.response?.data || e?.message || String(e) });
      }
    }

    this.open = null;
  }
}

let singleton = null;
export async function initializeLiveTrader() {
  if (!singleton) {
    singleton = new LiveTrader();
    await singleton.init();
  }
  return singleton;
}

export function getLiveTrader() {
  return singleton;
}
