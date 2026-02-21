import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExits, capPnl, computeMaxLossUsd } from '../../src/domain/exitEvaluator.js';

// ─── Helpers ───────────────────────────────────────────────────────

const NOW = Date.now();

function pos(overrides = {}) {
  return {
    id: 'test-001',
    side: 'UP',
    marketSlug: 'btc-5m-abc',
    entryPrice: 0.55,
    shares: 200,
    contractSize: 110,
    mark: 0.57,
    unrealizedPnl: 4, // (0.57 * 200) - 110 = 4
    maxUnrealizedPnl: 6,
    minUnrealizedPnl: -2,
    entryTime: new Date(NOW - 60000).toISOString(), // 60s ago
    lastTradeTime: null,
    ...overrides,
  };
}

function sig(overrides = {}) {
  return {
    modelUp: 0.58,
    modelDown: 0.42,
    timeLeftMin: 3.0,
    market: {
      slug: 'btc-5m-abc',
      liquidityNum: 100000,
      endDate: new Date(NOW + 3 * 60000).toISOString(),
    },
    polyMarketSnapshot: {},
    ...overrides,
  };
}

function cfg(overrides = {}) {
  return {
    exitBeforeEndMinutes: 0.5,
    maxLossUsdPerTrade: 15,
    maxLossGraceEnabled: false,
    maxLossGraceSeconds: 0,
    maxLossRecoverUsd: null,
    maxLossGraceRequireModelSupport: false,
    takeProfitPrice: null,
    trailingTakeProfitEnabled: false,
    trailingStartUsd: 0,
    trailingDrawdownUsd: 0,
    takeProfitImmediate: false,
    takeProfitPnlUsd: 0,
    loserMaxHoldSeconds: 0,
    stopLossEnabled: false,
    stopLossPct: 0.25,
    exitFlipMinProb: 0.55,
    exitFlipMargin: 0.03,
    exitFlipMinHoldSeconds: 0,
    minLiquidity: 1000,
    ...overrides,
  };
}

