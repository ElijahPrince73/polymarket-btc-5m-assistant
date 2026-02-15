import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'polybot-test-'));
}

test('Trader can enter in loose rec gating by inferring side when rec.side is missing', async () => {
  const tmp = mkTmpDir();
  process.chdir(tmp);
  fs.mkdirSync('paper_trading', { recursive: true });

  // Import after chdir so ledger writes to tmp/paper_trading
  const { initializeLedger, getLedger } = await import('../src/paper_trading/ledger.js');
  const { Trader } = await import('../src/paper_trading/trader.js');
  const { CONFIG } = await import('../src/config.js');

  // Ensure defaults are present
  await initializeLedger();

  // Force loose gating
  CONFIG.paperTrading.recGating = 'loose';
  // Ensure weekend tightening doesn't interfere with this unit test
  CONFIG.paperTrading.weekendTighteningEnabled = false;
  CONFIG.paperTrading.enabled = true;
  CONFIG.paperTrading.noEntryFinalMinutes = 2;
  CONFIG.paperTrading.minCandlesForEntry = 1;
  CONFIG.paperTrading.minPolyPrice = 0.002;
  CONFIG.paperTrading.maxPolyPrice = 0.98;
  CONFIG.paperTrading.minLiquidity = 0;
  CONFIG.paperTrading.maxSpread = 999;
  CONFIG.paperTrading.maxEntryPolyPrice = 1;

  // Make thresholds easy to hit
  CONFIG.paperTrading.minProbEarly = 0.50;
  CONFIG.paperTrading.edgeEarly = 0;
  // Disable impulse filter for unit test
  CONFIG.paperTrading.minBtcImpulsePct1m = 0;

  const t = new Trader();
  await t.initialize();

  const signals = {
    rec: { action: 'NO_TRADE', phase: 'EARLY', edge: 0.2 },
    timeLeftMin: 10,
    market: { slug: 'm1', liquidityNum: 100000 },
    polyMarketSnapshot: { orderbook: { up: { spread: 0.01 }, down: { spread: 0.01 } } },
    polyPrices: { UP: 0.01, DOWN: 0.02 },
    polyPricesCents: { UP: 1, DOWN: 2 },
    modelUp: 0.7,
    modelDown: 0.3,
    indicators: {
      rsiNow: 50,
      vwapNow: 100,
      vwapSlope: 0.1,
      macd: { hist: 1, histDelta: 0.1 },
      heikenColor: 'green',
      heikenCount: 3
    }
  };

  const klines1m = [{ close: 100 }];

  await t.processSignals(signals, klines1m);

  assert.ok(t.openTrade, 'expected an openTrade');
  assert.equal(t.openTrade.side, 'UP');

  const ledger = getLedger();
  assert.ok(Array.isArray(ledger.trades));
  assert.equal(ledger.trades.length, 1);
  assert.equal(ledger.trades[0].status, 'OPEN');
});
