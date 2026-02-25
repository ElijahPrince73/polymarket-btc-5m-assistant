import test from 'node:test';
import assert from 'node:assert';

// Skip all tests if better-sqlite3 is not installed (replaced by Supabase in v1.1)
let TradeStore;
let SKIP = false;
try {
  const mod = await import('../../src/infrastructure/persistence/tradeStore.js');
  TradeStore = mod.TradeStore;
} catch {
  SKIP = true;
}

if (SKIP) {
  test('TradeStore: SKIPPED — better-sqlite3 not installed (replaced by Supabase)', { skip: true }, () => {});
} else {

// All tests use in-memory DB to avoid file system side effects

function createStore() {
  return new TradeStore({ inMemory: true });
}

function makeTrade(overrides = {}) {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
    timestamp: new Date().toISOString(),
    status: 'CLOSED',
    side: 'UP',
    entryPrice: 0.004,
    exitPrice: 0.005,
    shares: 100,
    contractSize: 0.4,
    pnl: 0.1,
    entryTime: new Date().toISOString(),
    exitTime: new Date().toISOString(),
    exitReason: 'Pre-settlement rollover',
    entryPhase: 'MID',
    marketSlug: 'btc-up-or-down-5m-2026-02-23',
    sideInferred: false,
    modelProbAtEntry: 0.62,
    edgeAtEntry: 0.05,
    rsiAtEntry: 55,
    spreadAtEntry: 0.008,
    liquidityAtEntry: 15000,
    ...overrides,
  };
}

// ── Basic CRUD ───────────────────────────────────────────────────────

test('TradeStore: insert and retrieve a trade', () => {
  const store = createStore();
  const trade = makeTrade({ id: 'trade-1' });

  store.insertTrade(trade);
  const result = store.getTradeById('trade-1');

  assert.ok(result);
  assert.strictEqual(result.id, 'trade-1');
  assert.strictEqual(result.side, 'UP');
  assert.strictEqual(result.entryPrice, 0.004);
  assert.strictEqual(result.pnl, 0.1);
  assert.strictEqual(result.status, 'CLOSED');
  store.close();
});

test('TradeStore: getAllTrades returns trades in timestamp order', () => {
  const store = createStore();
  const t1 = makeTrade({ id: 'a', timestamp: '2026-02-01T00:00:00Z' });
  const t2 = makeTrade({ id: 'b', timestamp: '2026-02-02T00:00:00Z' });
  const t3 = makeTrade({ id: 'c', timestamp: '2026-01-31T00:00:00Z' });

  store.insertTrade(t3);
  store.insertTrade(t1);
  store.insertTrade(t2);

  const all = store.getAllTrades();
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[0].id, 'c');
  assert.strictEqual(all[1].id, 'a');
  assert.strictEqual(all[2].id, 'b');
  store.close();
});

test('TradeStore: getClosedTrades filters by status', () => {
  const store = createStore();
  store.insertTrade(makeTrade({ id: 'closed-1', status: 'CLOSED', pnl: 5 }));
  store.insertTrade(makeTrade({ id: 'open-1', status: 'OPEN', pnl: 0 }));
  store.insertTrade(makeTrade({ id: 'closed-2', status: 'CLOSED', pnl: -3 }));

  const closed = store.getClosedTrades();
  assert.strictEqual(closed.length, 2);
  assert.ok(closed.every(t => t.status === 'CLOSED'));
  store.close();
});

test('TradeStore: getOpenTrades returns only OPEN trades', () => {
  const store = createStore();
  store.insertTrade(makeTrade({ id: 'o1', status: 'OPEN' }));
  store.insertTrade(makeTrade({ id: 'c1', status: 'CLOSED' }));

  const open = store.getOpenTrades();
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].id, 'o1');
  store.close();
});

// ── Update trade ─────────────────────────────────────────────────────

test('TradeStore: updateTrade modifies fields', () => {
  const store = createStore();
  store.insertTrade(makeTrade({ id: 'upd-1', status: 'OPEN', pnl: 0 }));

  store.updateTrade('upd-1', {
    status: 'CLOSED',
    pnl: 12.5,
    exitPrice: 0.006,
    exitTime: '2026-02-23T12:00:00Z',
    exitReason: 'Take profit',
  });

  const updated = store.getTradeById('upd-1');
  assert.strictEqual(updated.status, 'CLOSED');
  assert.strictEqual(updated.pnl, 12.5);
  assert.strictEqual(updated.exitPrice, 0.006);
  assert.strictEqual(updated.exitReason, 'Take profit');
  store.close();
});

// ── Date range queries ───────────────────────────────────────────────