function grace(overrides = {}) {
  return {
    breachAtMs: null,
    used: false,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

test('no exit when position is healthy', () => {
  const { decision } = evaluateExits(pos(), sig(), cfg(), grace(), NOW);
  assert.equal(decision, null);
});

test('null position returns null decision', () => {
  const { decision } = evaluateExits(null, sig(), cfg(), grace(), NOW);
  assert.equal(decision, null);
});

// ── Market Rollover ────────────────────────────────────────────────

test('market rollover triggers exit', () => {
  const signals = sig({
    market: {
      slug: 'btc-5m-DIFFERENT',
      liquidityNum: 100000,
      endDate: new Date(NOW + 3 * 60000).toISOString(),
    },
  });
  const { decision } = evaluateExits(pos(), signals, cfg(), grace(), NOW);
  assert.ok(decision);
  assert.equal(decision.reason, 'Market Rollover');
});

// ── Pre-settlement Exit ────────────────────────────────────────────

test('pre-settlement exit triggers when near settlement', () => {
  const signals = sig({
    market: {
      slug: 'btc-5m-abc',
      liquidityNum: 100000,
      endDate: new Date(NOW + 20000).toISOString(), // 20s to settlement
    },
  });
  const { decision } = evaluateExits(pos(), signals, cfg(), grace(), NOW);
  assert.ok(decision);
  assert.equal(decision.reason, 'Pre-settlement Exit');
});

test('pre-settlement does not trigger when time is ample', () => {
  const { decision } = evaluateExits(pos(), sig(), cfg(), grace(), NOW);
  assert.equal(decision, null);
});

// ── Max Loss ───────────────────────────────────────────────────────

test('max loss exits immediately without grace', () => {
  const p = pos({ unrealizedPnl: -20, mark: 0.45 });
  const config = cfg({ maxLossUsdPerTrade: 15, maxLossGraceEnabled: false });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.ok(decision);
  assert.ok(decision.reason.includes('Max Loss'));
});

test('max loss with grace: starts grace on first breach', () => {
  const p = pos({ unrealizedPnl: -20, mark: 0.45 });
  const config = cfg({
    maxLossUsdPerTrade: 15,
    maxLossGraceEnabled: true,
    maxLossGraceSeconds: 30,
  });
  const result = evaluateExits(p, sig(), config, grace(), NOW);
  assert.equal(result.decision, null); // Don't exit yet
  assert.equal(result.graceAction, 'START_GRACE');
});

test('max loss with grace: exits after grace expires', () => {
  const p = pos({ unrealizedPnl: -20, mark: 0.45 });
  const config = cfg({
    maxLossUsdPerTrade: 15,
    maxLossGraceEnabled: true,
    maxLossGraceSeconds: 30,
  });
  const g = grace({ breachAtMs: NOW - 40000, used: true }); // 40s ago, > 30s grace
  const { decision } = evaluateExits(p, sig(), config, g, NOW);
  assert.ok(decision);
  assert.ok(decision.reason.includes('Max Loss'));
});

test('max loss with grace: holds during grace window', () => {
  const p = pos({ unrealizedPnl: -20, mark: 0.45 });
  const config = cfg({
    maxLossUsdPerTrade: 15,
    maxLossGraceEnabled: true,
    maxLossGraceSeconds: 30,
  });
  const g = grace({ breachAtMs: NOW - 10000, used: true }); // 10s ago, < 30s grace
  const { decision } = evaluateExits(p, sig(), config, g, NOW);
  assert.equal(decision, null); // Still in grace, hold
});

test('max loss with grace: clears grace on recovery', () => {
  const p = pos({ unrealizedPnl: -5, mark: 0.52 }); // recovered above -15+1 = -14
  const config = cfg({
    maxLossUsdPerTrade: 15,
    maxLossGraceEnabled: true,
    maxLossGraceSeconds: 30,
  });
  const g = grace({ breachAtMs: NOW - 10000, used: true });
  const result = evaluateExits(p, sig(), config, g, NOW);
  assert.equal(result.decision, null);
  assert.equal(result.graceAction, 'CLEAR_GRACE');
});

// ── High-price Take Profit ─────────────────────────────────────────

test('high-price take profit triggers when mark >= threshold', () => {
  const p = pos({ mark: 0.95 });
  const config = cfg({ takeProfitPrice: 0.90 });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.ok(decision);
  assert.ok(decision.reason.includes('Take Profit'));
  assert.ok(decision.reason.includes('90¢'));
});

// ── Trailing Take Profit ───────────────────────────────────────────

test('trailing TP triggers on pullback from MFE', () => {
  const p = pos({
    unrealizedPnl: 8,   // pulled back from max of 25
    maxUnrealizedPnl: 25,
  });
  const config = cfg({
    trailingTakeProfitEnabled: true,
    trailingStartUsd: 20,
    trailingDrawdownUsd: 10,
  });
  // max=25 >= start=20, trail = 25-10 = 15; pnl 8 <= 15 → exit
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.ok(decision);
  assert.ok(decision.reason.includes('Trailing TP'));
});

test('trailing TP does not trigger when MFE not yet reached start', () => {
  const p = pos({
    unrealizedPnl: 8,
    maxUnrealizedPnl: 10, // < start of 20
  });
  const config = cfg({
    trailingTakeProfitEnabled: true,
    trailingStartUsd: 20,
    trailingDrawdownUsd: 10,
  });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.equal(decision, null);
});

// ── Immediate Take Profit ──────────────────────────────────────────

test('immediate TP triggers when pnl >= threshold', () => {
  const p = pos({ unrealizedPnl: 5 });
  const config = cfg({
    takeProfitImmediate: true,
    takeProfitPnlUsd: 3,
    trailingTakeProfitEnabled: false,
  });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.ok(decision);
  assert.equal(decision.reason, 'Take Profit');
});

test('immediate TP is suppressed when trailing TP is enabled', () => {
  const p = pos({ unrealizedPnl: 5, maxUnrealizedPnl: 5 });
  const config = cfg({
    takeProfitImmediate: true,
    takeProfitPnlUsd: 3,
    trailingTakeProfitEnabled: true,
    trailingStartUsd: 50, // won't trigger trailing
    trailingDrawdownUsd: 10,
  });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.equal(decision, null);
});

// ── Time Stop ──────────────────────────────────────────────────────

test('time stop triggers for loser past max hold', () => {
  const p = pos({
    unrealizedPnl: -3,
    entryTime: new Date(NOW - 200000).toISOString(), // 200s ago
  });
  const config = cfg({ loserMaxHoldSeconds: 120 });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.ok(decision);
  assert.equal(decision.reason, 'Time Stop');
});

test('time stop does not trigger for winner', () => {
  const p = pos({
    unrealizedPnl: 3,
    entryTime: new Date(NOW - 200000).toISOString(),
  });
  const config = cfg({ loserMaxHoldSeconds: 120 });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.equal(decision, null);
});

test('time stop does not trigger if not enough time elapsed', () => {
  const p = pos({
    unrealizedPnl: -3,
    entryTime: new Date(NOW - 50000).toISOString(), // only 50s
  });
  const config = cfg({ loserMaxHoldSeconds: 120 });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.equal(decision, null);
});

// ── Conditional Stop Loss ──────────────────────────────────────────

test('conditional stop loss triggers when hit AND opposing likely', () => {
  const p = pos({
    unrealizedPnl: -30, // -30 vs contractSize 110 * 0.25 = -27.5
    contractSize: 110,
  });
  const signals = sig({
    modelUp: 0.40,   // opposing UP side is now stronger if pos side is DOWN
    modelDown: 0.60,
  });
  // Position is UP, modelDown is dominant → opposingMoreLikely = true
  // But we need the stop loss to be hit: pnl -30 <= -(110*0.25) = -27.5 ✓
  // And opposing: downP=0.60 >= 0.55 && downP >= upP + 0.03 → 0.60 >= 0.43 ✓
  const config = cfg({ stopLossEnabled: true, stopLossPct: 0.25 });
  const { decision } = evaluateExits(p, signals, config, grace(), NOW);
  assert.ok(decision);
  assert.equal(decision.reason, 'Stop Loss');
});

test('conditional stop loss does not trigger without opposing flip', () => {
  const p = pos({
    unrealizedPnl: -30,
    contractSize: 110,
  });
  // UP position, model still supports UP
  const signals = sig({ modelUp: 0.58, modelDown: 0.42 });
  const config = cfg({ stopLossEnabled: true, stopLossPct: 0.25 });
  const { decision } = evaluateExits(p, signals, config, grace(), NOW);
  // stopLossHit but opposing NOT likely → no exit
  assert.equal(decision, null);
});

// ── opposingMoreLikely ─────────────────────────────────────────────

test('opposingMoreLikely is true when opposing model dominates', () => {
  const p = pos({ side: 'UP' });
  const signals = sig({ modelUp: 0.40, modelDown: 0.60 });
  const result = evaluateExits(p, signals, cfg(), grace(), NOW);
  assert.equal(result.opposingMoreLikely, true);
});

test('opposingMoreLikely is false when same side dominates', () => {
  const p = pos({ side: 'UP' });
  const signals = sig({ modelUp: 0.60, modelDown: 0.40 });
  const result = evaluateExits(p, signals, cfg(), grace(), NOW);
  assert.equal(result.opposingMoreLikely, false);
});

// ── capPnl ─────────────────────────────────────────────────────────

test('capPnl does not cap within limit', () => {
  const { pnl, exitPrice } = capPnl(-10, 100, 200, 0.45, { maxLossUsdPerTrade: 15 });
  assert.equal(pnl, -10);
  assert.equal(exitPrice, 0.45);
});

test('capPnl caps excessive loss', () => {
  const { pnl, exitPrice } = capPnl(-25, 100, 200, 0.35, { maxLossUsdPerTrade: 15 });
  assert.equal(pnl, -15);
  // cappedValue = 100 + (-15) = 85; impliedExit = 85/200 = 0.425
  assert.ok(Math.abs(exitPrice - 0.425) < 0.001);
});

test('capPnl returns raw when config has no max', () => {
  const { pnl, exitPrice } = capPnl(-30, 100, 200, 0.35, {});
  assert.equal(pnl, -30);
  assert.equal(exitPrice, 0.35);
});

// ── computeMaxLossUsd ─────────────────────────────────────────────

test('computeMaxLossUsd: dynamic = contractSize * pct', () => {
  const result = computeMaxLossUsd(80, {
    dynamicStopLossEnabled: true,
    dynamicStopLossPct: 0.20,
    minMaxLossUsd: 8,
    maxMaxLossUsd: 40,
  });
  assert.equal(result, 16); // 80 * 0.20 = 16
});

test('computeMaxLossUsd: clamps to floor', () => {
  const result = computeMaxLossUsd(25, {
    dynamicStopLossEnabled: true,
    dynamicStopLossPct: 0.20,
    minMaxLossUsd: 8,
    maxMaxLossUsd: 40,
  });
  assert.equal(result, 8); // 25 * 0.20 = 5, clamped to floor 8
});

test('computeMaxLossUsd: clamps to ceiling', () => {
  const result = computeMaxLossUsd(250, {
    dynamicStopLossEnabled: true,
    dynamicStopLossPct: 0.20,
    minMaxLossUsd: 8,
    maxMaxLossUsd: 40,
  });
  assert.equal(result, 40); // 250 * 0.20 = 50, clamped to ceiling 40
});

test('computeMaxLossUsd: disabled falls back to fixed', () => {
  const result = computeMaxLossUsd(80, {
    dynamicStopLossEnabled: false,
    maxLossUsdPerTrade: 15,
  });
  assert.equal(result, 15);
});

test('computeMaxLossUsd: absent key defaults to disabled (backward compat)', () => {
  const result = computeMaxLossUsd(80, {
    maxLossUsdPerTrade: 15,
  });
  assert.equal(result, 15);
});

test('computeMaxLossUsd: null contractSize falls back to fixed', () => {
  const result = computeMaxLossUsd(null, {
    dynamicStopLossEnabled: true,
    maxLossUsdPerTrade: 15,
  });
  assert.equal(result, 15);
});

test('computeMaxLossUsd: zero contractSize falls back to fixed', () => {
  const result = computeMaxLossUsd(0, {
    dynamicStopLossEnabled: true,
    maxLossUsdPerTrade: 15,
  });
  assert.equal(result, 15);
});

test('computeMaxLossUsd: returns null when no config at all', () => {
  const result = computeMaxLossUsd(80, {});
  assert.equal(result, null);
});

// ── Dynamic stop loss integration with evaluateExits ──────────────

test('dynamic max loss exits at correct threshold', () => {
  // contractSize=110, pct=0.20 => maxLoss=22; pnl=-25 => breached
  const p = pos({ unrealizedPnl: -25, mark: 0.42, contractSize: 110 });
  const config = cfg({
    dynamicStopLossEnabled: true,
    dynamicStopLossPct: 0.20,
    minMaxLossUsd: 8,
    maxMaxLossUsd: 40,
    maxLossGraceEnabled: false,
  });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.ok(decision);
  assert.ok(decision.reason.includes('Max Loss'));
  assert.ok(decision.reason.includes('$22.00'));
});

test('dynamic max loss holds when not breached', () => {
  // contractSize=110, pct=0.20 => maxLoss=22; pnl=-15 => NOT breached
  const p = pos({ unrealizedPnl: -15, mark: 0.47, contractSize: 110 });
  const config = cfg({
    dynamicStopLossEnabled: true,
    dynamicStopLossPct: 0.20,
    minMaxLossUsd: 8,
    maxMaxLossUsd: 40,
  });
  const { decision } = evaluateExits(p, sig(), config, grace(), NOW);
  assert.equal(decision, null);
});

// ── capPnl with dynamic config ────────────────────────────────────

test('capPnl uses dynamic max loss', () => {
  // contractSize=80, pct=0.20 => maxLoss=16
  const { pnl } = capPnl(-25, 80, 200, 0.35, {
    dynamicStopLossEnabled: true,
    dynamicStopLossPct: 0.20,
    minMaxLossUsd: 8,
    maxMaxLossUsd: 40,
  });
  assert.equal(pnl, -16);
});

test('capPnl with dynamic: does not cap within limit', () => {
  // contractSize=80, pct=0.20 => maxLoss=16; rawPnl=-10 => within limit
  const { pnl, exitPrice } = capPnl(-10, 80, 200, 0.35, {
    dynamicStopLossEnabled: true,
    dynamicStopLossPct: 0.20,
    minMaxLossUsd: 8,
    maxMaxLossUsd: 40,
  });
  assert.equal(pnl, -10);
  assert.equal(exitPrice, 0.35);
});
