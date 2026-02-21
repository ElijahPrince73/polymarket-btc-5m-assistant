import { CONFIG } from '../config.js';
import { initializeLedger, getLedger, recalculateSummary, getOpenTrade } from '../paper_trading/ledger.js';
import { fetchCollateralBalance } from '../live_trading/clob.js';
import { getLiveLedger } from '../live_trading/ledger.js';

export async function assembleStatus() {
  await initializeLedger();

  // New unified engine + mode manager (exposed by index.js)
  const engine = globalThis.__tradingEngine ?? null;
  const modeManager = globalThis.__modeManager ?? null;

  const ledgerData = getLedger();
  const openTrade = getOpenTrade();

  // Entry debug from unified engine
  const entryDebug = engine?.lastEntryStatus ?? null;

  const summary = ledgerData.summary ?? recalculateSummary(ledgerData.trades ?? []);

  const starting = CONFIG.paperTrading.startingBalance ?? 1000;
  const baseRealized = typeof summary.totalPnL === 'number' ? summary.totalPnL : 0;
  const offset = (ledgerData.meta && typeof ledgerData.meta.realizedOffset === 'number' && Number.isFinite(ledgerData.meta.realizedOffset))
    ? ledgerData.meta.realizedOffset
    : 0;
  const realized = baseRealized + offset;
  const balance = starting + realized;

  let liveCollateral = null;
  if (CONFIG.liveTrading?.enabled) {
    try {
      liveCollateral = await fetchCollateralBalance();
    } catch (e) {
      liveCollateral = { error: e?.message || String(e) };
    }
  }

  const liveLedger = CONFIG.liveTrading?.enabled ? (getLiveLedger()?.trades ?? []) : [];

  const dailyPnl = engine?.state?.todayRealizedPnl ?? null;

  return {
    status: { ok: true, updatedAt: new Date().toISOString() },
    mode: modeManager?.getMode()?.toUpperCase() ?? (CONFIG.liveTrading?.enabled ? 'LIVE' : 'PAPER'),
    tradingEnabled: engine?.tradingEnabled ?? false,
    openTrade,
    entryDebug,
    ledgerSummary: summary,
    balance: { starting, realized, balance },
    paperTrading: {
      enabled: CONFIG.paperTrading.enabled,
      stakePct: CONFIG.paperTrading.stakePct,
      minTradeUsd: CONFIG.paperTrading.minTradeUsd,
      maxTradeUsd: CONFIG.paperTrading.maxTradeUsd,
      stopLossPct: CONFIG.paperTrading.stopLossPct,
      flipOnProbabilityFlip: CONFIG.paperTrading.flipOnProbabilityFlip
    },
    liveTrading: {
      enabled: Boolean(CONFIG.liveTrading?.enabled),
      available: modeManager?.isLiveAvailable() ?? false,
      funder: process.env.FUNDER_ADDRESS || null,
      signatureType: process.env.SIGNATURE_TYPE || null,
      limits: CONFIG.liveTrading || null,
      collateral: liveCollateral,
      tradesCount: Array.isArray(liveLedger) ? liveLedger.length : 0,
      daily: {
        realizedPnlUsd: typeof dailyPnl === 'number' ? dailyPnl : null,
        maxDailyLossUsd: CONFIG.liveTrading?.maxDailyLossUsd ?? CONFIG.paperTrading.maxDailyLossUsd ?? null,
        remainingLossBudgetUsd: (typeof dailyPnl === 'number' && Number.isFinite(dailyPnl))
          ? (Number(CONFIG.liveTrading?.maxDailyLossUsd ?? CONFIG.paperTrading.maxDailyLossUsd ?? 0) + dailyPnl)
          : null
      },
      fees: engine?.executor?.feeService?.getSnapshot?.() ?? null,
      approvals: engine?.executor?.approvalService?.getStatus?.() ?? null,
    },
    runtime: globalThis.__uiStatus ?? null
  };
}