test('TradeStore: getTradesByDateRange filters correctly', () => {
  const store = createStore();
  store.insertTrade(makeTrade({ id: 'd1', timestamp: '2026-02-01T00:00:00Z' }));
  store.insertTrade(makeTrade({ id: 'd2', timestamp: '2026-02-15T00:00:00Z' }));
  store.insertTrade(makeTrade({ id: 'd3', timestamp: '2026-03-01T00:00:00Z' }));

  const range = store.getTradesByDateRange('2026-02-01T00:00:00Z', '2026-02-28T23:59:59Z');
  assert.strictEqual(range.length, 2);
  assert.ok(range.some(t => t.id === 'd1'));
  assert.ok(range.some(t => t.id === 'd2'));
  store.close();
});

// ── Outcome queries ──────────────────────────────────────────────────

test('TradeStore: getTradesByOutcome returns wins/losses', () => {
  const store = createStore();
  store.insertTrade(makeTrade({ id: 'w1', status: 'CLOSED', pnl: 10 }));
  store.insertTrade(makeTrade({ id: 'w2', status: 'CLOSED', pnl: 5 }));
  store.insertTrade(makeTrade({ id: 'l1', status: 'CLOSED', pnl: -3 }));
  store.insertTrade(makeTrade({ id: 'o1', status: 'OPEN', pnl: 0 }));

  const wins = store.getTradesByOutcome('win');
  assert.strictEqual(wins.length, 2);

  const losses = store.getTradesByOutcome('loss');
  assert.strictEqual(losses.length, 1);
  assert.strictEqual(losses[0].id, 'l1');
  store.close();
});

// ── Mode queries ─────────────────────────────────────────────────────

test('TradeStore: getTradesByMode filters by mode', () => {
  const store = createStore();
  store.insertTrade(makeTrade({ id: 'p1' }), 'paper');
  store.insertTrade(makeTrade({ id: 'l1' }), 'live');
  store.insertTrade(makeTrade({ id: 'p2' }), 'paper');

  const paper = store.getTradesByMode('paper');
  assert.strictEqual(paper.length, 2);

  const live = store.getTradesByMode('live');
  assert.strictEqual(live.length, 1);
  store.close();
});

// ── Summary ──────────────────────────────────────────────────────────

test('TradeStore: recalculateSummary produces correct stats', () => {
  const store = createStore();
  store.insertTrade(makeTrade({ id: 's1', status: 'CLOSED', pnl: 10 }));
  store.insertTrade(makeTrade({ id: 's2', status: 'CLOSED', pnl: -5 }));
  store.insertTrade(makeTrade({ id: 's3', status: 'CLOSED', pnl: 3 }));
  store.insertTrade(makeTrade({ id: 's4', status: 'OPEN', pnl: 0 }));

  store.recalculateSummary();
  const summary = store.getSummary();

  assert.strictEqual(summary.totalTrades, 4);
  assert.strictEqual(summary.wins, 2);
  assert.strictEqual(summary.losses, 1);
  assert.strictEqual(summary.totalPnL, 8);
  assert.ok(summary.winRate > 0);
  store.close();
});

// ── Meta ─────────────────────────────────────────────────────────────

test('TradeStore: meta read/write', () => {
  const store = createStore();

  const meta = store.getMeta();
  assert.strictEqual(meta.realizedOffset, 0);

  store.updateMeta({ realizedOffset: -25.5 });
  const updated = store.getMeta();
  assert.strictEqual(updated.realizedOffset, -25.5);
  store.close();
});

// ── Ledger-compatible interface ──────────────────────────────────────

test('TradeStore: getLedgerData returns ledger-shaped object', () => {
  const store = createStore();
  store.insertTrade(makeTrade({ id: 'ld1', status: 'CLOSED', pnl: 5 }));
  store.recalculateSummary();

  const data = store.getLedgerData();
  assert.ok(Array.isArray(data.trades));
  assert.strictEqual(data.trades.length, 1);
  assert.ok(data.summary);
  assert.ok(data.meta);
  assert.strictEqual(data.summary.wins, 1);
  store.close();
});

// ── Migration ────────────────────────────────────────────────────────

test('TradeStore: migrateFromLedger imports trades', () => {
  const store = createStore();
  const ledger = {
    trades: [
      makeTrade({ id: 'mig-1', pnl: 10 }),
      makeTrade({ id: 'mig-2', pnl: -5 }),
      makeTrade({ id: 'mig-3', pnl: 3 }),
    ],
    summary: { totalTrades: 3, wins: 2, losses: 1, totalPnL: 8, winRate: 66.67 },
    meta: { realizedOffset: -10 },
  };

  const result = store.migrateFromLedger(ledger);
  assert.strictEqual(result.migrated, 3);
  assert.strictEqual(result.skipped, 0);

  const allTrades = store.getAllTrades();
  assert.strictEqual(allTrades.length, 3);

  const meta = store.getMeta();
  assert.strictEqual(meta.realizedOffset, -10);
  store.close();
});

