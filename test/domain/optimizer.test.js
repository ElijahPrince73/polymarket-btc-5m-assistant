import test from 'node:test';
import assert from 'node:assert';
import { cartesianProduct, generateParamRanges, gridSearch, DEFAULT_PARAM_RANGES } from '../../src/domain/optimizer.js';

// ─── cartesianProduct tests ──────────────────────────────────────

test('cartesianProduct: 2 params with 3 values each -> 9 combinations', () => {
  const ranges = {
    a: [1, 2, 3],
    b: [10, 20, 30],
  };
  const combos = cartesianProduct(ranges);
  assert.strictEqual(combos.length, 9);

  // Verify all combinations exist
  const expected = [
    { a: 1, b: 10 }, { a: 1, b: 20 }, { a: 1, b: 30 },
    { a: 2, b: 10 }, { a: 2, b: 20 }, { a: 2, b: 30 },
    { a: 3, b: 10 }, { a: 3, b: 20 }, { a: 3, b: 30 },
  ];
  assert.deepStrictEqual(combos, expected);
});

test('cartesianProduct: single param -> array of single-element objects', () => {
  const ranges = { x: [1, 2, 3] };
  const combos = cartesianProduct(ranges);
  assert.strictEqual(combos.length, 3);
  assert.deepStrictEqual(combos, [{ x: 1 }, { x: 2 }, { x: 3 }]);
});

test('cartesianProduct: empty input -> single empty combination', () => {
  const combos = cartesianProduct({});
  assert.strictEqual(combos.length, 1);
  assert.deepStrictEqual(combos, [{}]);
});

test('cartesianProduct: null input -> single empty combination', () => {
  const combos = cartesianProduct(null);
  assert.strictEqual(combos.length, 1);
  assert.deepStrictEqual(combos, [{}]);
});

// ─── generateParamRanges tests ───────────────────────────────────

test('generateParamRanges: known range config -> correct array of values', () => {
  const config = {
    minProbMid: { min: 0.50, max: 0.53, step: 0.01 },
  };
  const ranges = generateParamRanges(config);
  assert.deepStrictEqual(ranges.minProbMid, [0.50, 0.51, 0.52, 0.53]);
});

test('generateParamRanges: floating point correctness with 0.01 steps', () => {
  const config = {
    edgeMid: { min: 0.01, max: 0.04, step: 0.01 },
  };
  const ranges = generateParamRanges(config);
  assert.deepStrictEqual(ranges.edgeMid, [0.01, 0.02, 0.03, 0.04]);
  // Verify no floating point accumulation (e.g., 0.030000000000000004)
  for (const val of ranges.edgeMid) {
    const str = String(val);
    assert.ok(str.length <= 4, `Expected clean float, got: ${str}`);
  }
});

test('generateParamRanges: integer steps', () => {
  const config = {
    noTradeRsiMin: { min: 25, max: 40, step: 5 },
  };
  const ranges = generateParamRanges(config);
  assert.deepStrictEqual(ranges.noTradeRsiMin, [25, 30, 35, 40]);
});

test('generateParamRanges: single value when min equals max', () => {
  const config = {
    x: { min: 0.05, max: 0.05, step: 0.01 },
  };
  const ranges = generateParamRanges(config);
  assert.deepStrictEqual(ranges.x, [0.05]);
});

test('generateParamRanges: empty/null input returns empty object', () => {
  assert.deepStrictEqual(generateParamRanges(null), {});
  assert.deepStrictEqual(generateParamRanges({}), {});
});

test('generateParamRanges: skips invalid range entries', () => {
  const config = {
    valid: { min: 1, max: 3, step: 1 },
    noStep: { min: 1, max: 3 },
    reversed: { min: 5, max: 2, step: 1 },
  };
  const ranges = generateParamRanges(config);
  assert.deepStrictEqual(ranges.valid, [1, 2, 3]);
  assert.strictEqual(ranges.noStep, undefined);
  assert.strictEqual(ranges.reversed, undefined);
});

// ─── gridSearch tests ────────────────────────────────────────────

function makeMockTrades(n = 50) {
  const trades = [];
  for (let i = 0; i < n; i++) {
    trades.push({
      id: String(i + 1),
      status: 'CLOSED',
      pnl: (i % 3 === 0) ? -5 : 10,
      modelProbAtEntry: 0.50 + (i % 10) * 0.02,  // 0.50 to 0.68
      edgeAtEntry: 0.02 + (i % 8) * 0.01,         // 0.02 to 0.09
      rsiAtEntry: 20 + (i % 7) * 10,               // 20 to 80
      spreadAtEntry: 0.003,
      liquidityAtEntry: 10000,
      spotImpulsePctAtEntry: 0.001,
      entryTime: new Date(Date.now() - (n - i) * 60000).toISOString(),
      exitTime: new Date(Date.now() - (n - i) * 60000 + 30000).toISOString(),
    });
  }
  return trades;
}

