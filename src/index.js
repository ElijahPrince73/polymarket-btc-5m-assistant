import 'dotenv/config';
import { CONFIG } from "./config.js";
// Data providers - dynamically select based on config.priceFeed
let klineProvider = null;

// Load Kraken data providers by default
if (CONFIG.priceFeed === "kraken") {
  const { fetchKlines, fetchLastPrice } = await import("./data/kraken.js");
  klineProvider = { fetchKlines, fetchLastPrice };
} else {
  console.error(`Unsupported price feed configured: ${CONFIG.priceFeed}. Please configure a valid feed.`);
  // Defaulting to empty mocks if needed.
  klineProvider = { fetchKlines: async () => [], fetchLastPrice: async () => null };
}

// Fallback data providers and Polymarket data
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import { startCoinbaseTradeStream } from "./data/binanceWs.js";
import {
  fetchPolymarketSnapshot,
  priceToBeatFromPolymarketMarket,
  resolveCurrentBtc5mMarket
} from "./data/polymarket.js";

// Indicators
import { computeVwapSeries, countVwapCrosses } from "./indicators/vwap.js";
import { computeRsi, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";

// Engines
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";

// Utilities and Setup
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

// Clean Architecture: unified trading engine
import { TradingEngine } from "./application/TradingEngine.js";
import { ModeManager } from "./application/ModeManager.js";
import { PaperExecutor } from "./infrastructure/executors/PaperExecutor.js";
import { LiveExecutor } from "./infrastructure/executors/LiveExecutor.js";

// Legacy imports kept for backward compat (ledger init, status service)
import { initializeLedger } from "./paper_trading/ledger.js";
// UI Server
import { startUIServer } from "./ui/server.js";

// --- TUI Helpers ---
import {
  ANSI, screenWidth, sepLine, renderScreen, kv, centerText,
  colorPriceLine, formatSignedDelta, colorByNarrative, formatNarrativeValue,
  narrativeFromSign, narrativeFromSlope, formatProbPct, fmtEtTime, fmtTimeLeft, getBtcSession
} from "./ui/tui.js";

// --- Extracted helpers for startApp ---

function computeIndicators(klines1m, currentPrice) {
  const data = { candleCount: klines1m?.length ?? 0 };
  if (!klines1m || klines1m.length < CONFIG.candleWindowMinutes) return data;

  const closes = klines1m.map(c => c.close);
  data.vwapSeries = computeVwapSeries(klines1m);
  data.vwapNow = data.vwapSeries[data.vwapSeries.length - 1];
  data.vwapSlope = data.vwapSeries.length >= CONFIG.vwapSlopeLookbackMinutes
    ? (data.vwapNow - data.vwapSeries[data.vwapSeries.length - CONFIG.vwapSlopeLookbackMinutes]) / CONFIG.vwapSlopeLookbackMinutes
    : null;
  data.vwapDist = data.vwapNow !== null && data.vwapNow !== 0 ? (currentPrice - data.vwapNow) / data.vwapNow : null;
  data.rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
  const rsiSeries = closes.map((_, i) => computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod)).filter(v => v !== null);
  data.rsiSlope = slopeLast(rsiSeries, 3);
  data.macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
  const haSeries = computeHeikenAshi(klines1m);
  const haCC = countConsecutive(haSeries);
  data.heikenColor = haCC.color;
  data.heikenCount = haCC.count;
  data.failedVwapReclaim = data.vwapNow !== null && data.vwapSeries.length >= 3
    ? closes[closes.length - 1] < data.vwapNow && data.vwapSeries[data.vwapSeries.length - 2] > data.vwapSeries[data.vwapSeries.length - 2]
    : false;
  data.vwapCrossCount = countVwapCrosses(closes, data.vwapSeries, 20);

  const lookback = 20;
  const lastN = closes.slice(-lookback);
  const lastClose = lastN.length ? lastN[lastN.length - 1] : null;
  data.rangePct20 = (lastN.length && lastClose) ? (Math.max(...lastN) - Math.min(...lastN)) / lastClose : null;
  data.volumeRecent = null;
  data.volumeAvg = null;
  return data;
}

function buildSignals({ rec, klines1m, polySnapshot, polyPrices, marketUp, marketDown, timeLeftMin, timeAware, indicatorsData, spotNow, spotDelta1mPct }) {
  return {
    rec,
    kline: klines1m.length ? klines1m[klines1m.length - 1] : null,
    market: polySnapshot.ok ? polySnapshot.market : null,
    polyMarketSnapshot: polySnapshot,
    polyPrices,
    polyPricesCents: { UP: marketUp, DOWN: marketDown },
    timeLeftMin,
    modelUp: timeAware.adjustedUp,
    modelDown: timeAware.adjustedDown,
    predictNarrative: (timeAware.adjustedUp !== null && timeAware.adjustedDown !== null) ? (timeAware.adjustedUp > timeAware.adjustedDown ? "LONG" : "SHORT") : "NEUTRAL",
    indicators: indicatorsData,
    spot: { price: spotNow, delta1mPct: spotDelta1mPct }
  };
}