test('TradeStore: migrateFromLedger skips duplicates', () => {
  const store = createStore();
  const trade = makeTrade({ id: 'dup-1' });
  store.insertTrade(trade);

  const result = store.migrateFromLedger({ trades: [trade], meta: {} });
  assert.strictEqual(result.migrated, 0);
  assert.strictEqual(result.skipped, 1);
  store.close();
});

// ── Enrichment fields roundtrip ──────────────────────────────────────

test('TradeStore: enrichment fields survive insert-read roundtrip', () => {
  const store = createStore();
  const trade = makeTrade({
    id: 'enrich-1',
    modelProbAtEntry: 0.62,
    edgeAtEntry: 0.045,
    rsiAtEntry: 55.3,
    vwapDistAtEntry: 0.0015,
    spreadAtEntry: 0.008,
    liquidityAtEntry: 15000,
    macdHistAtEntry: 0.23,
    heikenColorAtEntry: 'green',
    heikenCountAtEntry: 3,
    rangePct20AtEntry: 0.0018,
    recActionAtEntry: 'ENTER',
    sideInferred: true,
    entryGateSnapshot: { totalChecks: 24, passedCount: 24, failedCount: 0, margins: {} },
    maxUnrealizedPnl: 15.5,
    minUnrealizedPnl: -3.2,
    btcSpotAtExit: 96500,
    rsiAtExit: 48,
  });

  store.insertTrade(trade);
  const result = store.getTradeById('enrich-1');

  assert.strictEqual(result.modelProbAtEntry, 0.62);
  assert.strictEqual(result.edgeAtEntry, 0.045);
  assert.strictEqual(result.rsiAtEntry, 55.3);
  assert.strictEqual(result.spreadAtEntry, 0.008);
  assert.strictEqual(result.heikenColorAtEntry, 'green');
  assert.strictEqual(result.heikenCountAtEntry, 3);
  assert.strictEqual(result.recActionAtEntry, 'ENTER');
  assert.strictEqual(result.sideInferred, true);
  assert.strictEqual(result.maxUnrealizedPnl, 15.5);
  assert.strictEqual(result.minUnrealizedPnl, -3.2);
  assert.strictEqual(result.btcSpotAtExit, 96500);
  assert.deepStrictEqual(result.entryGateSnapshot, { totalChecks: 24, passedCount: 24, failedCount: 0, margins: {} });
  store.close();
});

// ── Extra JSON fields roundtrip ──────────────────────────────────────

test('TradeStore: extra unknown fields preserved via extraJson', () => {
  const store = createStore();
  const trade = makeTrade({
    id: 'extra-1',
    customField: 'hello',
    numericExtra: 42,
  });

  store.insertTrade(trade);
  const result = store.getTradeById('extra-1');

  assert.strictEqual(result.customField, 'hello');
  assert.strictEqual(result.numericExtra, 42);
  store.close();
});

// ── insertMany (batch) ───────────────────────────────────────────────

test('TradeStore: insertMany inserts in transaction', () => {
  const store = createStore();
  const trades = Array.from({ length: 50 }, (_, i) =>
    makeTrade({ id: `batch-${i}`, pnl: i % 2 === 0 ? 5 : -3 })
  );

  store.insertMany(trades);
  assert.strictEqual(store.getTradeCount(), 50);
  store.close();
});

// ── Edge cases ───────────────────────────────────────────────────────

test('TradeStore: handles null/undefined fields gracefully', () => {
  const store = createStore();
  store.insertTrade({
    id: 'null-1',
    timestamp: new Date().toISOString(),
    status: 'OPEN',
    entryPrice: null,
    rsiAtEntry: undefined,
  });

  const result = store.getTradeById('null-1');
  assert.ok(result);
  assert.strictEqual(result.entryPrice, null);
  store.close();
});

test('TradeStore: deleteAll clears all trades', () => {
  const store = createStore();
  store.insertTrade(makeTrade({ id: 'del-1' }));
  store.insertTrade(makeTrade({ id: 'del-2' }));
  assert.strictEqual(store.getTradeCount(), 2);

  store.deleteAll();
  assert.strictEqual(store.getTradeCount(), 0);
  store.close();
});

} // end else (SKIP)
