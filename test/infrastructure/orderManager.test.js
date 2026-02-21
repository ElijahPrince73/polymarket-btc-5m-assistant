import test from 'node:test';
import assert from 'node:assert/strict';

import { OrderManager } from '../../src/infrastructure/orders/OrderManager.js';

// ─── Track orders ──────────────────────────────────────────────────

test('trackOrder: adds order with pending status', () => {
  const om = new OrderManager();
  om.trackOrder('order_1', {
    tokenID: 'tok_abc',
    side: 'BUY',
    price: 0.04,
    size: 100,
  });

  const orders = om.getPendingOrders();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, 'order_1');
  assert.equal(orders[0].status, 'pending');
  assert.equal(orders[0].tokenID, 'tok_abc');
  assert.equal(orders[0].side, 'BUY');
  assert.equal(orders[0].price, 0.04);
  assert.equal(orders[0].size, 100);
});

test('trackOrder: ignores empty orderId', () => {
  const om = new OrderManager();
  om.trackOrder('', { tokenID: 'tok', side: 'BUY', price: 0.04, size: 100 });
  om.trackOrder(null, { tokenID: 'tok', side: 'BUY', price: 0.04, size: 100 });

  assert.equal(om.getPendingOrders().length, 0);
});

test('trackOrder: stores extra metadata', () => {
  const om = new OrderManager();
  om.trackOrder('order_2', {
    tokenID: 'tok_def',
    side: 'SELL',
    price: 0.95,
    size: 50,
    extra: { marketSlug: 'btc-up-or-down', reason: 'Take Profit' },
  });

  const order = om.getPendingOrders()[0];
  assert.equal(order.metadata.marketSlug, 'btc-up-or-down');
  assert.equal(order.metadata.reason, 'Take Profit');
});

// ─── Get orders ────────────────────────────────────────────────────

test('getPendingOrders: filters by status', () => {
  const om = new OrderManager();
  om.trackOrder('o1', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });
  om.trackOrder('o2', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });

  // Manually update one to filled
  om._orders.get('o1').status = 'filled';

  const pending = om.getPendingOrders({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].orderId, 'o2');

  const filled = om.getPendingOrders({ status: 'filled' });
  assert.equal(filled.length, 1);
  assert.equal(filled[0].orderId, 'o1');
});

test('getPendingOrders: returns all when no filter', () => {
  const om = new OrderManager();
  om.trackOrder('o1', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });
  om.trackOrder('o2', { tokenID: 't', side: 'SELL', price: 0.95, size: 10 });

  const all = om.getPendingOrders();
  assert.equal(all.length, 2);
});

// ─── Snapshot ──────────────────────────────────────────────────────

test('getSnapshot: empty state', () => {
  const om = new OrderManager();
  const snap = om.getSnapshot();

  assert.equal(snap.total, 0);
  assert.equal(snap.pending, 0);
  assert.equal(snap.open, 0);
  assert.equal(snap.filled, 0);
  assert.equal(snap.cancelled, 0);
  assert.deepEqual(snap.orders, []);
});

test('getSnapshot: counts by status', () => {
  const om = new OrderManager();
  om.trackOrder('o1', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });
  om.trackOrder('o2', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });
  om.trackOrder('o3', { tokenID: 't', side: 'SELL', price: 0.95, size: 10 });

  om._orders.get('o1').status = 'filled';
  om._orders.get('o3').status = 'cancelled';

  const snap = om.getSnapshot();
  assert.equal(snap.total, 3);
  assert.equal(snap.pending, 1); // o2
  assert.equal(snap.filled, 1);  // o1
  assert.equal(snap.cancelled, 1); // o3
});

// ─── Cancel (without client) ───────────────────────────────────────

test('cancelOrder: returns error without client', async () => {
  const om = new OrderManager();
  om.trackOrder('o1', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });

  const result = await om.cancelOrder('o1');
  assert.equal(result.cancelled, false);
  assert.ok(result.error);
});

test('cancelAllOrders: returns error without client', async () => {
  const om = new OrderManager();
  const result = await om.cancelAllOrders();
  assert.equal(result.cancelled, false);
  assert.ok(result.error);
});

// ─── Prune ─────────────────────────────────────────────────────────

test('pruneOldOrders: removes old filled/cancelled orders', () => {
  const om = new OrderManager();
  om.trackOrder('o1', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });
  om.trackOrder('o2', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });
  om.trackOrder('o3', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });

  // o1 = filled, old
  om._orders.get('o1').status = 'filled';
  om._orders.get('o1').updatedAt = new Date(Date.now() - 60 * 60_000).toISOString(); // 1 hour ago

  // o2 = cancelled, old
  om._orders.get('o2').status = 'cancelled';
  om._orders.get('o2').updatedAt = new Date(Date.now() - 60 * 60_000).toISOString();

  // o3 = pending (should not be pruned)

  om.pruneOldOrders(30 * 60_000); // 30 min cutoff

  assert.equal(om._orders.size, 1);
  assert.ok(om._orders.has('o3'));
});

test('pruneOldOrders: keeps recent filled orders', () => {
  const om = new OrderManager();
  om.trackOrder('o1', { tokenID: 't', side: 'BUY', price: 0.05, size: 10 });
  om._orders.get('o1').status = 'filled';
  om._orders.get('o1').updatedAt = new Date().toISOString(); // Just now

  om.pruneOldOrders(30 * 60_000);
  assert.equal(om._orders.size, 1); // Still there
});
