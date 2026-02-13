import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSessionVwap } from '../src/indicators/vwap.js';

test('computeSessionVwap falls back to unweighted typical price average when volume is zero', () => {
  const candles = [
    { high: 110, low: 90, close: 100, volume: 0 },
    { high: 120, low: 100, close: 110, volume: 0 }
  ];

  const tp1 = (110 + 90 + 100) / 3;
  const tp2 = (120 + 100 + 110) / 3;
  const expected = (tp1 + tp2) / 2;

  const vwap = computeSessionVwap(candles);
  assert.ok(Number.isFinite(vwap));
  assert.equal(vwap, expected);
});
