/**
 * @file Live-trading executor using real CLOB orders.
 *
 * Implements the OrderExecutor interface. Delegates to @polymarket/clob-client
 * for actual order placement. Reuses existing position tracking and PnL
 * computation modules.
 */

import { OrderExecutor } from '../../application/ExecutorInterface.js';
import { getClobClient } from '../../live_trading/clob.js';
import { appendLiveTrade, initializeLiveLedger } from '../../live_trading/ledger.js';
import {
  computePositionsFromTrades,
  enrichPositionsWithMarks,
} from '../../live_trading/positions.js';
import { fetchClobPrice } from '../../data/polymarket.js';
import { CONFIG } from '../../config.js';
import { FeeService } from '../fees/FeeService.js';
import { ApprovalService } from '../approvals/ApprovalService.js';
import { OrderManager } from '../orders/OrderManager.js';
import { pickTokenId } from '../market/tokenMapping.js';

/** @import { OrderRequest, OrderResult, CloseRequest, CloseResult, PositionView, BalanceSnapshot } from '../../domain/types.js' */

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

export class LiveExecutor extends OrderExecutor {
  /**
   * @param {Object} opts
   * @param {Object} opts.config    - Merged trading config
   * @param {Function} opts.getMarket - Returns the current Polymarket market object
   */
  constructor({ config, getMarket }) {
    super();
    this.config = config;
    this.getMarket = getMarket;
    this.client = getClobClient();

    // Fee observability (SDK handles actual fee injection; this is for logging/UI)
    this.feeService = new FeeService({
      cacheTtlMs: CONFIG.liveTrading?.feeCacheTtlMs ?? 30_000,
      alertThresholdBps: CONFIG.liveTrading?.feeRateAlertThresholdBps ?? 300,
    });

    // Proactive approvals (collateral + conditional tokens)
    this.approvalService = new ApprovalService();

    // Order lifecycle tracking
    this.orderManager = new OrderManager();

    // Cached CLOB trades for position computation
    this._cachedTrades = [];
    this._lastTradesFetchAttemptMs = 0;
    this._lastTradesFetchSuccessMs = 0;

    // Adaptive polling hint
    this._hadPositionLastLoop = false;

    // Exit spam guard (30s cooldown per tokenID)
    this._lastExitAttemptMsByToken = new Map();
  }

  getMode() {
    return 'live';
  }

  async initialize() {
    await initializeLiveLedger();

    // Run startup approvals (best-effort — doesn't block trading)
    this.approvalService.runStartupApprovals().catch((e) => {
      console.warn('LiveExecutor: Startup approvals failed:', e?.message);
    });

    console.log('LiveExecutor initialized.');
  }

  // ─── OrderExecutor interface ─────────────────────────────────

  /**
   * @param {OrderRequest} request
   * @returns {Promise<OrderResult>}
   */
  async openPosition(request) {
    const { side, marketSlug, sizeUsd, price, phase, metadata } = request;

    const market = this.getMarket();
    const tokenID = market ? pickTokenId(market, side) : null;
    if (!tokenID) {
      return { filled: false, tradeId: null, fillPrice: 0, fillShares: 0, fillSizeUsd: 0 };
    }

    // Check collateral
    const collateral = await this._collateralUsd();
    const maxPer = CONFIG.liveTrading?.maxPerTradeUsd || sizeUsd;
    const usd = Math.min(
      maxPer,
      collateral,
      CONFIG.liveTrading?.maxOpenExposureUsd || maxPer,
    );
    if (!isNum(usd) || usd <= 0) {
      return { filled: false, tradeId: null, fillPrice: 0, fillShares: 0, fillSizeUsd: 0 };
    }

    // Fetch live buy price
    let buyPrice = price;
    try {
      const px = await fetchClobPrice({ tokenId: tokenID, side: 'buy' });
      if (isNum(px) && px > 0) buyPrice = px;
    } catch {
      // use passed price
    }

    const size = Math.max(5, Math.floor(usd / buyPrice));

    // ── Order validation ─────────────────────────────────────────
    if (size < 5) {
      console.warn(`[live] Order rejected: size ${size} < CLOB minimum 5`);
      return { filled: false, tradeId: null, fillPrice: 0, fillShares: 0, fillSizeUsd: 0 };
    }
    if (!isNum(buyPrice) || buyPrice < 0.001 || buyPrice > 0.999) {
      console.warn(`[live] Order rejected: price ${buyPrice} outside [0.001, 0.999]`);
      return { filled: false, tradeId: null, fillPrice: 0, fillShares: 0, fillSizeUsd: 0 };
    }
    const maxPerTrade = CONFIG.liveTrading?.maxPerTradeUsd ?? Infinity;
    if (size * buyPrice > maxPerTrade) {
      console.warn(`[live] Order rejected: notional $${(size * buyPrice).toFixed(2)} > maxPerTradeUsd $${maxPerTrade}`);
      return { filled: false, tradeId: null, fillPrice: 0, fillShares: 0, fillSizeUsd: 0 };
    }

    // Fetch fee rate for observability (SDK handles actual fee injection)
    let feeRateBps = null;
    let feeImpact = null;
    try {
      feeRateBps = await this.feeService.getFeeRateBps(tokenID);
      if (feeRateBps !== null) {
        feeImpact = this.feeService.computeFeeImpact(buyPrice * size, buyPrice, feeRateBps);
        console.log(
          `[live] Fee: ${feeRateBps} bps (${(feeRateBps / 100).toFixed(2)}%) | est. $${feeImpact.feeUsd.toFixed(4)} on $${(buyPrice * size).toFixed(2)} notional`,
        );
      }
    } catch {
      // Fee lookup is best-effort observability
    }

    try {
      // Dynamic import to avoid crashing if the library isn't installed
      const { OrderType } = await import('@polymarket/clob-client');

      const resp = await this.client.createAndPostOrder(
        { tokenID, price: buyPrice, size, side: 'BUY' },
        {},
        OrderType.GTC,
        false,
        Boolean(CONFIG.liveTrading?.postOnly),
      );

      // Track order in OrderManager
      if (resp?.orderID) {
        this.orderManager.trackOrder(resp.orderID, {
          tokenID, side: 'BUY', price: buyPrice, size,
          extra: { marketSlug, phase, type: 'OPEN' },
        });
      }

      await appendLiveTrade({
        type: 'OPEN',
        ts: new Date().toISOString(),
        marketSlug,
        side,
        tokenID,
        price: buyPrice,
        size,
        usdNotional: buyPrice * size,
        orderID: resp?.orderID || null,
        feeRateBps,
        feeImpact,
        resp,
      });

      return {
        filled: true,
        tradeId: tokenID,
        fillPrice: buyPrice,
        fillShares: size,
        fillSizeUsd: buyPrice * size,
        orderId: resp?.orderID || null,
      };
    } catch (e) {
      await appendLiveTrade({
        type: 'OPEN_FAILED',
        ts: new Date().toISOString(),
        marketSlug,
        side,
        tokenID,
        error: e?.response?.data || e?.message || String(e),
      });
      return { filled: false, tradeId: null, fillPrice: 0, fillShares: 0, fillSizeUsd: 0 };
    }
  }

