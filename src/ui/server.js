import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';

import { CONFIG } from '../config.js';
import { initializeLedger, getLedger, recalculateSummary } from '../paper_trading/ledger.js'; // Paper ledger
import { getOpenTrade, getTraderInstance } from '../paper_trading/trader.js'; // Paper trader status
import { readLiquiditySamples, computeLiquidityStats } from '../analytics/liquiditySampler.js';

import { fetchCollateralBalance, getClobClient } from '../live_trading/clob.js';
import { initializeLiveLedger, getLiveLedger } from '../live_trading/ledger.js';
import { computePositionsFromTrades, enrichPositionsWithMarks } from '../live_trading/positions.js';

// Use __dirname polyfill for ES modules
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.UI_PORT || 3000;

// Middleware
app.use(cors()); // Enable CORS for requests to the UI server
app.use(express.json()); // For parsing JSON bodies

// Serve static UI files (HTML, CSS, JS)
const uiPath = path.join(__dirname, '..', 'ui'); // Assuming ui folder is at src/ui
if (!fs.existsSync(uiPath)) {
  fs.mkdirSync(uiPath); // Create UI directory if it doesn't exist
}
app.use(express.static(uiPath)); // Serve files from ./src/ui/

function bucketEntryPrice(trade) {
  const px = trade?.entryPrice;
  if (typeof px !== 'number' || !Number.isFinite(px)) return 'unknown';
  const cents = px * 100;
  if (cents < 0.5) return '<0.5¢';
  if (cents < 1) return '0.5–1¢';
  if (cents < 2) return '1–2¢';
  if (cents < 5) return '2–5¢';
  if (cents < 10) return '5–10¢';
  return '10¢+';
}

function groupSummary(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const key = String(keyFn(t) ?? 'unknown');
    const cur = map.get(key) || { key, count: 0, pnl: 0 };
    cur.count += 1;
    cur.pnl += (typeof t.pnl === 'number' && Number.isFinite(t.pnl)) ? t.pnl : 0;
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
}

function bucketTimeLeftMin(trade) {
  const t = trade?.timeLeftMinAtEntry;
  if (typeof t !== 'number' || !Number.isFinite(t)) return 'unknown';
  if (t < 2) return '<2m';
  if (t < 5) return '2–5m';
  if (t < 10) return '5–10m';
  return '10m+';
}

function bucketProb(trade) {
  const p = trade?.modelProbAtEntry;
  if (typeof p !== 'number' || !Number.isFinite(p)) return 'unknown';
  if (p < 0.55) return '<0.55';
  if (p < 0.60) return '0.55–0.60';
  if (p < 0.65) return '0.60–0.65';
  if (p < 0.70) return '0.65–0.70';
  return '0.70+';
}

function bucketLiquidity(trade) {
  const l = trade?.liquidityAtEntry;
  if (typeof l !== 'number' || !Number.isFinite(l)) return 'unknown';
  if (l < 1000) return '<1k';
  if (l < 5000) return '1k–5k';
  if (l < 10000) return '5k–10k';
  if (l < 25000) return '10k–25k';
  if (l < 50000) return '25k–50k';
  if (l < 100000) return '50k–100k';
  return '100k+';
}

function bucketSpread(trade) {
  const s = trade?.spreadAtEntry;
  if (typeof s !== 'number' || !Number.isFinite(s)) return 'unknown';
  // spread is in $ (0..1). Express in cents.
  const c = s * 100;
  if (c < 0.5) return '<0.5¢';
  if (c < 1) return '0.5–1¢';
  if (c < 2) return '1–2¢';
  if (c < 5) return '2–5¢';
  return '5¢+';
}

function bucketMarketVolume(trade) {
  const v = trade?.volumeNumAtEntry;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'unknown';
  if (v < 25000) return '<25k';
  if (v < 50000) return '25k–50k';
  if (v < 100000) return '50k–100k';
  if (v < 200000) return '100k–200k';
  return '200k+';
}

function bucketEdge(trade) {
  const e = trade?.edgeAtEntry;
  if (typeof e !== 'number' || !Number.isFinite(e)) return 'unknown';
  if (e < 0.04) return '<0.04';
  if (e < 0.08) return '0.04–0.08';
  if (e < 0.12) return '0.08–0.12';
  if (e < 0.16) return '0.12–0.16';
  return '0.16+';
}

function bucketVwapDist(trade) {
  const d = trade?.vwapDistAtEntry;
  if (typeof d !== 'number' || !Number.isFinite(d)) return 'unknown';
  const pct = d * 100;
  if (pct < -0.20) return '<-0.20%';
  if (pct < -0.05) return '-0.20–-0.05%';
  if (pct <= 0.05) return '-0.05–0.05%';
  if (pct <= 0.20) return '0.05–0.20%';
  return '>0.20%';
}

