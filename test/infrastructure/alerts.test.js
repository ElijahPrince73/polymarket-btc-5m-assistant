import test from 'node:test';
import assert from 'node:assert/strict';

import { AlertService } from '../../src/infrastructure/alerts.js';

test('AlertService: initial state is empty', () => {
  const svc = new AlertService();
  assert.equal(svc.getRecent().length, 0);
  assert.equal(svc.getSnapshot().total, 0);
});

test('AlertService: fire adds alert', () => {
  const svc = new AlertService();
  const fired = svc.fire('circuit_breaker', '5 consecutive losses', 'critical');
  assert.equal(fired, true);

  const recent = svc.getRecent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].type, 'circuit_breaker');
  assert.equal(recent[0].level, 'critical');
});

test('AlertService: deduplication within window', () => {
  const svc = new AlertService({ dedupeWindowMs: 60_000 });

  svc.fire('test_alert', 'first');
  const duped = svc.fire('test_alert', 'second');

  assert.equal(duped, false);
  assert.equal(svc.getRecent().length, 1); // Only first
});

test('AlertService: different types are not deduped', () => {
  const svc = new AlertService({ dedupeWindowMs: 60_000 });

  svc.fire('alert_a', 'first');
  svc.fire('alert_b', 'second');

  assert.equal(svc.getRecent().length, 2);
});

test('AlertService: getByType filters correctly', () => {
  const svc = new AlertService({ dedupeWindowMs: 0 }); // No dedupe for test

  svc.fire('type_a', 'a1');
  svc.fire('type_b', 'b1');
  svc.fire('type_a', 'a2');

  const typeA = svc.getByType('type_a');
  assert.equal(typeA.length, 2);

  const typeB = svc.getByType('type_b');
  assert.equal(typeB.length, 1);
});

test('AlertService: prunes when exceeding maxAlerts', () => {
  const svc = new AlertService({ maxAlerts: 3, dedupeWindowMs: 0 });

  svc.fire('a', '1');
  svc.fire('b', '2');
  svc.fire('c', '3');
  svc.fire('d', '4');

  assert.equal(svc.getRecent().length, 3);
  assert.equal(svc.getRecent()[0].type, 'b'); // 'a' was pruned
});

test('AlertService: getSnapshot includes critical count', () => {
  const svc = new AlertService({ dedupeWindowMs: 0 });

  svc.fire('warn1', 'w', 'warning');
  svc.fire('crit1', 'c', 'critical');
  svc.fire('warn2', 'w2', 'warning');
  svc.fire('crit2', 'c2', 'critical');

  const snap = svc.getSnapshot();
  assert.equal(snap.total, 4);
  assert.equal(snap.criticalCount, 2);
});

test('AlertService: clear removes all alerts', () => {
  const svc = new AlertService({ dedupeWindowMs: 0 });

  svc.fire('a', '1');
  svc.fire('b', '2');
  assert.equal(svc.getRecent().length, 2);

  svc.clear();
  assert.equal(svc.getRecent().length, 0);
  assert.equal(svc.getSnapshot().total, 0);
});