const baseConfig = {
  minProbMid: 0.53,
  edgeMid: 0.03,
  noTradeRsiMin: 30,
  noTradeRsiMax: 45,
  maxSpreadThreshold: 0.012,
  minLiquidity: 500,
  minSpotImpulse: 0.0003,
};

test('gridSearch: small 2x2 grid produces results', () => {
  const trades = makeMockTrades(50);
  const paramRanges = {
    minProbMid: [0.50, 0.53],
    edgeMid: [0.02, 0.03],
  };
  const result = gridSearch(trades, baseConfig, paramRanges, 5);

  assert.strictEqual(result.totalCombinations, 4);
  assert.deepStrictEqual(result.paramNames, ['minProbMid', 'edgeMid']);
  assert.ok(result.results.length > 0);
  assert.ok(result.results.length + result.skippedCombinations === 4);
});

test('gridSearch: results sorted by profitFactor descending', () => {
  const trades = makeMockTrades(50);
  const paramRanges = {
    minProbMid: [0.50, 0.52, 0.54],
    edgeMid: [0.02, 0.03],
  };
  const result = gridSearch(trades, baseConfig, paramRanges, 5);

  // Verify sorting order
  for (let i = 1; i < result.results.length; i++) {
    const prevPF = result.results[i - 1].profitFactor ?? -Infinity;
    const currPF = result.results[i].profitFactor ?? -Infinity;
    if (prevPF === currPF) {
      const prevWR = result.results[i - 1].winRate ?? -Infinity;
      const currWR = result.results[i].winRate ?? -Infinity;
      assert.ok(prevWR >= currWR, `Secondary sort by winRate failed at index ${i}`);
    } else {
      assert.ok(prevPF >= currPF, `Primary sort by profitFactor failed at index ${i}`);
    }
  }
});

test('gridSearch: combinations with < minTradesPerCombo are skipped', () => {
  const trades = makeMockTrades(50);
  const paramRanges = {
    minProbMid: [0.50, 0.90],  // 0.90 will filter almost everything
    edgeMid: [0.02],
  };
  const result = gridSearch(trades, baseConfig, paramRanges, 30);

  // The combo with minProbMid=0.90 should be skipped (too few trades)
  assert.ok(result.skippedCombinations > 0, 'Expected some skipped combos');
  assert.strictEqual(result.totalCombinations, 2);
});

test('gridSearch: error thrown when combos > 10,000', () => {
  // Build param ranges that exceed 10,000 combinations
  const paramRanges = {
    a: Array.from({ length: 50 }, (_, i) => i),
    b: Array.from({ length: 50 }, (_, i) => i),
    c: Array.from({ length: 5 }, (_, i) => i),
  };
  // 50 * 50 * 5 = 12,500 > 10,000

  assert.throws(
    () => gridSearch([], baseConfig, paramRanges, 1),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('12500'));
      assert.ok(err.message.includes('10,000'));
      return true;
    }
  );
});

test('gridSearch: empty param ranges returns empty results', () => {
  const trades = makeMockTrades(50);
  const result = gridSearch(trades, baseConfig, {}, 5);

  // Empty param ranges => cartesianProduct => [{}] => 1 combination with no overrides
  assert.strictEqual(result.totalCombinations, 1);
  assert.ok(result.results.length <= 1);
});

test('gridSearch: each result has required fields', () => {
  const trades = makeMockTrades(50);
  const paramRanges = {
    minProbMid: [0.50, 0.53],
  };
  const result = gridSearch(trades, baseConfig, paramRanges, 5);

  const requiredFields = ['params', 'tradeCount', 'filteredCount', 'winRate', 'profitFactor', 'totalPnl', 'maxDrawdown', 'avgWin', 'avgLoss', 'expectancy'];
  for (const r of result.results) {
    for (const field of requiredFields) {
      assert.ok(field in r, `Missing field: ${field}`);
    }
  }
});

test('DEFAULT_PARAM_RANGES is exported and has expected keys', () => {
  assert.ok(DEFAULT_PARAM_RANGES);
  assert.ok('minProbMid' in DEFAULT_PARAM_RANGES);
  assert.ok('edgeMid' in DEFAULT_PARAM_RANGES);
  assert.ok('noTradeRsiMin' in DEFAULT_PARAM_RANGES);
  assert.ok('noTradeRsiMax' in DEFAULT_PARAM_RANGES);
  assert.ok('maxEntryPolyPrice' in DEFAULT_PARAM_RANGES);
});