  /**
   * @param {CloseRequest} request
   * @returns {Promise<CloseResult>}
   */
  async closePosition(request) {
    const { tradeId, side, shares, reason, tokenID } = request;
    const tid = tokenID || tradeId;

    if (!tid) {
      return { closed: false, exitPrice: 0, pnl: 0, reason };
    }

    // Exit spam guard (30s cooldown)
    const cooldownMs = 30_000;
    const now = Date.now();
    const lastAttempt = this._lastExitAttemptMsByToken.get(tid) ?? 0;
    if (now - lastAttempt < cooldownMs) {
      return { closed: false, exitPrice: 0, pnl: 0, reason: 'Exit cooldown' };
    }
    this._lastExitAttemptMsByToken.set(tid, now);

    // Refresh trade snapshot
    try {
      this._cachedTrades = await this.client.getTrades();
      this._lastTradesFetchSuccessMs = now;
    } catch {
      // best-effort
    }

    let size = Math.max(5, Math.floor(Number(shares)));

    // Ensure conditional token allowance via ApprovalService
    try {
      const maxSell = Math.min(size, await this.approvalService.getSellableQty(tid));

      if (maxSell < 5) {
        const approvalStatus = this.approvalService.getStatus().conditional[tid];
        await appendLiveTrade({
          type: 'EXIT_SELL_SKIPPED',
          ts: new Date().toISOString(),
          tokenID: tid,
          reason,
          note: `Insufficient conditional balance/allowance (bal=${approvalStatus?.balance ?? '?'}, allow=${approvalStatus?.allowance ?? '?'})`,
        });
        return { closed: false, exitPrice: 0, pnl: 0, reason };
      }
      size = maxSell;
    } catch {
      // best-effort; proceed with requested size
    }

    // Fetch sell price
    let sellPrice = null;
    try {
      sellPrice = await fetchClobPrice({ tokenId: tid, side: 'sell' });
    } catch {
      sellPrice = null;
    }
    if (!isNum(sellPrice) || sellPrice <= 0) {
      sellPrice = 0.01; // fallback: will almost certainly fill
    }

    // Fetch fee rate for exit observability
    let exitFeeRateBps = null;
    let exitFeeImpact = null;
    try {
      exitFeeRateBps = await this.feeService.getFeeRateBps(tid);
      if (exitFeeRateBps !== null) {
        exitFeeImpact = this.feeService.computeFeeImpact(sellPrice * size, sellPrice, exitFeeRateBps);
        console.log(
          `[live] Exit fee: ${exitFeeRateBps} bps | est. $${exitFeeImpact.feeUsd.toFixed(4)} on $${(sellPrice * size).toFixed(2)} notional`,
        );
      }
    } catch {
      // best-effort
    }

    try {
      const { OrderType } = await import('@polymarket/clob-client');

      const resp = await this.client.createAndPostOrder(
        { tokenID: tid, price: sellPrice, size, side: 'SELL' },
        {},
        OrderType.GTC,
        false,
        false, // postOnly OFF for exits
      );

      // Track exit order in OrderManager
      if (resp?.orderID) {
        this.orderManager.trackOrder(resp.orderID, {
          tokenID: tid, side: 'SELL', price: sellPrice, size,
          extra: { reason, type: 'EXIT_SELL' },
        });
      }

      await appendLiveTrade({
        type: 'EXIT_SELL',
        ts: new Date().toISOString(),
        tokenID: tid,
        price: sellPrice,
        size,
        reason,
        feeRateBps: exitFeeRateBps,
        feeImpact: exitFeeImpact,
        resp,
      });

      // Clean up tracking state
      this._lastExitAttemptMsByToken.delete(tid);

      return {
        closed: true,
        exitPrice: sellPrice,
        pnl: 0, // Live PnL computed from trade history, not here
        reason,
      };
    } catch (e) {
      await appendLiveTrade({
        type: 'EXIT_SELL_FAILED',
        ts: new Date().toISOString(),
        tokenID: tid,
        price: sellPrice,
        size,
        reason,
        error: e?.response?.data || e?.message || String(e),
      });
      return { closed: false, exitPrice: 0, pnl: 0, reason };
    }
  }

