import test from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalService } from '../../src/infrastructure/approvals/ApprovalService.js';

// ─── Constructor Defaults ──────────────────────────────────────────

test('constructor: default recheckCooldownMs', () => {
  const svc = new ApprovalService();
  assert.equal(svc.recheckCooldownMs, 5 * 60_000);
});

test('constructor: custom recheckCooldownMs', () => {
  const svc = new ApprovalService({ recheckCooldownMs: 10_000 });
  assert.equal(svc.recheckCooldownMs, 10_000);
});

// ─── getStatus ─────────────────────────────────────────────────────

test('getStatus: returns default state when nothing checked', () => {
  const svc = new ApprovalService();
  const status = svc.getStatus();

  assert.equal(status.collateral.state, 'unknown');
  assert.equal(status.collateral.balance, 0);
  assert.equal(status.collateral.allowance, 0);
  assert.equal(status.collateral.lastCheckedAt, null);
  assert.deepEqual(status.conditional, {});
});

test('getStatus: returns conditional status after manual population', () => {
  const svc = new ApprovalService();

  // Simulate a cached conditional status
  svc._conditionalStatus.set('token_abc', {
    state: 'approved',
    balance: 100,
    allowance: 100,
    lastCheckedAt: Date.now(),
    error: null,
  });

  const status = svc.getStatus();
  assert.equal(Object.keys(status.conditional).length, 1);
  assert.equal(status.conditional['token_abc'].state, 'approved');
  assert.equal(status.conditional['token_abc'].balance, 100);
  assert.equal(status.conditional['token_abc'].allowance, 100);
  assert.ok(status.conditional['token_abc'].lastCheckedAt); // ISO string
});

// ─── checkAndApproveCollateral (no client) ─────────────────────────

test('checkAndApproveCollateral: returns failed when no client', async () => {
  const svc = new ApprovalService();
  const result = await svc.checkAndApproveCollateral();

  assert.equal(result.state, 'failed');
  assert.ok(result.error);
  assert.ok(result.lastCheckedAt); // ISO string
});

// ─── checkAndApproveConditional ────────────────────────────────────

test('checkAndApproveConditional: returns failed for empty tokenId', async () => {
  const svc = new ApprovalService();
  const result = await svc.checkAndApproveConditional('');

  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'No tokenId provided');
});

test('checkAndApproveConditional: returns failed when no client', async () => {
  const svc = new ApprovalService();
  const result = await svc.checkAndApproveConditional('token_xyz');

  assert.equal(result.state, 'failed');
  assert.ok(result.error);
});

test('checkAndApproveConditional: respects cooldown', async () => {
  const svc = new ApprovalService({ recheckCooldownMs: 60_000 });

  // Manually populate status and last check time
  svc._conditionalStatus.set('token_cool', {
    state: 'approved',
    balance: 50,
    allowance: 50,
    lastCheckedAt: Date.now(),
    error: null,
  });
  svc._lastCheckByToken.set('token_cool', Date.now());

  // Should return cached result, not re-check
  const result = await svc.checkAndApproveConditional('token_cool');
  assert.equal(result.state, 'approved');
  assert.equal(result.balance, 50);
});

test('checkAndApproveConditional: force bypasses cooldown', async () => {
  const svc = new ApprovalService({ recheckCooldownMs: 60_000 });

  svc._conditionalStatus.set('token_force', {
    state: 'approved',
    balance: 50,
    allowance: 50,
    lastCheckedAt: Date.now(),
    error: null,
  });
  svc._lastCheckByToken.set('token_force', Date.now());

  // Force re-check — will fail because no client, but should not use cached
  const result = await svc.checkAndApproveConditional('token_force', { force: true });
  // Without a real client, it fails
  assert.equal(result.state, 'failed');
});

// ─── getSellableQty ────────────────────────────────────────────────

test('getSellableQty: returns 0 when no client (via checkAndApprove fallthrough)', async () => {
  const svc = new ApprovalService();
  const qty = await svc.getSellableQty('token_sell');
  // No client → checkAndApproveConditional returns failed with balance=0, allowance=0
  assert.equal(qty, 0);
});

// ─── _formatStatus ─────────────────────────────────────────────────

test('_formatStatus: formats lastCheckedAt as ISO string', () => {
  const svc = new ApprovalService();
  const now = Date.now();
  const formatted = svc._formatStatus({
    state: 'approved',
    balance: 100,
    allowance: 100,
    lastCheckedAt: now,
    error: null,
  });

  assert.equal(formatted.state, 'approved');
  assert.equal(formatted.lastCheckedAt, new Date(now).toISOString());
  assert.equal(formatted.error, null);
});

test('_formatStatus: null lastCheckedAt when 0', () => {
  const svc = new ApprovalService();
  const formatted = svc._formatStatus({
    state: 'unknown',
    balance: 0,
    allowance: 0,
    lastCheckedAt: 0,
    error: null,
  });

  assert.equal(formatted.lastCheckedAt, null);
});
