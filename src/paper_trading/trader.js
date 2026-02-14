import { CONFIG } from "../config.js";
import { loadLedger, addTrade, updateTrade, getOpenTrade as ledgerGetOpenTrade, getLedger, recalculateSummary } from "./ledger.js";

// Core trading logic - NO fixed TP/SL, dynamic exits only
export class Trader {
  constructor() {
    this.openTrade = null;
    this.lastFlipAtMs = 0;

    // Debug / UI: why we did or didn't enter on the last check
    this.lastEntryStatus = {
      at: null,
      eligible: false,
      blockers: []
    };
  }

  async initialize() {
    loadLedger();
    this.openTrade = ledgerGetOpenTrade();

    // Guard against corrupted/invalid open trades (e.g., entryPrice 0.00)
    if (this.openTrade) {
      const t = this.openTrade;
      const badPrice = typeof t.entryPrice !== "number" || !Number.isFinite(t.entryPrice) || t.entryPrice <= 0;
      const badShares = t.shares !== null && t.shares !== undefined && (!Number.isFinite(Number(t.shares)) || Number(t.shares) <= 0);
      if (badPrice || badShares) {
        console.warn("Invalid open trade found in ledger; force-closing:", { id: t.id, entryPrice: t.entryPrice, shares: t.shares });
        const forced = {
          ...t,
          status: "CLOSED",
          exitPrice: t.exitPrice ?? null,
          exitTime: new Date().toISOString(),
          pnl: 0,
          exitReason: "Invalid Entry (sanity check)"
        };
        await updateTrade(t.id, forced);
        this.openTrade = null;
      }
    }

    console.log("Trader initialized. Open trade:", this.openTrade ? this.openTrade.id.substring(0, 8) : "None");
  }

  getBalanceSnapshot() {
    const ledger = getLedger();
    const summary = ledger.summary ?? recalculateSummary(ledger.trades ?? []);
    const starting = CONFIG.paperTrading.startingBalance ?? 1000;
    const realized = typeof summary.totalPnL === "number" ? summary.totalPnL : 0;
    const balance = starting + realized;
    return { balance, starting, realized };
  }

  computeContractSizeUsd() {
    const { balance } = this.getBalanceSnapshot();
    if (!Number.isFinite(balance) || balance <= 0) return 0;

    const stakePct = CONFIG.paperTrading.stakePct;
    const useDynamic = typeof stakePct === "number" && Number.isFinite(stakePct) && stakePct > 0;

    const minUsd = CONFIG.paperTrading.minTradeUsd ?? 0;
    const maxUsd = CONFIG.paperTrading.maxTradeUsd ?? Number.POSITIVE_INFINITY;

    let size = useDynamic ? (balance * stakePct) : (CONFIG.paperTrading.contractSize ?? 100);
    size = Math.max(minUsd, Math.min(maxUsd, size));
    size = Math.min(size, balance);

    // round to cents
    size = Math.floor(size * 100) / 100;
    return size;
  }