function renderConsole({ indicatorsData, timeAware, marketUp, marketDown, klines1m, polySnapshot, currentPrice, prevCurrentPrice, timeLeftMin }) {
  if (!process.stdout.isTTY) return;

  const vwapSlopeLabel = indicatorsData.vwapSlope == null ? "-" : indicatorsData.vwapSlope > 0 ? "UP" : indicatorsData.vwapSlope < 0 ? "DOWN" : "FLAT";
  const macdHist = indicatorsData.macd?.hist ?? null;
  const macdHistDelta = indicatorsData.macd?.histDelta ?? null;
  const macdLabel = macdHist == null ? "-"
    : (macdHist < 0 ? (macdHistDelta != null && macdHistDelta < 0 ? "bearish (expanding)" : "bearish")
      : (macdHistDelta != null && macdHistDelta > 0 ? "bullish (expanding)" : "bullish"));
  const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
  const lastClose = lastCandle?.close ?? null;
  const macdNarrative = narrativeFromSign(macdHist);
  const vwapNarrative = indicatorsData.vwapDist !== null ? (indicatorsData.vwapDist > 0 ? "LONG" : "SHORT") : "NEUTRAL";
  const haNarrative = (indicatorsData.heikenColor ?? "").toLowerCase() === "green" ? "LONG" : (indicatorsData.heikenColor ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
  const rsiNarrative = narrativeFromSlope(indicatorsData.rsiSlope);

  const pLong = timeAware?.adjustedUp ?? null;
  const pShort = timeAware?.adjustedDown ?? null;
  const predictValue = `${ANSI.green}LONG${ANSI.reset} ${formatProbPct(pLong)} / ${ANSI.red}SHORT${ANSI.reset} ${formatProbPct(pShort)}`;
  const marketUpStr = `${marketUp ?? "-"}${marketUp == null ? "" : "¢"}`;
  const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset}`;
  const heikenLine = formatNarrativeValue("Heiken Ashi", `${indicatorsData.heikenColor ?? "-"} x${indicatorsData.heikenCount}`, haNarrative);
  const rsiArrow = indicatorsData.rsiSlope !== null && indicatorsData.rsiSlope < 0 ? "↓" : indicatorsData.rsiSlope !== null && indicatorsData.rsiSlope > 0 ? "↑" : "-";
  const rsiLine = formatNarrativeValue("RSI", `${formatNumber(indicatorsData.rsiNow, 1)} ${rsiArrow}`, rsiNarrative);
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

  const displayMarketSlug = polySnapshot.ok ? (polySnapshot.market?.slug ?? "-") : "-";
  const settlementLeftMin = polySnapshot.ok && polySnapshot.market?.endDate ? (new Date(polySnapshot.market.endDate).getTime() - Date.now()) / 60_000 : null;
  const polyTimeLeftColor = settlementLeftMin !== null ? (settlementLeftMin >= 10 ? ANSI.green : settlementLeftMin >= 5 ? ANSI.yellow : ANSI.red) : ANSI.reset;
  const polyTimeLeftDisplay = settlementLeftMin !== null ? fmtTimeLeft(settlementLeftMin) : "-";

  const priceToBeat = polySnapshot.ok ? priceToBeatFromPolymarketMarket(polySnapshot.market) : null;
  const ptbDelta = (currentPrice !== null && priceToBeat !== null) ? currentPrice - priceToBeat : null;
  const ptbDeltaColor = ptbDelta === null ? ANSI.gray : ptbDelta > 0 ? ANSI.green : ptbDelta < 0 ? ANSI.red : ANSI.gray;
  const ptbDeltaText = ptbDelta === null ? `${ANSI.gray}-${ANSI.reset}` : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ""}${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
  const currentPriceLine = kv("CURRENT PRICE", `${colorPriceLine({ label: "", price: currentPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" })} (${ptbDeltaText})`);

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
}

async function startApp() {
  // --- Initialization ---
  await initializeLedger(); // Ensure ledger file structure is correct
  applyGlobalProxyFromEnv(); // Apply proxy settings from environment

  // --- Unified Trading Engine (Clean Architecture) ---
  // getMarket thunk: lazily resolves the current Polymarket market
  let _cachedMarket = null;
  let _marketFetchedAt = 0;
  const getMarket = () => _cachedMarket;
  const refreshMarket = async () => {
    try {
      _cachedMarket = await resolveCurrentBtc5mMarket();
      _marketFetchedAt = Date.now();
    } catch { /* best-effort */ }
    return _cachedMarket;
  };

  const paperConfig = { ...CONFIG.paperTrading };
  const paperExecutor = new PaperExecutor({ config: paperConfig, getMarket });
  await paperExecutor.initialize();

  let liveExecutor = null;
  if (CONFIG.liveTrading?.enabled) {
    try {
      const liveConfig = { ...CONFIG.paperTrading, ...CONFIG.liveTrading };
      liveExecutor = new LiveExecutor({ config: liveConfig, getMarket });
      await liveExecutor.initialize();
    } catch (e) {
      console.error('Failed to initialize LiveExecutor:', e);
      liveExecutor = null;
    }
  }

  const modeManager = new ModeManager({
    paperExecutor,
    liveExecutor,
    initialMode: CONFIG.liveTrading?.enabled ? 'live' : 'paper',
  });

  const activeExecutor = modeManager.getActiveExecutor();
  const activeConfig = modeManager.getMode() === 'live'
    ? { ...CONFIG.paperTrading, ...CONFIG.liveTrading }
    : { ...CONFIG.paperTrading };

  const engine = new TradingEngine({
    executor: activeExecutor,
    config: activeConfig,
  });

  // Expose for API routes (server.js, statusService.js)
  globalThis.__tradingEngine = engine;
  globalThis.__modeManager = modeManager;

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
  } catch (e) { console.debug('Chainlink REST prime skipped:', e.message); }

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
  console.log(`Mode: ${modeManager.getMode()} | Live available: ${modeManager.isLiveAvailable()}`);
  console.log(`Trading: ${engine.tradingEnabled ? 'ACTIVE' : 'STOPPED (start via UI)'}`);
  console.log(`BTC feed: Chainlink WS (candles built from ticks).`);
  console.log(`UI Server running on http://localhost:${CONFIG.uiPort}. Use 'ngrok http ${CONFIG.uiPort}' for remote access.`);

  let prevCurrentPrice = null;
  const csvHeader = ["timestamp", "time_left", "regime", "signal", "model_up", "model_down", "mkt_up", "mkt_down", "edge_up", "edge_down", "rec"];

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
      } catch (e) { console.debug('Late candle seed failed:', e.message); }
    }

    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);
    const timeLeftMin = timing.remainingMinutes;

    let currentPrice = null;

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
      try { currentPrice = await klineProvider.fetchLastPrice(); }
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
      console.debug('Liquidity sampling failed:', e.message);
    }

    const indicatorsData = computeIndicators(klines1m, currentPrice);

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

    // Spot impulse (Coinbase) over last 60s
    const spotLast = spotStream?.getLast?.() ?? { price: null, ts: null };
    const spotNow = (typeof spotLast.price === "number" && Number.isFinite(spotLast.price)) ? spotLast.price : null;
    let spotDelta1mPct = null;
    if (spotNow !== null && spotTicks.length) {
      const targetT = Date.now() - 60_000;
      let base = null;
      for (let i = 0; i < spotTicks.length; i += 1) {
        if (spotTicks[i].t >= targetT) { base = spotTicks[i].price; break; }
      }
      if (base === null) base = spotTicks[0]?.price ?? null;
      if (typeof base === "number" && Number.isFinite(base) && base > 0) {
        spotDelta1mPct = (spotNow - base) / base;
      }
    }

    const predictNarrative = (timeAware.adjustedUp !== null && timeAware.adjustedDown !== null)
      ? (timeAware.adjustedUp > timeAware.adjustedDown ? "LONG" : "SHORT") : "NEUTRAL";
    const signalsForTrader = buildSignals({ rec, klines1m, polySnapshot, polyPrices, marketUp, marketDown, timeLeftMin, timeAware, indicatorsData, spotNow, spotDelta1mPct });

    globalThis.__uiStatus = {
      marketSlug: polySnapshot.ok ? (polySnapshot.market?.slug ?? null) : null,
      timeLeftMin, btcPrice: currentPrice, spotPrice: spotNow, spotDelta1mPct,
      modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, narrative: predictNarrative,
      polyUp: polyPrices.UP, polyDown: polyPrices.DOWN, candleCount: klines1m?.length ?? 0,
      lastUpdate: new Date().toISOString()
    };

    // Refresh market cache for executor's getMarket() thunk
    if (Date.now() - _marketFetchedAt > CONFIG.pollIntervalMs) {
      _cachedMarket = polySnapshot.ok ? polySnapshot.market : _cachedMarket;
    }

    // Unified trading engine: handles both paper and live via active executor
    await engine.processSignals(signalsForTrader, klines1m);

    const signal = rec.action === "ENTER" ? `${rec.side} (${rec.phase})` : "NO TRADE";
    appendCsvRow("./logs/signals.csv", csvHeader, [new Date().toISOString(), timing.elapsedMinutes.toFixed(3), signal, timeAware.adjustedUp, timeAware.adjustedDown, marketUp, marketDown, edge.edgeUp, edge.edgeDown, rec.action === "ENTER" ? `${rec.side}:${rec.phase}` : "NO_TRADE"]);

    renderConsole({ indicatorsData, timeAware, marketUp, marketDown, klines1m, polySnapshot, currentPrice, prevCurrentPrice, timeLeftMin });

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
