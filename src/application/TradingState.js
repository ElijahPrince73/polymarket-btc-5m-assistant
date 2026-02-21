/**
 * @file Mutable per-session trading state.
 *
 * Extracted from both Trader (paper) and LiveTrader (live) constructors.
 * The TradingEngine reads/writes this state; domain functions read it
 * via the `state` parameter they receive.
 *
 * One TradingState instance per TradingEngine (recreated on mode switch).
 */

/** @import { GraceState } from '../domain/types.js' */

export class TradingState {
  constructor() {
    // ── Cooldowns ────────────────────────────────────────────────
    /** @type {number|null} */
    this.lastLossAtMs = null;

    /** @type {number|null} */
    this.lastWinAtMs = null;

    /** @type {number|null} */
    this.lastFlipAtMs = null;

    // ── Skip market after max loss ──────────────────────────────
    /** @type {string|null} */
    this.skipMarketUntilNextSlug = null;

    // ── Open-position flag (set by engine before calling entryGate) */
    /** @type {boolean} */
    this.hasOpenPosition = false;

    // ── Per-position MFE/MAE tracking ───────────────────────────
    /** @type {Map<string, number>} positionId → max unrealized PnL */
    this._mfeByPos = new Map();

    /** @type {Map<string, number>} positionId → min unrealized PnL */
    this._maeByPos = new Map();

    // ── Max-loss grace window (per position) ────────────────────
    /** @type {Map<string, GraceState>} */
    this._graceByPos = new Map();

    // ── Entry status (for UI debug) ─────────────────────────────
    /** @type {{ at: string|null, eligible: boolean, blockers: string[] }} */
    this.lastEntryStatus = {
      at: null,
      eligible: false,
      blockers: [],
    };

    // ── Daily PnL tracking (for kill-switch) ────────────────────
    /** @type {number} */
    this.todayRealizedPnl = 0;

    /** @type {string|null} YYYY-MM-DD key for midnight reset */
    this._todayKey = null;

    // ── Circuit breaker (consecutive losses) ─────────────────────
    /** @type {number} */
    this.consecutiveLosses = 0;

    /** @type {number|null} Timestamp when circuit breaker was tripped */
    this.circuitBreakerTrippedAtMs = null;
  }

  // ─── MFE/MAE ─────────────────────────────────────────────────

  /**
   * Track MFE (maximum favorable excursion) for a position.
   * @param {string} posId
   * @param {number} unrealizedPnl
   */
  trackMFE(posId, unrealizedPnl) {
    const prev = this._mfeByPos.get(posId) ?? unrealizedPnl;
    this._mfeByPos.set(posId, Math.max(prev, unrealizedPnl));
  }

  /**
   * Track MAE (maximum adverse excursion) for a position.
   * @param {string} posId
   * @param {number} unrealizedPnl
   */
  trackMAE(posId, unrealizedPnl) {
    const prev = this._maeByPos.get(posId) ?? unrealizedPnl;
    this._maeByPos.set(posId, Math.min(prev, unrealizedPnl));
  }

  /** @param {string} posId */
  getMaxUnrealized(posId) {
    return this._mfeByPos.get(posId) ?? null;
  }

  /** @param {string} posId */
  getMinUnrealized(posId) {
    return this._maeByPos.get(posId) ?? null;
  }

  // ─── Grace window ────────────────────────────────────────────

  /**
   * Get the grace-window state for a position.
   * @param {string} posId
   * @returns {GraceState}
   */
  getGraceState(posId) {
    return this._graceByPos.get(posId) || { breachAtMs: null, used: false };
  }

  /**
   * Start the grace timer for a position.
   * @param {string} posId
   */
  startGrace(posId) {
    this._graceByPos.set(posId, { breachAtMs: Date.now(), used: true });
  }

  /**
   * Clear the grace timer (position recovered).
   * @param {string} posId
   */
  clearGrace(posId) {
    const gs = this._graceByPos.get(posId);
    if (gs) {
      gs.breachAtMs = null;
      // used stays true — grace can only fire once per position
    }
  }

  /**
   * Remove all tracking for a position (after close).
   * @param {string} posId
   */
  clearPosition(posId) {
    this._mfeByPos.delete(posId);
    this._maeByPos.delete(posId);
    this._graceByPos.delete(posId);
  }

  // ─── Exit recording ──────────────────────────────────────────

  /**
   * Record an exit for cooldown/skip tracking.
   * @param {number} pnl
   * @param {string} marketSlug
   * @param {string} reason
   * @param {boolean} skipAfterMaxLoss - Config flag
   */
  recordExit(pnl, marketSlug, reason, skipAfterMaxLoss = false) {
    const now = Date.now();
    if (Number.isFinite(pnl)) {
      if (pnl < 0) {
        this.lastLossAtMs = now;
        this.consecutiveLosses++;
      } else {
        this.lastWinAtMs = now;
        this.consecutiveLosses = 0; // Reset on any non-loss
      }
    }

    // If we hit max loss, skip re-entry for this market slug
    if (String(reason || '').startsWith('Max Loss') && marketSlug && skipAfterMaxLoss) {
      this.skipMarketUntilNextSlug = marketSlug;
    }

    // Update daily PnL
    this.updateDailyPnl(pnl);
  }

  // ─── Circuit breaker ───────────────────────────────────────────

  /**
   * Check if the circuit breaker should trip based on consecutive losses.
   * @param {number} maxConsecutive - Max consecutive losses before tripping
   * @param {number} cooldownMs     - How long to stay tripped
   * @returns {{ tripped: boolean, remaining: number }}
   */
  checkCircuitBreaker(maxConsecutive, cooldownMs) {
    const now = Date.now();

    // If already tripped, check if cooldown has elapsed
    if (this.circuitBreakerTrippedAtMs !== null) {
      const elapsed = now - this.circuitBreakerTrippedAtMs;
      if (elapsed < cooldownMs) {
        return { tripped: true, remaining: cooldownMs - elapsed };
      }
      // Cooldown elapsed — reset
      this.circuitBreakerTrippedAtMs = null;
      this.consecutiveLosses = 0;
    }

    // Check if we should trip now
    if (this.consecutiveLosses >= maxConsecutive) {
      this.circuitBreakerTrippedAtMs = now;
      console.warn(`Circuit breaker tripped: ${this.consecutiveLosses} consecutive losses. Cooldown: ${(cooldownMs / 1000).toFixed(0)}s`);
      return { tripped: true, remaining: cooldownMs };
    }

    return { tripped: false, remaining: 0 };
  }

  // ─── Daily PnL ──────────────────────────────────────────────

  /**
   * Reset daily counter at midnight PT (best-effort).
   */
  resetDayIfNeeded() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const key = `${y}-${m}-${day}`;

    if (this._todayKey !== key) {
      this._todayKey = key;
      this.todayRealizedPnl = 0;
    }
  }

  /**
   * Add realized PnL from a closed trade.
   * @param {number} pnl
   */
  updateDailyPnl(pnl) {
    if (Number.isFinite(pnl)) {
      this.todayRealizedPnl += pnl;
    }
  }

  // ─── Entry status (for UI) ───────────────────────────────────

  /**
   * @param {boolean} eligible
   * @param {string[]} blockers
   */
  setEntryStatus(eligible, blockers = []) {
    this.lastEntryStatus = {
      at: new Date().toISOString(),
      eligible,
      blockers,
    };
  }
}
