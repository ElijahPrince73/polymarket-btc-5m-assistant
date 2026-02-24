import test from 'node:test';
import assert from 'node:assert';
import { evaluateHistoricalEntry, replayTrades } from '../../src/domain/backtester.js';

// ─── evaluateHistoricalEntry tests ─────────────────────────────────

test('evaluateHistoricalEntry: trade with all fields above thresholds returns true', () => {
  const trade = {
    modelProbAtEntry: 0.65,
    edgeAtEntry: 0.06,
    rsiAtEntry: 55,       // outside no-trade band [30, 45)
    spreadAtEntry: 0.005,
    liquidityAtEntry: 10000,
    spotImpulsePctAtEntry: 0.001,
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), true);
});

test('evaluateHistoricalEntry: trade with prob below minProbMid returns false', () => {
  const trade = {
    modelProbAtEntry: 0.50,
    edgeAtEntry: 0.06,
    rsiAtEntry: 55,
    spreadAtEntry: 0.005,
    liquidityAtEntry: 10000,
    spotImpulsePctAtEntry: 0.001,
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), false);
});

test('evaluateHistoricalEntry: trade with edge below edgeMid returns false', () => {
  const trade = {
    modelProbAtEntry: 0.65,
    edgeAtEntry: 0.01,
    rsiAtEntry: 55,
    spreadAtEntry: 0.005,
    liquidityAtEntry: 10000,
    spotImpulsePctAtEntry: 0.001,
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), false);
});

test('evaluateHistoricalEntry: trade with RSI in no-trade band returns false', () => {
  const trade = {
    modelProbAtEntry: 0.65,
    edgeAtEntry: 0.06,
    rsiAtEntry: 38,       // inside [30, 45) band
    spreadAtEntry: 0.005,
    liquidityAtEntry: 10000,
    spotImpulsePctAtEntry: 0.001,
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), false);
});

test('evaluateHistoricalEntry: trade with all null enrichment fields returns true (unknown = do not filter)', () => {
  const trade = {
    modelProbAtEntry: null,
    edgeAtEntry: null,
    rsiAtEntry: null,
    spreadAtEntry: null,
    liquidityAtEntry: null,
    spotImpulsePctAtEntry: null,
    status: 'CLOSED',
    pnl: 5,
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), true);
});

test('evaluateHistoricalEntry: trade with some null fields, some failing filters correctly on available data', () => {
  const trade = {
    modelProbAtEntry: null,      // skip (null)
    edgeAtEntry: 0.01,           // fail (below 0.03)
    rsiAtEntry: null,            // skip (null)
    spreadAtEntry: null,         // skip (null)
    liquidityAtEntry: 10000,     // pass
    spotImpulsePctAtEntry: null, // skip (null)
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), false);
});

test('evaluateHistoricalEntry: undefined enrichment fields treated as unknown (pass)', () => {
  const trade = {
    // No *AtEntry fields at all (pre-enrichment historical trade)
    status: 'CLOSED',
    pnl: 10,
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), true);
});

test('evaluateHistoricalEntry: spread above maxSpreadThreshold returns false', () => {
  const trade = {
    modelProbAtEntry: 0.65,
    edgeAtEntry: 0.06,
    rsiAtEntry: 55,
    spreadAtEntry: 0.020,  // above 0.012
    liquidityAtEntry: 10000,
    spotImpulsePctAtEntry: 0.001,
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), false);
});

test('evaluateHistoricalEntry: liquidity below minLiquidity returns false', () => {
  const trade = {
    modelProbAtEntry: 0.65,
    edgeAtEntry: 0.06,
    rsiAtEntry: 55,
    spreadAtEntry: 0.005,
    liquidityAtEntry: 200,  // below 500
    spotImpulsePctAtEntry: 0.001,
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), false);
});

test('evaluateHistoricalEntry: impulse below minSpotImpulse returns false', () => {
  const trade = {
    modelProbAtEntry: 0.65,
    edgeAtEntry: 0.06,
    rsiAtEntry: 55,
    spreadAtEntry: 0.005,
    liquidityAtEntry: 10000,
    spotImpulsePctAtEntry: 0.0001,  // below 0.0003 (abs)
  };
  const config = {
    minProbMid: 0.53,
    edgeMid: 0.03,
    noTradeRsiMin: 30,
    noTradeRsiMax: 45,
    maxSpreadThreshold: 0.012,
    minLiquidity: 500,
    minSpotImpulse: 0.0003,
  };
  assert.strictEqual(evaluateHistoricalEntry(trade, config), false);
});

