import { CONFIG } from "../config.js";
import { sleep } from "../utils.js";

// Helper to convert string numbers to finite numbers, null if invalid
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Helper to format datetime for Coinbase API
function formatDatetime(date) {
  return date.toISOString();
}

// Fetch historical klines from Coinbase API
export async function fetchKlines({ interval, limit }) {
  const product_id = CONFIG.coinbase.symbol; // e.g. BTC-USD
  const granularityMap = {
    "1m": 60,    // 1 minute
    "5m": 300,   // 5 minutes
    "15m": 900,  // 15 minutes
  };
  const granularity = granularityMap[interval];
  if (!granularity) {
    throw new Error(`Unsupported interval for Coinbase: ${interval}`);
  }

  // Coinbase API typically needs start and end times. For 'limit', we'll fetch a sufficient range.
  // The API often returns data in reverse chronological order, so we might need to adjust.
  // Let's fetch slightly more than 'limit' candles to ensure we get the required ones when ordered.
  // Fetching the last 'limit' data points means we need to specify 'end' and go back in time.
  // Coinbase API v2: https://docs.cloud.coinbase.com/exchange/reference/get-product-candlesticks
  // It uses start/end timestamps and granularity.
  // For simplicity, we'll fetch a range and slice it. Let's assume we need the latest 'limit' candles.
  // The API returns candles in chronological order.

  const endTime = new Date(); // Current time as end
  // To get 'limit' candles, we need to estimate the start time.
  // Assuming limit is within a reasonable range, e.g., a few hours of 1m candles.
  // Fallback if limit is too large or interval is too small/large.
  const startTime = new Date(endTime - (limit * granularity * 1.5 * 1000)); // Fetch a bit more than needed

  const url = new URL(`/v2/products/${product_id}/candles`, CONFIG.coinbase.baseUrl);
  url.searchParams.set("start", formatDatetime(startTime));
  url.searchParams.set("end", formatDatetime(endTime));
  url.searchParams.set("granularity", String(granularity));

  let retries = 3;
  while (retries > 0) {
    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        // Check for rate limiting or other common errors
        if (res.status === 429 || res.status === 503) {
          console.log(`Coinbase API rate limited or unavailable (status ${res.status}). Retrying in 5s...`);
          await sleep(5000);
          retries--;
          continue;
        }
        throw new Error(`Coinbase API error: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();

      // Coinbase klines format: [ time, low, high, open, close, volume ]
      const formattedKlines = data.map((k) => ({
        openTime: Number(k[0]) * 1000, // Coinbase returns timestamp in seconds, convert to ms
        open: toNumber(k[3]),
        high: toNumber(k[2]),
        low: toNumber(k[1]),
        close: toNumber(k[4]),
        volume: toNumber(k[5]),
        closeTime: Number(k[0] + granularity) * 1000 // Estimate close time
      }));

      // Coinbase returns data chronologically. The original code clipped the last 'limit' items.
      // We need to ensure we return exactly 'limit' klines if available, and they are the latest.
      // The API returns data up to 'end', so slicing from the end should work if total returned is >= limit.
      const startIndex = Math.max(0, formattedKlines.length - limit);
      return formattedKlines.slice(startIndex);

    } catch (err) {
      console.error(`Error fetching Coinbase klines: ${err.message}`);
      retries--;
      if (retries === 0) throw err;
      await sleep(3000); // Wait before retrying
    }
  }
}

// Fetch last price from Coinbase API
export async function fetchLastPrice() {
  const product_id = CONFIG.coinbase.symbol; // e.g. BTC-USD
  const url = new URL(`/v2/products/${product_id}/ticker`, CONFIG.coinbase.baseUrl);

  let retries = 3;
  while (retries > 0) {
    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        if (res.status === 429 || res.status === 503) {
          console.log(`Coinbase API rate limited or unavailable (status ${res.status}). Retrying in 5s...`);
          await sleep(5000);
          retries--;
          continue;
        }
        throw new Error(`Coinbase API error: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return toNumber(data.price);
    } catch (err) {
      console.error(`Error fetching Coinbase last price: ${err.message}`);
      retries--;
      if (retries === 0) throw err;
      await sleep(3000);
    }
  }
}
