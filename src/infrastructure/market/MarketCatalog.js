/**
 * @file Market catalog with background sync.
 *
 * Wraps the existing market resolution logic from polymarket.js and
 * adds background syncing and an in-memory cache of active markets.
 *
 * Provides a centralized source of truth for the current market,
 * all known tokenIDs (for proactive approvals), and market metadata.
 */

import { resolveCurrentBtc5mMarket } from '../../data/polymarket.js';
import { getAllTokenIds } from './tokenMapping.js';

export class MarketCatalog {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.syncIntervalMs] - Background sync interval (default 30s)
   */
  constructor(opts = {}) {
    this.syncIntervalMs = opts.syncIntervalMs ?? 30_000;

    /** @type {Object|null} Current active market */
    this._currentMarket = null;

    /** @type {string[]} All known token IDs from current market */
    this._knownTokenIds = [];

    /** @type {number} */
    this._lastSyncMs = 0;

    /** @type {string|null} */
    this._lastSyncError = null;

    /** @type {NodeJS.Timeout|null} */
    this._syncTimer = null;

    /** @type {number} */
    this._syncCount = 0;
  }

  /**
   * Sync the market catalog (fetch latest market).
   * @returns {Promise<Object|null>} The current market, or null
   */
  async sync() {
    try {
      const market = await resolveCurrentBtc5mMarket();
      if (market) {
        this._currentMarket = market;
        this._knownTokenIds = getAllTokenIds(market);
        this._lastSyncError = null;
      }
      this._lastSyncMs = Date.now();
      this._syncCount++;
      return this._currentMarket;
    } catch (e) {
      this._lastSyncError = e?.message || String(e);
      this._lastSyncMs = Date.now();
      this._syncCount++;
      return this._currentMarket; // Return stale if available
    }
  }

  /**
   * Get the current market (with optional lazy sync).
   * @returns {Object|null}
   */
  getCurrentMarket() {
    return this._currentMarket;
  }

  /**
   * Get all known token IDs from the current market.
   * Used for proactive approvals.
   * @returns {string[]}
   */
  getAllKnownTokenIds() {
    return [...this._knownTokenIds];
  }

  /**
   * Start background sync.
   */
  startBackgroundSync() {
    if (this._syncTimer) return; // Already running

    console.log(`MarketCatalog: Starting background sync (every ${this.syncIntervalMs / 1000}s)`);

    // Initial sync
    this.sync().catch((e) => {
      console.warn('MarketCatalog: Initial sync failed:', e?.message);
    });

    this._syncTimer = setInterval(() => {
      this.sync().catch((e) => {
        console.warn('MarketCatalog: Background sync failed:', e?.message);
      });
    }, this.syncIntervalMs);
  }

  /**
   * Stop background sync.
   */
  stop() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }

  /**
   * Get a snapshot for the API.
   * @returns {{ market: Object|null, tokenIds: string[], lastSyncAt: string|null, syncCount: number, error: string|null }}
   */
  getSnapshot() {
    return {
      market: this._currentMarket
        ? {
          slug: this._currentMarket.slug,
          question: this._currentMarket.question,
          endDate: this._currentMarket.endDate,
          outcomes: this._currentMarket.outcomes,
          clobTokenIds: this._currentMarket.clobTokenIds,
          liquidityNum: this._currentMarket.liquidityNum,
          volumeNum: this._currentMarket.volumeNum,
        }
        : null,
      tokenIds: this._knownTokenIds,
      lastSyncAt: this._lastSyncMs > 0 ? new Date(this._lastSyncMs).toISOString() : null,
      syncCount: this._syncCount,
      error: this._lastSyncError,
    };
  }
}
