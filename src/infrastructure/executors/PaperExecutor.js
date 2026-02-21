/**
 * @file Paper-trading executor with CLOB-simulated fills.
 *
 * Instead of instant fills at mid-price, this executor walks the real
 * CLOB orderbook to compute a volume-weighted average fill price that
 * includes realistic slippage. Entry and exit use the live orderbook
 * from Polymarket's CLOB endpoint.
 *
 * Implements the OrderExecutor interface so the TradingEngine can swap
 * between PaperExecutor and LiveExecutor without changes.
 */

import { OrderExecutor } from '../../application/ExecutorInterface.js';
import { capPnl } from '../../domain/exitEvaluator.js';
import {
  loadLedger,
  addTrade,
  updateTrade,
  getOpenTrade as ledgerGetOpenTrade,
  getLedger,
  recalculateSummary,
  initializeLedger,
} from '../../paper_trading/ledger.js';
import { fetchOrderBook, fetchClobPrice } from '../../data/polymarket.js';
import { CONFIG } from '../../config.js';
import { pickTokenId } from '../market/tokenMapping.js';

/** @import { OrderRequest, OrderResult, CloseRequest, CloseResult, PositionView, BalanceSnapshot } from '../../domain/types.js' */

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

export class PaperExecutor extends OrderExecutor {
  /**
   * @param {Object} opts
   * @param {Object} opts.config  - Merged trading config
   * @param {Function} opts.getMarket - Returns the current Polymarket market object
   */
  constructor({ config, getMarket }) {
    super();
    this.config = config;
    this.getMarket = getMarket;

    /** @type {Object|null} Currently open paper trade */
    this.openTrade = null;
  }

  getMode() {
    return 'paper';
  }

  async initialize() {
    await initializeLedger();
    this.openTrade = ledgerGetOpenTrade() || null;

    // Guard against corrupted open trades
    if (this.openTrade) {
      const t = this.openTrade;
      const badPrice =
        typeof t.entryPrice !== 'number' ||
        !Number.isFinite(t.entryPrice) ||
        t.entryPrice <= 0;
      const badShares =
        t.shares !== null &&
        t.shares !== undefined &&
        (!Number.isFinite(Number(t.shares)) || Number(t.shares) <= 0);

      if (badPrice || badShares) {
        console.warn('PaperExecutor: Invalid open trade found; force-closing.');
        await updateTrade(t.id, {
          status: 'CLOSED',
          exitPrice: t.exitPrice ?? null,
          exitTime: new Date().toISOString(),
          pnl: 0,
          exitReason: 'Invalid Entry (sanity check)',
        });
        this.openTrade = null;
      }
    }

    console.log(
      'PaperExecutor initialized. Open trade:',
      this.openTrade ? this.openTrade.id?.substring(0, 8) : 'None',
    );
  }

  // ─── OrderExecutor interface ─────────────────────────────────

  /**
   * Open a position with CLOB-simulated fill.
   * @param {OrderRequest} request
   * @returns {Promise<OrderResult>}
   */
  async openPosition(request) {
    const { side, marketSlug, sizeUsd, price, phase, sideInferred, metadata } = request;

    // Try to simulate fill via live orderbook
    let fillPrice = price;
    let fillShares = price > 0 ? sizeUsd / price : 0;

    const market = this.getMarket();
    const tokenId = market ? pickTokenId(market, side) : null;

    if (tokenId) {
      try {
        const fill = await this._simulateFill(tokenId, sizeUsd, 'BUY');
        if (fill) {
          fillPrice = fill.vwapPrice;
          fillShares = fill.totalShares;
        }
      } catch (e) {
        // Fallback to simple price
        console.debug('PaperExecutor: orderbook fill simulation failed, using simple price:', e?.message);
      }
    }

    if (!isNum(fillPrice) || fillPrice <= 0 || !isNum(fillShares) || fillShares <= 0) {
      return { filled: false, tradeId: null, fillPrice: 0, fillShares: 0, fillSizeUsd: 0 };
    }

    const tradeId = Date.now().toString() + Math.random().toString(36).substring(2, 8);
    const fillSizeUsd = fillShares * fillPrice;

    const trade = {
      id: tradeId,
      timestamp: new Date().toISOString(),
      marketSlug,
      side,
      instrument: 'POLY',
      entryPrice: fillPrice,
      shares: fillShares,
      contractSize: fillSizeUsd,
      status: 'OPEN',
      entryTime: new Date().toISOString(),
      exitPrice: null,
      exitTime: null,
      pnl: 0,
      entryPhase: phase,
      entryReason: sideInferred ? 'Inferred' : 'Rec',
      maxUnrealizedPnl: 0,
      minUnrealizedPnl: 0,
      tokenID: tokenId,
      ...metadata,
    };

    await addTrade(trade);
    this.openTrade = trade;

    return {
      filled: true,
      tradeId,
      fillPrice,
      fillShares,
      fillSizeUsd,
    };
  }

