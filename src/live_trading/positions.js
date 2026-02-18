import { fetchClobPrice } from '../data/polymarket.js';
import { getClobClient } from './clob.js';

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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

async function fetchMarkBestEffort(client, tokenID) {
  if (!tokenID) return { mark: null, tradable: false };

  // 1) Prefer orderbook midpoint (fast + stable when available)
  try {
    const book = await client.getOrderBook(String(tokenID));
    const bestBid = Array.isArray(book?.bids) && book.bids.length ? toNum(book.bids[0]?.price) : null;
    const bestAsk = Array.isArray(book?.asks) && book.asks.length ? toNum(book.asks[0]?.price) : null;

    // If the orderbook exists but is empty, it's effectively not tradable right now.
    const tradable = Boolean(bestBid !== null || bestAsk !== null);

    if (bestBid !== null && bestAsk !== null) return { mark: (bestBid + bestAsk) / 2, tradable };
    if (bestBid !== null) return { mark: bestBid, tradable };
    if (bestAsk !== null) return { mark: bestAsk, tradable };

    return { mark: null, tradable: false };
  } catch (e) {
    // If there's no orderbook for the token, do NOT use last trade fallbacks—can't exit anyway.
    if (e?.response?.status === 404) return { mark: null, tradable: false };
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