function bucketRsi(trade) {
  const r = trade?.rsiAtEntry;
  if (typeof r !== 'number' || !Number.isFinite(r)) return 'unknown';
  if (r < 30) return '<30';
  if (r < 45) return '30–45';
  if (r < 55) return '45–55';
  if (r < 70) return '55–70';
  return '70+';
}

function bucketHoldTime(trade) {
  if (!trade?.entryTime || !trade?.exitTime) return 'unknown';
  const ms = new Date(trade.exitTime).getTime() - new Date(trade.entryTime).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const min = ms / 60000;
  if (min < 2) return '<2m';
  if (min < 5) return '2–5m';
  if (min < 10) return '5–10m';
  return '10m+';
}

function bucketMAE(trade) {
  const x = trade?.minUnrealizedPnl;
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'unknown';
  if (x > -10) return '> -$10';
  if (x > -25) return '-$10–-$25';
  if (x > -50) return '-$25–-$50';
  if (x > -100) return '-$50–-$100';
  return '<= -$100';
}

function bucketMFE(trade) {
  const x = trade?.maxUnrealizedPnl;
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'unknown';
  if (x < 10) return '<$10';
  if (x < 25) return '$10–$25';
  if (x < 50) return '$25–$50';
  if (x < 100) return '$50–$100';
  return '$100+';
}

function computeAnalytics(allTrades) {
  const trades = Array.isArray(allTrades) ? allTrades : [];
  const closed = trades.filter((t) => t && t.status === 'CLOSED');

  const wins = closed.filter((t) => (typeof t.pnl === 'number' && t.pnl > 0));
  const losses = closed.filter((t) => (typeof t.pnl === 'number' && t.pnl < 0));

  const sum = (arr) => arr.reduce((acc, t) => acc + (typeof t.pnl === 'number' ? t.pnl : 0), 0);
  const totalPnL = sum(closed);
  const winPnL = sum(wins);
  const lossPnL = sum(losses); // negative

  const avgWin = wins.length ? (winPnL / wins.length) : null;
  const avgLoss = losses.length ? (lossPnL / losses.length) : null;
  const winRate = closed.length ? (wins.length / closed.length) : null;
  const profitFactor = (lossPnL !== 0) ? (winPnL / Math.abs(lossPnL)) : null;
  const expectancy = closed.length ? (totalPnL / closed.length) : null;

  return {
    overview: {
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      totalPnL,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      expectancy
    },
    byExitReason: groupSummary(closed, (t) => t.exitReason || 'unknown'),
    byEntryPhase: groupSummary(closed, (t) => t.entryPhase || 'unknown'),
    byEntryPriceBucket: groupSummary(closed, (t) => bucketEntryPrice(t)),
    byEntryTimeLeftBucket: groupSummary(closed, (t) => bucketTimeLeftMin(t)),
    byEntryProbBucket: groupSummary(closed, (t) => bucketProb(t)),
    byEntryLiquidityBucket: groupSummary(closed, (t) => bucketLiquidity(t)),
    byEntryMarketVolumeBucket: groupSummary(closed, (t) => bucketMarketVolume(t)),
    byEntrySpreadBucket: groupSummary(closed, (t) => bucketSpread(t)),
    byEntryEdgeBucket: groupSummary(closed, (t) => bucketEdge(t)),
    byEntryVwapDistBucket: groupSummary(closed, (t) => bucketVwapDist(t)),
    byEntryRsiBucket: groupSummary(closed, (t) => bucketRsi(t)),
    byHoldTimeBucket: groupSummary(closed, (t) => bucketHoldTime(t)),
    byMAEBucket: groupSummary(closed, (t) => bucketMAE(t)),
    byMFEBucket: groupSummary(closed, (t) => bucketMFE(t)),
    bySide: groupSummary(closed, (t) => t.side || 'unknown'),
    byRecActionAtEntry: groupSummary(closed, (t) => t.recActionAtEntry || 'unknown'),
    bySideInferred: groupSummary(closed, (t) => {
      if (t.sideInferred === true) return 'inferred';
      if (t.sideInferred === false) return 'explicit';
      return 'unknown';
    })
  };
}

