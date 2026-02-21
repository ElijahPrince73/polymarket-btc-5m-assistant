import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeEntryBlockers,
  computeEffectiveThresholds,
  getPacificTimeInfo,
} from '../../src/domain/entryGate.js';

// ─── Helpers ───────────────────────────────────────────────────────

/** Minimal signals that pass all gates (happy path baseline). */
function happySignals(overrides = {}) {
  return {
    rec: { action: 'ENTER', side: 'UP', phase: 'MID', edge: 0.08 },
    modelUp: 0.60,
    modelDown: 0.40,
    timeLeftMin: 3.0,
    polyPricesCents: { UP: 55, DOWN: 45 },
    polyMarketSnapshot: {
      orderbook: {
        up: { bestAsk: 0.56, bestBid: 0.54, spread: 0.02 },
        down: { bestAsk: 0.46, bestBid: 0.44, spread: 0.02 },
      },
    },
    market: {
      slug: 'btc-5m-abc',
      liquidityNum: 100000,
      volumeNum: 50000,
      endDate: new Date(Date.now() + 5 * 60000).toISOString(),
    },
    indicators: {
      rsiNow: 55,
      vwapNow: 100000,
      vwapSlope: 0.1,
      macd: { hist: 0.5 },
      heikenColor: 'green',
      heikenCount: 3,
      rangePct20: 0.005,
      volumeRecent: 100,
      volumeAvg: 80,
    },
    spot: { delta1mPct: 0.001 },
    ...overrides,
  };
}

/** Minimal config that allows entry (no aggressive gates). */
function happyConfig(overrides = {}) {
  return {
    recGating: 'strict',
    minCandlesForEntry: 5,
    noEntryFinalMinutes: 1.5,
    exitBeforeEndMinutes: 0.5,
    minLiquidity: 1000,
    maxSpread: 0.10,
    minMarketVolumeNum: 0,
    minProbEarly: 0.52,
    edgeEarly: 0.02,
    minProbMid: 0.53,
    edgeMid: 0.03,
    minProbLate: 0.55,
    edgeLate: 0.05,
    minPolyPrice: 0.01,
    maxPolyPrice: 0.99,
    weekdaysOnly: false,
    weekendTighteningEnabled: false,
    lossCooldownSeconds: 0,
    winCooldownSeconds: 0,
    skipMarketAfterMaxLoss: false,
    ...overrides,
  };
}

