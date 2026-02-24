/**
 * @file Unified TradingEngine — replaces both Trader and LiveTrader.
 *
 * Orchestrates the entry/exit decision loop using domain-layer pure functions
 * and delegates execution to the active OrderExecutor (paper or live).
 *
 * Trading is OFF by default; the user must click "Start Trading" in the UI.
 */

import { computeEntryBlockers, computeEntryGateEvaluation } from '../domain/entryGate.js';
import { evaluateExits } from '../domain/exitEvaluator.js';
import { computeTradeSize } from '../domain/sizing.js';
import { TradingState } from './TradingState.js';

/** @import { OrderExecutor } from './ExecutorInterface.js' */

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

export class TradingEngine {
  /**
   * @param {Object} opts
   * @param {OrderExecutor} opts.executor  - Active executor (PaperExecutor or LiveExecutor)
   * @param {Object} opts.config           - Merged trading config
   */
  constructor({ executor, config }) {
    /** @type {OrderExecutor} */
    this.executor = executor;

    /** @type {Object} */
    this.config = config;

    /** @type {boolean} Trading starts OFF — user must enable via UI */
    this.tradingEnabled = false;

    /** @type {TradingState} */
    this.state = new TradingState();

    /** @type {{ at: string|null, eligible: boolean, blockers: string[] }} */
    this.lastEntryStatus = { at: null, eligible: false, blockers: [] };
  }

  /**
   * Initialize the executor (load ledger, connect, etc.).
   */
  async initialize() {
    await this.executor.initialize();
  }

