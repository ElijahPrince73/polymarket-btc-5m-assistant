import test from 'node:test';
import assert from 'node:assert/strict';

import { FeeService } from '../../src/infrastructure/fees/FeeService.js';

// ─── computeFeeImpact ──────────────────────────────────────────────

test('computeFeeImpact: 200 bps on $100 at price 0.50', () => {
  const svc = new FeeService();
  const result = svc.computeFeeImpact(100, 0.50, 200);

  // 200 bps = 2%, so fee = $100 * 0.02 = $2.00
  assert.equal(result.feeUsd, 2);

  // At price 0.50, $2 buys 4 shares worth of fee
  assert.equal(result.feeShareEquivalent, 4);

  // 200 shares total ($100 / $0.50), fee $2 / 200 shares = $0.01 per share
  assert.equal(result.effectivePriceShift, 0.01);
});

test('computeFeeImpact: 100 bps on $50 at price 0.04', () => {
  const svc = new FeeService();
  const result = svc.computeFeeImpact(50, 0.04, 100);

  // 100 bps = 1%, so fee = $50 * 0.01 = $0.50
  assert.equal(result.feeUsd, 0.5);

  // At price 0.04, $0.50 / 0.04 = 12.5 shares
  assert.equal(result.feeShareEquivalent, 12.5);

  // 1250 shares total ($50 / $0.04), $0.50 / 1250 = $0.0004 per share
  assert.equal(result.effectivePriceShift, 0.0004);
});

test('computeFeeImpact: 0 bps returns zero fees', () => {
  const svc = new FeeService();
  const result = svc.computeFeeImpact(100, 0.50, 0);

  assert.equal(result.feeUsd, 0);
  assert.equal(result.feeShareEquivalent, 0);
  assert.equal(result.effectivePriceShift, 0);
});

test('computeFeeImpact: handles zero price gracefully', () => {
  const svc = new FeeService();
  const result = svc.computeFeeImpact(100, 0, 200);

  assert.equal(result.feeUsd, 0);
  assert.equal(result.feeShareEquivalent, 0);
  assert.equal(result.effectivePriceShift, 0);
});

test('computeFeeImpact: handles NaN inputs gracefully', () => {
  const svc = new FeeService();
  const result = svc.computeFeeImpact(NaN, 0.50, 200);

  assert.equal(result.feeUsd, 0);
  assert.equal(result.feeShareEquivalent, 0);
  assert.equal(result.effectivePriceShift, 0);
});

test('computeFeeImpact: handles negative price gracefully', () => {
  const svc = new FeeService();
  const result = svc.computeFeeImpact(100, -0.5, 200);

  assert.equal(result.feeUsd, 0);
  assert.equal(result.feeShareEquivalent, 0);
  assert.equal(result.effectivePriceShift, 0);
});

// ─── Cache Behavior ────────────────────────────────────────────────

test('getSnapshot: returns empty when no fees cached', () => {
  const svc = new FeeService();
  const snapshot = svc.getSnapshot();

  assert.deepEqual(snapshot.tokens, {});
  assert.equal(snapshot.cacheSize, 0);
  assert.equal(snapshot.cacheTtlMs, 30_000);
});

test('getSnapshot: respects custom cacheTtlMs', () => {
  const svc = new FeeService({ cacheTtlMs: 60_000 });
  const snapshot = svc.getSnapshot();

  assert.equal(snapshot.cacheTtlMs, 60_000);
});

test('clearCache: empties the cache', () => {
  const svc = new FeeService();

  // Manually populate cache to test clearing
  svc._cache.set('token_123', { rateBps: 200, fetchedAt: Date.now() });
  assert.equal(svc._cache.size, 1);

  svc.clearCache();
  assert.equal(svc._cache.size, 0);

  const snapshot = svc.getSnapshot();
  assert.deepEqual(snapshot.tokens, {});
  assert.equal(snapshot.cacheSize, 0);
});

test('getSnapshot: includes cached entries with formatted data', () => {
  const svc = new FeeService();
  const now = Date.now();

  svc._cache.set('token_abc', { rateBps: 150, fetchedAt: now });
  svc._cache.set('token_def', { rateBps: 200, fetchedAt: now });

  const snapshot = svc.getSnapshot();
  assert.equal(snapshot.cacheSize, 2);
  assert.equal(snapshot.tokens['token_abc'].rateBps, 150);
  assert.equal(snapshot.tokens['token_abc'].ratePct, '1.50%');
  assert.equal(snapshot.tokens['token_def'].rateBps, 200);
  assert.equal(snapshot.tokens['token_def'].ratePct, '2.00%');
});

// ─── getFeeRateBps (without CLOB client) ────────────────────────────

test('getFeeRateBps: returns null for empty tokenId', async () => {
  const svc = new FeeService();
  const result = await svc.getFeeRateBps('');
  assert.equal(result, null);
});

test('getFeeRateBps: returns null for null tokenId', async () => {
  const svc = new FeeService();
  const result = await svc.getFeeRateBps(null);
  assert.equal(result, null);
});

test('getFeeRateBps: returns cached value when fresh', async () => {
  const svc = new FeeService({ cacheTtlMs: 60_000 });
  svc._cache.set('token_cached', { rateBps: 175, fetchedAt: Date.now() });

  const result = await svc.getFeeRateBps('token_cached');
  assert.equal(result, 175);
});

test('getFeeRateBps: returns stale cache when expired and client unavailable', async () => {
  const svc = new FeeService({ cacheTtlMs: 1 }); // 1ms TTL - immediately stale
  svc._cache.set('token_stale', { rateBps: 250, fetchedAt: Date.now() - 100 });

  // No CLOB client configured → fetch fails → falls back to stale cache
  const result = await svc.getFeeRateBps('token_stale');
  assert.equal(result, 250);
});

// ─── Constructor defaults ──────────────────────────────────────────

test('constructor: default values', () => {
  const svc = new FeeService();
  assert.equal(svc.cacheTtlMs, 30_000);
  assert.equal(svc.alertThresholdBps, 300);
});

test('constructor: custom values', () => {
  const svc = new FeeService({ cacheTtlMs: 10_000, alertThresholdBps: 500 });
  assert.equal(svc.cacheTtlMs, 10_000);
  assert.equal(svc.alertThresholdBps, 500);
});