// ─── replayTrades tests ────────────────────────────────────────────

function makeMockTrades() {
  // 10 mock trades with known PnL and enrichment fields
  return [
    { id: '1', status: 'CLOSED', pnl: 15,  modelProbAtEntry: 0.70, edgeAtEntry: 0.08, rsiAtEntry: 60, spreadAtEntry: 0.003, liquidityAtEntry: 15000, spotImpulsePctAtEntry: 0.002 },
    { id: '2', status: 'CLOSED', pnl: -10, modelProbAtEntry: 0.55, edgeAtEntry: 0.04, rsiAtEntry: 50, spreadAtEntry: 0.005, liquidityAtEntry: 8000,  spotImpulsePctAtEntry: 0.001 },
    { id: '3', status: 'CLOSED', pnl: 20,  modelProbAtEntry: 0.65, edgeAtEntry: 0.06, rsiAtEntry: 55, spreadAtEntry: 0.004, liquidityAtEntry: 12000, spotImpulsePctAtEntry: 0.0015 },
    { id: '4', status: 'CLOSED', pnl: -5,  modelProbAtEntry: 0.58, edgeAtEntry: 0.035,rsiAtEntry: 48, spreadAtEntry: 0.006, liquidityAtEntry: 6000,  spotImpulsePctAtEntry: 0.0008 },
    { id: '5', status: 'CLOSED', pnl: 8,   modelProbAtEntry: 0.60, edgeAtEntry: 0.05, rsiAtEntry: 52, spreadAtEntry: 0.004, liquidityAtEntry: 10000, spotImpulsePctAtEntry: 0.0012 },
    { id: '6', status: 'CLOSED', pnl: -12, modelProbAtEntry: 0.54, edgeAtEntry: 0.03, rsiAtEntry: 35, spreadAtEntry: 0.008, liquidityAtEntry: 3000,  spotImpulsePctAtEntry: 0.0005 },  // RSI in [30,45)
    { id: '7', status: 'CLOSED', pnl: 25,  modelProbAtEntry: 0.72, edgeAtEntry: 0.10, rsiAtEntry: 65, spreadAtEntry: 0.002, liquidityAtEntry: 20000, spotImpulsePctAtEntry: 0.003 },
    { id: '8', status: 'CLOSED', pnl: -8,  modelProbAtEntry: 0.56, edgeAtEntry: 0.04, rsiAtEntry: 46, spreadAtEntry: 0.007, liquidityAtEntry: 7000,  spotImpulsePctAtEntry: 0.0009 },
    { id: '9', status: 'CLOSED', pnl: 12,  modelProbAtEntry: 0.63, edgeAtEntry: 0.055,rsiAtEntry: 58, spreadAtEntry: 0.003, liquidityAtEntry: 11000, spotImpulsePctAtEntry: 0.0018 },
    { id: '10', status: 'CLOSED', pnl: -3, modelProbAtEntry: 0.52, edgeAtEntry: 0.025,rsiAtEntry: 42, spreadAtEntry: 0.009, liquidityAtEntry: 4000,  spotImpulsePctAtEntry: 0.0004 },  // RSI in [30,45)
  ];
}

const baseConfig = {
  minProbMid: 0.53,
  edgeMid: 0.03,
  noTradeRsiMin: 30,
  noTradeRsiMax: 45,
  maxSpreadThreshold: 0.012,
  minLiquidity: 500,
  minSpotImpulse: 0.0003,
};

test('replayTrades: base config includes most trades', () => {
  const trades = makeMockTrades();
  const result = replayTrades(trades, {}, baseConfig);

  // Trade #6 (RSI=35, in [30,45)) and #10 (RSI=42, in [30,45)) should be filtered
  assert.strictEqual(result.tradeCount, 8);
  assert.strictEqual(result.filteredCount, 2);
  assert.strictEqual(result.tradeCount + result.filteredCount, 10);
});