  /**
   * Close a position with CLOB-simulated exit fill.
   * @param {CloseRequest} request
   * @returns {Promise<CloseResult>}
   */
  async closePosition(request) {
    const { tradeId, side, shares, reason, tokenID } = request;
    const trade = this.openTrade;

    if (!trade) {
      return { closed: false, exitPrice: 0, pnl: 0, reason };
    }

    // Compute exit price via CLOB simulation or fallback
    let exitPrice = null;
    const exitTokenId = tokenID || trade.tokenID;

    if (exitTokenId) {
      try {
        const estNotional = (trade.shares || shares) * (trade.entryPrice || 0.50);
        const fill = await this._simulateFill(exitTokenId, estNotional, 'SELL');
        if (fill) {
          exitPrice = fill.vwapPrice;
        }
      } catch {
        // fallback below
      }
    }

    // Fallback: fetch simple CLOB price
    if (!isNum(exitPrice) && exitTokenId) {
      try {
        exitPrice = await fetchClobPrice({ tokenId: exitTokenId, side: 'sell' });
      } catch {
        // ignore
      }
    }

    // Final fallback: entry price (flat close)
    if (!isNum(exitPrice)) {
      exitPrice = trade.entryPrice;
    }

    // Compute PnL
    const tradeShares = isNum(trade.shares) ? trade.shares : (trade.entryPrice > 0 ? trade.contractSize / trade.entryPrice : 0);
    const valueNow = tradeShares * exitPrice;
    let rawPnl = valueNow - trade.contractSize;

    // Apply max-loss cap
    const { pnl, exitPrice: cappedExitPrice } = capPnl(
      rawPnl,
      trade.contractSize,
      tradeShares,
      exitPrice,
      this.config,
    );

    // Only override the reason if the loss was actually capped
    let finalReason = reason;
    const maxLossAbs = Math.abs(this.config.maxLossUsdPerTrade ?? 0);
    if (rawPnl < -maxLossAbs && pnl !== rawPnl) {
      finalReason = `Max Loss ($${maxLossAbs.toFixed(2)})`;
    }

    // Update trade in ledger
    trade.exitPrice = cappedExitPrice;
    trade.exitTime = new Date().toISOString();
    trade.pnl = Number(pnl.toFixed(2));
    trade.status = 'CLOSED';
    trade.exitReason = finalReason;

    await updateTrade(trade.id, trade);
    this.openTrade = null;

    return {
      closed: true,
      exitPrice: cappedExitPrice,
      pnl: trade.pnl,
      reason: finalReason,
    };
  }

  /**
   * @param {Object} signals
   * @returns {Promise<PositionView[]>}
   */
  async getOpenPositions(signals) {
    // Re-read from ledger in case it was updated externally
    this.openTrade = ledgerGetOpenTrade() || null;

    if (!this.openTrade) return [];

    const t = this.openTrade;
    return [
      {
        id: t.id,
        side: t.side,
        marketSlug: t.marketSlug,
        entryPrice: t.entryPrice,
        shares: t.shares,
        contractSize: t.contractSize,
        mark: null,
        unrealizedPnl: null,
        maxUnrealizedPnl: t.maxUnrealizedPnl ?? 0,
        minUnrealizedPnl: t.minUnrealizedPnl ?? 0,
        entryTime: t.entryTime,
        lastTradeTime: null,
        tokenID: t.tokenID || null,
      },
    ];
  }

