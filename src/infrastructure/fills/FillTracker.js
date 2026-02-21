/**
 * @file Fill tracker for Polymarket CLOB trades.
 *
 * Polls `client.getTrades()` and tracks new fills since the last check.
 * Provides recent fills for audit and the portfolio endpoint.
 */

import { getClobClient } from '../../live_trading/clob.js';

/**
 * @typedef {Object} Fill
 * @property {string} id - Trade ID from CLOB
 * @property {string} tokenID
 * @property {'BUY'|'SELL'} side
 * @property {number} price
 * @property {number} size
 * @property {string} timestamp
 * @property {Object} [raw] - Raw trade object from CLOB
 */

export class FillTracker {
  constructor() {
    /** @type {import('@polymarket/clob-client').ClobClient|null} */
    this._client = null;

    /** @type {Fill[]} */
    this._fills = [];

    /** @type {Set<string>} Known fill IDs to deduplicate */
    this._knownIds = new Set();

    /** @type {number} */
    this._lastPollMs = 0;

    /** @type {number} Max fills to keep in memory */
    this.maxFills = 500;
  }

  /**
   * Lazy-initialize the CLOB client.
   * @returns {import('@polymarket/clob-client').ClobClient|null}
   */
  _getClient() {
    if (!this._client) {
      try {
        this._client = getClobClient();
      } catch {
        // not available
      }
    }
    return this._client;
  }

  /**
   * Poll for new fills.
   * @param {Object} [opts]
   * @param {number} [opts.minIntervalMs] - Min time between polls (default 5s)
   * @returns {Promise<Fill[]>} New fills since last poll
   */
  async poll(opts = {}) {
    const minInterval = opts.minIntervalMs ?? 5_000;
    const now = Date.now();

    if (now - this._lastPollMs < minInterval) {
      return [];
    }
    this._lastPollMs = now;

    const client = this._getClient();
    if (!client) return [];

    try {
      const trades = await client.getTrades();
      if (!Array.isArray(trades)) return [];

      const newFills = [];
      for (const t of trades) {
        const id = t.id || t.tradeId || t.trade_id || `${t.asset_id}-${t.match_time}`;
        if (this._knownIds.has(id)) continue;

        this._knownIds.add(id);

        const fill = {
          id,
          tokenID: t.asset_id || t.token_id || t.tokenID || null,
          side: String(t.side || '').toUpperCase(),
          price: Number(t.price) || 0,
          size: Number(t.size) || 0,
          timestamp: t.match_time || t.timestamp || t.created_at || new Date().toISOString(),
          raw: t,
        };

        this._fills.push(fill);
        newFills.push(fill);
      }

      // Prune oldest fills if over limit
      if (this._fills.length > this.maxFills) {
        const excess = this._fills.length - this.maxFills;
        this._fills.splice(0, excess);
      }

      return newFills;
    } catch {
      return [];
    }
  }

  /**
   * Get recent fills.
   * @param {number} [limit=50] - Max fills to return
   * @returns {Fill[]}
   */
  getRecentFills(limit = 50) {
    return this._fills.slice(-limit);
  }

  /**
   * Get a snapshot for the API.
   * @returns {{ totalTracked: number, recentCount: number, fills: Fill[] }}
   */
  getSnapshot() {
    return {
      totalTracked: this._fills.length,
      knownIds: this._knownIds.size,
      fills: this._fills.slice(-100), // Last 100
    };
  }
}
