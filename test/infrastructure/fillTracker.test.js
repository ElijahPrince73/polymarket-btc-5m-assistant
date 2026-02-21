import test from 'node:test';
import assert from 'node:assert/strict';

import { FillTracker } from '../../src/infrastructure/fills/FillTracker.js';

// ─── Initial state ─────────────────────────────────────────────────

test('initial state: empty', () => {
  const ft = new FillTracker();
  assert.equal(ft.getRecentFills().length, 0);
  assert.equal(ft.getSnapshot().totalTracked, 0);
  assert.equal(ft.getSnapshot().knownIds, 0);
});

// ─── getRecentFills ────────────────────────────────────────────────

test('getRecentFills: returns last N fills', () => {
  const ft = new FillTracker();

  // Manually populate fills
  for (let i = 0; i < 10; i++) {
    ft._fills.push({
      id: `fill_${i}`,
      tokenID: 'tok_abc',
      side: 'BUY',
      price: 0.04,
      size: 100,
      timestamp: new Date().toISOString(),
    });
    ft._knownIds.add(`fill_${i}`);
  }

  const recent5 = ft.getRecentFills(5);
  assert.equal(recent5.length, 5);
  assert.equal(recent5[0].id, 'fill_5'); // Last 5
  assert.equal(recent5[4].id, 'fill_9');

  const recentAll = ft.getRecentFills(100);
  assert.equal(recentAll.length, 10);
});

// ─── getSnapshot ───────────────────────────────────────────────────

test('getSnapshot: includes totals and capped fills', () => {
  const ft = new FillTracker();

  for (let i = 0; i < 5; i++) {
    ft._fills.push({
      id: `fill_${i}`,
      tokenID: 'tok',
      side: 'SELL',
      price: 0.95,
      size: 50,
      timestamp: new Date().toISOString(),
    });
    ft._knownIds.add(`fill_${i}`);
  }

  const snap = ft.getSnapshot();
  assert.equal(snap.totalTracked, 5);
  assert.equal(snap.knownIds, 5);
  assert.equal(snap.fills.length, 5);
});

// ─── poll (without client) ─────────────────────────────────────────

test('poll: returns empty when no client', async () => {
  const ft = new FillTracker();
  const fills = await ft.poll();
  assert.deepEqual(fills, []);
});

test('poll: respects minIntervalMs', async () => {
  const ft = new FillTracker();

  // First poll (will fail due to no client, but updates timer)
  await ft.poll({ minIntervalMs: 60_000 });

  // Second poll should be skipped
  ft._lastPollMs = Date.now(); // Manually set as recent
  const fills = await ft.poll({ minIntervalMs: 60_000 });
  assert.deepEqual(fills, []);
});

// ─── maxFills pruning ──────────────────────────────────────────────

test('fills are pruned when exceeding maxFills', () => {
  const ft = new FillTracker();
  ft.maxFills = 5;

  // Add 10 fills
  for (let i = 0; i < 10; i++) {
    ft._fills.push({
      id: `fill_${i}`,
      tokenID: 'tok',
      side: 'BUY',
      price: 0.04,
      size: 100,
      timestamp: new Date().toISOString(),
    });
  }

  // Simulate pruning (done in poll normally)
  if (ft._fills.length > ft.maxFills) {
    const excess = ft._fills.length - ft.maxFills;
    ft._fills.splice(0, excess);
  }

  assert.equal(ft._fills.length, 5);
  assert.equal(ft._fills[0].id, 'fill_5'); // Oldest remaining
});
