import test from 'node:test';
import assert from 'node:assert/strict';

import { TradingState } from '../../src/application/TradingState.js';

// ─── Consecutive loss tracking ─────────────────────────────────────

test('consecutiveLosses: starts at 0', () => {
  const s = new TradingState();
  assert.equal(s.consecutiveLosses, 0);
});

test('consecutiveLosses: increments on losses', () => {
  const s = new TradingState();
  s.recordExit(-5, 'mkt1', 'Max Loss');
  assert.equal(s.consecutiveLosses, 1);
  s.recordExit(-3, 'mkt2', 'Time Stop');
  assert.equal(s.consecutiveLosses, 2);
  s.recordExit(-1, 'mkt3', 'Settlement');
  assert.equal(s.consecutiveLosses, 3);
});

test('consecutiveLosses: resets on win', () => {
  const s = new TradingState();
  s.recordExit(-5, 'mkt1', 'Max Loss');
  s.recordExit(-3, 'mkt2', 'Time Stop');
  assert.equal(s.consecutiveLosses, 2);

  s.recordExit(5, 'mkt3', 'Take Profit');
  assert.equal(s.consecutiveLosses, 0);
});

test('consecutiveLosses: zero PnL counts as non-loss', () => {
  const s = new TradingState();
  s.recordExit(-5, 'mkt1', 'Max Loss');
  assert.equal(s.consecutiveLosses, 1);

  s.recordExit(0, 'mkt2', 'Flat Close');
  assert.equal(s.consecutiveLosses, 0);
});

// ─── Circuit breaker ───────────────────────────────────────────────

test('checkCircuitBreaker: not tripped when under threshold', () => {
  const s = new TradingState();
  s.recordExit(-5, 'mkt1', 'Loss');
  s.recordExit(-3, 'mkt2', 'Loss');

  const cb = s.checkCircuitBreaker(5, 60_000);
  assert.equal(cb.tripped, false);
  assert.equal(cb.remaining, 0);
});

test('checkCircuitBreaker: trips at threshold', () => {
  const s = new TradingState();
  for (let i = 0; i < 5; i++) {
    s.recordExit(-1, `mkt${i}`, 'Loss');
  }
  assert.equal(s.consecutiveLosses, 5);

  const cb = s.checkCircuitBreaker(5, 60_000);
  assert.equal(cb.tripped, true);
  assert.ok(cb.remaining > 0);
  assert.ok(cb.remaining <= 60_000);
});

test('checkCircuitBreaker: stays tripped during cooldown', () => {
  const s = new TradingState();
  for (let i = 0; i < 3; i++) {
    s.recordExit(-1, `mkt${i}`, 'Loss');
  }

  // Trip it
  const cb1 = s.checkCircuitBreaker(3, 60_000);
  assert.equal(cb1.tripped, true);

  // Check again immediately — still tripped
  const cb2 = s.checkCircuitBreaker(3, 60_000);
  assert.equal(cb2.tripped, true);
  assert.ok(cb2.remaining > 0);
});

test('checkCircuitBreaker: resets after cooldown', () => {
  const s = new TradingState();
  for (let i = 0; i < 3; i++) {
    s.recordExit(-1, `mkt${i}`, 'Loss');
  }

  // Trip it
  s.checkCircuitBreaker(3, 100); // 100ms cooldown

  // Manually set tripped time to the past
  s.circuitBreakerTrippedAtMs = Date.now() - 200;

  const cb = s.checkCircuitBreaker(3, 100);
  assert.equal(cb.tripped, false);
  assert.equal(s.consecutiveLosses, 0); // Reset after cooldown
});

test('checkCircuitBreaker: disabled when maxConsecutive is 0', () => {
  const s = new TradingState();
  for (let i = 0; i < 10; i++) {
    s.recordExit(-1, `mkt${i}`, 'Loss');
  }

  // Disabled when threshold is 0
  const cb = s.checkCircuitBreaker(0, 60_000);
  // With 0 threshold, consecutiveLosses (10) >= 0 is always true, but
  // the entryGate only calls checkCircuitBreaker when cbMaxLosses > 0,
  // so this test just verifies the function behavior with 0
  // In practice, the entryGate skips this check when cbMaxLosses === 0
  assert.equal(cb.tripped, true); // Function itself would trip, but entryGate guards this
});

// ─── Integration with recordExit ─────────────────────────────────

test('circuit breaker trips after mixed wins and losses', () => {
  const s = new TradingState();

  s.recordExit(-1, 'mkt1', 'Loss');
  s.recordExit(-1, 'mkt2', 'Loss');
  s.recordExit(5, 'mkt3', 'Win'); // Resets
  assert.equal(s.consecutiveLosses, 0);

  s.recordExit(-1, 'mkt4', 'Loss');
  s.recordExit(-1, 'mkt5', 'Loss');
  s.recordExit(-1, 'mkt6', 'Loss');
  assert.equal(s.consecutiveLosses, 3);

  const cb = s.checkCircuitBreaker(3, 60_000);
  assert.equal(cb.tripped, true);
});

// ─── Rate limiter ──────────────────────────────────────────────────

test('RateLimiter: tryAcquire consumes tokens', async () => {
  const { RateLimiter } = await import('../../src/infrastructure/rateLimit.js');
  const limiter = new RateLimiter({ maxTokens: 3, refillRate: 1 });

  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false); // Exhausted
});

test('RateLimiter: tokens refill over time', async () => {
  const { RateLimiter } = await import('../../src/infrastructure/rateLimit.js');
  const limiter = new RateLimiter({ maxTokens: 2, refillRate: 100 });

  // Exhaust tokens
  limiter.tryAcquire();
  limiter.tryAcquire();
  assert.equal(limiter.tryAcquire(), false);

  // Wait for refill (100 tokens/sec = 1 token per 10ms)
  await new Promise(r => setTimeout(r, 25));
  assert.equal(limiter.tryAcquire(), true);
});

test('RateLimiter: getStats returns stats', async () => {
  const { RateLimiter } = await import('../../src/infrastructure/rateLimit.js');
  const limiter = new RateLimiter({ maxTokens: 5, refillRate: 10, name: 'test' });

  limiter.tryAcquire();
  limiter.tryAcquire();

  const stats = limiter.getStats();
  assert.equal(stats.name, 'test');
  assert.equal(stats.maxTokens, 5);
  assert.equal(stats.refillRate, 10);
  assert.equal(stats.totalRequests, 2);
  assert.equal(stats.totalThrottled, 0);
});

test('RateLimiter: acquire waits for token', async () => {
  const { RateLimiter } = await import('../../src/infrastructure/rateLimit.js');
  const limiter = new RateLimiter({ maxTokens: 1, refillRate: 100 });

  limiter.tryAcquire(); // Exhaust
  const result = await limiter.acquire(100); // Wait up to 100ms
  assert.equal(result, true);
});

test('RateLimiter: acquire times out', async () => {
  const { RateLimiter } = await import('../../src/infrastructure/rateLimit.js');
  const limiter = new RateLimiter({ maxTokens: 1, refillRate: 0.01 }); // Very slow refill

  limiter.tryAcquire(); // Exhaust
  const result = await limiter.acquire(50); // Short timeout
  assert.equal(result, false);
});