  async processSignals(signals, klines1m) {
    if (!CONFIG.paperTrading.enabled) return;

    const candleCount = Array.isArray(klines1m) ? klines1m.length : 0;
    const minCandlesForEntry = CONFIG.paperTrading.minCandlesForEntry ?? 30;
    const indicatorsReady = candleCount >= minCandlesForEntry;

    // IMPORTANT: We paper-trade the Polymarket contract, not BTC spot.
    // BTC price/klines are only used for generating the signal.
    const action = signals.rec?.action || "NONE";
    let side = signals.rec?.side;
    let sideInferred = false;
    const timeLeftMin = signals.timeLeftMin;
    const marketSlug = signals.market?.slug || "unknown";

    // Rec gating: strict requires explicit ENTER; loose allows entry if thresholds hit.
    const recGating = String(CONFIG.paperTrading.recGating || "loose");
    const strictRec = recGating === "strict";

    // If we are not in a trade and strict gating is enabled, short-circuit unless Rec=ENTER.
    if (!this.openTrade && strictRec && action !== "ENTER") {
      this.lastEntryStatus = {
        at: new Date().toISOString(),
        eligible: false,
        blockers: [`Rec=${action} (strict)`]
      };
      return;
    }

    // Always populate entry debug, even if we can't trade this tick.
    // This helps the UI show why no trade happened.
    const entryBlockers = [];

    // In loose mode, if the engine doesn't provide a side, infer it from the model probabilities.
    // This keeps paper trading active even when rec.action is conservative.
    if (!side && !strictRec) {
      const upP = typeof signals.modelUp === "number" ? signals.modelUp : null;
      const downP = typeof signals.modelDown === "number" ? signals.modelDown : null;
      if (upP !== null && downP !== null) {
        side = upP >= downP ? "UP" : "DOWN";
        sideInferred = true;
        entryBlockers.push(`Inferred side=${side}`);
      }
    }

    // --- Effective Polymarket prices ---
    // Gamma/derived prices occasionally show 0/1 while the CLOB orderbook has real quotes.
    // For entry + sanity checks, prefer explicit cents, but fall back to orderbook bestAsk/bestBid.
    const poly = signals.polyMarketSnapshot;

    const rawUpC = signals.polyPricesCents?.UP ?? null;
    const rawDownC = signals.polyPricesCents?.DOWN ?? null;

    const obUpAsk = poly?.orderbook?.up?.bestAsk;
    const obUpBid = poly?.orderbook?.up?.bestBid;
    const obDownAsk = poly?.orderbook?.down?.bestAsk;
    const obDownBid = poly?.orderbook?.down?.bestBid;

    const fallbackUpC = (typeof obUpAsk === "number" && Number.isFinite(obUpAsk) && obUpAsk > 0)
      ? (obUpAsk * 100)
      : ((typeof obUpBid === "number" && Number.isFinite(obUpBid) && obUpBid > 0) ? (obUpBid * 100) : null);

    const fallbackDownC = (typeof obDownAsk === "number" && Number.isFinite(obDownAsk) && obDownAsk > 0)
      ? (obDownAsk * 100)
      : ((typeof obDownBid === "number" && Number.isFinite(obDownBid) && obDownBid > 0) ? (obDownBid * 100) : null);

    const upC = (typeof rawUpC === "number" && Number.isFinite(rawUpC) && rawUpC > 0) ? rawUpC : fallbackUpC;
    const downC = (typeof rawDownC === "number" && Number.isFinite(rawDownC) && rawDownC > 0) ? rawDownC : fallbackDownC;

    const upCok = (typeof upC === "number" && Number.isFinite(upC) && upC > 0);
    const downCok = (typeof downC === "number" && Number.isFinite(downC) && downC > 0);
    const polyPricesSane = upCok && downCok;

    const effectivePolyPrices = {
      UP: upCok ? (upC / 100) : null,
      DOWN: downCok ? (downC / 100) : null
    };

    const currentPolyPrice = side ? (effectivePolyPrices?.[side] ?? null) : null; // dollars (0..1)

    const effectivePriceForSide = (s) => {
      if (!s) return null;
      const p = effectivePolyPrices?.[s] ?? null;
      return (typeof p === "number" && Number.isFinite(p) && p > 0) ? p : null;
    };

    if (!side) entryBlockers.push("Missing side");
    if (side && (currentPolyPrice === null || currentPolyPrice === undefined)) entryBlockers.push("Missing Polymarket price");

    if (!side || currentPolyPrice === null) {
      this.lastEntryStatus = {
        at: new Date().toISOString(),
        eligible: false,
        blockers: entryBlockers.length ? entryBlockers : [`Rec=${action}`]
      };
      return;
    }

    // Market quality filters
    const spreadUp = poly?.orderbook?.up?.spread;
    const spreadDown = poly?.orderbook?.down?.spread;

    // Determine weekend (Pacific time) so we can tighten thresholds.
    const partsNow = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const getNow = (t) => partsNow.find(p => p.type === t)?.value;
    const wdNow = getNow('weekday');
    const hourNow = Number(getNow('hour'));
    const isWeekendNow = (wdNow === 'Sat' || wdNow === 'Sun');

    const weekendTightening = (CONFIG.paperTrading.weekendTighteningEnabled ?? false) && isWeekendNow;

    const effectiveMaxSpread = weekendTightening
      ? (CONFIG.paperTrading.weekendMaxSpread ?? CONFIG.paperTrading.maxSpread)
      : CONFIG.paperTrading.maxSpread;

    const hasBadSpread = (spreadUp !== null && spreadUp > effectiveMaxSpread) ||
                         (spreadDown !== null && spreadDown > effectiveMaxSpread);

    const liquidityNum = signals.market?.liquidityNum ?? null;
    const effectiveMinLiquidity = weekendTightening
      ? (CONFIG.paperTrading.weekendMinLiquidity ?? CONFIG.paperTrading.minLiquidity)
      : (CONFIG.paperTrading.minLiquidity ?? 0);
    const minLiquidity = effectiveMinLiquidity;

    // Market data sanity: require liquidity to be a real, positive number.
    const liquidityOk = (typeof liquidityNum === "number" && Number.isFinite(liquidityNum) && liquidityNum > 0);
    const hasLowLiquidity = liquidityOk ? (liquidityNum < minLiquidity) : true;

    // Market volume filter is optional (disabled by default)
    const marketVolumeNum = signals.market?.volumeNum ?? null;
    const minMarketVolumeNum = CONFIG.paperTrading.minMarketVolumeNum ?? 0;
    const hasLowMarketVolume = (typeof marketVolumeNum === "number" && Number.isFinite(marketVolumeNum) && minMarketVolumeNum > 0)
      ? (marketVolumeNum < minMarketVolumeNum)
      : false;

    const isLowLiquidity = hasBadSpread || hasLowLiquidity || hasLowMarketVolume;

    const isTooLateToEnter = timeLeftMin < CONFIG.paperTrading.noEntryFinalMinutes;

    // Weekday-only schedule filter (Pacific time). Exits are handled separately.
    const weekdaysOnly = CONFIG.paperTrading.weekdaysOnly ?? false;
    const noEntryAfterFridayHour = CONFIG.paperTrading.noEntryAfterFridayHour;
    let isOutsideSchedule = false;
    if (weekdaysOnly) {
      const wd = wdNow;
      const hour = hourNow;

      const allowSundayAfterHour = CONFIG.paperTrading.allowSundayAfterHour;
      const isSundayAllowed = (wd === 'Sun' && Number.isFinite(allowSundayAfterHour) && allowSundayAfterHour >= 0 && hour >= allowSundayAfterHour);

      const isWeekend = (wd === 'Sat' || wd === 'Sun');
      const isFridayAfter = (wd === 'Fri' && Number.isFinite(noEntryAfterFridayHour) && noEntryAfterFridayHour >= 0 && hour >= noEntryAfterFridayHour);

      // Outside schedule if it's weekend (unless Sunday exception applies) or after Friday cutoff
      isOutsideSchedule = (isWeekend && !isSundayAllowed) || isFridayAfter;
    }

    // Volume filter
    const volumeRecent = signals.indicators?.volumeRecent ?? null;
    const volumeAvg = signals.indicators?.volumeAvg ?? null;
    const minVolumeRecent = CONFIG.paperTrading.minVolumeRecent ?? 0;
    const minVolumeRatio = CONFIG.paperTrading.minVolumeRatio ?? 0;

    const isLowVolumeAbsolute = (minVolumeRecent > 0) && (volumeRecent !== null) && (volumeRecent < minVolumeRecent);
    const isLowVolumeRelative = (minVolumeRatio > 0) && (volumeRecent !== null) && (volumeAvg !== null) && (volumeRecent < (volumeAvg * minVolumeRatio));
    const isLowVolume = isLowVolumeAbsolute || isLowVolumeRelative;

    // --- ENTRY ---
    // Wait until indicators are warmed up (enough candles)
    const canEnter = indicatorsReady;

    // Require core indicators to be populated (prevents 50/50 / undefined warm states)
    const ind = signals.indicators ?? {};
    const hasRsi = typeof ind.rsiNow === "number" && Number.isFinite(ind.rsiNow);
    const hasVwap = typeof ind.vwapNow === "number" && Number.isFinite(ind.vwapNow);
    const hasVwapSlope = typeof ind.vwapSlope === "number" && Number.isFinite(ind.vwapSlope);
    const hasMacd = typeof ind.macd?.hist === "number" && Number.isFinite(ind.macd.hist);
    const hasHeiken = typeof ind.heikenColor === "string" && ind.heikenColor.length > 0 && typeof ind.heikenCount === "number" && Number.isFinite(ind.heikenCount);
    const indicatorsPopulated = hasRsi && hasVwap && hasVwapSlope && hasMacd && hasHeiken;

    // Build debug blockers for UI
    const blockers = [...entryBlockers];
    if (!canEnter) blockers.push(`Warmup: candles ${candleCount}/${minCandlesForEntry}`);
    if (!indicatorsPopulated) blockers.push("Indicators not ready");
    if (!polyPricesSane) blockers.push("Market data sanity: invalid Polymarket prices (gamma 0/NaN and no valid orderbook quotes)");
    if (this.openTrade) blockers.push("Trade already open");
    if (strictRec && signals.rec?.action !== "ENTER") blockers.push(`Rec=${signals.rec?.action || "NONE"} (strict)`);
    if (!strictRec && signals.rec?.action !== "ENTER") blockers.push(`Rec=${signals.rec?.action || "NONE"} (loose)`);
    if (isTooLateToEnter) blockers.push(`Too late (<${CONFIG.paperTrading.noEntryFinalMinutes}m)`);
    if (hasBadSpread) blockers.push("High spread");
    if (!liquidityOk) blockers.push("Market data sanity: liquidity missing/0");
    if (hasLowLiquidity && liquidityOk) blockers.push(`Low liquidity (<${minLiquidity})`);
    if (hasLowMarketVolume) blockers.push(`Low market volume (<${minMarketVolumeNum})`);
    if (isOutsideSchedule) blockers.push("Outside schedule (weekdays only / Friday cutoff)");

    // Confidence filter: avoid 50/50 model conditions
    const upP0 = typeof signals.modelUp === "number" ? signals.modelUp : null;
    const downP0 = typeof signals.modelDown === "number" ? signals.modelDown : null;
    const baseMinModelMaxProb = CONFIG.paperTrading.minModelMaxProb ?? 0;
    const baseMinRangePct20 = CONFIG.paperTrading.minRangePct20 ?? 0;

    const effectiveMinModelMaxProb = weekendTightening
      ? (CONFIG.paperTrading.weekendMinModelMaxProb ?? baseMinModelMaxProb)
      : baseMinModelMaxProb;

    const effectiveMinRangePct20 = weekendTightening
      ? (CONFIG.paperTrading.weekendMinRangePct20 ?? baseMinRangePct20)
      : baseMinRangePct20;

    if (effectiveMinModelMaxProb > 0 && upP0 !== null && downP0 !== null) {
      const m = Math.max(upP0, downP0);
      if (m < effectiveMinModelMaxProb) {
        blockers.push(`Low conviction (maxProb ${(m * 100).toFixed(1)}% < ${(effectiveMinModelMaxProb * 100).toFixed(1)}%)`);
      }
    }

    // Chop/volatility filter (BTC reference)
    const rangePct20 = signals.indicators?.rangePct20 ?? null;
    if (typeof rangePct20 === "number" && Number.isFinite(rangePct20) && effectiveMinRangePct20 > 0 && rangePct20 < effectiveMinRangePct20) {
      blockers.push(`Choppy (range20 ${(rangePct20 * 100).toFixed(2)}% < ${(effectiveMinRangePct20 * 100).toFixed(2)}%)`);
    }

    // RSI regime filter (avoid empirically bad band)
    const rsiNow = signals.indicators?.rsiNow ?? null;
    const noTradeRsiMin = CONFIG.paperTrading.noTradeRsiMin;
    const noTradeRsiMax = CONFIG.paperTrading.noTradeRsiMax;
    const isBadRsiBand = (typeof rsiNow === "number" && Number.isFinite(rsiNow) && Number.isFinite(noTradeRsiMin) && Number.isFinite(noTradeRsiMax))
      ? (rsiNow >= noTradeRsiMin && rsiNow < noTradeRsiMax)
      : false;
    if (isBadRsiBand) blockers.push(`RSI in no-trade band (${rsiNow.toFixed(1)} in [${noTradeRsiMin},${noTradeRsiMax}))`);

    if (isLowVolume) blockers.push("Low volume");

    // Price sanity blockers
    const minPoly = CONFIG.paperTrading.minPolyPrice ?? 0.002;
    const maxPoly = CONFIG.paperTrading.maxPolyPrice ?? 0.98;
    if (!(typeof currentPolyPrice === "number") || !Number.isFinite(currentPolyPrice) || currentPolyPrice < minPoly || currentPolyPrice > maxPoly) {
      blockers.push(`Poly price out of bounds (${(currentPolyPrice ?? NaN) * 100}¢)`);
    }

    // Opposite-side sanity: avoid markets that are effectively already decided.
    const minOpp = CONFIG.paperTrading.minOppositePolyPrice ?? 0;
    if (minOpp > 0) {
      const oppSide = side === "UP" ? "DOWN" : "UP";
      const oppPx = signals.polyPrices?.[oppSide] ?? null;
      if (typeof oppPx === "number" && Number.isFinite(oppPx) && oppPx < minOpp) {
        blockers.push(`Opposite price too low (${oppSide} ${(oppPx * 100).toFixed(2)}¢ < ${(minOpp * 100).toFixed(2)}¢)`);
      }
    }

    // Threshold blockers
    if (signals.rec?.side) {
      const modelProb = side === "UP" ? signals.modelUp : signals.modelDown;
      const edge = signals.rec?.edge ?? 0;
      const phase = signals.rec?.phase;
      let minProbReq, edgeReq;
      if (phase === "EARLY") { minProbReq = CONFIG.paperTrading.minProbEarly; edgeReq = CONFIG.paperTrading.edgeEarly; }
      else if (phase === "MID") { minProbReq = CONFIG.paperTrading.minProbMid; edgeReq = CONFIG.paperTrading.edgeMid; }
      else { minProbReq = CONFIG.paperTrading.minProbLate; edgeReq = CONFIG.paperTrading.edgeLate; }

      if (typeof modelProb === "number" && Number.isFinite(modelProb) && modelProb < minProbReq) blockers.push(`Prob ${modelProb.toFixed(3)} < ${minProbReq}`);
      if ((edge || 0) < edgeReq) blockers.push(`Edge ${(edge || 0).toFixed(3)} < ${edgeReq}`);
    }

    this.lastEntryStatus = {
      at: new Date().toISOString(),
      eligible: blockers.length === 0,
      blockers
    };

    const recAction = signals.rec?.action || "NONE";
    const wantsEnter = (recAction === "ENTER") || !strictRec;

    // No-trade if volume is below threshold(s)
    if (canEnter && indicatorsPopulated && polyPricesSane && !this.openTrade && wantsEnter && !isTooLateToEnter && !isLowLiquidity && !isLowVolume && !isBadRsiBand) {
      const { phase, edge } = signals.rec;
      
      // Phase-based thresholds
      let minProb, edgeThreshold;
      if (phase === "EARLY") {
        minProb = CONFIG.paperTrading.minProbEarly;
        edgeThreshold = CONFIG.paperTrading.edgeEarly;
      } else if (phase === "MID") {
        minProb = CONFIG.paperTrading.minProbMid;
        edgeThreshold = CONFIG.paperTrading.edgeMid;
      } else {
        minProb = CONFIG.paperTrading.minProbLate;
        edgeThreshold = CONFIG.paperTrading.edgeLate;
      }

      // Weekend tightening: require stronger thresholds
      if (weekendTightening) {
        minProb += (CONFIG.paperTrading.weekendProbBoost ?? 0);
        edgeThreshold += (CONFIG.paperTrading.weekendEdgeBoost ?? 0);
      }

      // Tighten MID entries slightly (analytics: MID was worse than EARLY)
      if (phase === "MID") {
        minProb += (CONFIG.paperTrading.midProbBoost ?? 0);
        edgeThreshold += (CONFIG.paperTrading.midEdgeBoost ?? 0);
      }

      // Tighten inferred-side entries in loose mode
      if (!strictRec && sideInferred) {
        minProb += (CONFIG.paperTrading.inferredProbBoost ?? 0);
        edgeThreshold += (CONFIG.paperTrading.inferredEdgeBoost ?? 0);
      }

      const modelProb = side === "UP" ? signals.modelUp : signals.modelDown;
      const meetsThresholds = modelProb >= minProb && (edge || 0) >= edgeThreshold;

      if (meetsThresholds) {
        // Model: spend $contractSize at entry price; shares = notional / price
        const entryPrice = currentPolyPrice;

        // Sanity guard: never enter at 0 / near-0 prices.
        const minPoly = CONFIG.paperTrading.minPolyPrice ?? 0.001;
        const maxPoly = CONFIG.paperTrading.maxPolyPrice ?? 0.999;
        if (!(typeof entryPrice === "number") || !Number.isFinite(entryPrice) || entryPrice < minPoly || entryPrice > maxPoly) {
          // Skip entry if price is out of bounds
          console.warn(`Skipping entry due to invalid Poly price: side=${side} entryPrice=${entryPrice} min=${minPoly} max=${maxPoly}`);
          return;
        }

        const contractSizeUsd = this.computeContractSizeUsd();
        if (!contractSizeUsd || contractSizeUsd <= 0) {
          console.warn("Skipping entry: no available balance for trade size.");
          return;
        }

        const shares = (entryPrice > 0) ? (contractSizeUsd / entryPrice) : null;
        if (shares === null || !Number.isFinite(shares) || shares <= 0) return;

        const modelProbAtEntry = side === "UP" ? signals.modelUp : signals.modelDown;
        const liquidityAtEntry = signals.market?.liquidityNum ?? null;
        const volumeNumAtEntry = signals.market?.volumeNum ?? null;
        const spreadAtEntry = side === "UP" ? (spreadUp ?? null) : (spreadDown ?? null);

        // Additional entry context for analytics
        const vwapDistAtEntry = signals.indicators?.vwapDist ?? null;
        const vwapSlopeAtEntry = signals.indicators?.vwapSlope ?? null;
        const rsiAtEntry = signals.indicators?.rsiNow ?? null;
        const macdHistAtEntry = signals.indicators?.macd?.hist ?? null;
        const rangePct20AtEntry = signals.indicators?.rangePct20 ?? null;

        this.openTrade = {
          id: Date.now().toString() + Math.random().toString(36).substring(2, 8),
          timestamp: new Date().toISOString(),
          marketSlug,
          side,
          instrument: "POLY",
          entryPrice, // dollars (0..1)
          shares,
          contractSize: contractSizeUsd,
          status: "OPEN",
          entryTime: new Date().toISOString(),
          exitPrice: null,
          exitTime: null,
          pnl: 0,
          entryPhase: phase,
          sideInferred,

          // analytics fields (best-effort)
          timeLeftMinAtEntry: timeLeftMin ?? null,
          modelProbAtEntry: (typeof modelProbAtEntry === "number" && Number.isFinite(modelProbAtEntry)) ? modelProbAtEntry : null,
          edgeAtEntry: (typeof edge === "number" && Number.isFinite(edge)) ? edge : null,
          liquidityAtEntry: (typeof liquidityAtEntry === "number" && Number.isFinite(liquidityAtEntry)) ? liquidityAtEntry : null,
          volumeNumAtEntry: (typeof volumeNumAtEntry === "number" && Number.isFinite(volumeNumAtEntry)) ? volumeNumAtEntry : null,
          spreadAtEntry: (typeof spreadAtEntry === "number" && Number.isFinite(spreadAtEntry)) ? spreadAtEntry : null,
          recActionAtEntry: signals.rec?.action ?? null,

          vwapDistAtEntry: (typeof vwapDistAtEntry === "number" && Number.isFinite(vwapDistAtEntry)) ? vwapDistAtEntry : null,
          vwapSlopeAtEntry: (typeof vwapSlopeAtEntry === "number" && Number.isFinite(vwapSlopeAtEntry)) ? vwapSlopeAtEntry : null,
          rsiAtEntry: (typeof rsiAtEntry === "number" && Number.isFinite(rsiAtEntry)) ? rsiAtEntry : null,
          macdHistAtEntry: (typeof macdHistAtEntry === "number" && Number.isFinite(macdHistAtEntry)) ? macdHistAtEntry : null,
          rangePct20AtEntry: (typeof rangePct20AtEntry === "number" && Number.isFinite(rangePct20AtEntry)) ? rangePct20AtEntry : null,

          // will be updated while trade is open
          maxUnrealizedPnl: 0,
          minUnrealizedPnl: 0
        };
        await addTrade(this.openTrade);
        const { balance } = this.getBalanceSnapshot();
        console.log(`📈 TRADE OPENED (POLY): ${side} @ ${(entryPrice * 100).toFixed(2)}¢ | $${contractSizeUsd} (balance ~$${balance.toFixed(2)})`);
      }
    }

    // --- EXIT ---
    else if (this.openTrade) {
      const trade = this.openTrade;
      let shouldExit = false;
      let exitReason = "";
      let shouldFlip = false;

      // If the Polymarket market rolled to a new slug, close the old trade so it can't get "stuck".
      // Note: we use the current market's contract price as a best-effort mark.
      if (trade.marketSlug && marketSlug && trade.marketSlug !== marketSlug) {
        const exitPrice = effectivePriceForSide(trade.side);
        if (exitPrice !== null) {
          await this.closeTrade(trade, exitPrice, "Market Rollover");
        } else {
          // If we can't fetch a live quote during rollover, force-close at entry to avoid being stuck open.
          await this.closeTrade(trade, trade.entryPrice, "Market Rollover (no quote)");
        }
        return;
      }

      // Current mark-to-market PnL (for stop loss + MFE/MAE tracking)
      const curPx = effectivePriceForSide(trade.side);
      let stopLossHit = false;
      let pnlNow = null;
      if (curPx !== null) {
        const sharesNow = (typeof trade.shares === "number" && Number.isFinite(trade.shares))
          ? trade.shares
          : (trade.entryPrice > 0 ? trade.contractSize / trade.entryPrice : 0);
        const valueNow = sharesNow * curPx;
        pnlNow = valueNow - trade.contractSize;

        // Update MFE/MAE while open
        const maxU = (typeof trade.maxUnrealizedPnl === "number" && Number.isFinite(trade.maxUnrealizedPnl)) ? trade.maxUnrealizedPnl : 0;
        const minU = (typeof trade.minUnrealizedPnl === "number" && Number.isFinite(trade.minUnrealizedPnl)) ? trade.minUnrealizedPnl : 0;
        trade.maxUnrealizedPnl = Math.max(maxU, pnlNow);
        trade.minUnrealizedPnl = Math.min(minU, pnlNow);

        const stopLossPct = CONFIG.paperTrading.stopLossPct ?? 0.25;
        const stopLossAmount = -Math.abs(trade.contractSize * stopLossPct);
        stopLossHit = pnlNow <= stopLossAmount;
      }

      // Exit when the other side becomes more likely to complete.
      const upP = typeof signals.modelUp === "number" ? signals.modelUp : null;
      const downP = typeof signals.modelDown === "number" ? signals.modelDown : null;
      const minProb = CONFIG.paperTrading.exitFlipMinProb ?? 0.55;
      const margin = CONFIG.paperTrading.exitFlipMargin ?? 0.03;

      const minHoldSec = CONFIG.paperTrading.exitFlipMinHoldSeconds ?? 0;
      const tradeAgeSec = trade.entryTime ? ((Date.now() - new Date(trade.entryTime).getTime()) / 1000) : null;

      let opposingMoreLikely = false;
      const holdOk = (tradeAgeSec === null) ? true : (tradeAgeSec >= minHoldSec);

      if (holdOk && trade.side === "UP" && upP !== null && downP !== null) {
        opposingMoreLikely = (downP >= minProb) && (downP >= upP + margin);
      }
      if (holdOk && trade.side === "DOWN" && upP !== null && downP !== null) {
        opposingMoreLikely = (upP >= minProb) && (upP >= downP + margin);
      }

      // NOTE: Probability Flip exits disabled (analytics showed they were a major drag on PnL).
      // We still compute opposingMoreLikely because it's used by the conditional stop loss.
      // If you want to re-enable flip exits later, restore the block that sets shouldExit here.


      // Immediate take-profit: close as soon as we are profitable (mark-to-market).
      // This is intentionally aggressive for max-frequency 5m behavior.
      if (!shouldExit && (CONFIG.paperTrading.takeProfitImmediate ?? false) && pnlNow !== null) {
        const tp = CONFIG.paperTrading.takeProfitPnlUsd ?? 0;
        if (Number.isFinite(tp) && tp >= 0 && pnlNow >= tp) {
          shouldExit = true;
          exitReason = "Take Profit";
        }
      }

      // Conditional stop loss: only stop out when we are materially losing AND the model has flipped against us.
      // Disabled by default for 5m.
      if (!shouldExit && (CONFIG.paperTrading.stopLossEnabled ?? false) && stopLossHit && opposingMoreLikely) {
        shouldExit = true;
        exitReason = "Stop Loss";
      }

      // Exit before settlement / candle end to reduce rollover risk
      const exitBeforeEndMin = CONFIG.paperTrading.exitBeforeEndMinutes ?? 0.5;
      if (!shouldExit && typeof timeLeftMin === "number" && Number.isFinite(timeLeftMin) && timeLeftMin < exitBeforeEndMin) {
        shouldExit = true;
        exitReason = "End of Candle";
      }

      if (shouldExit) {
        const exitPrice = effectivePriceForSide(trade.side);
        if (exitPrice !== null) {
          await this.closeTrade(trade, exitPrice, exitReason);

          // Optional flip: immediately open the other side
          if (shouldFlip) {
            const newSide = trade.side === "UP" ? "DOWN" : "UP";
            const entryPrice = effectivePriceForSide(newSide);

            const minPoly = CONFIG.paperTrading.minPolyPrice ?? 0.001;
            const maxPoly = CONFIG.paperTrading.maxPolyPrice ?? 0.999;
            if (typeof entryPrice === "number" && Number.isFinite(entryPrice) && entryPrice >= minPoly && entryPrice <= maxPoly && !isLowLiquidity && !isLowVolume) {
              const contractSizeUsd = this.computeContractSizeUsd();
              if (!contractSizeUsd || contractSizeUsd <= 0) {
                console.warn("Skipping flip entry: no available balance for trade size.");
              } else {
                const shares = entryPrice > 0 ? (contractSizeUsd / entryPrice) : null;
                if (shares !== null && Number.isFinite(shares) && shares > 0) {
                  const flipped = {
                    id: Date.now().toString() + Math.random().toString(36).substring(2, 8),
                    timestamp: new Date().toISOString(),
                    marketSlug,
                    side: newSide,
                    instrument: "POLY",
                    entryPrice,
                    shares,
                    contractSize: contractSizeUsd,
                    status: "OPEN",
                    entryTime: new Date().toISOString(),
                    exitPrice: null,
                    exitTime: null,
                    pnl: 0,
                    entryPhase: signals.rec?.phase ?? "MID",
                    entryReason: "Flip"
                  };

                  await addTrade(flipped);
                  this.openTrade = flipped;
                  this.lastFlipAtMs = Date.now();
                  const { balance } = this.getBalanceSnapshot();
                  console.log(`🔁 FLIP OPENED (POLY): ${newSide} @ ${(entryPrice * 100).toFixed(2)}¢ | $${contractSizeUsd} (balance ~$${balance.toFixed(2)})`);
                }
              }
            }
          }
        }
      }
    }
  }