function happyState(overrides = {}) {
  return {
    hasOpenPosition: false,
    lastLossAtMs: null,
    lastWinAtMs: null,
    skipMarketUntilNextSlug: null,
    todayRealizedPnl: 0,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

test('happy path: no blockers when all conditions met', () => {
  const result = computeEntryBlockers(happySignals(), happyConfig(), happyState(), 20);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.effectiveSide, 'UP');
  assert.equal(result.sideInferred, false);
});

test('strict rec gating blocks when rec != ENTER', () => {
  const signals = happySignals({
    rec: { action: 'HOLD', side: 'UP', phase: 'MID', edge: 0.08 },
  });
  const result = computeEntryBlockers(signals, happyConfig(), happyState(), 20);
  assert.ok(result.blockers.length > 0);
  assert.ok(result.blockers[0].includes('Rec=HOLD'));
});

test('loose rec gating allows entry despite rec != ENTER (adds note but continues)', () => {
  const signals = happySignals({
    rec: { action: 'HOLD', side: null, phase: 'MID', edge: 0.08 },
    modelUp: 0.60,
    modelDown: 0.40,
  });
  const config = happyConfig({ recGating: 'loose' });
  const result = computeEntryBlockers(signals, config, happyState(), 20);
  // Loose mode adds a note but continues checking — side gets inferred
  assert.ok(result.blockers.some((b) => b.includes('Rec=HOLD')));
  assert.equal(result.sideInferred, true);
  assert.equal(result.effectiveSide, 'UP');
});

test('missing side blocks entry', () => {
  const signals = happySignals({
    rec: { action: 'ENTER', side: null, phase: 'MID', edge: 0.08 },
    modelUp: null,
    modelDown: null,
  });
  const config = happyConfig({ recGating: 'strict' });
  const result = computeEntryBlockers(signals, config, happyState(), 20);
  assert.ok(result.blockers.some((b) => b.includes('Missing side')));
});

test('settlement time gate blocks near settlement', () => {
  const signals = happySignals({
    market: {
      slug: 'btc-5m-abc',
      liquidityNum: 100000,
      volumeNum: 50000,
      endDate: new Date(Date.now() + 0.5 * 60000).toISOString(), // 30s to settlement
    },
  });
  const result = computeEntryBlockers(signals, happyConfig(), happyState(), 20);
  assert.ok(result.blockers.some((b) => b.includes('Too late')));
});

test('candle warmup blocks when insufficient candles', () => {
  const result = computeEntryBlockers(
    happySignals(),
    happyConfig({ minCandlesForEntry: 15 }),
    happyState(),
    10, // only 10 candles
  );
  assert.ok(result.blockers.some((b) => b.includes('Warmup')));
});

test('indicator readiness blocks when indicators missing', () => {
  const signals = happySignals({
    indicators: { rsiNow: 55 }, // missing vwap, macd, heiken
  });
  const result = computeEntryBlockers(signals, happyConfig(), happyState(), 20);
  assert.ok(result.blockers.some((b) => b.includes('Indicators not ready')));
});

test('loss cooldown blocks entry', () => {
  const state = happyState({ lastLossAtMs: Date.now() - 10000 }); // 10s ago
  const config = happyConfig({ lossCooldownSeconds: 60 }); // 60s cooldown
  const result = computeEntryBlockers(happySignals(), config, state, 20);
  assert.ok(result.blockers.some((b) => b.includes('Loss cooldown')));
});

test('loss cooldown does not block after expiry', () => {
  const state = happyState({ lastLossAtMs: Date.now() - 120000 }); // 2min ago
  const config = happyConfig({ lossCooldownSeconds: 60 }); // 60s cooldown
  const result = computeEntryBlockers(happySignals(), config, state, 20);
  assert.ok(!result.blockers.some((b) => b.includes('Loss cooldown')));
});

test('has open position blocks entry', () => {
  const state = happyState({ hasOpenPosition: true });
  const result = computeEntryBlockers(happySignals(), happyConfig(), state, 20);
  assert.ok(result.blockers.some((b) => b.includes('Trade already open')));
});

test('low liquidity blocks entry', () => {
  const signals = happySignals({
    market: {
      slug: 'btc-5m-abc',
      liquidityNum: 500,
      volumeNum: 50000,
      endDate: new Date(Date.now() + 5 * 60000).toISOString(),
    },
  });
  const config = happyConfig({ minLiquidity: 1000 });
  const result = computeEntryBlockers(signals, config, happyState(), 20);
  assert.ok(result.blockers.some((b) => b.includes('Low liquidity')));
});

test('poly price out of bounds blocks entry', () => {
  const signals = happySignals({
    polyPricesCents: { UP: 99.5, DOWN: 0.5 },
  });
  const config = happyConfig({ minPolyPrice: 0.01, maxPolyPrice: 0.98 });
  const result = computeEntryBlockers(signals, config, happyState(), 20);
  assert.ok(result.blockers.some((b) => b.includes('Poly price out of bounds')));
});

test('daily loss kill-switch blocks entry', () => {
  const state = happyState({ todayRealizedPnl: -55 });
  const config = happyConfig({ maxDailyLossUsd: 50 });
  const result = computeEntryBlockers(happySignals(), config, state, 20);
  assert.ok(result.blockers.some((b) => b.includes('Daily loss kill-switch')));
});

test('skip market after max loss blocks same slug', () => {
  const state = happyState({ skipMarketUntilNextSlug: 'btc-5m-abc' });
  const config = happyConfig({ skipMarketAfterMaxLoss: true });
  const result = computeEntryBlockers(happySignals(), config, state, 20);
  assert.ok(result.blockers.some((b) => b.includes('Skip market after Max Loss')));
});

// ─── computeEffectiveThresholds ────────────────────────────────────

test('computeEffectiveThresholds returns EARLY thresholds', () => {
  const { minProb, edgeThreshold } = computeEffectiveThresholds(
    { minProbEarly: 0.52, edgeEarly: 0.02 },
    false, 'EARLY', false, true,
  );
  assert.equal(minProb, 0.52);
  assert.equal(edgeThreshold, 0.02);
});

test('computeEffectiveThresholds applies weekend boost', () => {
  const { minProb, edgeThreshold } = computeEffectiveThresholds(
    {
      minProbMid: 0.53, edgeMid: 0.03,
      weekendTighteningEnabled: true,
      weekendProbBoost: 0.02, weekendEdgeBoost: 0.01,
    },
    true, 'MID', false, true,
  );
  assert.ok(Math.abs(minProb - 0.55) < 0.001);
  assert.ok(Math.abs(edgeThreshold - 0.04) < 0.001);
});

test('computeEffectiveThresholds applies MID boost', () => {
  const { minProb, edgeThreshold } = computeEffectiveThresholds(
    {
      minProbMid: 0.53, edgeMid: 0.03,
      midProbBoost: 0.01, midEdgeBoost: 0.005,
    },
    false, 'MID', false, true,
  );
  assert.ok(Math.abs(minProb - 0.54) < 0.001);
  assert.ok(Math.abs(edgeThreshold - 0.035) < 0.001);
});

test('computeEffectiveThresholds applies inferred boost in loose mode', () => {
  const { minProb, edgeThreshold } = computeEffectiveThresholds(
    {
      minProbMid: 0.53, edgeMid: 0.03,
      inferredProbBoost: 0.03, inferredEdgeBoost: 0.02,
    },
    false, 'MID', true, false, // sideInferred=true, strictRec=false
  );
  assert.ok(Math.abs(minProb - 0.56) < 0.001);
  assert.ok(Math.abs(edgeThreshold - 0.05) < 0.001);
});

// ─── getPacificTimeInfo ────────────────────────────────────────────

test('getPacificTimeInfo returns valid shape', () => {
  const info = getPacificTimeInfo();
  assert.equal(typeof info.isWeekend, 'boolean');
  assert.equal(typeof info.wd, 'string');
  assert.equal(typeof info.hour, 'number');
  assert.ok(info.hour >= 0 && info.hour <= 23);
});
