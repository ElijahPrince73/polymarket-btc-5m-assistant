import { CONFIG } from '../config.js';
import { getClobClient } from './clob.js';
import { appendLiveTrade, initializeLiveLedger } from './ledger.js';
import { OrderType } from '@polymarket/clob-client';
import { fetchClobPrice } from '../data/polymarket.js';

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
    this.open = null;
    this.todayRealizedPnl = 0;
    this.todayKey = null;
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

    // Daily loss kill-switch
    if (this.todayRealizedPnl <= -Math.abs(CONFIG.liveTrading.maxDailyLossUsd || 0)) {
      return;
    }

    const market = signals?.market;
    const marketSlug = market?.slug;
    const timeLeftMin = signals?.timeLeftMin;

    if (!market || !marketSlug) return;

    const rec = signals?.rec;
    if (!rec) return;

    const upTokenId = pickTokenId(market, CONFIG.polymarket.upOutcomeLabel);
    const downTokenId = pickTokenId(market, CONFIG.polymarket.downOutcomeLabel);

    // If we have an open position, exit near settlement.
    if (this.open) {
      const exitBefore = CONFIG.paperTrading.exitBeforeEndMinutes ?? 1;
      if (isNum(timeLeftMin) && timeLeftMin <= exitBefore) {
        await this._close('Pre-settlement Exit');
      }
      // Close on rollover
      if (this.open.marketSlug && marketSlug !== this.open.marketSlug) {
        await this._close('Market Rollover');
      }
      return;
    }

    // Entry
    if (rec.action !== 'ENTER') return;

    const side = rec.side;
    const tokenID = side === 'DOWN' ? downTokenId : upTokenId;
    if (!tokenID) return;

    // Sizing
    const collateral = await this._collateralUsd();
    const maxPer = CONFIG.liveTrading.maxPerTradeUsd || 0;
    const usd = Math.min(maxPer, collateral, CONFIG.liveTrading.maxOpenExposureUsd || maxPer);
    if (!isNum(usd) || usd <= 0) return;

    // Price: use current buy quote (marketable limit). If postOnly is enabled, lower it.
    let price = null;
    try {
      price = await fetchClobPrice({ tokenId: tokenID, side: 'buy' });
    } catch {
      price = null;
    }
    if (!isNum(price) || price <= 0) return;

    const size = Math.max(5, Math.floor(usd / price)); // min size 5 shares

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

  async _close(reason) {
    if (!this.open) return;

    // For now, just cancel any open order (if it exists). Full position unwinds will use SELL once we start getting fills.
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
