import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAnalytics,
  groupSummary,
  dayKeyFromTrade,
  weekKeyFromTrade,
  sessionKeyFromTrade,
  computeDailyReturns,
  computeSharpeRatio,
  computeSortinoRatio,
  computeDrawdownSeries,
  computeMaxDrawdown,
} from '../src/services/analyticsService.js';

// ─── Existing tests ─────────────────────────────────────────────────

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

// ─── groupSummary enhanced fields ───────────────────────────────────

test('groupSummary includes wins, losses, winRate, avgPnl', () => {
  const trades = [
    { pnl: 10, side: 'UP' },
    { pnl: -5, side: 'UP' },
    { pnl: 8, side: 'DOWN' },
  ];
  const result = groupSummary(trades, t => t.side);
  const upBucket = result.find(b => b.key === 'UP');
  const downBucket = result.find(b => b.key === 'DOWN');

  assert.ok(upBucket);
  assert.equal(upBucket.wins, 1);
  assert.equal(upBucket.losses, 1);
  assert.ok(Math.abs(upBucket.winRate - 0.5) < 0.001);
  assert.ok(Math.abs(upBucket.avgPnl - 2.5) < 0.001);

  assert.ok(downBucket);
  assert.equal(downBucket.wins, 1);
  assert.equal(downBucket.losses, 0);
  assert.ok(Math.abs(downBucket.winRate - 1.0) < 0.001);
  assert.ok(Math.abs(downBucket.avgPnl - 8.0) < 0.001);
});

// ─── dayKeyFromTrade ────────────────────────────────────────────────

test('dayKeyFromTrade returns YYYY-MM-DD for valid timestamp', () => {
  const trade = { exitTime: '2026-02-23T15:30:00Z' };
  const key = dayKeyFromTrade(trade);
  // Should be a date string in YYYY-MM-DD format
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});

test('dayKeyFromTrade returns unknown for missing timestamp', () => {
  assert.equal(dayKeyFromTrade({}), 'unknown');
  assert.equal(dayKeyFromTrade(null), 'unknown');
  assert.equal(dayKeyFromTrade({ exitTime: null }), 'unknown');
});

test('dayKeyFromTrade falls back to timestamp when exitTime is missing', () => {
  const trade = { timestamp: '2026-02-23T12:00:00Z' };
  const key = dayKeyFromTrade(trade);
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});

// ─── weekKeyFromTrade ───────────────────────────────────────────────

test('weekKeyFromTrade returns YYYY-Wnn for valid timestamp', () => {
  const trade = { exitTime: '2026-02-23T15:30:00Z' };
  const key = weekKeyFromTrade(trade);
  assert.match(key, /^\d{4}-W\d{2}$/);
});

test('weekKeyFromTrade returns unknown for missing timestamp', () => {
  assert.equal(weekKeyFromTrade({}), 'unknown');
  assert.equal(weekKeyFromTrade(null), 'unknown');
});

// ─── sessionKeyFromTrade ────────────────────────────────────────────

test('sessionKeyFromTrade returns Asia for UTC 0-7', () => {
  const trade = { entryTime: '2026-02-23T05:30:00Z' };
  assert.equal(sessionKeyFromTrade(trade), 'Asia');
});

test('sessionKeyFromTrade returns London for UTC 8-12', () => {
  const trade = { entryTime: '2026-02-23T10:00:00Z' };
  assert.equal(sessionKeyFromTrade(trade), 'London');
});

test('sessionKeyFromTrade returns NY for UTC 13-20', () => {
  const trade = { entryTime: '2026-02-23T15:00:00Z' };
  assert.equal(sessionKeyFromTrade(trade), 'NY');
});

test('sessionKeyFromTrade returns Off-hours for UTC 21-23', () => {
  const trade = { entryTime: '2026-02-23T22:00:00Z' };
  assert.equal(sessionKeyFromTrade(trade), 'Off-hours');
});

test('sessionKeyFromTrade returns unknown for missing timestamp', () => {
  assert.equal(sessionKeyFromTrade({}), 'unknown');
  assert.equal(sessionKeyFromTrade(null), 'unknown');
});

// ─── computeSharpeRatio ─────────────────────────────────────────────

test('computeSharpeRatio returns null for empty array', () => {
  assert.equal(computeSharpeRatio([]), null);
});

test('computeSharpeRatio returns null for single element', () => {
  assert.equal(computeSharpeRatio([0.01]), null);
});

test('computeSharpeRatio returns null when stdDev is 0 (all equal returns)', () => {
  assert.equal(computeSharpeRatio([0.01, 0.01, 0.01, 0.01]), null);
});

test('computeSharpeRatio returns positive for all-positive returns with variance', () => {
  const returns = [0.01, 0.02, 0.015, 0.025, 0.01];
  const sharpe = computeSharpeRatio(returns);
  assert.ok(sharpe !== null);
  assert.ok(sharpe > 0, `Expected positive Sharpe, got ${sharpe}`);
});

