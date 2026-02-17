import { CONFIG } from "./config.js";
// Data providers - dynamically select based on config.priceFeed
let klineProvider = null;
let priceProvider = null;
let tradeStreamProvider = null;

// Load Kraken data providers by default
if (CONFIG.priceFeed === "kraken") {
  const { fetchKlines, fetchLastPrice } = await import("./data/kraken.js");
  const { startKrakenTradeStream } = await import("./data/kraken.js");
  klineProvider = { fetchKlines, fetchLastPrice };
  tradeStreamProvider = startKrakenTradeStream;
} else {
  console.error(`Unsupported price feed configured: ${CONFIG.priceFeed}. Please configure a valid feed.`);
  // Defaulting to empty mocks if needed.
  klineProvider = { fetchKlines: async () => [], fetchLastPrice: async () => null };
  tradeStreamProvider = ({ onUpdate }) => ({ getLast: () => ({ price: null, ts: null }), close: () => {} });
}

// Fallback data providers and Polymarket data
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import { startCoinbaseTradeStream } from "./data/binanceWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";

// Indicators
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";

// Engines
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";

// Utilities and Setup
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

// Paper trading modules
import { Trader, initializeTrader, getTraderInstance, getOpenTrade } from "./paper_trading/trader.js";
import { initializeLedger } from "./paper_trading/ledger.js";
// UI Server
import { startUIServer } from "./ui/server.js";

