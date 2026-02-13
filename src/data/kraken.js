import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";
import { sleep } from "../utils.js";

// Helper to convert string numbers to finite numbers, null if invalid
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// --- Caching and Rate Limiting for REST API Calls ---
// NOTE: Kraken REST is rate-limited. We aggressively cache + coalesce requests.
const klineCache = {
  data: [],
  timestamp: 0,
  expirationMs: 30_000 // Cache klines for 30 seconds to reduce API hits
};
let inFlightKlinesPromise = null;
let lastOhlcRestCallMs = 0;
const OHLC_MIN_INTERVAL_MS = 25_000; // hard throttle (even if callers spam)

const lastPriceCache = {
  price: null,
  timestamp: 0,
  expirationMs: 5_000
};
let inFlightLastPricePromise = null;
let lastTickerRestCallMs = 0;
const TICKER_MIN_INTERVAL_MS = 2_000;

const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 5000; // Start with 5 seconds delay for rate limits

// Fetch historical klines from Kraken API with caching + backoff.
// Never hard-crash callers if we have cached data available.
export async function fetchKlines({ interval, limit }) {
  const pair = CONFIG.kraken.pair;
  const krakenIntervalMap = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "3h": 180, "4h": 240, "1d": 1440 };
  const krakenIntervalMinutes = krakenIntervalMap[interval];
  if (!krakenIntervalMinutes) throw new Error(`Unsupported interval for Kraken OHLC: ${interval}`);

  const nowMs = Date.now();

  // Fast path: fresh cache
  if (klineCache.data.length > 0 && (nowMs - klineCache.timestamp < klineCache.expirationMs)) {
    const startIndex = Math.max(0, klineCache.data.length - limit);
    return klineCache.data.slice(startIndex);
  }

  // Coalesce concurrent callers
  if (inFlightKlinesPromise) {
    try { await inFlightKlinesPromise; } catch { /* ignore */ }
    if (klineCache.data.length > 0) {
      const startIndex = Math.max(0, klineCache.data.length - limit);
      return klineCache.data.slice(startIndex);
    }
  }

  // Hard throttle REST
  if (klineCache.data.length > 0 && (nowMs - lastOhlcRestCallMs < OHLC_MIN_INTERVAL_MS)) {
    const startIndex = Math.max(0, klineCache.data.length - limit);
    return klineCache.data.slice(startIndex);
  }

  const doFetch = async () => {
    // Fetch fresh data
    const lookbackMs = limit * krakenIntervalMinutes * 60 * 1000;
    const sinceTimestamp = Math.floor((Date.now() - lookbackMs) / 1000);

    const url = new URL("/0/public/OHLC", CONFIG.kraken.baseUrl);
    url.searchParams.set("pair", pair);
    url.searchParams.set("interval", String(krakenIntervalMinutes));
    url.searchParams.set("since", String(sinceTimestamp));

    let retries = MAX_RETRY_ATTEMPTS;
    let currentRetryDelayMs = INITIAL_RETRY_DELAY_MS;

    while (retries > 0) {
      try {
        lastOhlcRestCallMs = Date.now();
        const res = await fetch(url.toString());
        if (!res.ok) {
          if (res.status === 429) {
            console.log(`Kraken API rate limited (status ${res.status}). Retrying REST OHLC in ${currentRetryDelayMs / 1000}s...`);
            await sleep(currentRetryDelayMs);
            currentRetryDelayMs = Math.min(currentRetryDelayMs * 2, 30_000);
            retries--;
            continue;
          }
          throw new Error(`Kraken API error: ${res.status} ${await res.text()}`);
        }

        const data = await res.json();
        if (data.error && data.error.length > 0) {
          throw new Error(`Kraken API error response: ${data.error.join(", ")}`);
        }

        const klinesForPair = data.result?.[pair];
        if (!klinesForPair) {
          throw new Error(`No OHLC data found for pair ${pair}`);
        }

        const formattedKlines = klinesForPair.map((k) => ({
          openTime: k[0] * 1000,
          open: toNumber(k[1]),
          high: toNumber(k[2]),
          low: toNumber(k[3]),
          close: toNumber(k[4]),
          volume: toNumber(k[5]),
          closeTime: (k[0] + krakenIntervalMinutes * 60) * 1000
        }));

        klineCache.data = formattedKlines;
        klineCache.timestamp = Date.now();

        const startIndex = Math.max(0, formattedKlines.length - limit);
        return formattedKlines.slice(startIndex);
      } catch (err) {
        console.error(`Error fetching Kraken klines for ${pair} (retries left: ${retries - 1}): ${err.message}`);
        retries--;
        if (retries === 0) throw err;
        await sleep(currentRetryDelayMs);
        currentRetryDelayMs = Math.min(currentRetryDelayMs * 2, 30_000);
      }
    }

    throw new Error(`fetchKlines: Failed to fetch data for ${pair} after multiple retries.`);
  };

  inFlightKlinesPromise = doFetch();
  try {
    return await inFlightKlinesPromise;
  } catch (err) {
    if (klineCache.data.length > 0) {
      console.warn(`Kraken OHLC REST failed; using cached klines (${klineCache.data.length}). Error: ${err.message}`);
      const startIndex = Math.max(0, klineCache.data.length - limit);
      return klineCache.data.slice(startIndex);
    }
    throw err;
  } finally {
    inFlightKlinesPromise = null;
  }
}

