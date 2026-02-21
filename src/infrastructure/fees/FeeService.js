/**
 * @file Fee verification & observability service.
 *
 * The @polymarket/clob-client SDK (v5.2.3+) already handles fees
 * automatically inside `createOrder()` via `_resolveFeeRateBps()`.
 * This service does NOT interfere with order placement. Instead, it:
 *
 * 1. Fetches and caches fee rates per token for observability.
 * 2. Computes estimated fee impact for UI display and logging.
 * 3. Exposes current fee info via `getSnapshot()` for the status API.
 */

import { getClobClient } from '../../live_trading/clob.js';

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * @typedef {Object} FeeCacheEntry
 * @property {number} rateBps    - Fee rate in basis points (e.g. 200 = 2%)
 * @property {number} fetchedAt  - Timestamp of last fetch (ms)
 */

/**
 * @typedef {Object} FeeSnapshot
 * @property {Record<string, { rateBps: number, ratePct: string, fetchedAt: string }>} tokens
 * @property {number} cacheSize
 * @property {number} cacheTtlMs
 */

export class FeeService {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.cacheTtlMs]         - TTL for cached fee rates (default 30s)
   * @param {number} [opts.alertThresholdBps]   - Log warning if fee rate exceeds this (default 300 = 3%)
   */
  constructor(opts = {}) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.alertThresholdBps = opts.alertThresholdBps ?? 300;

    /** @type {Map<string, FeeCacheEntry>} */
    this._cache = new Map();

    /** @type {import('@polymarket/clob-client').ClobClient|null} */
    this._client = null;
  }

  /**
   * Lazy-initialize the CLOB client (avoids crashing if live trading is not configured).
   * @returns {import('@polymarket/clob-client').ClobClient}
   */
  _getClient() {
    if (!this._client) {
      try {
        this._client = getClobClient();
      } catch {
        // Will be null — callers handle gracefully
      }
    }
    return this._client;
  }

  /**
   * Get the fee rate for a token, using cache when fresh.
   * @param {string} tokenId - CLOB token ID
   * @returns {Promise<number|null>} Fee rate in basis points, or null if unavailable
   */
  async getFeeRateBps(tokenId) {
    if (!tokenId) return null;

    const now = Date.now();
    const cached = this._cache.get(tokenId);
    if (cached && (now - cached.fetchedAt) < this.cacheTtlMs) {
      return cached.rateBps;
    }

    const client = this._getClient();
    if (!client) return null;

    try {
      // SDK exposes getFeeRateBps(tokenID) which calls GET /fee-rate?token_id=...
      const result = await client.getFeeRateBps(tokenId);
      const bps = Number(result);
      if (!isNum(bps) || bps < 0) return null;

      this._cache.set(tokenId, { rateBps: bps, fetchedAt: now });

      // Alert if fee rate is unusually high
      if (bps > this.alertThresholdBps) {
        console.warn(
          `FeeService: High fee rate for token ${tokenId.substring(0, 12)}...: ${bps} bps (threshold: ${this.alertThresholdBps} bps)`,
        );
      }

      return bps;
    } catch (e) {
      console.debug('FeeService: Failed to fetch fee rate:', e?.message || String(e));
      // Return stale cache if available
      return cached?.rateBps ?? null;
    }
  }

  /**
   * Compute estimated fee impact for a given trade.
   * This is for display/logging only — the SDK handles actual fee computation.
   *
   * @param {number} sizeUsd     - Trade notional in USD
   * @param {number} price       - Entry price (0..1)
   * @param {number} feeRateBps  - Fee rate in basis points
   * @returns {{ feeUsd: number, feeShareEquivalent: number, effectivePriceShift: number }}
   */
  computeFeeImpact(sizeUsd, price, feeRateBps) {
    if (!isNum(sizeUsd) || !isNum(price) || !isNum(feeRateBps) || price <= 0) {
      return { feeUsd: 0, feeShareEquivalent: 0, effectivePriceShift: 0 };
    }

    // Fee is charged on notional (sizeUsd)
    const feeUsd = (sizeUsd * feeRateBps) / 10_000;

    // How many shares the fee "costs" at the given price
    const feeShareEquivalent = price > 0 ? feeUsd / price : 0;

    // Effective price shift: how much worse your fill is due to fees
    const shares = sizeUsd / price;
    const effectivePriceShift = shares > 0 ? feeUsd / shares : 0;

    return {
      feeUsd: Math.round(feeUsd * 10000) / 10000,
      feeShareEquivalent: Math.round(feeShareEquivalent * 100) / 100,
      effectivePriceShift: Math.round(effectivePriceShift * 10000) / 10000,
    };
  }

  /**
   * Get a snapshot of all cached fee rates (for status API).
   * @returns {FeeSnapshot}
   */
  getSnapshot() {
    /** @type {Record<string, { rateBps: number, ratePct: string, fetchedAt: string }>} */
    const tokens = {};
    for (const [tokenId, entry] of this._cache) {
      tokens[tokenId] = {
        rateBps: entry.rateBps,
        ratePct: (entry.rateBps / 100).toFixed(2) + '%',
        fetchedAt: new Date(entry.fetchedAt).toISOString(),
      };
    }
    return {
      tokens,
      cacheSize: this._cache.size,
      cacheTtlMs: this.cacheTtlMs,
    };
  }

  /**
   * Clear the fee cache (e.g. on market rollover).
   */
  clearCache() {
    this._cache.clear();
  }
}