test('computeSharpeRatio returns negative for all-negative returns', () => {
  const returns = [-0.01, -0.02, -0.015, -0.025, -0.01];
  const sharpe = computeSharpeRatio(returns);
  assert.ok(sharpe !== null);
  assert.ok(sharpe < 0, `Expected negative Sharpe, got ${sharpe}`);
});

test('computeSharpeRatio handles mix of positive and negative returns', () => {
  const returns = [0.02, -0.01, 0.03, -0.005, 0.01];
  const sharpe = computeSharpeRatio(returns);
  assert.ok(sharpe !== null);
  assert.equal(typeof sharpe, 'number');
});

// ─── computeSortinoRatio ────────────────────────────────────────────

test('computeSortinoRatio returns null for empty array', () => {
  assert.equal(computeSortinoRatio([]), null);
});

test('computeSortinoRatio returns null for single element', () => {
  assert.equal(computeSortinoRatio([0.01]), null);
});

test('computeSortinoRatio returns null when no negative returns', () => {
  assert.equal(computeSortinoRatio([0.01, 0.02, 0.03]), null);
});

test('computeSortinoRatio returns a number for mixed returns', () => {
  const returns = [0.02, -0.01, 0.03, -0.005, 0.01];
  const sortino = computeSortinoRatio(returns);
  assert.ok(sortino !== null);
  assert.equal(typeof sortino, 'number');
});

test('computeSortinoRatio uses downside-only deviation', () => {
  // With small downside, Sortino should be higher than Sharpe
  const returns = [0.05, 0.04, 0.03, -0.001, 0.06];
  const sharpe = computeSharpeRatio(returns);
  const sortino = computeSortinoRatio(returns);
  assert.ok(sharpe !== null);
  assert.ok(sortino !== null);
  // With very small downside vs large variance from positive returns, Sortino should be larger
  assert.ok(sortino > sharpe, `Expected Sortino (${sortino}) > Sharpe (${sharpe})`);
});

// ─── computeDrawdownSeries ──────────────────────────────────────────

test('computeDrawdownSeries tracks peak and drawdown correctly', () => {
  const trades = [
    { pnl: 10 },   // equity: 1010, peak: 1010, dd: 0
    { pnl: -20 },  // equity: 990, peak: 1010, dd: -20
    { pnl: 5 },    // equity: 995, peak: 1010, dd: -15
    { pnl: 30 },   // equity: 1025, peak: 1025, dd: 0
  ];
  const series = computeDrawdownSeries(trades, 1000);
  assert.equal(series.length, 4);

  assert.equal(series[0].equity, 1010);
  assert.equal(series[0].peak, 1010);
  assert.equal(series[0].drawdown, 0);

  assert.equal(series[1].equity, 990);
  assert.equal(series[1].peak, 1010);
  assert.equal(series[1].drawdown, -20);

  assert.equal(series[2].equity, 995);
  assert.equal(series[2].peak, 1010);
  assert.equal(series[2].drawdown, -15);

  assert.equal(series[3].equity, 1025);
  assert.equal(series[3].peak, 1025);
  assert.equal(series[3].drawdown, 0);
});

test('computeDrawdownSeries handles empty array', () => {
  const series = computeDrawdownSeries([], 1000);
  assert.equal(series.length, 0);
});

test('computeDrawdownSeries handles null pnl gracefully', () => {
  const trades = [
    { pnl: 10 },
    { pnl: null },
    { pnl: -5 },
  ];
  const series = computeDrawdownSeries(trades, 1000);
  assert.equal(series.length, 3);
  assert.equal(series[1].equity, 1010); // null treated as 0
  assert.equal(series[2].equity, 1005);
});

// ─── computeMaxDrawdown ─────────────────────────────────────────────

test('computeMaxDrawdown returns correct max drawdown', () => {
  const trades = [
    { pnl: 10 },   // peak 1010
    { pnl: -30 },  // equity 980, dd=30
    { pnl: 5 },    // equity 985, dd=25
    { pnl: 50 },   // equity 1035, new peak
    { pnl: -10 },  // equity 1025, dd=10
  ];
  const result = computeMaxDrawdown(trades, 1000);
  assert.equal(result.maxDrawdownUsd, 30);
  assert.ok(Math.abs(result.maxDrawdownPct - 30/1010) < 0.001);
});

test('computeMaxDrawdown handles empty trades', () => {
  const result = computeMaxDrawdown([], 1000);
  assert.equal(result.maxDrawdownUsd, 0);
  assert.equal(result.maxDrawdownPct, 0);
});

test('computeMaxDrawdown handles all-positive PnL', () => {
  const trades = [{ pnl: 10 }, { pnl: 20 }, { pnl: 5 }];
  const result = computeMaxDrawdown(trades, 1000);
  assert.equal(result.maxDrawdownUsd, 0);
  assert.equal(result.maxDrawdownPct, 0);
});