// --- Last Price Fetching with Backoff ---
export async function fetchLastPrice() {
  const pair = CONFIG.kraken.pair;
  const nowMs = Date.now();

  // Fresh cache
  if (lastPriceCache.price !== null && (nowMs - lastPriceCache.timestamp < lastPriceCache.expirationMs)) {
    return lastPriceCache.price;
  }

  // Coalesce callers
  if (inFlightLastPricePromise) {
    try { return await inFlightLastPricePromise; } catch { /* ignore */ }
    if (lastPriceCache.price !== null) return lastPriceCache.price;
  }

  // Hard throttle
  if (lastPriceCache.price !== null && (nowMs - lastTickerRestCallMs < TICKER_MIN_INTERVAL_MS)) {
    return lastPriceCache.price;
  }

  const doFetch = async () => {
    const url = new URL("/0/public/Ticker", CONFIG.kraken.baseUrl);
    url.searchParams.set("pair", pair);

    let retries = MAX_RETRY_ATTEMPTS;
    let currentRetryDelayMs = INITIAL_RETRY_DELAY_MS;

    while (retries > 0) {
      try {
        lastTickerRestCallMs = Date.now();
        const res = await fetch(url.toString());
        if (!res.ok) {
          if (res.status === 429) {
            console.log(`Kraken API rate limited (status ${res.status}). Retrying REST Ticker in ${currentRetryDelayMs / 1000}s...`);
            await sleep(currentRetryDelayMs);
            currentRetryDelayMs = Math.min(currentRetryDelayMs * 2, 30_000);
            retries--;
            continue;
          }
          throw new Error(`Kraken API error: ${res.status} ${await res.text()}`);
        }

        const data = await res.json();
        if (data.error && data.error.length > 0) {
          throw new Error(`Kraken API error response: ${data.error.join(", ")}`);
        }

        const tickerInfo = data.result?.[pair];
        const p = toNumber(tickerInfo?.a?.[0]);
        if (p === null) {
          throw new Error(`Could not find last trade price for ${pair}`);
        }

        lastPriceCache.price = p;
        lastPriceCache.timestamp = Date.now();
        return p;
      } catch (err) {
        console.error(`Error fetching Kraken ticker for ${pair} (retries left: ${retries - 1}): ${err.message}`);
        retries--;
        if (retries === 0) throw err;
        await sleep(currentRetryDelayMs);
        currentRetryDelayMs = Math.min(currentRetryDelayMs * 2, 30_000);
      }
    }

    throw new Error(`fetchLastPrice: Failed to fetch data for ${pair} after multiple retries.`);
  };

  inFlightLastPricePromise = doFetch();
  try {
    return await inFlightLastPricePromise;
  } catch (err) {
    if (lastPriceCache.price !== null) {
      console.warn(`Kraken Ticker REST failed; using cached lastPrice. Error: ${err.message}`);
      return lastPriceCache.price;
    }
    throw err;
  } finally {
    inFlightLastPricePromise = null;
  }
}