test('replayTrades: override minProbMid higher filters more trades', () => {
  const trades = makeMockTrades();
  const result = replayTrades(trades, { minProbMid: 0.60 }, baseConfig);

  // Trades with modelProbAtEntry < 0.60: #2(0.55), #4(0.58), #6(0.54, also RSI), #8(0.56), #10(0.52, also RSI)
  // Trades with modelProbAtEntry >= 0.60: #1(0.70), #3(0.65), #5(0.60), #7(0.72), #9(0.63)
  assert.strictEqual(result.tradeCount, 5);
  assert.strictEqual(result.filteredCount, 5);
});

test('replayTrades: override edgeMid higher filters more trades', () => {
  const trades = makeMockTrades();
  const result = replayTrades(trades, { edgeMid: 0.05 }, baseConfig);

  // Trades with edgeAtEntry >= 0.05: #1(0.08), #3(0.06), #5(0.05), #7(0.10), #9(0.055)
  // But also filtered by RSI: none of these are in the RSI band
  // Trades with edgeAtEntry < 0.05: #2(0.04), #4(0.035), #6(0.03, also RSI), #8(0.04), #10(0.025, also RSI)
  assert.strictEqual(result.tradeCount, 5);
  assert.strictEqual(result.filteredCount, 5);
});

test('replayTrades: all trades filtered returns null metrics gracefully', () => {
  const trades = makeMockTrades();
  // Set impossibly high threshold
  const result = replayTrades(trades, { minProbMid: 0.99 }, baseConfig);

  assert.strictEqual(result.tradeCount, 0);
  assert.strictEqual(result.filteredCount, 10);
  assert.strictEqual(result.totalPnl, 0);
  assert.strictEqual(result.wins, 0);
  assert.strictEqual(result.losses, 0);
  assert.strictEqual(result.winRate, null);
  assert.strictEqual(result.profitFactor, null);
  assert.strictEqual(result.avgWin, null);
  assert.strictEqual(result.avgLoss, null);
  assert.strictEqual(result.expectancy, null);
  assert.deepStrictEqual(result.maxDrawdown, { maxDrawdownUsd: 0, maxDrawdownPct: 0 });
});

test('replayTrades: empty trades array returns empty results gracefully', () => {
  const result = replayTrades([], {}, baseConfig);

  assert.strictEqual(result.tradeCount, 0);
  assert.strictEqual(result.filteredCount, 0);
  assert.strictEqual(result.totalPnl, 0);
  assert.strictEqual(result.winRate, null);
  assert.strictEqual(result.profitFactor, null);
  assert.deepStrictEqual(result.entered, []);
  assert.deepStrictEqual(result.filtered, []);
});

test('replayTrades: null/undefined trades handled gracefully', () => {
  const result = replayTrades(null, {}, baseConfig);
  assert.strictEqual(result.tradeCount, 0);

  const result2 = replayTrades(undefined, {}, baseConfig);
  assert.strictEqual(result2.tradeCount, 0);
});

test('replayTrades: only CLOSED trades are processed', () => {
  const trades = [
    { id: '1', status: 'OPEN', pnl: 0, modelProbAtEntry: 0.70, edgeAtEntry: 0.08, rsiAtEntry: 60, spreadAtEntry: 0.003, liquidityAtEntry: 15000, spotImpulsePctAtEntry: 0.002 },
    { id: '2', status: 'CLOSED', pnl: 10, modelProbAtEntry: 0.65, edgeAtEntry: 0.06, rsiAtEntry: 55, spreadAtEntry: 0.004, liquidityAtEntry: 12000, spotImpulsePctAtEntry: 0.0015 },
  ];
  const result = replayTrades(trades, {}, baseConfig);
  assert.strictEqual(result.tradeCount, 1);
  assert.strictEqual(result.entered[0].id, '2');
});

