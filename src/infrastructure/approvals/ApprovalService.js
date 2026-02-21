/**
 * @file Proactive approvals service for Polymarket CLOB.
 *
 * Manages COLLATERAL and CONDITIONAL token allowances. Instead of
 * checking/approving on every trade, this service:
 *
 * 1. Runs startup approvals for known token IDs (proactive).
 * 2. Provides `checkAndApproveCollateral()` and `checkAndApproveConditional(tokenId)`.
 * 3. Exposes approval status via `getStatus()` for the API.
 *
 * Replaces the inline allowance logic that was previously scattered
 * across LiveExecutor.closePosition() and _ensureConditionalAllowanceBestEffort().
 */

import { getClobClient } from '../../live_trading/clob.js';

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * @typedef {Object} ApprovalStatus
 * @property {'approved'|'pending'|'failed'|'unknown'} state
 * @property {number} balance
 * @property {number} allowance
 * @property {string|null} lastCheckedAt
 * @property {string|null} error
 */

export class ApprovalService {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.recheckCooldownMs] - Min time between re-checks per token (default 5 min)
   */
  constructor(opts = {}) {
    this.recheckCooldownMs = opts.recheckCooldownMs ?? 5 * 60_000;

    /** @type {import('@polymarket/clob-client').ClobClient|null} */
    this._client = null;

    /** @type {Map<string, { state: string, balance: number, allowance: number, lastCheckedAt: number, error: string|null }>} */
    this._conditionalStatus = new Map();

    /** @type {{ state: string, balance: number, allowance: number, lastCheckedAt: number, error: string|null }} */
    this._collateralStatus = {
      state: 'unknown',
      balance: 0,
      allowance: 0,
      lastCheckedAt: 0,
      error: null,
    };

    /** @type {Map<string, number>} */
    this._lastCheckByToken = new Map();
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
        // Will be null — callers handle gracefully
      }
    }
    return this._client;
  }

  /**
   * Check and approve collateral (USDC) allowance.
   * @returns {Promise<ApprovalStatus>}
   */
  async checkAndApproveCollateral() {
    const client = this._getClient();
    if (!client) {
      this._collateralStatus = {
        state: 'failed',
        balance: 0,
        allowance: 0,
        lastCheckedAt: Date.now(),
        error: 'CLOB client not available',
      };
      return this._formatStatus(this._collateralStatus);
    }

    try {
      let ba = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      let balance = Number(ba?.balance ?? 0);
      let allowance = Number(ba?.allowance ?? 0);

      if (!isNum(allowance) || allowance <= 0) {
        console.log('ApprovalService: Approving COLLATERAL allowance...');
        await client.updateBalanceAllowance({ asset_type: 'COLLATERAL' });

        ba = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
        balance = Number(ba?.balance ?? 0);
        allowance = Number(ba?.allowance ?? 0);
      }

      const approved = isNum(allowance) && allowance > 0;
      this._collateralStatus = {
        state: approved ? 'approved' : 'pending',
        balance,
        allowance,
        lastCheckedAt: Date.now(),
        error: null,
      };
    } catch (e) {
      this._collateralStatus = {
        state: 'failed',
        balance: 0,
        allowance: 0,
        lastCheckedAt: Date.now(),
        error: e?.message || String(e),
      };
    }

    return this._formatStatus(this._collateralStatus);
  }

  /**
   * Check and approve conditional token allowance.
   * Respects cooldown to avoid spamming the API.
   *
   * @param {string} tokenId - CLOB token ID
   * @param {Object} [opts]
   * @param {boolean} [opts.force] - Ignore cooldown
   * @returns {Promise<ApprovalStatus>}
   */
  async checkAndApproveConditional(tokenId, opts = {}) {
    if (!tokenId) {
      return this._formatStatus({
        state: 'failed',
        balance: 0,
        allowance: 0,
        lastCheckedAt: Date.now(),
        error: 'No tokenId provided',
      });
    }

    // Cooldown check
    const now = Date.now();
    const lastCheck = this._lastCheckByToken.get(tokenId) ?? 0;
    if (!opts.force && (now - lastCheck) < this.recheckCooldownMs) {
      const cached = this._conditionalStatus.get(tokenId);
      if (cached) return this._formatStatus(cached);
    }
    this._lastCheckByToken.set(tokenId, now);

    const client = this._getClient();
    if (!client) {
      const status = {
        state: 'failed',
        balance: 0,
        allowance: 0,
        lastCheckedAt: now,
        error: 'CLOB client not available',
      };
      this._conditionalStatus.set(tokenId, status);
      return this._formatStatus(status);
    }

    try {
      let ba = await client.getBalanceAllowance({
        asset_type: 'CONDITIONAL',
        token_id: tokenId,
      });
      let balance = Number(ba?.balance ?? 0);
      let allowance = Number(ba?.allowance ?? 0);

      // Only approve if there's a balance but no allowance
      if (
        isNum(balance) && balance > 0 &&
        (!isNum(allowance) || allowance <= 0)
      ) {
        console.log(`ApprovalService: Approving CONDITIONAL for ${tokenId.substring(0, 12)}...`);
        await client.updateBalanceAllowance({
          asset_type: 'CONDITIONAL',
          token_id: tokenId,
        });

        ba = await client.getBalanceAllowance({
          asset_type: 'CONDITIONAL',
          token_id: tokenId,
        });
        balance = Number(ba?.balance ?? 0);
        allowance = Number(ba?.allowance ?? 0);
      }

      const approved = isNum(allowance) && allowance > 0;
      const status = {
        state: approved ? 'approved' : (isNum(balance) && balance > 0 ? 'pending' : 'unknown'),
        balance,
        allowance,
        lastCheckedAt: now,
        error: null,
      };
      this._conditionalStatus.set(tokenId, status);
      return this._formatStatus(status);
    } catch (e) {
      const status = {
        state: 'failed',
        balance: 0,
        allowance: 0,
        lastCheckedAt: now,
        error: e?.message || String(e),
      };
      this._conditionalStatus.set(tokenId, status);
      return this._formatStatus(status);
    }
  }

  /**
   * Run startup approvals for collateral + known conditional tokens.
   * Best-effort — failures are logged but don't throw.
   *
   * @param {string[]} [knownTokenIds] - Token IDs to pre-approve
   */
  async runStartupApprovals(knownTokenIds = []) {
    console.log('ApprovalService: Running startup approvals...');

    // Collateral first
    try {
      await this.checkAndApproveCollateral();
      console.log(`ApprovalService: Collateral status: ${this._collateralStatus.state}`);
    } catch (e) {
      console.warn('ApprovalService: Startup collateral approval failed:', e?.message);
    }

    // Conditional tokens
    for (const tokenId of knownTokenIds) {
      try {
        await this.checkAndApproveConditional(tokenId, { force: true });
        const st = this._conditionalStatus.get(tokenId);
        console.log(`ApprovalService: Conditional ${tokenId.substring(0, 12)}... status: ${st?.state}`);
      } catch (e) {
        console.warn(`ApprovalService: Startup conditional approval failed for ${tokenId}:`, e?.message);
      }
    }

    console.log('ApprovalService: Startup approvals complete.');
  }

  /**
   * Get the sellable quantity for a conditional token (min of balance, allowance).
   * Used by LiveExecutor.closePosition() to determine max sell size.
   *
   * @param {string} tokenId
   * @returns {Promise<number>} Max sellable quantity (floored integer)
   */
  async getSellableQty(tokenId) {
    const status = await this.checkAndApproveConditional(tokenId);
    const balance = isNum(status.balance) ? status.balance : 0;
    const allowance = isNum(status.allowance) ? status.allowance : 0;
    return Math.floor(Math.min(balance, allowance));
  }

  /**
   * Get full approval status for API display.
   * @returns {{ collateral: ApprovalStatus, conditional: Record<string, ApprovalStatus> }}
   */
  getStatus() {
    const conditional = {};
    for (const [tokenId, entry] of this._conditionalStatus) {
      conditional[tokenId] = this._formatStatus(entry);
    }
    return {
      collateral: this._formatStatus(this._collateralStatus),
      conditional,
    };
  }

  /**
   * @param {{ state: string, balance: number, allowance: number, lastCheckedAt: number, error: string|null }} entry
   * @returns {ApprovalStatus}
   */
  _formatStatus(entry) {
    return {
      state: entry.state,
      balance: entry.balance,
      allowance: entry.allowance,
      lastCheckedAt: entry.lastCheckedAt > 0 ? new Date(entry.lastCheckedAt).toISOString() : null,
      error: entry.error,
    };
  }
}