test('computeMaxDrawdown handles all-negative PnL', () => {
  const trades = [{ pnl: -10 }, { pnl: -20 }, { pnl: -5 }];
  const result = computeMaxDrawdown(trades, 1000);
  assert.equal(result.maxDrawdownUsd, 35);
  assert.ok(Math.abs(result.maxDrawdownPct - 35/1000) < 0.001);
});

// ─── computeAnalytics with period groupings and advanced metrics ────

test('computeAnalytics includes byDay, byWeek, bySession', () => {
  const trades = [
    { status: 'CLOSED', pnl: 10, exitTime: '2026-02-23T10:00:00Z', entryTime: '2026-02-23T09:55:00Z', timestamp: '2026-02-23T09:55:00Z' },
    { status: 'CLOSED', pnl: -5, exitTime: '2026-02-24T15:00:00Z', entryTime: '2026-02-24T14:55:00Z', timestamp: '2026-02-24T14:55:00Z' },
  ];
  const result = computeAnalytics(trades);
  assert.ok(Array.isArray(result.byDay));
  assert.ok(Array.isArray(result.byWeek));
  assert.ok(Array.isArray(result.bySession));
});

test('computeAnalytics includes advancedMetrics', () => {
  const trades = [
    { status: 'CLOSED', pnl: 10, exitTime: '2026-02-23T10:00:00Z', entryTime: '2026-02-23T09:55:00Z', timestamp: '2026-02-23T09:55:00Z' },
    { status: 'CLOSED', pnl: -5, exitTime: '2026-02-24T15:00:00Z', entryTime: '2026-02-24T14:55:00Z', timestamp: '2026-02-24T14:55:00Z' },
  ];
  const result = computeAnalytics(trades);
  assert.ok(result.advancedMetrics);
  assert.ok('sharpeRatio' in result.advancedMetrics);
  assert.ok('sortinoRatio' in result.advancedMetrics);
  assert.ok('maxDrawdownUsd' in result.advancedMetrics);
  assert.ok('maxDrawdownPct' in result.advancedMetrics);
  assert.ok('drawdownSeries' in result.advancedMetrics);
  assert.ok('dailyReturns' in result.advancedMetrics);
  assert.ok('dailyReturnCount' in result.advancedMetrics);
  assert.ok('metricsConfidence' in result.advancedMetrics);
});

test('computeAnalytics advancedMetrics handles empty trades', () => {
  const result = computeAnalytics([]);
  assert.equal(result.advancedMetrics.sharpeRatio, null);
  assert.equal(result.advancedMetrics.sortinoRatio, null);
  assert.equal(result.advancedMetrics.maxDrawdownUsd, 0);
  assert.equal(result.advancedMetrics.maxDrawdownPct, 0);
  assert.equal(result.advancedMetrics.dailyReturnCount, 0);
  assert.equal(result.advancedMetrics.metricsConfidence, 'LOW');
});

test('computeAnalytics with null enrichment fields does not crash', () => {
  const trades = [
    {
      status: 'CLOSED', pnl: 10, side: 'UP',
      // Simulate historical trade with null enrichment fields
      macdValueAtEntry: null, macdHistAtEntry: null, macdSignalAtEntry: null,
      spreadAtEntry: null, liquidityAtEntry: null, volumeNumAtEntry: null,
      btcSpotAtEntry: null, spotImpulsePctAtEntry: null,
      entryGateSnapshot: null,
      timeLeftMinAtEntry: null, modelProbAtEntry: null,
      exitTime: '2026-02-23T10:00:00Z', entryTime: '2026-02-23T09:55:00Z',
    },
    {
      status: 'CLOSED', pnl: -5, side: 'DOWN',
      exitTime: '2026-02-24T15:00:00Z', entryTime: '2026-02-24T14:55:00Z',
    },
  ];
  // Should not throw
  const result = computeAnalytics(trades);
  assert.equal(result.overview.closedTrades, 2);
  assert.ok(result.advancedMetrics);
  assert.ok(Array.isArray(result.byDay));
  assert.ok(Array.isArray(result.bySession));
});

test('computeAnalytics metricsConfidence is HIGH when 30+ daily returns', () => {
  // Create 35 trades spread across 35 different days
  const trades = [];
  for (let i = 0; i < 35; i++) {
    const day = String(i + 1).padStart(2, '0');
    const month = i < 28 ? '01' : '02';
    const dayNum = i < 28 ? String(i + 1).padStart(2, '0') : String(i - 27).padStart(2, '0');
    trades.push({
      status: 'CLOSED',
      pnl: i % 2 === 0 ? 5 : -3,
      exitTime: `2026-${month}-${dayNum}T12:00:00Z`,
      entryTime: `2026-${month}-${dayNum}T11:55:00Z`,
      timestamp: `2026-${month}-${dayNum}T11:55:00Z`,
    });
  }
  const result = computeAnalytics(trades);
  assert.equal(result.advancedMetrics.metricsConfidence, 'HIGH');
});
