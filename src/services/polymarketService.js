/**
 * @file Unified Polymarket service facade.
 *
 * Composes all Polymarket infrastructure services into a single
 * initialization and lifecycle manager. Used by the startup flow
 * and API routes instead of accessing individual services.
 *
 * Lifecycle: sync markets -> approve tokens -> start WS -> ready
 */

import { FeeService } from '../infrastructure/fees/FeeService.js';
import { ApprovalService } from '../infrastructure/approvals/ApprovalService.js';
import { OrderManager } from '../infrastructure/orders/OrderManager.js';
import { FillTracker } from '../infrastructure/fills/FillTracker.js';
import { MarketCatalog } from '../infrastructure/market/MarketCatalog.js';
import { startClobOrderbookStream } from '../data/clobWs.js';
import { CONFIG } from '../config.js';

export class PolymarketService {
  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.enableWs] - Enable CLOB WS (default true if live enabled)
   * @param {boolean} [opts.enableApprovals] - Enable proactive approvals (default true if live)
   */
  constructor(opts = {}) {
    const isLive = Boolean(CONFIG.liveTrading?.enabled);

    this.feeService = new FeeService({
      cacheTtlMs: CONFIG.liveTrading?.feeCacheTtlMs ?? 30_000,
      alertThresholdBps: CONFIG.liveTrading?.feeRateAlertThresholdBps ?? 300,
    });

    this.approvalService = new ApprovalService();
    this.orderManager = new OrderManager();
    this.fillTracker = new FillTracker();
    this.marketCatalog = new MarketCatalog();

    this._enableWs = opts.enableWs ?? isLive;
    this._enableApprovals = opts.enableApprovals ?? isLive;

    /** @type {{ getBook: Function, updateSubscriptions: Function, close: Function }|null} */
    this._clobWs = null;

    /** @type {boolean} */
    this._initialized = false;
  }

  /**
   * Initialize all services.
   * Lifecycle: sync markets -> approve tokens -> start WS
   */
  async initialize() {
    console.log('PolymarketService: Initializing...');

    // 1. Sync markets first (need tokenIds for approvals + WS)
    try {
      await this.marketCatalog.sync();
      console.log('PolymarketService: Market synced:', this.marketCatalog.getCurrentMarket()?.slug ?? 'none');
    } catch (e) {
      console.warn('PolymarketService: Market sync failed:', e?.message);
    }

    // 2. Start background market sync
    this.marketCatalog.startBackgroundSync();

    // 3. Proactive approvals (if live)
    if (this._enableApprovals) {
      const tokenIds = this.marketCatalog.getAllKnownTokenIds();
      this.approvalService.runStartupApprovals(tokenIds).catch((e) => {
        console.warn('PolymarketService: Startup approvals failed:', e?.message);
      });
    }

    // 4. Start CLOB WS orderbook stream (if enabled)
    if (this._enableWs) {
      try {
        const tokenIds = this.marketCatalog.getAllKnownTokenIds();
        this._clobWs = startClobOrderbookStream({
          tokenIds,
          onBookUpdate: (tokenId, snapshot) => {
            // Could emit events or update global state here
          },
        });
      } catch (e) {
        console.warn('PolymarketService: CLOB WS start failed:', e?.message);
      }
    }

    // Expose MarketCatalog globally for the /api/markets endpoint
    globalThis.__marketCatalog = this.marketCatalog;

    this._initialized = true;
    console.log('PolymarketService: Initialization complete.');
  }

  /**
   * Get the CLOB WS book for a token (if available).
   * @param {string} tokenId
   * @returns {{ bestBid: number|null, bestAsk: number|null, spread: number|null }|null}
   */
  getWsBook(tokenId) {
    return this._clobWs?.getBook?.(tokenId) ?? null;
  }

  /**
   * Update WS subscriptions (e.g., on market rollover).
   * @param {string[]} tokenIds
   */
  updateWsSubscriptions(tokenIds) {
    if (this._clobWs) {
      this._clobWs.updateSubscriptions(tokenIds);
    }
  }

  /**
   * Get a full status snapshot for the API.
   */
  getStatus() {
    return {
      initialized: this._initialized,
      market: this.marketCatalog.getSnapshot(),
      fees: this.feeService.getSnapshot(),
      approvals: this.approvalService.getStatus(),
      orders: this.orderManager.getSnapshot(),
      fills: this.fillTracker.getSnapshot(),
      wsConnected: this._clobWs !== null,
    };
  }

  /**
   * Graceful shutdown.
   */
  shutdown() {
    this.marketCatalog.stop();
    if (this._clobWs) {
      this._clobWs.close();
      this._clobWs = null;
    }
    console.log('PolymarketService: Shut down.');
  }
}