  /**
   * @param {PositionView[]} positions
   * @param {Object} signals
   * @returns {Promise<PositionView[]>}
   */
  async markPositions(positions, signals) {
    return positions.map((p) => {
      // Determine current price from Polymarket prices
      const poly = signals.polyMarketSnapshot;
      const rawUpC = signals.polyPricesCents?.UP ?? null;
      const rawDownC = signals.polyPricesCents?.DOWN ?? null;

      const obUp = poly?.orderbook?.up;
      const obDown = poly?.orderbook?.down;

      // For marking, use the sell-side price (bid) since that's what we'd get if we sold
      let mark = null;
      if (p.side === 'UP') {
        mark = isNum(rawUpC) && rawUpC > 0
          ? rawUpC / 100
          : (isNum(obUp?.bestBid) && obUp.bestBid > 0 ? obUp.bestBid : null);
      } else {
        mark = isNum(rawDownC) && rawDownC > 0
          ? rawDownC / 100
          : (isNum(obDown?.bestBid) && obDown.bestBid > 0 ? obDown.bestBid : null);
      }

      let unrealizedPnl = null;
      if (isNum(mark) && isNum(p.shares) && isNum(p.contractSize)) {
        unrealizedPnl = p.shares * mark - p.contractSize;
      }

      return { ...p, mark, unrealizedPnl };
    });
  }

  /**
   * @returns {Promise<BalanceSnapshot>}
   */
  async getBalance() {
    const ledger = getLedger();
    const summary = ledger.summary ?? recalculateSummary(ledger.trades ?? []);
    const starting = this.config.startingBalance ?? CONFIG.paperTrading.startingBalance ?? 1000;
    const baseRealized = typeof summary.totalPnL === 'number' ? summary.totalPnL : 0;
    const offset =
      ledger.meta &&
      typeof ledger.meta.realizedOffset === 'number' &&
      Number.isFinite(ledger.meta.realizedOffset)
        ? ledger.meta.realizedOffset
        : 0;
    const realized = baseRealized + offset;
    const balance = starting + realized;
    return { balance, starting, realized };
  }

  // ─── CLOB Simulation ────────────────────────────────────────

  /**
   * Simulate an order fill by walking the live CLOB orderbook.
   * Returns a VWAP fill price that reflects actual orderbook depth/slippage.
   *
   * @param {string} tokenId    - CLOB token ID
   * @param {number} notionalUsd - Dollar amount to fill
   * @param {'BUY'|'SELL'} direction
   * @returns {Promise<{ vwapPrice: number, totalShares: number, levelsConsumed: number }|null>}
   */
  async _simulateFill(tokenId, notionalUsd, direction) {
    const book = await fetchOrderBook({ tokenId });
    if (!book) return null;

    // BUY walks the ask ladder (ascending price); SELL walks the bid ladder (descending price)
    const levels = direction === 'BUY'
      ? (Array.isArray(book.asks) ? book.asks : [])
      : (Array.isArray(book.bids) ? book.bids : []);

    if (!levels.length) return null;

    // Sort: asks ascending, bids descending
    const sorted = [...levels].sort((a, b) => {
      const pa = Number(a.price);
      const pb = Number(b.price);
      return direction === 'BUY' ? pa - pb : pb - pa;
    });

    let remainingUsd = notionalUsd;
    let totalShares = 0;
    let totalCost = 0;
    let levelsConsumed = 0;

    for (const level of sorted) {
      if (remainingUsd <= 0) break;

      const px = Number(level.price);
      const sz = Number(level.size);
      if (!isNum(px) || px <= 0 || !isNum(sz) || sz <= 0) continue;

      const levelNotional = px * sz; // Max USD at this level
      const fillUsd = Math.min(remainingUsd, levelNotional);
      const fillShares = fillUsd / px;

      totalShares += fillShares;
      totalCost += fillUsd;
      remainingUsd -= fillUsd;
      levelsConsumed++;
    }

    if (totalShares <= 0 || totalCost <= 0) return null;

    return {
      vwapPrice: totalCost / totalShares,
      totalShares,
      levelsConsumed,
    };
  }
}