// API endpoints for UI to fetch data
app.get('/api/status', async (req, res) => {
  try {
    // Ensure ledger is initialized at least once so summary exists.
    await initializeLedger();

    const ledgerData = getLedger();
    const openTrade = getOpenTrade();
    const trader = getTraderInstance?.() ?? null;
    const entryDebug = trader?.lastEntryStatus ?? null;

    const summary = ledgerData.summary ?? recalculateSummary(ledgerData.trades ?? []);

    const starting = CONFIG.paperTrading.startingBalance ?? 1000;
    const baseRealized = typeof summary.totalPnL === 'number' ? summary.totalPnL : 0;
    const offset = (ledgerData.meta && typeof ledgerData.meta.realizedOffset === 'number' && Number.isFinite(ledgerData.meta.realizedOffset))
      ? ledgerData.meta.realizedOffset
      : 0;
    const realized = baseRealized + offset;
    const balance = starting + realized;

    // Live collateral (best-effort)
    let liveCollateral = null;
    if (CONFIG.liveTrading?.enabled) {
      try {
        liveCollateral = await fetchCollateralBalance();
      } catch (e) {
        liveCollateral = { error: e?.message || String(e) };
      }
    }

    const liveLedger = CONFIG.liveTrading?.enabled ? (getLiveLedger()?.trades ?? []) : [];

    res.json({
      status: {
        ok: true,
        updatedAt: new Date().toISOString()
      },
      mode: CONFIG.liveTrading?.enabled ? 'LIVE' : 'PAPER',

      // PAPER
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

      // LIVE
      liveTrading: {
        enabled: Boolean(CONFIG.liveTrading?.enabled),
        funder: process.env.FUNDER_ADDRESS || null,
        signatureType: process.env.SIGNATURE_TYPE || null,
        limits: CONFIG.liveTrading || null,
        collateral: liveCollateral,
        tradesCount: Array.isArray(liveLedger) ? liveLedger.length : 0,
      },

      // Very simple runtime snapshot (set by index.js)
      runtime: globalThis.__uiStatus ?? null
    });
  } catch (error) {
    console.error("Error fetching status:", error);
    res.status(500).json({ status: { ok: false }, error: "Failed to fetch status data." });
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    await initializeLedger();
    const ledgerData = getLedger();
    res.json(Array.isArray(ledgerData.trades) ? ledgerData.trades : []);
  } catch (error) {
    console.error("Error fetching trades:", error);
    res.status(500).json({ error: "Failed to fetch trades data." });
  }
});

// LIVE: recent trades from CLOB (best-effort)
app.get('/api/live/trades', async (req, res) => {
  try {
    const client = getClobClient();
    // clob-client returns Trade[]
    const trades = await client.getTrades();
    res.json(Array.isArray(trades) ? trades : []);
  } catch (error) {
    console.error('Error fetching LIVE trades:', error);
    res.status(500).json({ error: 'Failed to fetch live trades.' });
  }
});

// LIVE: open orders from CLOB
app.get('/api/live/open-orders', async (req, res) => {
  try {
    const client = getClobClient();
    const open = await client.getOpenOrders();
    res.json(open);
  } catch (error) {
    console.error('Error fetching LIVE open orders:', error);
    res.status(500).json({ error: 'Failed to fetch live open orders.' });
  }
});

// LIVE: positions inferred from trade history (best-effort)
app.get('/api/live/positions', async (req, res) => {
  try {
    const client = getClobClient();
    const trades = await client.getTrades();
    const positions = computePositionsFromTrades(trades);
    const enriched = await enrichPositionsWithMarks(positions);
    res.json(enriched);
  } catch (error) {
    console.error('Error fetching LIVE positions:', error);
    res.status(500).json({ error: 'Failed to fetch live positions.' });
  }
});

app.get('/api/analytics', async (req, res) => {
  try {
    await initializeLedger();
    const ledgerData = getLedger();
    const analytics = computeAnalytics(ledgerData.trades);

    // Liquidity stats from Polymarket sampling (independent of trade entries)
    const rows = readLiquiditySamples({ limit: 20000 });
    const liquidity = {
      last1h: computeLiquidityStats(rows, { windowHours: 1 }),
      last6h: computeLiquidityStats(rows, { windowHours: 6 }),
      last24h: computeLiquidityStats(rows, { windowHours: 24 })
    };

    res.json({ ...analytics, liquidity });
  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({ error: "Failed to fetch analytics data." });
  }
});

// Basic route for the root to serve index.html
app.get('/', (req, res) => {
  // Serve an index.html from the ui directory
  // Ensure index.html exists in src/ui/
  res.sendFile(path.join(uiPath, 'index.html'));
});

export function startUIServer() {
  // Warm ledgers so the UI doesn't throw on first load.
  initializeLedger().catch((e) => console.error("UI server (paper) ledger init failed:", e));
  initializeLiveLedger().catch((e) => console.error("UI server (live) ledger init failed:", e));

  console.log(`Starting UI server on port ${port}...`);
  const server = app.listen(port, () => {
    console.log(`UI server running on http://localhost:${port}`);
    console.log(`To access remotely, use ngrok: ngrok http ${port}`);
  });

  server.on('error', (err) => {
    console.error('UI server failed to bind/listen:', err);
  });

  return server;
}
