import { fetchClobPrice } from '../data/polymarket.js';

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

export async function enrichPositionsWithMarks(positions) {
  const out = [];
  for (const p of Array.isArray(positions) ? positions : []) {
    let mark = null;
    try {
      // mid-ish mark: use buy quote as conservative (what it costs to enter), for pnl use sell quote.
      mark = await fetchClobPrice({ tokenId: p.tokenID, side: 'sell' });
    } catch {
      mark = null;
    }

    let unrealizedPnl = null;
    if (mark !== null && p.avgEntry !== null) {
      unrealizedPnl = (mark - p.avgEntry) * p.qty;
    }

    out.push({ ...p, mark, unrealizedPnl });
  }
  return out;
}