test('replayTrades: profitFactor computation is correct', () => {
  // Hand-crafted trades with known winning and losing PnL
  const trades = [
    { id: '1', status: 'CLOSED', pnl: 20, modelProbAtEntry: 0.70, edgeAtEntry: 0.08, rsiAtEntry: 60, spreadAtEntry: 0.003, liquidityAtEntry: 15000, spotImpulsePctAtEntry: 0.002 },
    { id: '2', status: 'CLOSED', pnl: 10, modelProbAtEntry: 0.65, edgeAtEntry: 0.06, rsiAtEntry: 55, spreadAtEntry: 0.004, liquidityAtEntry: 12000, spotImpulsePctAtEntry: 0.0015 },
    { id: '3', status: 'CLOSED', pnl: -15, modelProbAtEntry: 0.60, edgeAtEntry: 0.05, rsiAtEntry: 50, spreadAtEntry: 0.005, liquidityAtEntry: 10000, spotImpulsePctAtEntry: 0.001 },
  ];
  const result = replayTrades(trades, {}, baseConfig);

  // profitFactor = winPnlSum / abs(lossPnlSum) = 30 / 15 = 2.0
  assert.strictEqual(result.profitFactor, 2.0);
  // winRate = 2/3
  assert.ok(Math.abs(result.winRate - 2 / 3) < 0.0001);
  // avgWin = 30/2 = 15
  assert.strictEqual(result.avgWin, 15);
  // avgLoss = -15/1 = -15
  assert.strictEqual(result.avgLoss, -15);
  // expectancy = 15/3 = 5
  assert.strictEqual(result.expectancy, 5);
});

test('replayTrades: maxDrawdown computation is correct', () => {
  // Trades: +10, -20, +5 -> equity curve: 1010, 990, 995
  // Peak at 1010, trough at 990 => max drawdown = 20
  const trades = [
    { id: '1', status: 'CLOSED', pnl: 10, modelProbAtEntry: 0.70, edgeAtEntry: 0.08, rsiAtEntry: 60, spreadAtEntry: 0.003, liquidityAtEntry: 15000, spotImpulsePctAtEntry: 0.002 },
    { id: '2', status: 'CLOSED', pnl: -20, modelProbAtEntry: 0.65, edgeAtEntry: 0.06, rsiAtEntry: 55, spreadAtEntry: 0.004, liquidityAtEntry: 12000, spotImpulsePctAtEntry: 0.0015 },
    { id: '3', status: 'CLOSED', pnl: 5, modelProbAtEntry: 0.60, edgeAtEntry: 0.05, rsiAtEntry: 50, spreadAtEntry: 0.005, liquidityAtEntry: 10000, spotImpulsePctAtEntry: 0.001 },
  ];
  const result = replayTrades(trades, {}, baseConfig);

  assert.strictEqual(result.maxDrawdown.maxDrawdownUsd, 20);
  // maxDrawdownPct = 20 / 1010 ~= 0.0198
  assert.ok(Math.abs(result.maxDrawdown.maxDrawdownPct - 20 / 1010) < 0.0001);
});

test('replayTrades: winRate and metrics with all-winning trades', () => {
  const trades = [
    { id: '1', status: 'CLOSED', pnl: 10, modelProbAtEntry: 0.70, edgeAtEntry: 0.08, rsiAtEntry: 60, spreadAtEntry: 0.003, liquidityAtEntry: 15000, spotImpulsePctAtEntry: 0.002 },
    { id: '2', status: 'CLOSED', pnl: 5, modelProbAtEntry: 0.65, edgeAtEntry: 0.06, rsiAtEntry: 55, spreadAtEntry: 0.004, liquidityAtEntry: 12000, spotImpulsePctAtEntry: 0.0015 },
  ];
  const result = replayTrades(trades, {}, baseConfig);

  assert.strictEqual(result.winRate, 1);
  assert.strictEqual(result.profitFactor, null); // no losses
  assert.strictEqual(result.losses, 0);
  assert.strictEqual(result.maxDrawdown.maxDrawdownUsd, 0);
});

test('replayTrades: pre-enrichment trades with missing fields are not filtered', () => {
  // Simulate historical trades that lack enrichment fields
  const trades = [
    { id: '1', status: 'CLOSED', pnl: 10 },
    { id: '2', status: 'CLOSED', pnl: -5 },
    { id: '3', status: 'CLOSED', pnl: 8 },
  ];
  const result = replayTrades(trades, { minProbMid: 0.60 }, baseConfig);

  // All trades should pass since all enrichment fields are undefined (treated as unknown)
  assert.strictEqual(result.tradeCount, 3);
  assert.strictEqual(result.filteredCount, 0);
  assert.strictEqual(result.totalPnl, 13);
});
