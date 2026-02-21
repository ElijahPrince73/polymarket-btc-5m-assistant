/**
 * @file Unified exit evaluation for both paper and live trading.
 *
 * Pure function — reads position/signals/config/state, returns a decision.
 * No I/O, no side effects. The TradingEngine handles state mutations
 * (cooldowns, grace timer start/clear, MFE updates, etc.).
 *
 * Extracted from:
 *   - src/paper_trading/trader.js processSignals() lines 778-1103
 *   - src/live_trading/trader.js processSignals() lines 224-437
 */

/** @import { ExitDecision, PositionView } from './types.js' */

// ─── helpers ───────────────────────────────────────────────────────

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

// ─── dynamic stop loss ────────────────────────────────────────────

/**
 * Compute the effective max loss USD for a given position.
 *
 * When dynamic stop loss is enabled, scales with contract size:
 *   maxLoss = contractSize * dynamicStopLossPct
 * Clamped to [minMaxLossUsd, maxMaxLossUsd].
 *
 * When disabled, falls back to the fixed maxLossUsdPerTrade.
 *
 * @param {number} contractSize     - Position notional ($)
 * @param {Object} config
 * @param {boolean} [config.dynamicStopLossEnabled]  - Toggle (default: false)
 * @param {number}  [config.dynamicStopLossPct]      - Fraction of contractSize (default: 0.20)
 * @param {number}  [config.minMaxLossUsd]            - Floor (default: 8)
 * @param {number}  [config.maxMaxLossUsd]            - Ceiling (default: 40)
 * @param {number}  [config.maxLossUsdPerTrade]       - Fixed fallback
 * @returns {number|null}  Max loss in USD, or null if not configured
 */
export function computeMaxLossUsd(contractSize, config) {
  const dynamicEnabled = config.dynamicStopLossEnabled ?? false;

  if (dynamicEnabled && isNum(contractSize) && contractSize > 0) {
    const pct = config.dynamicStopLossPct ?? 0.20;
    const raw = contractSize * pct;
    const floor = config.minMaxLossUsd ?? 8;
    const ceiling = config.maxMaxLossUsd ?? 40;
    return Math.max(floor, Math.min(ceiling, raw));
  }

  // Fallback: fixed dollar amount (backward compatible)
  return config.maxLossUsdPerTrade ?? null;
}

// ─── types ─────────────────────────────────────────────────────────

/**
 * Per-position grace-window state, managed by TradingEngine.
 *
 * @typedef {Object} GraceState
 * @property {number|null} breachAtMs - Timestamp when max-loss was first breached
 * @property {boolean} used          - Whether grace has already been used once
 */

/**
 * Full exit evaluation result.
 *
 * @typedef {Object} ExitResult
 * @property {ExitDecision|null} decision         - Exit to execute, or null (hold)
 * @property {'START_GRACE'|'CLEAR_GRACE'|null} graceAction - Grace-timer action for engine
 * @property {number|null} pnlNow                - Current unrealized PnL (for MFE/MAE tracking)
 * @property {boolean} opposingMoreLikely         - Whether the opposing side's model prob dominates
 */

// ─── main exit evaluator ───────────────────────────────────────────

/**
 * Evaluate all exit conditions for a single position.
 *
 * The caller (TradingEngine) must:
 *   1. Pre-compute `position.mark` and `position.unrealizedPnl`
 *   2. Keep `position.maxUnrealizedPnl` / `minUnrealizedPnl` up-to-date
 *   3. Act on `graceAction` by updating the per-position GraceState
 *   4. Record cooldowns (loss/win) after executing a close
 *
 * @param {PositionView} position   - Current position view (mark + PnL already set)
 * @param {Object} signals          - The unified signals bundle
 * @param {Object} config           - Merged trading config (paperTrading keys)
 * @param {GraceState} graceState   - Per-position grace-window state
 * @param {number} [nowMs]          - Current time in ms (default: Date.now()) — injectable for tests
 * @returns {ExitResult}
 */