// WebSocket Trade Stream for Kraken
const KRAKEN_WS_URL = CONFIG.kraken.wsUrl || "wss://ws.kraken.com";

// Build the subscription message for Kraken WebSocket
function buildWsSubscriptionMessage(pair) {
  return JSON.stringify({
    "event": "subscribe",
    "subscription": { "name": "trade" },
    "pair": [pair]
  });
}

export function startKrakenTradeStream({ pair = CONFIG.kraken.pair, onUpdate } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let lastPrice = null;
  let lastTs = null;
  const MAX_RECONNECT_INTERVAL = 10000;

  const connect = () => {
    if (closed) return;

    const url = KRAKEN_WS_URL;
    const subscribeMessage = buildWsSubscriptionMessage(pair);
    const agent = wsAgentForUrl(url);

    ws = new WebSocket(url, { agent });

    ws.on("open", () => {
      console.log(`Kraken WebSocket connected to ${url}. Sending subscription for ${pair}...`);
      reconnectMs = 500;
      try {
        ws.send(subscribeMessage);
      } catch (e) {
        console.error("Failed to send Kraken subscription message:", e);
        scheduleReconnect();
      }
    });

    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());

        // Kraken v2 style events are objects; Kraken trade feed (commonly) comes as arrays:
        // [channelId, [[price, volume, time, side, orderType, misc], ...], "trade", "XBT/USD"]
        if (Array.isArray(msg)) {
          const channelName = msg[2];
          const msgPair = msg[3];
          if (channelName === "trade" && (msgPair === pair || String(msgPair).includes(pair))) {
            const trades = msg[1];
            if (Array.isArray(trades) && trades.length) {
              const t = trades[trades.length - 1];
              const price = toNumber(t?.[0]);
              const timestampSeconds = toNumber(t?.[2]);
              if (price !== null && timestampSeconds !== null) {
                lastPrice = price;
                lastTs = timestampSeconds * 1000;
                if (typeof onUpdate === "function") onUpdate({ price: lastPrice, ts: lastTs });
              }
            }
          }
          return;
        }

        if (msg.event === "subscribed" && (msg.channel === "trade" || msg.subscription?.name === "trade")) {
          console.log(`Kraken WebSocket subscription confirmed for ${pair}.`);
          return;
        }

        if (msg.event === "unsubscribed") {
          console.log("Kraken WebSocket unsubscribed:", msg);
          return;
        }

        if (msg.event === "error") {
          console.error("Kraken WebSocket Error:", msg.errorMessage, "Code:", msg.error);
          scheduleReconnect();
          return;
        }

        // ignore info/heartbeat
      } catch (e) {
        // Don't reconnect on occasional parse/format weirdness; just log.
        console.error("Error processing Kraken WebSocket message:", e);
      }
    });

    const scheduleReconnect = (opts = {}) => {
      if (closed) return;
      try { ws?.terminate(); } catch { /* ignore */ }
      ws = null;

      const wait = typeof opts.waitMs === "number" ? opts.waitMs : reconnectMs;
      // Exponential backoff with a higher cap to avoid 429 storms.
      reconnectMs = Math.min(60_000, Math.floor(reconnectMs * 1.8));

      setTimeout(connect, wait);
    };

    ws.on("close", () => {
      console.log("Kraken WebSocket disconnected. Attempting to reconnect...");
      scheduleReconnect();
    });
    ws.on("error", (err) => {
      const msg = String(err?.message || err);
      console.error("Kraken WebSocket encountered an error:", err);

      // If Kraken is rate limiting the WS handshake, back off hard.
      if (msg.includes("429")) {
        console.warn("Kraken WS rate-limited (429). Backing off 60s before reconnect.");
        reconnectMs = 60_000;
        scheduleReconnect({ waitMs: 60_000 });
        return;
      }

      scheduleReconnect();
    });
  };

  connect();

  return {
    getLast() { return { price: lastPrice, ts: lastTs }; },
    close() { closed = true; try { ws?.close(); } catch { /* ignore */ } ws = null; }
  };
}
