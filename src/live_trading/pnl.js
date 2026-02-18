function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Average-cost realized PnL computation from CLOB trades.
 * Returns { realizedTotal, realizedByToken, inventoryByToken }
 */
export function computeRealizedPnlAvgCost(trades) {
  const inv = new Map();
  const realizedByToken = new Map();

  for (const t of Array.isArray(trades) ? trades : []) {
    const tokenID = t?.asset_id;
    if (!tokenID) continue;

    const side = String(t?.side || '').toUpperCase();
    const size = toNum(t?.size);
    const price = toNum(t?.price);
    if (!size || !price) continue;

    const cur = inv.get(tokenID) || { qty: 0, cost: 0 };

    if (side === 'BUY') {
      cur.qty += size;
      cur.cost += size * price;
    } else if (side === 'SELL') {
      const avgCost = cur.qty > 0 ? (cur.cost / cur.qty) : 0;
      const realized = (price - avgCost) * size;
      realizedByToken.set(tokenID, (realizedByToken.get(tokenID) || 0) + realized);

      // reduce inventory
      const newQty = cur.qty - size;
      cur.qty = newQty;
      cur.cost = Math.max(0, cur.cost - avgCost * size);
    }

    inv.set(tokenID, cur);
  }

  let realizedTotal = 0;
  for (const v of realizedByToken.values()) realizedTotal += v;

  return {
    realizedTotal,
    realizedByToken: Object.fromEntries(realizedByToken.entries()),
    inventoryByToken: Object.fromEntries(Array.from(inv.entries()).map(([k, v]) => [k, v.qty]))
  };
}