  async closeTrade(trade, exitPrice, reason) {
    // POLY behavior: $notional -> shares
    const shares = (typeof trade.shares === "number" && Number.isFinite(trade.shares))
      ? trade.shares
      : (trade.entryPrice > 0 ? trade.contractSize / trade.entryPrice : 0);

    const value = shares * exitPrice;
    const pnl = value - trade.contractSize;

    trade.exitPrice = exitPrice;
    trade.exitTime = new Date().toISOString();
    trade.pnl = Number(pnl.toFixed(2));
    trade.status = "CLOSED";
    trade.exitReason = reason;

    await updateTrade(trade.id, trade);
    
    const icon = pnl >= 0 ? "✅" : "❌";
    console.log(`${icon} TRADE CLOSED (POLY): ${trade.side} | Entry: ${(trade.entryPrice * 100).toFixed(2)}¢ → Exit: ${(exitPrice * 100).toFixed(2)}¢ | PnL: $${pnl.toFixed(2)} | ${reason}`);
    
    this.openTrade = null;
  }
}

// Singleton for UI access
let traderInstance = null;

export async function initializeTrader() {
  if (!traderInstance) {
    traderInstance = new Trader();
    await traderInstance.initialize();
  }
  return traderInstance;
}

export function getTraderInstance() {
  return traderInstance;
}

export function setTraderInstance(trader) {
  traderInstance = trader;
}

export function getOpenTrade() {
  return traderInstance?.openTrade || ledgerGetOpenTrade();
}
