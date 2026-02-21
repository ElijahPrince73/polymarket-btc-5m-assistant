import test from 'node:test';
import assert from 'node:assert/strict';

import { pickTokenId, getAllTokenIds } from '../../src/infrastructure/market/tokenMapping.js';

// ─── pickTokenId ───────────────────────────────────────────────────

test('pickTokenId: resolves UP token', () => {
  const market = {
    outcomes: ['Up', 'Down'],
    clobTokenIds: ['tok_up_123', 'tok_down_456'],
  };
  assert.equal(pickTokenId(market, 'UP'), 'tok_up_123');
  assert.equal(pickTokenId(market, 'Up'), 'tok_up_123');
  assert.equal(pickTokenId(market, 'up'), 'tok_up_123');
});

test('pickTokenId: resolves DOWN token', () => {
  const market = {
    outcomes: ['Up', 'Down'],
    clobTokenIds: ['tok_up_123', 'tok_down_456'],
  };
  assert.equal(pickTokenId(market, 'DOWN'), 'tok_down_456');
  assert.equal(pickTokenId(market, 'Down'), 'tok_down_456');
});

test('pickTokenId: handles JSON-encoded arrays', () => {
  const market = {
    outcomes: '["Up","Down"]',
    clobTokenIds: '["tok_a","tok_b"]',
  };
  assert.equal(pickTokenId(market, 'UP'), 'tok_a');
  assert.equal(pickTokenId(market, 'DOWN'), 'tok_b');
});

test('pickTokenId: returns null for missing side', () => {
  const market = {
    outcomes: ['Up', 'Down'],
    clobTokenIds: ['tok_a', 'tok_b'],
  };
  assert.equal(pickTokenId(market, 'SIDEWAYS'), null);
});

test('pickTokenId: returns null for null market', () => {
  assert.equal(pickTokenId(null, 'UP'), null);
  assert.equal(pickTokenId(undefined, 'UP'), null);
});

test('pickTokenId: returns null for empty arrays', () => {
  const market = { outcomes: [], clobTokenIds: [] };
  assert.equal(pickTokenId(market, 'UP'), null);
});

test('pickTokenId: handles falsy clobTokenIds entry', () => {
  const market = {
    outcomes: ['Up', 'Down'],
    clobTokenIds: [null, 'tok_b'],
  };
  assert.equal(pickTokenId(market, 'UP'), null);
  assert.equal(pickTokenId(market, 'DOWN'), 'tok_b');
});

// ─── getAllTokenIds ────────────────────────────────────────────────

test('getAllTokenIds: returns all token IDs', () => {
  const market = {
    clobTokenIds: ['tok_a', 'tok_b', 'tok_c'],
  };
  assert.deepEqual(getAllTokenIds(market), ['tok_a', 'tok_b', 'tok_c']);
});

test('getAllTokenIds: handles JSON-encoded array', () => {
  const market = {
    clobTokenIds: '["tok_1","tok_2"]',
  };
  assert.deepEqual(getAllTokenIds(market), ['tok_1', 'tok_2']);
});

test('getAllTokenIds: filters out falsy entries', () => {
  const market = {
    clobTokenIds: ['tok_a', null, '', 'tok_b'],
  };
  assert.deepEqual(getAllTokenIds(market), ['tok_a', 'tok_b']);
});

test('getAllTokenIds: returns empty for null market', () => {
  assert.deepEqual(getAllTokenIds(null), []);
  assert.deepEqual(getAllTokenIds(undefined), []);
});
