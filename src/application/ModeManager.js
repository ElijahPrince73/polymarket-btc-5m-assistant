/**
 * @file Session-only mode manager for paper/live switching.
 *
 * Holds references to both executors and tracks the current mode.
 * Mode is session-only — it resets to the initial mode on restart.
 */

import { CONFIG } from '../config.js';

/** @import { OrderExecutor } from './ExecutorInterface.js' */

export class ModeManager {
  /**
   * @param {Object} opts
   * @param {OrderExecutor} opts.paperExecutor
   * @param {OrderExecutor|null} opts.liveExecutor  - null if live trading not configured
   * @param {'paper'|'live'} [opts.initialMode='paper']
   */
  constructor({ paperExecutor, liveExecutor = null, initialMode = 'paper' }) {
    /** @type {OrderExecutor} */
    this._paperExecutor = paperExecutor;

    /** @type {OrderExecutor|null} */
    this._liveExecutor = liveExecutor;

    /** @type {'paper'|'live'} */
    this._mode = initialMode === 'live' && liveExecutor ? 'live' : 'paper';
  }

  /**
   * Get the currently active executor.
   * @returns {OrderExecutor}
   */
  getActiveExecutor() {
    return this._mode === 'live' && this._liveExecutor
      ? this._liveExecutor
      : this._paperExecutor;
  }

  /**
   * Switch the active mode. Throws if trying to switch to live without a live executor.
   *
   * @param {'paper'|'live'} mode
   * @returns {'paper'|'live'} The new active mode
   */
  switchMode(mode) {
    if (mode === 'live') {
      if (!this._liveExecutor) {
        throw new Error('Live trading is not configured. Set LIVE_TRADING_ENABLED=true and provide credentials.');
      }
      // Environment gate: prevent accidental live trading in dev
      const envGate = CONFIG.liveTrading?.envGate;
      if (envGate && envGate !== 'production') {
        throw new Error(`Live trading blocked: LIVE_ENV_GATE is "${envGate}" (must be "production").`);
      }
      this._mode = 'live';
    } else {
      this._mode = 'paper';
    }
    return this._mode;
  }

  /**
   * Get the current mode.
   * @returns {'paper'|'live'}
   */
  getMode() {
    return this._mode;
  }

  /**
   * Check if live trading is available (credentials configured).
   * @returns {boolean}
   */
  isLiveAvailable() {
    return this._liveExecutor !== null;
  }
}
