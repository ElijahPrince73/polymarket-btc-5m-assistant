import test from 'node:test';
import assert from 'node:assert/strict';

import { computeTradeSize } from '../../src/domain/sizing.js';

// ─── Dynamic Sizing ────────────────────────────────────────────────

test('dynamic sizing: stakePct * balance', () => {
  const size = computeTradeSize(1000, { stakePct: 0.10 });
  assert.equal(size, 100); // 10% of 1000
});

test('dynamic sizing: respects maxTradeUsd', () => {
  const size = computeTradeSize(10000, { stakePct: 0.10, maxTradeUsd: 500 });
  assert.equal(size, 500); // 10% of 10000 = 1000, capped at 500
});

test('dynamic sizing: respects minTradeUsd', () => {
  const size = computeTradeSize(100, { stakePct: 0.01, minTradeUsd: 5 });
  assert.equal(size, 5); // 1% of 100 = 1, raised to min 5
});

test('dynamic sizing: capped at balance', () => {
  const size = computeTradeSize(50, { stakePct: 0.10, minTradeUsd: 100 });
  assert.equal(size, 50); // min 100 but only 50 available
});

// ─── Fixed Sizing ──────────────────────────────────────────────────

test('fixed sizing: uses contractSize when no stakePct', () => {
  const size = computeTradeSize(500, { contractSize: 100 });
  assert.equal(size, 100);
});

test('fixed sizing: default 100 when nothing configured', () => {
  const size = computeTradeSize(500, {});
  assert.equal(size, 100);
});

test('fixed sizing: capped at balance', () => {
  const size = computeTradeSize(50, { contractSize: 100 });
  assert.equal(size, 50);
});

// ─── Edge Cases ────────────────────────────────────────────────────

test('returns 0 for zero balance', () => {
  const size = computeTradeSize(0, { stakePct: 0.10 });
  assert.equal(size, 0);
});

test('returns 0 for negative balance', () => {
  const size = computeTradeSize(-100, { stakePct: 0.10 });
  assert.equal(size, 0);
});

test('returns 0 for NaN balance', () => {
  const size = computeTradeSize(NaN, { stakePct: 0.10 });
  assert.equal(size, 0);
});

test('rounds down to cents', () => {
  const size = computeTradeSize(333, { stakePct: 0.10 });
  // 333 * 0.10 = 33.3 → floor(33.3 * 100) / 100 = 33.30
  assert.equal(size, 33.30);
});

test('stakePct=0 falls back to fixed sizing', () => {
  const size = computeTradeSize(500, { stakePct: 0, contractSize: 75 });
  assert.equal(size, 75);
});
