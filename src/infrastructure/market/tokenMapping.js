/**
 * @file Canonical token ID mapping.
 *
 * Single shared implementation of pickTokenId, eliminating the
 * duplication across PaperExecutor, LiveExecutor, and polymarket.js.
 */

/**
 * Resolve the CLOB tokenID for a given side from a Polymarket market object.
 *
 * @param {Object} market - Full market object from Gamma API
 * @param {'UP'|'DOWN'|string} side - Outcome label to match
 * @returns {string|null} CLOB token ID, or null if not found
 */
export function pickTokenId(market, side) {
  const outcomes = Array.isArray(market?.outcomes)
    ? market.outcomes
    : JSON.parse(market?.outcomes || '[]');
  const clobTokenIds = Array.isArray(market?.clobTokenIds)
    ? market.clobTokenIds
    : JSON.parse(market?.clobTokenIds || '[]');

  const label = String(side).toLowerCase();
  for (let i = 0; i < outcomes.length; i++) {
    if (String(outcomes[i]).toLowerCase() === label) {
      const tid = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
      if (tid) return tid;
    }
  }
  return null;
}

/**
 * Get all known CLOB token IDs from a market object.
 *
 * @param {Object} market - Full market object from Gamma API
 * @returns {string[]} Array of token IDs
 */
export function getAllTokenIds(market) {
  const clobTokenIds = Array.isArray(market?.clobTokenIds)
    ? market.clobTokenIds
    : JSON.parse(market?.clobTokenIds || '[]');

  return clobTokenIds
    .map((t) => (t ? String(t) : null))
    .filter(Boolean);
}