  /**
   * @param {Object} signals
   * @returns {Promise<PositionView[]>}
   */
  async getOpenPositions(signals) {
    // Adaptive polling: faster when in position, slower when flat
    const now = Date.now();
    const interval = this._hadPositionLastLoop ? 1500 : 5000;
    const elapsed = now - this._lastTradesFetchAttemptMs;

    if (elapsed >= interval) {
      this._lastTradesFetchAttemptMs = now;
      try {
        this._cachedTrades = await this.client.getTrades();
        this._lastTradesFetchSuccessMs = now;
      } catch {
        // use cached
      }
    }

    const rawPositions = computePositionsFromTrades(this._cachedTrades);
    this._hadPositionLastLoop = rawPositions.length > 0;

    // Pre-approve conditional token allowance for any open position (via ApprovalService)
    for (const p of rawPositions) {
      if (p.tokenID) {
        // Fire-and-forget — ApprovalService handles its own cooldowns
        this.approvalService.checkAndApproveConditional(p.tokenID).catch(() => {});
      }
    }

    // Convert to PositionView[]
    return rawPositions.map((p) => ({
      id: p.tokenID,
      side: String(p.outcome || '').toUpperCase() === 'DOWN' ? 'DOWN' : 'UP',
      marketSlug: signals.market?.slug ?? 'unknown',
      entryPrice: p.avgEntry ?? 0,
      shares: p.qty,
      contractSize: (p.avgEntry ?? 0) * p.qty,
      mark: p.mark ?? null,
      unrealizedPnl: p.unrealizedPnl ?? null,
      maxUnrealizedPnl: 0, // Tracked by TradingState
      minUnrealizedPnl: 0,
      entryTime: null, // Live positions don't have a single entry time
      lastTradeTime: p.lastTradeTime ?? null,
      tokenID: p.tokenID,
      outcome: p.outcome,
      tradable: p.tradable !== false,
    }));
  }

  /**
   * @param {PositionView[]} positions
   * @param {Object} signals
   * @returns {Promise<PositionView[]>}
   */
  async markPositions(positions, signals) {
    // enrichPositionsWithMarks fetches orderbook midpoint for each token
    const rawPositions = positions.map((p) => ({
      tokenID: p.tokenID,
      qty: p.shares,
      avgEntry: p.entryPrice,
      outcome: p.outcome || p.side,
      lastTradeTime: p.lastTradeTime,
      buyQty: 0,
      buyNotional: 0,
      sellQty: 0,
      sellNotional: 0,
    }));

    const enriched = await enrichPositionsWithMarks(rawPositions);

    return positions.map((p, i) => {
      const e = enriched[i];
      if (!e) return p;
      return {
        ...p,
        mark: e.mark ?? p.mark,
        unrealizedPnl: e.unrealizedPnl ?? p.unrealizedPnl,
        tradable: e.tradable !== false,
      };
    });
  }

  /**
   * @returns {Promise<BalanceSnapshot>}
   */
  async getBalance() {
    const collateral = await this._collateralUsd();
    return {
      balance: collateral,
      starting: collateral, // Live doesn't have a "starting" concept
      realized: 0,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────

  async _collateralUsd() {
    try {
      const bal = await this.client.getBalanceAllowance({
        asset_type: 'COLLATERAL',
      });
      const base = Number(bal?.balance || 0);
      return base / 1e6; // 6 decimals
    } catch {
      return 0;
    }
  }

  // Note: Conditional allowance management is now delegated to this.approvalService.
  // See ApprovalService.checkAndApproveConditional() for the implementation.
}