// --- __dirname polyfill for ES modules ---
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Constants and Helpers ---
const ANSI = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", gray: "\x1b[90m", white: "\x1b[97m", dim: "\x1b[2m" };
function screenWidth() { const w = Number(process.stdout?.columns); return Number.isFinite(w) && w >= 40 ? w : 80; }
function sepLine(ch = "─") { const w = screenWidth(); return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`; }
function renderScreen(text) { try { readline.cursorTo(process.stdout, 0, 0); readline.clearScreenDown(process.stdout); } catch { /* ignore */ } process.stdout.write(text.replace(/\x1b\[[0-9;]*m/g, '') + "\n"); }
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ""); }
function padLabel(label, width) { const visible = stripAnsi(label).length; if (visible >= width) return label; return label + " ".repeat(width - visible); }
function centerText(text, width) { const visible = stripAnsi(text).length; if (visible >= width) return text; const left = Math.floor((width - visible) / 2); const right = width - visible - left; return " ".repeat(left) + text + " ".repeat(right); }
const LABEL_W = 16;
function kv(label, value) { const l = padLabel(String(label), LABEL_W); return `${l}${value}`; }
function section(title) { return `${ANSI.white}${title}${ANSI.reset}`; }
function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  const p = Number(price); const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);
  let color = ANSI.reset; let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) { color = ANSI.green; arrow = " ↑"; } else { color = ANSI.red; arrow = " ↓"; }
  }
  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}
function formatSignedDelta(delta, base) { if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`; const sign = delta > 0 ? "+" : delta < 0 ? "-" : ""; const pct = (Math.abs(delta) / Math.abs(base)) * 100; return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`; }
function colorByNarrative(text, narrative) { if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`; if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`; return `${ANSI.gray}${text}${ANSI.reset}`; }
function formatNarrativeValue(label, value, narrative) { return `${label}: ${colorByNarrative(value, narrative)}`; }
function narrativeFromSign(x) { if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL"; return Number(x) > 0 ? "LONG" : "SHORT"; }
function narrativeFromRsi(rsi) { if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL"; const v = Number(rsi); if (v >= 55) return "LONG"; if (v <= 45) return "SHORT"; return "NEUTRAL"; }
function narrativeFromSlope(slope) { if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL"; return Number(slope) > 0 ? "LONG" : "SHORT"; }
function formatProbPct(p, digits = 0) { if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-"; return `${(Number(p) * 100).toFixed(digits)}%`; }
function fmtEtTime(now = new Date()) { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now); } catch { return "-"; } }
function fmtTimeLeft(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "-";
  const clamped = Math.max(0, minutes);
  const m = Math.floor(clamped);
  const s = Math.floor((clamped - m) * 60);
  return `${m}m ${s}s`;
}
function getBtcSession(now = new Date()) { const h = now.getUTCHours(); const inAsia = h >= 0 && h < 8; const inEurope = h >= 7 && h < 16; const inUs = h >= 13 && h < 22; if (inEurope && inUs) return "Europe/US overlap"; if (inAsia && inEurope) return "Asia/Europe overlap"; if (inAsia) return "Asia"; if (inEurope) return "Europe"; if (inUs) return "US"; return "Off-hours"; }
function parsePriceToBeat(market) { const text = String(market?.question ?? market?.title ?? ""); if (!text) return null; const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i); if (!m) return null; const raw = m[1].replace(/,/g, ""); const n = Number(raw); return Number.isFinite(n) ? n : null; }
const dumpedMarkets = new Set();
function safeFileSlug(x) { return String(x ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "").slice(0, 120); }
function extractNumericFromMarket(market) { const directKeys = ["priceToBeat", "price_to_beat", "strikePrice", "strike_price", "strike", "threshold", "thresholdPrice", "threshold_price", "targetPrice", "target_price", "referencePrice", "reference_price"]; for (const k of directKeys) { const v = market?.[k]; const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; if (Number.isFinite(n)) return n; } const seen = new Set(); const stack = [{ obj: market, depth: 0 }]; while (stack.length) { const { obj, depth } = stack.pop(); if (!obj || typeof obj !== "object") continue; if (seen.has(obj) || depth > 6) continue; seen.add(obj); const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj); for (const [key, value] of entries) { const k = String(key).toLowerCase(); if (value && typeof value === "object") { stack.push({ obj: value, depth: depth + 1 }); continue; } if (!/(price|strike|threshold|target|beat)/i.test(k)) continue; const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN; if (!Number.isFinite(n)) continue; if (n > 1000 && n < 2_000_000) return n; } } return null; }
function priceToBeatFromPolymarketMarket(market) { const n = extractNumericFromMarket(market); if (n !== null) return n; return parsePriceToBeat(market); }
const marketCache = { market: null, fetchedAtMs: 0 };
async function resolveCurrentBtc5mMarket() {
  // If a slug is pinned but the market is closed/expired, fall back to auto-select.
  if (CONFIG.polymarket.marketSlug) {
    const m = await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
    if (m) {
      const now = Date.now();
      const endMs = m.endDate ? new Date(m.endDate).getTime() : null;
      const isClosed = (String(m.closed ?? "").toLowerCase() === "true") || (endMs !== null && Number.isFinite(endMs) && now >= endMs);
      if (!isClosed) return m;
      console.warn("Pinned POLYMARKET_SLUG is closed/expired; falling back to auto-select latest:", CONFIG.polymarket.marketSlug);
    }
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;
  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }
  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 50 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);
  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}
async function fetchPolymarketSnapshot() { const market = await resolveCurrentBtc5mMarket(); if (!market) return { ok: false, reason: "market_not_found" }; const outcomes = Array.isArray(market.outcomes) ? market.outcomes : JSON.parse(market.outcomes || "[]"); const outcomePrices = Array.isArray(market.outcomePrices) ? market.outcomePrices : JSON.parse(market.outcomePrices || "[]"); const clobTokenIds = Array.isArray(market.clobTokenIds) ? market.clobTokenIds : JSON.parse(market.clobTokenIds || "[]"); let upTokenId = null; let downTokenId = null; for (let i = 0; i < outcomes.length; i += 1) { const label = String(outcomes[i]); const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null; if (!tokenId) continue; if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId; if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId; } const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()); const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()); const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null; const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null; if (!upTokenId || !downTokenId) { return { ok: false, reason: "missing_token_ids", market, outcomes, clobTokenIds, outcomePrices }; } let upBuy = null; let downBuy = null; let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null }; let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null }; try { const [yesBuy, noBuy, upBook, downBook] = await Promise.all([ fetchClobPrice({ tokenId: upTokenId, side: "buy" }), fetchClobPrice({ tokenId: downTokenId, side: "buy" }), fetchOrderBook({ tokenId: upTokenId }), fetchOrderBook({ tokenId: downTokenId }) ]); upBuy = yesBuy; downBuy = noBuy; upBookSummary = summarizeOrderBook(upBook); downBookSummary = summarizeOrderBook(downBook); } catch { upBuy = null; downBuy = null; upBookSummary = { bestBid: Number(market.bestBid) || null, bestAsk: Number(market.bestAsk) || null, spread: Number(market.spread) || null, bidLiquidity: null, askLiquidity: null }; downBookSummary = { bestBid: null, bestAsk: null, spread: Number(market.spread) || null, bidLiquidity: null, askLiquidity: null }; } return { ok: true, market, tokens: { upTokenId, downTokenId }, prices: { up: upBuy ?? gammaYes, down: downBuy ?? gammaNo }, orderbook: { up: upBookSummary, down: downBookSummary } }; }
function countVwapCrosses(closes, vwapSeries, lookback) { if (closes.length < lookback || vwapSeries.length < lookback) return null; let crosses = 0; for (let i = closes.length - lookback + 1; i < closes.length; i += 1) { const prev = closes[i - 1] - vwapSeries[i - 1]; const cur = closes[i] - vwapSeries[i]; if (prev === 0) continue; if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1; } return crosses; }

async function startApp() {
  // --- Initialization ---
  await initializeLedger(); // Ensure ledger file structure is correct
  await initializeTrader(); // Initialize trader and load ledger
  applyGlobalProxyFromEnv(); // Apply proxy settings from environment

  // Start data streams
  // We no longer rely on Kraken WS (often rate-limited). Use Chainlink for BTC reference price.
  const krakenStream = null;

  // Build lightweight 1m candles from Chainlink ticks for indicators (no exchange dependency).
  const chainlinkCandles1m = [];
  const pushChainlinkTick = ({ price, updatedAt }) => {
    if (typeof price !== "number" || !Number.isFinite(price)) return;
    const ts = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : Date.now();
    const bucket = Math.floor(ts / 60_000) * 60_000;
    const last = chainlinkCandles1m[chainlinkCandles1m.length - 1];

    if (!last || last.openTime !== bucket) {
      chainlinkCandles1m.push({
        openTime: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        closeTime: bucket + 60_000
      });
      // keep last 240
      if (chainlinkCandles1m.length > 240) chainlinkCandles1m.splice(0, chainlinkCandles1m.length - 240);
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.closeTime = bucket + 60_000;
    }
  };

  const chainlinkStream = startChainlinkPriceStream({ onUpdate: pushChainlinkTick });

  // Prime candles with an initial REST fetch so indicators can start without WS.
  try {
    const restTick = await fetchChainlinkBtcUsd();
    if (restTick?.price) pushChainlinkTick({ price: restTick.price, updatedAt: restTick.updatedAt ?? Date.now() });
  } catch { /* ignore */ }

  // --- Option B: Backfill 1m candles from exchange REST on startup ---
  // This avoids waiting for new Chainlink ticks to build enough history.
  // We use the configured klineProvider (Kraken REST by default) and then continue updating candles from Chainlink ticks.
  let seededFromRest = false;
  try {
    const seed = await klineProvider.fetchKlines({ interval: "1m", limit: 240 });
    if (Array.isArray(seed) && seed.length >= 30) {
      chainlinkCandles1m.splice(0, chainlinkCandles1m.length, ...seed.map((c) => ({
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: (typeof c.volume === "number" && Number.isFinite(c.volume)) ? c.volume : 0,
        closeTime: c.closeTime
      })));
      seededFromRest = true;
      console.log(`Seeded 1m candles from REST: ${chainlinkCandles1m.length}`);
    }
  } catch (e) {
    console.warn(`REST candle seed failed (continuing with tick-built candles): ${e.message}`);
  }
  const polyStream = startPolymarketChainlinkPriceStream({});

  // Spot reference stream (Coinbase) for impulse/basis metrics
  const spotTicks = [];
  const spotStream = startCoinbaseTradeStream({
    symbol: CONFIG.coinbase.symbol,
    onUpdate: ({ price, ts }) => {
      if (typeof price !== "number" || !Number.isFinite(price)) return;
      const t = (typeof ts === "number" && Number.isFinite(ts)) ? ts : Date.now();
      spotTicks.push({ t, price });
      // keep ~5 minutes of ticks
      const cutoff = Date.now() - 5 * 60_000;
      while (spotTicks.length && spotTicks[0].t < cutoff) spotTicks.shift();
    }
  });

  // Start UI server
  try { startUIServer(); } catch (err) { console.error('Failed to start UI server:', err); }

  console.log(`--- Bot Started ---`);
  console.log(`Paper Trading: ${CONFIG.paperTrading.enabled ? 'ON' : 'OFF'}`);
  console.log(`BTC feed: Chainlink WS (candles built from ticks).`);
  console.log(`UI Server running on http://localhost:${CONFIG.uiPort}. Use 'ngrok http ${CONFIG.uiPort}' for remote access.`);

  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };
  const csvHeader = ["timestamp", "time_left", "regime", "signal", "model_up", "model_down", "mkt_up", "mkt_down", "edge_up", "edge_down", "rec"];

  let trader = null;
  if (CONFIG.paperTrading.enabled) {
    trader = getTraderInstance(); // Assuming getTraderInstance() retrieves the singleton
    if (!trader) console.warn("Trader instance not available, paper trading will be disabled.");
  }

  while (true) {
    try {
    // If we couldn't seed at boot and candles are still empty, attempt a one-time seed.
    if (!seededFromRest && chainlinkCandles1m.length < 30) {
      try {
        const seed = await klineProvider.fetchKlines({ interval: "1m", limit: 240 });
        if (Array.isArray(seed) && seed.length >= 30) {
          chainlinkCandles1m.splice(0, chainlinkCandles1m.length, ...seed.map((c) => ({
            openTime: c.openTime,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: 0,
            closeTime: c.closeTime
          })));
          seededFromRest = true;
          console.log(`Seeded 1m candles from REST (late): ${chainlinkCandles1m.length}`);
        }
      } catch { /* ignore */ }
    }

    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);
    const timeLeftMin = timing.remainingMinutes;

    let currentPrice = null;
    let marketDataFetchSource = "N/A";

    // Fetch Live BTC Price Data ---
    // Primary: Chainlink WS (if configured)
    const chainlinkTick = chainlinkStream.getLast?.() ?? null;
    if (chainlinkTick?.price) currentPrice = chainlinkTick.price;

    // Fallback: Chainlink REST (reliable) + feed candle builder
    if (currentPrice === null) {
      try {
        const restTick = await fetchChainlinkBtcUsd();
        if (restTick?.price) {
          currentPrice = restTick.price;
          pushChainlinkTick({ price: restTick.price, updatedAt: restTick.updatedAt ?? Date.now() });
          marketDataFetchSource = "Chainlink REST";
        }
      } catch (e) {
        console.error(`Chainlink REST price fetch failed: ${e.message}`);
      }
    }

    // Secondary: Polymarket live BTC feed (if it has a price)
    const polyTick = polyStream.getLast?.() ?? null;
    if (currentPrice === null && polyTick?.price) currentPrice = polyTick.price;

    // Last resort: Kraken REST (throttled/cached) if configured
    if (currentPrice === null) {
      try { currentPrice = await klineProvider.fetchLastPrice(); marketDataFetchSource = "Kraken REST"; }
      catch (restErr) { console.error(`REST price fetch failed: ${restErr.message}`); }
    }

    // --- 1m Candle Data for indicators ---
    // Built from Chainlink ticks (volume=0; VWAP will be null which is fine).
    const klines1m = chainlinkCandles1m;

    if (!klines1m || klines1m.length < CONFIG.candleWindowMinutes) {
      console.warn(`Not enough Chainlink 1m candles yet (${klines1m?.length || 0}). Indicators might be unreliable.`);
    }

    const polySnapshot = await fetchPolymarketSnapshot();

    // --- Liquidity sampling (Polymarket) ---
    try {
      const { recordLiquiditySample } = await import('./analytics/liquiditySampler.js');
      const m = polySnapshot?.market;
      recordLiquiditySample({
        marketSlug: m?.slug ?? null,
        liquidityNum: m?.liquidityNum ?? null,
        spreadUp: polySnapshot?.orderbook?.up?.spread ?? null,
        spreadDown: polySnapshot?.orderbook?.down?.spread ?? null
      });
    } catch (e) {
      // never crash main loop
    }

    // --- Indicator Calculations ---
    let indicatorsData = {};
    if (klines1m && klines1m.length >= CONFIG.candleWindowMinutes) {
      const closes = klines1m.map(c => c.close);
      indicatorsData.vwapSeries = computeVwapSeries(klines1m);
      indicatorsData.vwapNow = indicatorsData.vwapSeries[indicatorsData.vwapSeries.length - 1];
      indicatorsData.vwapSlope = indicatorsData.vwapSeries.length >= CONFIG.vwapSlopeLookbackMinutes ? (indicatorsData.vwapNow - indicatorsData.vwapSeries[indicatorsData.vwapSeries.length - CONFIG.vwapSlopeLookbackMinutes]) / CONFIG.vwapSlopeLookbackMinutes : null;
      indicatorsData.vwapDist = indicatorsData.vwapNow !== null && indicatorsData.vwapNow !== 0 ? (currentPrice - indicatorsData.vwapNow) / indicatorsData.vwapNow : null;
      indicatorsData.rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = closes.map((_, i) => computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod)).filter(v => v !== null);
      indicatorsData.rsiSlope = slopeLast(rsiSeries, 3);
      indicatorsData.macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
      const haSeries = computeHeikenAshi(klines1m);
      const haCC = countConsecutive(haSeries);
      indicatorsData.heikenColor = haCC.color;
      indicatorsData.heikenCount = haCC.count;
      indicatorsData.failedVwapReclaim = indicatorsData.vwapNow !== null && indicatorsData.vwapSeries.length >= 3 ? closes[closes.length - 1] < indicatorsData.vwapNow && indicatorsData.vwapSeries[indicatorsData.vwapSeries.length - 2] > indicatorsData.vwapSeries[indicatorsData.vwapSeries.length - 2] : false;
      indicatorsData.vwapCrossCount = countVwapCrosses(closes, indicatorsData.vwapSeries, 20);

      // Chop metric: recent close range over last 20 minutes.
      const lookback = 20;
      const lastN = closes.slice(-lookback);
      const lastClose = lastN.length ? lastN[lastN.length - 1] : null;
      if (lastN.length && lastClose) {
        const hi = Math.max(...lastN);
        const lo = Math.min(...lastN);
        indicatorsData.rangePct20 = (hi - lo) / lastClose;
      } else {
        indicatorsData.rangePct20 = null;
      }

      // Volume is not available from Chainlink ticks; leave null so volume filter doesn't trigger.
      indicatorsData.volumeRecent = null;
      indicatorsData.volumeAvg = null;
    }
    
    // Normalize indicator names for the engines.
    const engineInputs = {
      price: currentPrice,
      vwap: indicatorsData.vwapNow ?? null,
      vwapSlope: indicatorsData.vwapSlope ?? null,
      rsi: indicatorsData.rsiNow ?? null,
      rsiSlope: indicatorsData.rsiSlope ?? null,
      macd: indicatorsData.macd ?? null,
      heikenColor: indicatorsData.heikenColor ?? null,
      heikenCount: indicatorsData.heikenCount ?? 0,
      failedVwapReclaim: indicatorsData.failedVwapReclaim ?? false
    };

    const regimeInfo = detectRegime({ ...engineInputs, vwapDist: indicatorsData.vwapDist ?? null, vwapCrossCount: indicatorsData.vwapCrossCount ?? null });
    const scored = scoreDirection(engineInputs);
    const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);
    const marketUp = polySnapshot.ok ? polySnapshot.prices?.up : null;   // cents (buy)
    const marketDown = polySnapshot.ok ? polySnapshot.prices?.down : null; // cents (buy)
    const polyPrices = {
      UP: (marketUp === null || marketUp === undefined) ? null : Number(marketUp) / 100,
      DOWN: (marketDown === null || marketDown === undefined) ? null : Number(marketDown) / 100
    };
    const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });
    const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });
    const predictNarrative = (timeAware.adjustedUp !== null && timeAware.adjustedDown !== null) ? (timeAware.adjustedUp > timeAware.adjustedDown ? "LONG" : "SHORT") : "NEUTRAL";

    // Spot impulse (Coinbase) over last 60s
    const spotLast = spotStream?.getLast?.() ?? { price: null, ts: null };
    const spotNow = (typeof spotLast.price === "number" && Number.isFinite(spotLast.price)) ? spotLast.price : null;
    let spotDelta1mPct = null;
    if (spotNow !== null && spotTicks.length) {
      const targetT = Date.now() - 60_000;
      // find oldest tick >= target; fallback to oldest tick
      let base = null;
      for (let i = 0; i < spotTicks.length; i += 1) {
        if (spotTicks[i].t >= targetT) { base = spotTicks[i].price; break; }
      }
      if (base === null) base = spotTicks[0]?.price ?? null;
      if (typeof base === "number" && Number.isFinite(base) && base > 0) {
        spotDelta1mPct = (spotNow - base) / base;
      }
    }

    const signalsForTrader = {
      rec,
      kline: klines1m.length ? klines1m[klines1m.length - 1] : null, // BTC candle (for indicators only)
      market: polySnapshot.ok ? polySnapshot.market : null,
      polyMarketSnapshot: polySnapshot,
      polyPrices, // dollars (0..1)
      polyPricesCents: { UP: marketUp, DOWN: marketDown },
      timeLeftMin,
      modelUp: timeAware.adjustedUp,
      modelDown: timeAware.adjustedDown,
      predictNarrative,
      indicators: indicatorsData,
      spot: {
        price: spotNow,
        delta1mPct: spotDelta1mPct
      }
    };

    // Expose a tiny runtime snapshot for the UI (simple text display)
    globalThis.__uiStatus = {
      marketSlug: polySnapshot.ok ? (polySnapshot.market?.slug ?? null) : null,
      timeLeftMin,
      btcPrice: currentPrice,
      spotPrice: spotNow,
      spotDelta1mPct,
      modelUp: timeAware.adjustedUp,
      modelDown: timeAware.adjustedDown,
      narrative: predictNarrative,
      polyUp: polyPrices.UP,
      polyDown: polyPrices.DOWN,
      candleCount: klines1m?.length ?? 0,
      lastUpdate: new Date().toISOString()
    };

    if (CONFIG.paperTrading.enabled && trader) await trader.processSignals(signalsForTrader, klines1m);

    // --- Console UI Rendering ---
    const vwapSlopeLabel = indicatorsData.vwapSlope === null || indicatorsData.vwapSlope === undefined ? "-" : indicatorsData.vwapSlope > 0 ? "UP" : indicatorsData.vwapSlope < 0 ? "DOWN" : "FLAT";
    const macdHist = indicatorsData.macd?.hist ?? null;
    const macdHistDelta = indicatorsData.macd?.histDelta ?? null;
    const macdLabel = (macdHist === null || macdHist === undefined)
      ? "-"
      : (macdHist < 0
          ? ((macdHistDelta !== null && macdHistDelta !== undefined && macdHistDelta < 0) ? "bearish (expanding)" : "bearish")
          : ((macdHistDelta !== null && macdHistDelta !== undefined && macdHistDelta > 0) ? "bullish (expanding)" : "bullish"));
    const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
    const lastClose = lastCandle?.close ?? null;
    const macdNarrative = narrativeFromSign(indicatorsData.macd?.hist ?? null);
    const vwapNarrative = indicatorsData.vwapDist !== null ? (indicatorsData.vwapDist > 0 ? "LONG" : "SHORT") : "NEUTRAL";
    const haNarrative = (indicatorsData.heikenColor ?? "").toLowerCase() === "green" ? "LONG" : (indicatorsData.heikenColor ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
    const rsiNarrative = narrativeFromSlope(indicatorsData.rsiSlope);
    
    const pLong = timeAware?.adjustedUp ?? null; const pShort = timeAware?.adjustedDown ?? null;
    const predictValue = `${ANSI.green}LONG${ANSI.reset} ${formatProbPct(pLong)} / ${ANSI.red}SHORT${ANSI.reset} ${formatProbPct(pShort)}`;
    const marketUpStr = `${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}`;
    const marketDownStr = `${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
    const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset}`;
    const heikenLine = formatNarrativeValue("Heiken Ashi", `${indicatorsData.heikenColor ?? "-"} x${indicatorsData.heikenCount}`, haNarrative);
    const rsiArrow = indicatorsData.rsiSlope !== null && indicatorsData.rsiSlope < 0 ? "↓" : indicatorsData.rsiSlope !== null && indicatorsData.rsiSlope > 0 ? "↑" : "-";
    const rsiValue = `${formatNumber(indicatorsData.rsiNow, 1)} ${rsiArrow}`;
    const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);
    const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

    const deltaVals = [];
    if (lastClose !== null) {
      const delta1m = lastClose - (klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null);
      const delta3m = lastClose !== null && klines1m.length >= 4 ? lastClose - klines1m[klines1m.length - 4]?.close ?? null : null;
      deltaVals.push(colorByNarrative(formatSignedDelta(delta1m, lastClose), narrativeFromSign(delta1m)));
      deltaVals.push(colorByNarrative(formatSignedDelta(delta3m, lastClose), narrativeFromSign(delta3m)));
    }
    const deltaLine = `Delta 1/3Min: ${deltaVals.join(" | ")}`;
    const vwapValue = `${formatNumber(indicatorsData.vwapNow, 0)} (${formatPct(indicatorsData.vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
    const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

    const signal = rec.action === "ENTER" ? `${rec.side} (${rec.phase})` : "NO TRADE";
    const displayMarketSlug = polySnapshot.ok ? (polySnapshot.market?.slug ?? "-") : "-";
    const displayTimeLeft = fmtTimeLeft(timeLeftMin);
    
    const settlementLeftMin = polySnapshot.ok && polySnapshot.market?.endDate ? (new Date(polySnapshot.market.endDate).getTime() - Date.now()) / 60_000 : null;
    const polyTimeLeftColor = settlementLeftMin !== null ? (settlementLeftMin >= 10 ? ANSI.green : settlementLeftMin >= 5 ? ANSI.yellow : ANSI.red) : ANSI.reset;
    const polyTimeLeftDisplay = settlementLeftMin !== null ? fmtTimeLeft(settlementLeftMin) : "-";

    const priceToBeat = polySnapshot.ok ? priceToBeatFromPolymarketMarket(polySnapshot.market) : null;
    const ptbDelta = (currentPrice !== null && priceToBeat !== null) ? currentPrice - priceToBeat : null;
    const ptbDeltaColor = ptbDelta === null ? ANSI.gray : ptbDelta > 0 ? ANSI.green : ptbDelta < 0 ? ANSI.red : ANSI.gray;
    const ptbDeltaText = ptbDelta === null ? `${ANSI.gray}-${ANSI.reset}` : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ""}${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
    const currentPriceLine = kv("CURRENT PRICE", `${colorPriceLine({ label: "", price: currentPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" })} (${ptbDeltaText})`);
    
    appendCsvRow("./logs/signals.csv", csvHeader, [new Date().toISOString(), timing.elapsedMinutes.toFixed(3), signal, timeAware.adjustedUp, timeAware.adjustedDown, marketUp, marketDown, edge.edgeUp, edge.edgeDown, rec.action === "ENTER" ? `${rec.side}:${rec.phase}` : "NO_TRADE"]);

    renderScreen([
      displayMarketSlug, kv("Time left", fmtTimeLeft(timeLeftMin)), "", sepLine(), "",
      kv("TA Predict", predictValue), kv("Heiken Ashi", (heikenLine.split(': ')[1] ?? heikenLine)?.replace(ANSI.reset,'') ?? "-"), kv("RSI", (rsiLine.split(': ')[1] ?? rsiLine)?.replace(ANSI.reset,'') ?? "-"),
      kv("MACD", (macdLine.split(': ')[1] ?? macdLine)?.replace(ANSI.reset,'') ?? "-"), kv("Delta 1/3", (deltaLine.split(': ')[1] ?? deltaLine)?.replace(ANSI.reset,'') ?? "-"), kv("VWAP", (vwapLine.split(': ')[1] ?? vwapLine)?.replace(ANSI.reset,'') ?? "-"),
      "", sepLine(), "",
      kv("POLYMARKET", polyHeaderValue),
      polySnapshot.ok && polySnapshot.market?.liquidityNum !== null ? kv("Liquidity", formatNumber(polySnapshot.market.liquidityNum, 0)) : null,
      settlementLeftMin !== null ? kv("Time left", `${polyTimeLeftColor}${polyTimeLeftDisplay}${ANSI.reset}`) : null,
      priceToBeat !== null ? kv("PRICE TO BEAT", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT", `${ANSI.gray}-${ANSI.reset}`),
      currentPriceLine, "", sepLine(), "",
      kv("ET | Session", `${ANSI.white}${fmtEtTime()}${ANSI.reset} | ${ANSI.white}${getBtcSession()}${ANSI.reset}`), "", sepLine(),
      centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
    ].filter(Boolean).join("\n") + "\n");

    prevCurrentPrice = currentPrice;

    // Throttle the main loop to avoid API spam + memory growth and to keep the UI responsive.
    const interval = Number(CONFIG.pollIntervalMs) || 2000;
    await sleep(Math.max(250, interval));
    } catch (err) {
      console.error("Loop error:", err);
      await sleep(1000);
    }
  }
}

startApp();