export function evaluateExits(position, signals, config, graceState, nowMs) {
  const now = nowMs ?? Date.now();
  const result = {
    decision: null,
    graceAction: null,
    pnlNow: null,
    opposingMoreLikely: false,
  };

  if (!position) return result;

  // ── Derived values ───────────────────────────────────────────────

  const pnlNow = isNum(position.unrealizedPnl) ? position.unrealizedPnl : null;
  result.pnlNow = pnlNow;

  const mark = isNum(position.mark) ? position.mark : null;

  // Trade age (seconds)
  let tradeAgeSec = null;
  if (position.entryTime) {
    const entryMs = new Date(position.entryTime).getTime();
    if (isNum(entryMs) && entryMs > 0) {
      tradeAgeSec = (now - entryMs) / 1000;
    }
  }
  // Fallback: live positions store lastTradeTime as epoch seconds
  if (tradeAgeSec === null && isNum(position.lastTradeTime) && position.lastTradeTime > 0) {
    tradeAgeSec = Math.floor(now / 1000) - position.lastTradeTime;
  }

  // Time-to-settlement
  const poly = signals.polyMarketSnapshot;
  const endDate = signals.market?.endDate ?? poly?.market?.endDate ?? null;
  const settlementLeftMin = endDate
    ? (new Date(endDate).getTime() - now) / 60000
    : null;
  const timeLeftForExit = isNum(settlementLeftMin)
    ? settlementLeftMin
    : (signals.timeLeftMin ?? null);

  const exitBeforeEndMin = config.exitBeforeEndMinutes ?? 0.5;

  // Current market slug
  const currentMarketSlug = signals.market?.slug ?? null;

  // Model probabilities
  const upP = isNum(signals.modelUp) ? signals.modelUp : null;
  const downP = isNum(signals.modelDown) ? signals.modelDown : null;

  const sideProb = position.side === 'UP' ? upP : downP;
  const oppProb = position.side === 'UP' ? downP : upP;

  // Opposing-side flip detection (used by conditional stop loss)
  const minFlipProb = config.exitFlipMinProb ?? 0.55;
  const flipMargin = config.exitFlipMargin ?? 0.03;
  const minFlipHoldSec = config.exitFlipMinHoldSeconds ?? 0;
  const holdOk = tradeAgeSec === null ? true : tradeAgeSec >= minFlipHoldSec;

  if (holdOk && upP !== null && downP !== null) {
    if (position.side === 'UP') {
      result.opposingMoreLikely = downP >= minFlipProb && downP >= upP + flipMargin;
    } else {
      result.opposingMoreLikely = upP >= minFlipProb && upP >= downP + flipMargin;
    }
  }

  // Stop-loss hit (percentage-based)
  let stopLossHit = false;
  if (pnlNow !== null && isNum(position.contractSize) && position.contractSize > 0) {
    const stopLossPct = config.stopLossPct ?? 0.25;
    const stopLossAmount = -Math.abs(position.contractSize * stopLossPct);
    stopLossHit = pnlNow <= stopLossAmount;
  }

  // Liquidity check (for grace-window eligibility)
  const liqNum = Number(signals.market?.liquidityNum ?? NaN);
  const minLiq = Number(config.minLiquidity ?? 0);
  const isLowLiquidity =
    isNum(minLiq) && minLiq > 0
      ? !(isNum(liqNum) && liqNum >= minLiq)
      : false;

  // ── 1. Market Rollover ───────────────────────────────────────────
  if (
    position.marketSlug &&
    currentMarketSlug &&
    position.marketSlug !== currentMarketSlug
  ) {
    result.decision = { reason: 'Market Rollover' };
    return result;
  }

  // ── 2. Pre-settlement exit ───────────────────────────────────────
  if (isNum(timeLeftForExit) && timeLeftForExit < exitBeforeEndMin) {
    result.decision = { reason: 'Pre-settlement Exit' };
    return result;
  }

  // ── 3. Max loss with grace window ────────────────────────────────
  const maxLossUsd = computeMaxLossUsd(position.contractSize, config);
  const graceEnabled = config.maxLossGraceEnabled ?? false;
  const graceSeconds = config.maxLossGraceSeconds ?? 0;
  const recoverUsd = config.maxLossRecoverUsd ?? null;
  const requireModelSupport =
    config.maxLossGraceRequireModelSupport ?? false;

  if (pnlNow !== null && isNum(maxLossUsd) && maxLossUsd > 0) {
    const maxLossAbs = Math.abs(maxLossUsd);
    const breached = pnlNow <= -maxLossAbs;

    // Model still supports trade?
    const modelSupports =
      isNum(sideProb) && isNum(oppProb)
        ? sideProb >= 0.55 && sideProb >= oppProb
        : false;

    const okForGrace = Boolean(
      graceEnabled &&
        isNum(graceSeconds) &&
        graceSeconds > 0 &&
        // Don't grace near settlement
        (isNum(timeLeftForExit)
          ? timeLeftForExit >= exitBeforeEndMin + 0.25
          : true) &&
        !isLowLiquidity &&
        (!requireModelSupport || modelSupports),
    );

    // Recovery threshold
    const recoverThresh =
      isNum(recoverUsd) && recoverUsd > 0
        ? -Math.abs(recoverUsd)
        : -maxLossAbs + 1; // fallback: recover at least $1

    // If in grace and recovered enough, cancel pending stop
    if (graceState?.breachAtMs && pnlNow > recoverThresh) {
      result.graceAction = 'CLEAR_GRACE';
    }

    if (breached) {
      if (okForGrace) {
        // Start grace timer once per position
        if (!graceState?.used && !graceState?.breachAtMs) {
          result.graceAction = 'START_GRACE';
          // Don't exit yet — grace period just started
        } else if (graceState?.breachAtMs) {
          const elapsed = now - graceState.breachAtMs;
          if (elapsed >= graceSeconds * 1000) {
            result.decision = {
              reason: `Max Loss ($${maxLossAbs.toFixed(2)})`,
            };
            return result;
          }
          // Still within grace: hold
        } else {
          // Grace used but can't track breach — fall back to exit
          result.decision = {
            reason: `Max Loss ($${maxLossAbs.toFixed(2)})`,
          };
          return result;
        }
      } else {
        // No grace available: exit immediately
        result.decision = {
          reason: `Max Loss ($${maxLossAbs.toFixed(2)})`,
        };
        return result;
      }
    }
  }

  // ── 4. High-price take-profit ────────────────────────────────────
  const tpPrice = config.takeProfitPrice ?? null;
  if (isNum(tpPrice) && isNum(mark) && mark >= tpPrice) {
    result.decision = {
      reason: `Take Profit (mark >= ${(tpPrice * 100).toFixed(0)}¢)`,
    };
    return result;
  }

  // ── 5. Trailing take-profit ──────────────────────────────────────
  if (pnlNow !== null && (config.trailingTakeProfitEnabled ?? false)) {
    const start = config.trailingStartUsd ?? 0;
    const dd = config.trailingDrawdownUsd ?? 0;
    const maxU = isNum(position.maxUnrealizedPnl)
      ? position.maxUnrealizedPnl
      : null;

    if (
      isNum(start) &&
      start > 0 &&
      isNum(dd) &&
      dd > 0 &&
      maxU !== null &&
      maxU >= start
    ) {
      const trail = maxU - dd;
      if (pnlNow <= trail) {
        result.decision = {
          reason: `Trailing TP (max $${maxU.toFixed(2)}; dd $${dd.toFixed(2)})`,
        };
        return result;
      }
    }
  }

  // ── 6. Immediate take-profit (only when trailing TP is disabled) ─
  if (
    !(config.trailingTakeProfitEnabled ?? false) &&
    (config.takeProfitImmediate ?? false) &&
    pnlNow !== null
  ) {
    const tp = config.takeProfitPnlUsd ?? 0;
    if (isNum(tp) && tp >= 0 && pnlNow >= tp) {
      result.decision = { reason: 'Take Profit' };
      return result;
    }
  }

  // ── 7. Time stop ─────────────────────────────────────────────────
  const loserMaxHold = config.loserMaxHoldSeconds ?? 0;
  if (
    pnlNow !== null &&
    tradeAgeSec !== null &&
    isNum(loserMaxHold) &&
    loserMaxHold > 0 &&
    tradeAgeSec >= loserMaxHold &&
    pnlNow < 0
  ) {
    result.decision = { reason: 'Time Stop' };
    return result;
  }

  // ── 8. Conditional stop loss ─────────────────────────────────────
  if (
    (config.stopLossEnabled ?? false) &&
    stopLossHit &&
    result.opposingMoreLikely
  ) {
    result.decision = { reason: 'Stop Loss' };
    return result;
  }

  // No exit triggered
  return result;
}

