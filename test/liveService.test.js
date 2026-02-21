import test from 'node:test';
import assert from 'node:assert/strict';

import { withTimeout, dayKeyFromEpochSec } from '../src/services/liveService.js';

test('withTimeout resolves when promise completes within timeout', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
  assert.equal(result, 'ok');
});

test('withTimeout rejects when promise exceeds timeout', async () => {
  const slow = new Promise(resolve => setTimeout(() => resolve('late'), 5000));
  await assert.rejects(
    () => withTimeout(slow, 50, 'slowOp'),
    { message: /slowOp timed out after 50ms/ }
  );
});

test('dayKeyFromEpochSec returns correct date key', () => {
  // 2025-01-15 00:00:00 UTC = epoch 1736899200
  const key = dayKeyFromEpochSec(1736899200, 'UTC');
  assert.equal(key, '2025-01-15');
});

test('dayKeyFromEpochSec handles timezone offset', () => {
  // 2025-01-15 02:00:00 UTC → still Jan 14 in LA (UTC-8)
  const key = dayKeyFromEpochSec(1736906400, 'America/Los_Angeles');
  assert.equal(key, '2025-01-14');
});
