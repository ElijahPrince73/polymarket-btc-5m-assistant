/**
 * @file Order lifecycle manager for the Polymarket CLOB.
 *
 * Tracks pending orders in memory, provides cancel/list functionality,
 * and reconciles pending orders by polling the CLOB API.
 */

import { getClobClient } from '../../live_trading/clob.js';

/**
 * @typedef {Object} TrackedOrder
 * @property {string} orderId
 * @property {string} tokenID
 * @property {'BUY'|'SELL'} side
 * @property {number} price
 * @property {number} size
 * @property {'pending'|'open'|'filled'|'cancelled'|'unknown'} status
 * @property {string} createdAt - ISO timestamp
 * @property {string|null} updatedAt
 * @property {Object} [metadata] - Additional context (marketSlug, reason, etc.)
 */

export class OrderManager {
  constructor() {
    /** @type {import('@polymarket/clob-client').ClobClient|null} */
    this._client = null;

    /** @type {Map<string, TrackedOrder>} orderId → TrackedOrder */
    this._orders = new Map();

    /** @type {number} */
    this._lastReconcileMs = 0;
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
   * Start tracking a new order.
   * @param {string} orderId
   * @param {Object} metadata
   * @param {string} metadata.tokenID
   * @param {'BUY'|'SELL'} metadata.side
   * @param {number} metadata.price
   * @param {number} metadata.size
   * @param {Object} [metadata.extra] - Any extra context
   */
  trackOrder(orderId, metadata) {
    if (!orderId) return;

    this._orders.set(orderId, {
      orderId,
      tokenID: metadata.tokenID,
      side: metadata.side,
      price: metadata.price,
      size: metadata.size,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: null,
      metadata: metadata.extra || null,
    });
  }

  /**
   * Cancel a specific order.
   * @param {string} orderId
   * @returns {Promise<{ cancelled: boolean, error?: string }>}
   */
  async cancelOrder(orderId) {
    const client = this._getClient();
    if (!client) {
      return { cancelled: false, error: 'CLOB client not available' };
    }

    try {
      await client.cancelOrder({ orderID: orderId });

      const tracked = this._orders.get(orderId);
      if (tracked) {
        tracked.status = 'cancelled';
        tracked.updatedAt = new Date().toISOString();
      }

      return { cancelled: true };
    } catch (e) {
      return { cancelled: false, error: e?.message || String(e) };
    }
  }

  /**
   * Cancel all open orders.
   * @returns {Promise<{ cancelled: boolean, result?: any, error?: string }>}
   */
  async cancelAllOrders() {
    const client = this._getClient();
    if (!client) {
      return { cancelled: false, error: 'CLOB client not available' };
    }

    try {
      const result = await client.cancelAll();

      // Mark all tracked as cancelled
      for (const order of this._orders.values()) {
        if (order.status === 'pending' || order.status === 'open') {
          order.status = 'cancelled';
          order.updatedAt = new Date().toISOString();
        }
      }

      return { cancelled: true, result };
    } catch (e) {
      return { cancelled: false, error: e?.message || String(e) };
    }
  }

  /**
   * Reconcile pending orders by polling the CLOB API.
   * Checks the status of each tracked pending/open order.
   *
   * @param {Object} [opts]
   * @param {number} [opts.minIntervalMs] - Min time between reconciliations (default 5s)
   * @returns {Promise<{ reconciled: number, filled: string[], cancelled: string[] }>}
   */
  async reconcilePendingOrders(opts = {}) {
    const minInterval = opts.minIntervalMs ?? 5_000;
    const now = Date.now();

    if (now - this._lastReconcileMs < minInterval) {
      return { reconciled: 0, filled: [], cancelled: [] };
    }
    this._lastReconcileMs = now;

    const client = this._getClient();
    if (!client) {
      return { reconciled: 0, filled: [], cancelled: [] };
    }

    const filled = [];
    const cancelled = [];
    let reconciled = 0;

    for (const [orderId, order] of this._orders) {
      if (order.status !== 'pending' && order.status !== 'open') continue;

      try {
        const apiOrder = await client.getOrder(orderId);
        reconciled++;

        if (!apiOrder) {
          order.status = 'unknown';
          order.updatedAt = new Date().toISOString();
          continue;
        }

        const apiStatus = String(apiOrder.status || apiOrder.order_status || '').toLowerCase();

        if (apiStatus === 'filled' || apiStatus === 'matched') {
          order.status = 'filled';
          order.updatedAt = new Date().toISOString();
          filled.push(orderId);
        } else if (apiStatus === 'cancelled' || apiStatus === 'canceled') {
          order.status = 'cancelled';
          order.updatedAt = new Date().toISOString();
          cancelled.push(orderId);
        } else if (apiStatus === 'live' || apiStatus === 'open') {
          order.status = 'open';
          order.updatedAt = new Date().toISOString();
        }
      } catch {
        // Skip — will retry next reconciliation
      }
    }

    return { reconciled, filled, cancelled };
  }

  /**
   * Get all tracked orders, optionally filtered by status.
   * @param {Object} [opts]
   * @param {string} [opts.status] - Filter by status ('pending'|'open'|'filled'|'cancelled')
   * @returns {TrackedOrder[]}
   */
  getPendingOrders(opts = {}) {
    const orders = [...this._orders.values()];
    if (opts.status) {
      return orders.filter((o) => o.status === opts.status);
    }
    return orders;
  }

  /**
   * Get a snapshot for the API.
   * @returns {{ total: number, pending: number, open: number, filled: number, cancelled: number, orders: TrackedOrder[] }}
   */
  getSnapshot() {
    const orders = [...this._orders.values()];
    return {
      total: orders.length,
      pending: orders.filter((o) => o.status === 'pending').length,
      open: orders.filter((o) => o.status === 'open').length,
      filled: orders.filter((o) => o.status === 'filled').length,
      cancelled: orders.filter((o) => o.status === 'cancelled').length,
      orders,
    };
  }

  /**
   * Clean up old orders (e.g., filled/cancelled older than N minutes).
   * @param {number} [maxAgeMs=30*60_000] - Max age for completed orders (default 30 min)
   */
  pruneOldOrders(maxAgeMs = 30 * 60_000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [orderId, order] of this._orders) {
      if (
        (order.status === 'filled' || order.status === 'cancelled') &&
        new Date(order.updatedAt || order.createdAt).getTime() < cutoff
      ) {
        this._orders.delete(orderId);
      }
    }
  }
}
