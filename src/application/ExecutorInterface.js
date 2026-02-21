/**
 * @file Abstract base class for order executors.
 *
 * Both PaperExecutor and LiveExecutor implement this interface so the
 * TradingEngine can swap them without knowing which is active.
 *
 * This is a plain JS class with JSDoc types — no TypeScript.
 */

/** @import { OrderRequest, OrderResult, CloseRequest, CloseResult, PositionView, BalanceSnapshot } from '../domain/types.js' */

export class OrderExecutor {
  /**
   * One-time initialization (load ledger, connect to CLOB, etc.).
   * Called once at startup.
   */
  async initialize() {
    throw new Error('OrderExecutor.initialize() not implemented');
  }

  /**
   * Open a new position.
   * @param {OrderRequest} request
   * @returns {Promise<OrderResult>}
   */
  async openPosition(request) {
    throw new Error('OrderExecutor.openPosition() not implemented');
  }

  /**
   * Close (fully or partially) an existing position.
   * @param {CloseRequest} request
   * @returns {Promise<CloseResult>}
   */
  async closePosition(request) {
    throw new Error('OrderExecutor.closePosition() not implemented');
  }

  /**
   * Return all currently open positions as PositionView[].
   * For paper: the single openTrade (if any).
   * For live: computed from CLOB trade history.
   *
   * @param {Object} signals - Current signals (used by live to fetch market data)
   * @returns {Promise<PositionView[]>}
   */
  async getOpenPositions(signals) {
    throw new Error('OrderExecutor.getOpenPositions() not implemented');
  }

  /**
   * Update mark prices and unrealized PnL on an array of positions.
   * The executor knows how to price its own positions (paper uses poly
   * prices from signals; live uses CLOB orderbook midpoint).
   *
   * @param {PositionView[]} positions
   * @param {Object} signals
   * @returns {Promise<PositionView[]>}
   */
  async markPositions(positions, signals) {
    throw new Error('OrderExecutor.markPositions() not implemented');
  }

  /**
   * Return current account balance.
   * @returns {Promise<BalanceSnapshot>}
   */
  async getBalance() {
    throw new Error('OrderExecutor.getBalance() not implemented');
  }

  /**
   * Return the mode this executor represents.
   * @returns {'paper' | 'live'}
   */
  getMode() {
    throw new Error('OrderExecutor.getMode() not implemented');
  }
}
