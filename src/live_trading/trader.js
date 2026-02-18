import { CONFIG } from '../config.js';
import { getClobClient } from './clob.js';
import { appendLiveTrade, initializeLiveLedger } from './ledger.js';
import { OrderType } from '@polymarket/clob-client';
import { fetchClobPrice } from '../data/polymarket.js';
import { computePositionsFromTrades, enrichPositionsWithMarks } from './positions.js';
import { computeRealizedPnlAvgCost } from './pnl.js';

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function pickTokenId(market, label) {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : JSON.parse(market?.outcomes || '[]');
  const clobTokenIds = Array.isArray(market?.clobTokenIds) ? market.clobTokenIds : JSON.parse(market?.clobTokenIds || '[]');
  for (let i = 0; i < outcomes.length; i += 1) {
    if (String(outcomes[i]).toLowerCase() === String(label).toLowerCase()) {
      const tid = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
      if (tid) return tid;
    }
  }
  return null;
}

export class LiveTrader {
  constructor() {
    this.client = getClobClient();

    // open *order* we placed (may fill quickly, so open order can be null even when positions exist)
    this.open = null;

    // trailing PnL state by tokenID
    this.maxUnrealizedByToken = new Map();

    // daily realized PnL (avg cost, best-effort)
    this.todayRealizedPnl = 0;
    this.todayKey = null;

    // throttle expensive calls
    this._lastTradesFetchMs = 0;
    this._cachedTrades = [];
  }

  async init() {
    await initializeLiveLedger();
  }

