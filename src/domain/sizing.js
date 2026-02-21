/**
 * @file Position sizing logic.
 *
 * Pure function — no I/O, no side effects.
 *
 * Extracted from:
 *   - src/paper_trading/trader.js  computeContractSizeUsd()  lines 88-108
 */

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Compute the USD trade size for a new position.
 *
 * Supports two modes:
 *   1. **Dynamic sizing**: `stakePct * balance` (when `config.stakePct > 0`)
 *   2. **Fixed sizing**: flat `config.contractSize` dollars (fallback)
 *
 * The result is clamped to `[minTradeUsd, maxTradeUsd]`, capped at balance,
 * and rounded down to the nearest cent.
 *
 * @param {number} balance          - Current available balance ($)
 * @param {Object} config
 * @param {number} [config.stakePct]      - Fraction of balance to risk (0..1)
 * @param {number} [config.contractSize]  - Fixed contract size ($) (fallback if no stakePct)
 * @param {number} [config.minTradeUsd]   - Minimum trade size ($)
 * @param {number} [config.maxTradeUsd]   - Maximum trade size ($)
 * @returns {number} Trade size in USD (0 if no valid size)
 */
export function computeTradeSize(balance, config) {
  if (!isNum(balance) || balance <= 0) return 0;

  const stakePct = config.stakePct;
  const useDynamic = isNum(stakePct) && stakePct > 0;

  const minUsd = config.minTradeUsd ?? 0;
  const maxUsd = config.maxTradeUsd ?? Number.POSITIVE_INFINITY;

  let size = useDynamic
    ? balance * stakePct
    : (config.contractSize ?? 100);

  size = Math.max(minUsd, Math.min(maxUsd, size));
  size = Math.min(size, balance);

  // Round down to the nearest cent
  size = Math.floor(size * 100) / 100;

  return size > 0 ? size : 0;
}
