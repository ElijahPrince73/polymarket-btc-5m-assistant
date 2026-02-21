import { CONFIG } from '../config.js';
import { getClobClient } from '../live_trading/clob.js';
import { computePositionsFromTrades, enrichPositionsWithMarks } from '../live_trading/positions.js';
import { computeRealizedPnlAvgCost } from '../live_trading/pnl.js';

export function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

export function dayKeyFromEpochSec(epochSec, tz = 'America/Los_Angeles') {
  const d = new Date(Number(epochSec) * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export async function fetchLiveTrades() {
  const client = getClobClient();
  const trades = await client.getTrades();
  return Array.isArray(trades) ? trades : [];
}

export async function fetchLiveOpenOrders() {
  const client = getClobClient();
  return withTimeout(client.getOpenOrders(), 6000, 'getOpenOrders');
}

export async function fetchLivePositions() {
  const client = getClobClient();
  const trades = await client.getTrades();
  const positions = computePositionsFromTrades(trades);
  const enriched = await enrichPositionsWithMarks(positions);

  const tradable = enriched.filter(p => p?.tradable !== false);
  const nonTradable = enriched.filter(p => p?.tradable === false);

  return {
    count: enriched.length,
    tradableCount: tradable.length,
    nonTradableCount: nonTradable.length,
    tradable,
    nonTradable
  };
}

export async function fetchLiveAnalytics() {
  const client = getClobClient();
  const trades = await client.getTrades();

  const pnl = computeRealizedPnlAvgCost(trades);

  const tz = process.env.UI_TZ || 'America/Los_Angeles';
  const todayKey = dayKeyFromEpochSec(Math.floor(Date.now() / 1000), tz);
  const yesterdayKey = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  })();

  const tradesToday = (Array.isArray(trades) ? trades : []).filter(t => {
    const mt = Number(t?.match_time || 0);
    return mt ? dayKeyFromEpochSec(mt, tz) === todayKey : false;
  });
  const tradesYesterday = (Array.isArray(trades) ? trades : []).filter(t => {
    const mt = Number(t?.match_time || 0);
    return mt ? dayKeyFromEpochSec(mt, tz) === yesterdayKey : false;
  });

  const pnlToday = computeRealizedPnlAvgCost(tradesToday);
  const pnlYesterday = computeRealizedPnlAvgCost(tradesYesterday);

  const baseline = Number(CONFIG.liveTrading?.dailyLossBaselineUsd ?? 0) || 0;
  const realizedTodayEffective = (pnlToday.realizedTotal || 0) - baseline;

  return {
    tz,
    todayKey,
    yesterdayKey,
    tradesCount: Array.isArray(trades) ? trades.length : 0,
    realizedTotal: pnl.realizedTotal,
    realizedTodayRaw: pnlToday.realizedTotal,
    dailyLossBaselineUsd: baseline,
    realizedToday: realizedTodayEffective,
    realizedYesterday: pnlYesterday.realizedTotal,
    inventoryByToken: pnl.inventoryByToken,
    realizedByToken: pnl.realizedByToken
  };
}