  // Midnight PT reset key
  _todayKey() {
    const d = new Date();
    // America/Los_Angeles is host timezone
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  _resetIfNeeded() {
    const k = this._todayKey();
    if (this.todayKey !== k) {
      this.todayKey = k;
      this.todayRealizedPnl = 0;
    }
  }

  async _collateralUsd() {
    const bal = await this.client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const base = Number(bal?.balance || 0);
    // 6 decimals
    return base / 1e6;
  }

  async processSignals(signals) {
    this._resetIfNeeded();

    if (!CONFIG.liveTrading?.enabled) return;

    const market = signals?.market;
    const marketSlug = market?.slug;
    const timeLeftMin = signals?.timeLeftMin;

    if (!market || !marketSlug) return;

    // Pull trades periodically (used to infer positions + realized PnL)
    const now = Date.now();
    if (now - this._lastTradesFetchMs > 5_000) {
      try {
        this._cachedTrades = await this.client.getTrades();
        this._lastTradesFetchMs = now;
      } catch {
        // keep old cache
      }
    }

    const positions = await enrichPositionsWithMarks(computePositionsFromTrades(this._cachedTrades));

    // Update daily realized PnL (avg-cost, best-effort)
    const pnl = computeRealizedPnlAvgCost(this._cachedTrades);
    this.todayRealizedPnl = pnl.realizedTotal;

    // Daily loss kill-switch
    if (this.todayRealizedPnl <= -Math.abs(CONFIG.liveTrading.maxDailyLossUsd || 0)) {
      return;
    }

    // --- EXIT LOGIC (fill-now exits) ---
    // If we have any position, we manage exits first.
    if (positions.length) {
      const exitBefore = CONFIG.paperTrading.exitBeforeEndMinutes ?? 1;

      for (const p of positions) {
        const tokenID = p.tokenID;
        const qty = Number(p.qty || 0);
        if (!tokenID || !isNum(qty) || qty <= 0) continue;

        const u = (typeof p.unrealizedPnl === 'number' && Number.isFinite(p.unrealizedPnl)) ? p.unrealizedPnl : null;

        // Track MFE for trailing exits
        if (u !== null) {
          const prevMax = this.maxUnrealizedByToken.get(tokenID) ?? u;
          this.maxUnrealizedByToken.set(tokenID, Math.max(prevMax, u));
        }

        // 1) Pre-settlement exit
        if (isNum(timeLeftMin) && timeLeftMin <= exitBefore) {
          await this._sellPosition({ tokenID, qty, reason: 'Pre-settlement Exit' });
          continue;
        }

        // 2) Rollover exit (position token should be tied to a market; best-effort: if market slug changes, still ok)
        // (We don't have per-position slug mapping here; rely on pre-settlement mostly.)

        // 3) Hard max loss
        const maxLossUsd = CONFIG.paperTrading.maxLossUsdPerTrade ?? 15;
        if (u !== null && u <= -Math.abs(maxLossUsd)) {
          await this._sellPosition({ tokenID, qty, reason: `Max Loss ($${Number(maxLossUsd).toFixed(2)})` });
          continue;
        }

        // 4) Trailing TP
        if (u !== null && (CONFIG.paperTrading.trailingTakeProfitEnabled ?? false)) {
          const start = CONFIG.paperTrading.trailingStartUsd ?? 20;
          const dd = CONFIG.paperTrading.trailingDrawdownUsd ?? 10;
          const maxU = this.maxUnrealizedByToken.get(tokenID) ?? null;
          if (isNum(start) && isNum(dd) && maxU !== null && maxU >= start) {
            const trail = maxU - dd;
            if (u <= trail) {
              await this._sellPosition({ tokenID, qty, reason: `Trailing TP (max $${maxU.toFixed(2)}; dd $${dd.toFixed(2)})` });
              continue;
            }
          }
        }
      }

      // If we have positions, do not enter new ones.
      return;
    }

    // --- ENTRY LOGIC ---
    const rec = signals?.rec;
    if (!rec) return;

    const upTokenId = pickTokenId(market, CONFIG.polymarket.upOutcomeLabel);
    const downTokenId = pickTokenId(market, CONFIG.polymarket.downOutcomeLabel);

    if (rec.action !== 'ENTER') return;

    const side = rec.side;
    const tokenID = side === 'DOWN' ? downTokenId : upTokenId;
    if (!tokenID) return;

    // Sizing
    const collateral = await this._collateralUsd();
    const maxPer = CONFIG.liveTrading.maxPerTradeUsd || 0;
    const usd = Math.min(maxPer, collateral, CONFIG.liveTrading.maxOpenExposureUsd || maxPer);
    if (!isNum(usd) || usd <= 0) return;

    // Price (BUY)
    let price = null;
    try {
      price = await fetchClobPrice({ tokenId: tokenID, side: 'buy' });
    } catch {
      price = null;
    }
    if (!isNum(price) || price <= 0) return;

    const size = Math.max(5, Math.floor(usd / price));

    try {
      const resp = await this.client.createAndPostOrder(
        { tokenID, price, size, side: 'BUY' },
        {},
        OrderType.GTC,
        false,
        Boolean(CONFIG.liveTrading.postOnly)
      );

      this.open = {
        openedAt: new Date().toISOString(),
        marketSlug,
        side,
        tokenID,
        price,
        size,
        orderID: resp?.orderID || null,
      };

      await appendLiveTrade({
        type: 'OPEN',
        ts: new Date().toISOString(),
        marketSlug,
        side,
        tokenID,
        price,
        size,
        usdNotional: price * size,
        orderID: resp?.orderID || null,
        resp,
      });
    } catch (e) {
      await appendLiveTrade({
        type: 'OPEN_FAILED',
        ts: new Date().toISOString(),
        marketSlug,
        side,
        tokenID,
        error: e?.response?.data || e?.message || String(e)
      });
    }
  }

  async _sellPosition({ tokenID, qty, reason }) {
    const size = Math.max(5, Math.floor(Number(qty)));

    // Ensure conditional token allowance is set (required for SELL).
    // If allowance is 0, attempt to set it via updateBalanceAllowance.
    try {
      const ba = await this.client.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenID });
      const allowance = Number(ba?.allowance ?? 0);
      if (!Number.isFinite(allowance) || allowance <= 0) {
        await this.client.updateBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenID });
      }
    } catch {
      // best-effort; proceed
    }

    // "fill-now" exit: use current sell quote (best bid) as a marketable limit.
    let price = null;
    try {
      price = await fetchClobPrice({ tokenId: tokenID, side: 'sell' });
    } catch {
      price = null;
    }
    if (!isNum(price) || price <= 0) {
      // fallback to something that will almost certainly fill
      price = 0.01;
    }

    try {
      const resp = await this.client.createAndPostOrder(
        { tokenID, price, size, side: 'SELL' },
        {},
        OrderType.GTC,
        false,
        false // postOnly OFF for exits
      );

      await appendLiveTrade({
        type: 'EXIT_SELL',
        ts: new Date().toISOString(),
        tokenID,
        price,
        size,
        reason,
        resp
      });

      // Reset trailing state so we don't re-trigger exits on a shrinking position
      this.maxUnrealizedByToken.delete(tokenID);
      this.open = null;

      return resp;
    } catch (e) {
      await appendLiveTrade({
        type: 'EXIT_SELL_FAILED',
        ts: new Date().toISOString(),
        tokenID,
        price,
        size,
        reason,
        error: e?.response?.data || e?.message || String(e)
      });
      return null;
    }
  }

  async _close(reason) {
    if (!this.open) return;

    // Cancel open order (if any)
    const { orderID } = this.open;
    if (orderID) {
      try {
        const resp = await this.client.cancelOrder({ orderID });
        await appendLiveTrade({ type: 'CANCEL', ts: new Date().toISOString(), orderID, reason, resp });
      } catch (e) {
        await appendLiveTrade({ type: 'CANCEL_FAILED', ts: new Date().toISOString(), orderID, reason, error: e?.response?.data || e?.message || String(e) });
      }
    }

    this.open = null;
  }
}

let singleton = null;
export async function initializeLiveTrader() {
  if (!singleton) {
    singleton = new LiveTrader();
    await singleton.init();
  }
  return singleton;
}

export function getLiveTrader() {
  return singleton;
}