// ─── PnL cap helper ────────────────────────────────────────────────

/**
 * Cap realized PnL at the configured max loss per trade.
 * When a trade would realize more loss than maxLossUsdPerTrade, clamp the PnL
 * and adjust the exit price to keep the ledger internally consistent.
 *
 * Used by executors when closing positions.
 *
 * @param {number} rawPnl        - Pre-cap PnL ($)
 * @param {number} contractSize  - Dollar notional at entry
 * @param {number} shares        - Number of shares
 * @param {number} exitPrice     - Raw exit price
 * @param {Object} config
 * @returns {{ pnl: number, exitPrice: number }}
 */
export function capPnl(rawPnl, contractSize, shares, exitPrice, config) {
  const maxLossUsd = computeMaxLossUsd(contractSize, config);

  if (isNum(maxLossUsd) && maxLossUsd > 0 && isNum(rawPnl)) {
    const cap = -Math.abs(maxLossUsd);
    if (rawPnl < cap) {
      const cappedPnl = cap;
      const cappedValue = contractSize + cappedPnl;
      const impliedExit = shares > 0 ? cappedValue / shares : exitPrice;

      if (isNum(impliedExit) && impliedExit > 0) {
        return { pnl: cappedPnl, exitPrice: impliedExit };
      }
      return { pnl: cappedPnl, exitPrice };
    }
  }

  return { pnl: rawPnl, exitPrice };
}
