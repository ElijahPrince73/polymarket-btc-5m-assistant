import { fetchClobPrice } from '../data/polymarket.js';
import { getClobClient } from './clob.js';
import { CONFIG } from '../config.js';

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch orderbook directly via fetch() instead of the CLOB client library.
 * The library logs "[CLOB Client] request error" to stdout on 404s before
 * throwing, which we cannot suppress. Using raw fetch avoids that entirely.
 */
async function fetchOrderBookQuiet(tokenID) {
  const url = new URL('/book', CONFIG.clobBaseUrl);
  url.searchParams.set('token_id', String(tokenID));
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`CLOB book: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Compute per-asset position + avg entry from CLOB trades.
 * Trades schema: { asset_id, side (BUY/SELL), size, price, outcome, match_time }
 */
export function computePositionsFromTrades(trades) {
  const map = new Map();

  for (const t of Array.isArray(trades) ? trades : []) {
    const tokenID = t?.asset_id;
    if (!tokenID) continue;

    const side = String(t?.side || '').toUpperCase();
    const size = toNum(t?.size);
    const price = toNum(t?.price);
    if (!size || !price) continue;

    const cur = map.get(tokenID) || {
      tokenID,
      outcome: t?.outcome ?? null,
      qty: 0,
      buyQty: 0,
      buyNotional: 0,
      sellQty: 0,
      sellNotional: 0,
      lastTradeTime: null,
    };

    cur.lastTradeTime = t?.match_time ?? cur.lastTradeTime;

    if (side === 'BUY') {
      cur.qty += size;
      cur.buyQty += size;
      cur.buyNotional += size * price;
      cur.outcome = cur.outcome ?? t?.outcome ?? null;
    } else if (side === 'SELL') {
      cur.qty -= size;
      cur.sellQty += size;
      cur.sellNotional += size * price;
    }

    map.set(tokenID, cur);
  }

  const positions = Array.from(map.values())
    .filter((p) => Math.abs(p.qty) > 1e-9)
    .map((p) => {
      const avgEntry = p.buyQty > 0 ? (p.buyNotional / p.buyQty) : null;
      const avgExit = p.sellQty > 0 ? (p.sellNotional / p.sellQty) : null;
      return { ...p, avgEntry, avgExit };
    })
    .sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty));

  return positions;
}

async function mapLimit(items, limit, fn) {
  const arr = Array.isArray(items) ? items : [];
  const out = new Array(arr.length);
  let idx = 0;

  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= arr.length) break;
      out[i] = await fn(arr[i], i);
    }
  });

  await Promise.all(workers);
  return out;
}

// Token IDs that returned 404 (expired/no orderbook). Avoids repeated CLOB
// queries that trigger noisy library-level error logs we can't suppress.
const _expiredTokenIds = new Set();

async function fetchMarkBestEffort(client, tokenID) {
  if (!tokenID) return { mark: null, tradable: false };

  // Skip tokens we already know are expired — prevents the CLOB client
  // library from logging "[CLOB Client] request error" every poll cycle.
  if (_expiredTokenIds.has(String(tokenID))) {
    return { mark: null, tradable: false };
  }

  // 1) Prefer orderbook midpoint via raw fetch (avoids CLOB client library's
  //    noisy "[CLOB Client] request error" log on 404s for expired tokens).
  try {
    const book = await fetchOrderBookQuiet(tokenID);
    const bestBid = Array.isArray(book?.bids) && book.bids.length ? toNum(book.bids[0]?.price) : null;
    const bestAsk = Array.isArray(book?.asks) && book.asks.length ? toNum(book.asks[0]?.price) : null;

    const tradable = Boolean(bestBid !== null || bestAsk !== null);

    if (bestBid !== null && bestAsk !== null) return { mark: (bestBid + bestAsk) / 2, tradable };
    if (bestBid !== null) return { mark: bestBid, tradable };
    if (bestAsk !== null) return { mark: bestAsk, tradable };

    return { mark: null, tradable: false };
  } catch (e) {
    // No orderbook for this token (404) → expired/non-tradable. Cache it.
    if (e?.status === 404 || String(e?.message).includes('404')) {
      _expiredTokenIds.add(String(tokenID));
      console.debug(`Cached expired token (no orderbook): ${String(tokenID).slice(0, 12)}…`);
      return { mark: null, tradable: false };
    }
    // For other errors, continue to fallback
  }

  // 2) Fallback: last trade price (useful when the book fetch is flaky/timeouts)
  try {
    const last = await client.getLastTradePrice(String(tokenID));
    const px = (typeof last === 'object' && last !== null) ? toNum(last?.price ?? last?.last_price) : toNum(last);
    if (px !== null) return { mark: px, tradable: true };
  } catch {
    // ignore
  }

  // 3) Legacy fallback: our existing price fetcher
  try {
    const px = await fetchClobPrice({ tokenId: String(tokenID), side: 'sell' });
    const n = toNum(px);
    return { mark: n, tradable: n !== null };
  } catch {
    return { mark: null, tradable: false };
  }
}

export async function enrichPositionsWithMarks(positions) {
  const client = getClobClient();
  const ps = Array.isArray(positions) ? positions : [];

  // Concurrency limit to avoid hanging the UI when many positions exist.
  const enriched = await mapLimit(ps, 6, async (p) => {
    const { mark, tradable } = await fetchMarkBestEffort(client, p.tokenID);

    let unrealizedPnl = null;
    if (mark !== null && p.avgEntry !== null) {
      unrealizedPnl = (mark - p.avgEntry) * p.qty;
    }

    return { ...p, mark, tradable, unrealizedPnl };
  });

  return enriched;
}