  /**
   * Main loop entry point — called every tick with fresh signals.
   *
   * @param {Object} signals  - The unified signals bundle (from buildSignals)
   * @param {Array} klines1m  - 1-minute candle array (for candle count)
   */
  async processSignals(signals, klines1m) {
    const mode = this.executor.getMode();
    const rec = signals?.rec;
    console.log(
      `${mode} engine: rec=${rec?.action || 'NONE'}, side=${rec?.side || '-'}, timeLeft=${signals?.timeLeftMin?.toFixed(1) || '-'}m`,
    );

    // Reset daily PnL counter at midnight
    this.state.resetDayIfNeeded();

    if (!this.tradingEnabled) {
      this.state.setEntryStatus(false, ['Trading disabled']);
      this.lastEntryStatus = this.state.lastEntryStatus;
      return;
    }

    // ── 1. Fetch open positions ────────────────────────────────
    let positions;
    try {
      positions = await this.executor.getOpenPositions(signals);
    } catch (e) {
      console.error(`[${mode} engine] Error fetching positions:`, e?.message || e);
      return;
    }

    // ── 2. Mark positions (compute mark + unrealized PnL) ──────
    if (positions.length > 0) {
      try {
        positions = await this.executor.markPositions(positions, signals);
      } catch (e) {
        console.error(`[${mode} engine] Error marking positions:`, e?.message || e);
        // Continue with un-marked positions — exits that don't need PnL (rollover, pre-settlement) can still fire
      }
    }

    // Update MFE/MAE tracking
    for (const p of positions) {
      const posId = p.id || p.tokenID || 'default';
      if (isNum(p.unrealizedPnl)) {
        this.state.trackMFE(posId, p.unrealizedPnl);
        this.state.trackMAE(posId, p.unrealizedPnl);

        // Inject tracked MFE/MAE into position for exit evaluator
        const mfe = this.state.getMaxUnrealized(posId);
        const mae = this.state.getMinUnrealized(posId);
        if (mfe !== null) p.maxUnrealizedPnl = mfe;
        if (mae !== null) p.minUnrealizedPnl = mae;
      }
    }

    // ── 3. Exit evaluation ─────────────────────────────────────
    this.state.hasOpenPosition = positions.length > 0;

    for (const p of positions) {
      const posId = p.id || p.tokenID || 'default';
      const graceState = this.state.getGraceState(posId);

      const exitResult = evaluateExits(p, signals, this.config, graceState);

      // Handle grace actions
      if (exitResult.graceAction === 'START_GRACE') {
        this.state.startGrace(posId);
      } else if (exitResult.graceAction === 'CLEAR_GRACE') {
        this.state.clearGrace(posId);
      }

      if (exitResult.decision) {
        const reason = exitResult.decision.reason;

        // Capture exit-time indicators for trade journal enrichment
        const exitMetadata = {
          btcSpotAtExit: signals?.spot?.price ?? null,
          rsiAtExit: signals?.indicators?.rsiNow ?? null,
          macdHistAtExit: signals?.indicators?.macd?.hist ?? null,
          vwapSlopeAtExit: signals?.indicators?.vwapSlope ?? null,
          modelUpAtExit: signals?.modelUp ?? null,
          modelDownAtExit: signals?.modelDown ?? null,
        };

        try {
          const closeResult = await this.executor.closePosition({
            tradeId: p.id,
            side: p.side,
            shares: p.shares,
            reason,
            tokenID: p.tokenID || null,
            exitMetadata,
          });

          if (closeResult.closed) {
            // Record exit for cooldowns + daily PnL
            const skipAfterMaxLoss = this.config.skipMarketAfterMaxLoss ?? false;
            this.state.recordExit(
              closeResult.pnl,
              p.marketSlug,
              reason,
              skipAfterMaxLoss,
            );

            // Clean up position tracking
            this.state.clearPosition(posId);

            console.log(
              `${closeResult.pnl >= 0 ? '✅' : '❌'} [${mode}] CLOSED: ${p.side} | PnL: $${closeResult.pnl?.toFixed(2)} | ${reason}`,
            );
          }
        } catch (e) {
          console.error(`[${mode} engine] Error closing position:`, e?.message || e);
        }
      }
    }

    // ── 4. Re-check: if still in position, skip entry ──────────
    // Re-fetch after exits to see if we're now flat
    try {
      positions = await this.executor.getOpenPositions(signals);
    } catch {
      // best-effort
    }

    if (positions.length > 0) {
      this.state.hasOpenPosition = true;
      this.state.setEntryStatus(false, [`Position open: ${positions.length}`]);
      this.lastEntryStatus = this.state.lastEntryStatus;
      return;
    }

    this.state.hasOpenPosition = false;

    // ── 5. Entry evaluation ────────────────────────────────────
    const candleCount = Array.isArray(klines1m) ? klines1m.length : 0;
    const { blockers, effectiveSide, sideInferred } = computeEntryBlockers(
      signals,
      this.config,
      this.state,
      candleCount,
    );

    this.state.setEntryStatus(blockers.length === 0, blockers);
    this.lastEntryStatus = this.state.lastEntryStatus;

    // Record blockers for frequency tracking + periodic console summary
    this.state.recordBlockers(blockers);
    const now = Date.now();
    if (blockers.length > 0 &&
        (this.state._lastBlockerLogAtMs === null || now - this.state._lastBlockerLogAtMs >= 30_000)) {
      this.state._lastBlockerLogAtMs = now;
      const summary = this.state.getBlockerSummary(5);
      console.log(
        `[${mode} engine] Entry blocked (${summary.total} checks). Top blockers: ` +
        summary.topBlockers.map(b => `${b.blocker} (${b.pct}%)`).join(' | '),
      );
      console.log(`[${mode} engine] Current blockers: ${blockers.join('; ')}`);
    }

    if (blockers.length > 0) {
      return; // Blocked
    }

    // ── 6. Sizing ──────────────────────────────────────────────
    let balance;
    try {
      const snap = await this.executor.getBalance();
      balance = snap.balance;
    } catch (e) {
      console.error(`[${mode} engine] Error fetching balance:`, e?.message || e);
      return;
    }

    const sizeUsd = computeTradeSize(balance, this.config);
    if (!sizeUsd || sizeUsd <= 0) {
      console.warn(`[${mode} engine] Computed trade size is 0; skipping entry.`);
      return;
    }

    // ── 7. Resolve entry price ─────────────────────────────────
    // The entry price comes from Polymarket prices in signals.
    // effectiveSide tells us which side to trade.
    const poly = signals.polyMarketSnapshot;
    const rawUpC = signals.polyPricesCents?.UP ?? null;
    const rawDownC = signals.polyPricesCents?.DOWN ?? null;

    const obUpAsk = poly?.orderbook?.up?.bestAsk;
    const obDownAsk = poly?.orderbook?.down?.bestAsk;

    const upPrice = isNum(rawUpC) && rawUpC > 0
      ? rawUpC / 100
      : (isNum(obUpAsk) && obUpAsk > 0 ? obUpAsk : null);
    const downPrice = isNum(rawDownC) && rawDownC > 0
      ? rawDownC / 100
      : (isNum(obDownAsk) && obDownAsk > 0 ? obDownAsk : null);

    const entryPrice = effectiveSide === 'UP' ? upPrice : downPrice;
    if (!isNum(entryPrice) || entryPrice <= 0) {
      console.warn(`[${mode} engine] No valid entry price for ${effectiveSide}; skipping.`);
      return;
    }

    // ── 8. Open position ───────────────────────────────────────
    const marketSlug = signals.market?.slug ?? 'unknown';
    const phase = signals.rec?.phase ?? 'MID';

    // Compute entry gate evaluation for trade journal enrichment
    const gateEvaluation = computeEntryGateEvaluation(
      signals,
      this.config,
      this.state,
      candleCount,
    );

    try {
      const result = await this.executor.openPosition({
        side: effectiveSide,
        marketSlug,
        sizeUsd,
        price: entryPrice,
        phase,
        sideInferred,
        metadata: {
          // Existing fields (preserved)
          modelUp: signals.modelUp ?? null,
          modelDown: signals.modelDown ?? null,
          edge: signals.rec?.edge ?? null,
          rsi: signals.indicators?.rsiNow ?? null,
          vwapSlope: signals.indicators?.vwapSlope ?? null,
          // Full MACD snapshot
          macdValueAtEntry: signals.indicators?.macd?.value ?? null,
          macdHistAtEntry: signals.indicators?.macd?.hist ?? null,
          macdSignalAtEntry: signals.indicators?.macd?.signal ?? null,
          // Market quality at entry
          spreadAtEntry: poly?.orderbook?.[effectiveSide.toLowerCase()]?.spread ?? null,
          liquidityAtEntry: signals.market?.liquidityNum ?? null,
          volumeNumAtEntry: signals.market?.volumeNum ?? null,
          // Spot price
          btcSpotAtEntry: signals.spot?.price ?? null,
          spotImpulsePctAtEntry: signals.spot?.delta1mPct ?? null,
          // Entry gate evaluation snapshot (compact)
          entryGateSnapshot: {
            totalChecks: gateEvaluation.totalChecks,
            passedCount: gateEvaluation.passedCount,
            failedCount: gateEvaluation.failedCount,
            margins: gateEvaluation.margins,
          },
          // Additional context
          timeLeftMinAtEntry: signals.timeLeftMin ?? null,
          modelProbAtEntry: effectiveSide === 'UP' ? (signals.modelUp ?? null) : (signals.modelDown ?? null),
          edgeAtEntry: signals.rec?.edge ?? null,
          rsiAtEntry: signals.indicators?.rsiNow ?? null,
          vwapDistAtEntry: signals.indicators?.vwapDist ?? null,
          heikenColorAtEntry: signals.indicators?.heikenColor ?? null,
          heikenCountAtEntry: signals.indicators?.heikenCount ?? null,
          rangePct20AtEntry: signals.indicators?.rangePct20 ?? null,
          recActionAtEntry: signals.rec?.action ?? null,
          sideInferred,
        },
      });

      if (result.filled) {
        console.log(
          `🟢 [${mode}] OPENED: ${effectiveSide} @ ${(result.fillPrice * 100).toFixed(2)}¢ | $${result.fillSizeUsd.toFixed(2)} (${result.fillShares.toFixed(0)} shares) | balance ~$${balance.toFixed(2)}`,
        );
      }
    } catch (e) {
      console.error(`[${mode} engine] Error opening position:`, e?.message || e);
    }
  }
}
