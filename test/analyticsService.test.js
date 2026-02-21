import test from 'node:test';
import assert from 'node:assert/strict';

import { computeAnalytics } from '../src/services/analyticsService.js';

test('computeAnalytics with empty trades returns zero/null counts', () => {
  const result = computeAnalytics([]);
  assert.equal(result.overview.closedTrades, 0);
  assert.equal(result.overview.winRate, null);
  assert.equal(result.overview.profitFactor, null);
  assert.equal(result.overview.totalPnL, 0);
});

test('computeAnalytics with mixed trades returns correct stats', () => {
  const trades = [
    { status: 'CLOSED', pnl: 10, side: 'UP' },
    { status: 'CLOSED', pnl: -5, side: 'UP' },
    { status: 'CLOSED', pnl: 8, side: 'DOWN' },
  ];

  const result = computeAnalytics(trades);
  assert.equal(result.overview.closedTrades, 3);
  assert.equal(result.overview.wins, 2);
  assert.equal(result.overview.losses, 1);
  assert.equal(result.overview.totalPnL, 13);
  // winRate = 2/3
  assert.ok(Math.abs(result.overview.winRate - 2/3) < 0.001);
  // profitFactor = (10+8) / |-5| = 3.6
  assert.ok(Math.abs(result.overview.profitFactor - 3.6) < 0.001);
});

test('computeAnalytics computes expectancy correctly', () => {
  const trades = [
    { status: 'CLOSED', pnl: 20, side: 'UP' },
    { status: 'CLOSED', pnl: -10, side: 'UP' },
  ];

  const result = computeAnalytics(trades);
  // expectancy = totalPnL / totalTrades = 10 / 2 = 5
  assert.equal(result.overview.expectancy, 5);
});

test('computeAnalytics ignores non-CLOSED trades', () => {
  const trades = [
    { status: 'CLOSED', pnl: 10, side: 'UP' },
    { status: 'OPEN', pnl: -50, side: 'DOWN' },
  ];

  const result = computeAnalytics(trades);
  assert.equal(result.overview.closedTrades, 1);
  assert.equal(result.overview.totalPnL, 10);
});
