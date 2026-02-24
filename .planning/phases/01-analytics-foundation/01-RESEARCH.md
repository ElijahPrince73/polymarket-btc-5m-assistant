# Phase 1: Analytics Foundation - Research

**Researched:** 2026-02-23
**Domain:** Trade analytics, backtesting, parameter optimization, vanilla JS dashboard
**Confidence:** HIGH

## Summary

Phase 1 enriches the existing paper trading ledger with full indicator snapshots at entry/exit, builds period-based analytics (day/week/session), adds advanced equity metrics (Sharpe, Sortino, drawdown), creates a backtest harness that replays historical trades with modified parameters, and implements a grid search threshold optimizer. All work builds on the existing Node.js/ESM + Express + vanilla JS + Chart.js stack with zero new framework dependencies.

The codebase is well-structured for this work. The clean architecture (domain/application/infrastructure/presentation layers) means analytics computation goes in `src/services/`, backtesting logic in a new `src/domain/backtester.js` (pure functions, no I/O), and the dashboard additions extend the existing `src/ui/` files. The existing `analyticsService.js` already has a `groupSummary()` pattern and bucket-based analysis that can be extended for period grouping.

**Primary recommendation:** Build bottom-up: first enrich the trade schema (ANLYT-03), then build analytics computations (ANLYT-01, ANLYT-04), then the backtest harness (PROF-01, ANLYT-02), then the optimizer (PROF-02). Each layer depends on the previous. Dashboard additions happen incrementally alongside each computational layer.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- Full indicator snapshot at entry and exit: MACD (value, histogram, signal line), RSI (already stored), VWAP slope (already stored), spread, liquidity depth, spot impulse %
- BTC spot price captured at both entry and exit -- enables slippage analysis (spot vs contract price) and correlation with price movements
- Entry gate evaluation stored per trade -- full list of which blockers were clear and by how much margin at the moment of entry. Enables near-miss analysis for threshold tuning
- Historical trades (pre-enrichment) backfilled with null for new fields. Analytics code must gracefully handle null/missing indicator data. New trades going forward get full snapshots
- Grid search for parameter space exploration -- test all combinations within defined ranges. Deterministic, exhaustive, easy to interpret. With 5-min trade cycles and bounded param ranges, performance should be acceptable
- Results displayed as sortable dashboard table with best combo highlighted. Columns: parameters tested, trade count, win rate, profit factor, max drawdown. User can sort by any column
- One-click apply button -- updates running config with selected parameter set. Changes take effect on next engine tick. Revert available if performance drops
- Minimum 30 historical trades required per parameter combination before optimizer produces recommendations. Prevents overfitting to small samples

### Claude's Discretion
- Analytics dashboard layout -- whether analytics appear in the existing right column, a new tab/page, or an expanded layout. Claude should choose based on information density and existing dashboard patterns
- Backtester interaction model -- whether backtest is triggered from a dashboard UI form, CLI command, or API endpoint. Claude should pick the approach that integrates best with the existing Express + vanilla JS architecture
- Visualization choices -- chart types, color schemes, and grouping UX for the analytics views
- Exact parameter ranges and step sizes for the grid search optimizer

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ANLYT-01 | Historical trade performance dashboard (per-day, per-week, per-session) | Existing `analyticsService.js` has `groupSummary()` pattern; extend with date-keyed grouping. Chart.js bar charts for period PnL. |
| ANLYT-02 | Strategy parameter backtesting framework | Pure-function backtester replays trades against modified entry gate thresholds. Reuses `computeEntryBlockers()` with param overrides. |
| ANLYT-03 | Trade journal capturing entry/exit context (indicators, market state, signals) | Enrich `openPosition()` metadata and `closePosition()` update in PaperExecutor + TradingEngine. Add fields to trade objects in ledger. |
| ANLYT-04 | Drawdown analysis and advanced equity curve metrics (Sharpe, Sortino) | Pure computation from trade PnL array. Chart.js line chart for drawdown visualization. |
| PROF-01 | Backtest harness that replays historical trades with modified parameters | Iterate over enriched trades, re-evaluate entry gate with alternate config, compute what-if PnL. |
| PROF-02 | Threshold optimizer testing parameter combinations and reporting expected win rate/PF | Grid search over configurable param ranges, calls backtest harness per combo, ranks results. |

</phase_requirements>

## Standard Stack

### Core (Already Present -- No New Dependencies)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js | 20+ | Runtime (ESM modules) | Already in use; `node --test` for tests |
| Express | 5.2.1 | API server | Already serves `/api/status`, `/api/trades`, `/api/analytics` |
| Chart.js | 4.4.1 | Charting (CDN) | Already used for equity curve; extend for drawdown + period charts |
| Vanilla JS | N/A | Dashboard frontend | Project constraint: no React/framework migration |

### Supporting (No New Dependencies Needed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:test` | Built-in | Test runner | Existing test pattern -- all new analytics code gets tests |
| `node:assert` | Built-in | Assertions | Existing test pattern |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom Sharpe/Sortino | `simple-statistics` npm package | Adds dependency for ~20 lines of math; not worth it |
| Custom grid search | `hyperopt-js` or similar | Massive overkill for bounded param grid on <1000 trades |
| Chart.js | Plotly.js, uPlot | Chart.js already loaded; no reason to add another library |
| Date adapter for Chart.js | `chartjs-adapter-date-fns` | Only needed for time scale axis; we use category labels (day/week strings) instead |

**Installation:**
```bash
# No new packages needed. Zero dependency additions.
```

## Architecture Patterns

### Recommended Project Structure (New/Modified Files)
```
src/
├── domain/
│   ├── entryGate.js             # MODIFY: export gate evaluation with margin data
│   ├── backtester.js            # NEW: pure backtest replay logic
│   └── optimizer.js             # NEW: grid search over param space
├── services/
│   ├── analyticsService.js      # MODIFY: add period grouping, Sharpe/Sortino, drawdown
│   └── backtestService.js       # NEW: orchestrates backtest runs (calls domain layer)
├── application/
│   └── TradingEngine.js         # MODIFY: pass enriched metadata to openPosition/closePosition
├── infrastructure/
│   └── executors/
│       └── PaperExecutor.js     # MODIFY: capture enriched snapshot at entry/exit
├── paper_trading/
│   └── ledger.js                # NO CHANGE (addTrade/updateTrade already spread metadata)
├── ui/
│   ├── server.js                # MODIFY: add /api/backtest, /api/optimizer, /api/config endpoints
│   ├── index.html               # MODIFY: add analytics tab/section
│   ├── analytics.js             # NEW: analytics dashboard rendering (period tables, charts)
│   └── style.css                # MODIFY: styles for new analytics components
test/
├── domain/
│   └── backtester.test.js       # NEW
├── services/
│   └── analyticsService.test.js # MODIFY: add tests for new metrics
└── optimizer.test.js            # NEW
```

### Pattern 1: Trade Schema Enrichment (ANLYT-03)
**What:** Add full indicator snapshot fields to trade objects at entry and exit.
**When to use:** Every time `openPosition()` or `closePosition()` is called.
**Current metadata passed in TradingEngine.processSignals():**
```javascript
// Current (TradingEngine.js line 256-262):
metadata: {
  modelUp: signals.modelUp,
  modelDown: signals.modelDown,
  edge: signals.rec?.edge,
  rsi: signals.indicators?.rsiNow,
  vwapSlope: signals.indicators?.vwapSlope,
}
```
**Enriched metadata (what needs to be added):**
```javascript
metadata: {
  // Existing fields (preserved)
  modelUp: signals.modelUp,
  modelDown: signals.modelDown,
  edge: signals.rec?.edge,
  rsi: signals.indicators?.rsiNow,
  vwapSlope: signals.indicators?.vwapSlope,
  // NEW: Full MACD snapshot
  macdValue: signals.indicators?.macd?.value ?? null,
  macdHist: signals.indicators?.macd?.hist ?? null,
  macdSignal: signals.indicators?.macd?.signal ?? null,
  // NEW: Market quality at entry
  spreadAtEntry: poly?.orderbook?.[effectiveSide.toLowerCase()]?.spread ?? null,
  liquidityAtEntry: signals.market?.liquidityNum ?? null,
  volumeNumAtEntry: signals.market?.volumeNum ?? null,
  // NEW: Spot price
  btcSpotAtEntry: signals.spot?.price ?? null,
  spotImpulsePctAtEntry: signals.spot?.delta1mPct ?? null,
  // NEW: Entry gate evaluation snapshot
  entryGateSnapshot: gateEvaluation, // { blockers, margins }
  // NEW: Additional context
  timeLeftMinAtEntry: signals.timeLeftMin ?? null,
  modelProbAtEntry: effectiveSide === 'UP' ? signals.modelUp : signals.modelDown,
  edgeAtEntry: signals.rec?.edge ?? null,
  rsiAtEntry: signals.indicators?.rsiNow ?? null,
  vwapDistAtEntry: signals.indicators?.vwapDist ?? null,
  heikenColorAtEntry: signals.indicators?.heikenColor ?? null,
  heikenCountAtEntry: signals.indicators?.heikenCount ?? null,
  rangePct20AtEntry: signals.indicators?.rangePct20 ?? null,
  recActionAtEntry: signals.rec?.action ?? null,
  sideInferred,
}
```

### Pattern 2: Entry Gate Evaluation with Margins (ANLYT-03)
**What:** Extend `computeEntryBlockers()` to return not just pass/fail but how much margin each check had.
**When to use:** Called from TradingEngine before entry; snapshot stored per trade.
**Example:**
```javascript
// New export from entryGate.js
export function computeEntryGateEvaluation(signals, config, state, candleCount) {
  const { blockers, effectiveSide, sideInferred } = computeEntryBlockers(signals, config, state, candleCount);

  // Compute margins for key thresholds
  const margins = {};
  const rsiNow = signals.indicators?.rsiNow ?? null;
  const noTradeRsiMin = config.noTradeRsiMin;
  const noTradeRsiMax = config.noTradeRsiMax;
  if (typeof rsiNow === 'number' && typeof noTradeRsiMin === 'number') {
    margins.rsiDistFromBand = rsiNow < noTradeRsiMin
      ? noTradeRsiMin - rsiNow
      : rsiNow >= noTradeRsiMax ? rsiNow - noTradeRsiMax : 0;
  }
  // ... similar for prob, edge, spread, liquidity, impulse thresholds

  return { blockers, effectiveSide, sideInferred, margins };
}
```

### Pattern 3: Period-Based Analytics (ANLYT-01)
**What:** Group trades by day, week, and trading session (Asia/London/NY).
**When to use:** In `analyticsService.js`, computed on-demand when `/api/analytics` is called.
**Example:**
```javascript
// Extend computeAnalytics() in analyticsService.js
function dayKeyFromTrade(trade) {
  const ts = trade.exitTime || trade.timestamp;
  if (!ts) return 'unknown';
  const d = new Date(ts);
  // Pacific time day key
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function weekKeyFromTrade(trade) {
  const ts = trade.exitTime || trade.timestamp;
  if (!ts) return 'unknown';
  const d = new Date(ts);
  // ISO week number
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function sessionKeyFromTrade(trade) {
  // BTC trading sessions: Asia (0-8 UTC), London (8-13 UTC), NY (13-21 UTC), Off-hours (21-0 UTC)
  const ts = trade.entryTime || trade.timestamp;
  if (!ts) return 'unknown';
  const hour = new Date(ts).getUTCHours();
  if (hour < 8) return 'Asia';
  if (hour < 13) return 'London';
  if (hour < 21) return 'NY';
  return 'Off-hours';
}
```

### Pattern 4: Sharpe and Sortino Computation (ANLYT-04)
**What:** Risk-adjusted return metrics from trade PnL series.
**When to use:** Computed in `analyticsService.js`, displayed in dashboard.
**Example:**
```javascript
// Pure functions for financial metrics
function computeSharpeRatio(dailyReturns, riskFreeRate = 0) {
  if (dailyReturns.length < 2) return null;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const excessMean = mean - riskFreeRate;
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;
  // Annualize: sqrt(252) for daily returns (trading days)
  return (excessMean / stdDev) * Math.sqrt(252);
}

function computeSortinoRatio(dailyReturns, riskFreeRate = 0) {
  if (dailyReturns.length < 2) return null;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const excessMean = mean - riskFreeRate;
  // Downside deviation: only negative returns
  const negReturns = dailyReturns.filter(r => r < 0);
  if (negReturns.length === 0) return null; // No downside -- infinite Sortino
  const downsideVariance = negReturns.reduce((s, r) => s + r ** 2, 0) / dailyReturns.length;
  const downsideDev = Math.sqrt(downsideVariance);
  if (downsideDev === 0) return null;
  return (excessMean / downsideDev) * Math.sqrt(252);
}

function computeDrawdownSeries(trades, startingBalance) {
  // Returns array of { tradeIndex, equity, drawdown, drawdownPct }
  let equity = startingBalance;
  let peak = startingBalance;
  const series = [];
  for (let i = 0; i < trades.length; i++) {
    equity += trades[i].pnl || 0;
    peak = Math.max(peak, equity);
    const dd = equity - peak;
    const ddPct = peak > 0 ? dd / peak : 0;
    series.push({ tradeIndex: i, equity, peak, drawdown: dd, drawdownPct: ddPct });
  }
  return series;
}
```

### Pattern 5: Backtest Harness (PROF-01, ANLYT-02)
**What:** Replay historical enriched trades with modified parameters to compute what-if results.
**When to use:** Called via API endpoint, computes results synchronously.
**Example:**
```javascript
// src/domain/backtester.js -- pure function, no I/O
export function replayTrades(trades, overrideConfig, baseConfig) {
  const config = { ...baseConfig, ...overrideConfig };
  const results = { entered: [], filtered: [], totalPnl: 0, wins: 0, losses: 0 };

  for (const trade of trades) {
    if (trade.status !== 'CLOSED') continue;

    // Would this trade have passed entry gate with modified params?
    const wouldEnter = evaluateHistoricalEntry(trade, config);

    if (wouldEnter) {
      results.entered.push(trade);
      results.totalPnl += trade.pnl || 0;
      if ((trade.pnl || 0) > 0) results.wins++;
      else results.losses++;
    } else {
      results.filtered.push(trade);
    }
  }

  const total = results.entered.length;
  results.winRate = total > 0 ? results.wins / total : null;
  results.profitFactor = results.losses > 0
    ? results.entered.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0)
      / Math.abs(results.entered.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0))
    : null;

  return results;
}

function evaluateHistoricalEntry(trade, config) {
  // Uses stored entry context (indicators, margins) to re-evaluate
  // whether this trade would have passed entry gate with new thresholds.
  // Key: check threshold-based blockers only (not time/state dependent ones).

  const rsi = trade.rsiAtEntry ?? trade.rsi;
  const edge = trade.edgeAtEntry ?? trade.edge;
  const prob = trade.modelProbAtEntry;
  const spread = trade.spreadAtEntry;
  const liquidity = trade.liquidityAtEntry;
  const impulse = trade.spotImpulsePctAtEntry;

  // Re-evaluate configurable thresholds
  if (typeof prob === 'number' && prob < (config.minProbMid ?? 0.53)) return false;
  if (typeof edge === 'number' && edge < (config.edgeMid ?? 0.03)) return false;
  if (typeof rsi === 'number') {
    const min = config.noTradeRsiMin ?? 30;
    const max = config.noTradeRsiMax ?? 45;
    if (rsi >= min && rsi < max) return false;
  }
  // ... more threshold checks

  return true;
}
```

### Pattern 6: Grid Search Optimizer (PROF-02)
**What:** Exhaustively test parameter combinations within defined ranges.
**When to use:** Triggered via API, runs synchronously, returns ranked results.
**Example:**
```javascript
// src/domain/optimizer.js -- pure function
export function gridSearch(trades, baseConfig, paramRanges, minTradesPerCombo = 30) {
  // paramRanges example:
  // { minProbMid: [0.50, 0.52, 0.53, 0.55], edgeMid: [0.02, 0.03, 0.04, 0.05] }

  const paramNames = Object.keys(paramRanges);
  const combos = cartesianProduct(paramRanges);

  const results = [];
  for (const combo of combos) {
    const overrideConfig = {};
    paramNames.forEach((name, i) => { overrideConfig[name] = combo[i]; });

    const replay = replayTrades(trades, overrideConfig, baseConfig);

    if (replay.entered.length < minTradesPerCombo) continue; // Skip sparse combos

    results.push({
      params: overrideConfig,
      tradeCount: replay.entered.length,
      filteredCount: replay.filtered.length,
      winRate: replay.winRate,
      profitFactor: replay.profitFactor,
      totalPnl: replay.totalPnl,
      maxDrawdown: computeMaxDrawdown(replay.entered),
    });
  }

  // Sort by profit factor descending (primary), then win rate (secondary)
  results.sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0)
    || (b.winRate ?? 0) - (a.winRate ?? 0));

  return results;
}

function cartesianProduct(paramRanges) {
  const keys = Object.keys(paramRanges);
  const values = keys.map(k => paramRanges[k]);
  // Iterative cartesian product
  let combos = [[]];
  for (const vals of values) {
    const next = [];
    for (const combo of combos) {
      for (const v of vals) {
        next.push([...combo, v]);
      }
    }
    combos = next;
  }
  return combos;
}
```

### Pattern 7: Dashboard Tab Navigation (UI Layout Decision)
**What:** Add an "Analytics" tab to the existing dashboard rather than cramming into the right column.
**Why this recommendation:** The existing right column already has KPIs, ledger summary, and equity curve. Analytics (period tables, drawdown chart, optimizer table) would create excessive vertical scrolling. A tab pattern keeps the existing layout intact while providing dedicated space for analytics.
**Example:**
```html
<!-- Tab navigation below header -->
<div class="tab-nav">
  <button class="tab-btn active" data-tab="dashboard">Dashboard</button>
  <button class="tab-btn" data-tab="analytics">Analytics</button>
  <button class="tab-btn" data-tab="optimizer">Optimizer</button>
</div>

<div class="tab-content" id="tab-dashboard">
  <!-- Existing dashboard grid (unchanged) -->
</div>

<div class="tab-content hidden" id="tab-analytics">
  <!-- Period performance tables + drawdown chart + Sharpe/Sortino -->
</div>

<div class="tab-content hidden" id="tab-optimizer">
  <!-- Backtest form + optimizer results table + one-click apply -->
</div>
```

### Pattern 8: One-Click Config Apply (PROF-02)
**What:** Update running config when user selects an optimizer result.
**When to use:** POST from dashboard to a new `/api/config` endpoint.
**Example:**
```javascript
// server.js -- new endpoint
app.post('/api/config', (req, res) => {
  const engine = globalThis.__tradingEngine;
  if (!engine) return res.status(503).json(fail('Engine not initialized'));

  const { params } = req.body; // e.g., { minProbMid: 0.55, edgeMid: 0.04 }

  // Store previous config for revert
  const previous = { ...engine.config };
  globalThis.__previousConfig = previous;

  // Apply overrides
  Object.assign(engine.config, params);

  res.json(ok({ applied: params, revertAvailable: true }));
});

app.post('/api/config/revert', (req, res) => {
  const engine = globalThis.__tradingEngine;
  const previous = globalThis.__previousConfig;
  if (!engine || !previous) return res.status(400).json(fail('No config to revert'));

  engine.config = { ...previous };
  globalThis.__previousConfig = null;

  res.json(ok({ reverted: true }));
});
```

### Anti-Patterns to Avoid
- **Modifying trade objects in-place during backtest:** Always copy trade data when replaying. The ledger trades are live objects used by the running engine.
- **Storing computed analytics in the ledger:** Analytics are derived, not persisted. Compute on-demand from trade data.
- **Blocking the main loop during grid search:** The optimizer runs synchronously but is triggered only via API. For large grids (>10K combos), consider chunking or warning the user. With the current bounded param space, this should not be an issue.
- **Adding a date adapter library for Chart.js:** The period charts use categorical labels (date strings), not time scale. No adapter needed.
- **Enriching historical trades with actual indicator values:** Historical trades cannot be enriched with real indicator data (it is gone). Backfill new fields with `null`. The backtester should gracefully skip trades missing required fields.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Date grouping | Custom date parsing | `Intl.DateTimeFormat` with timezone | Built into Node.js, handles PT timezone correctly, already used in `script.js` |
| JSON deep clone | `JSON.parse(JSON.stringify())` for trade copies | Spread operator `{ ...trade }` | Trades are flat objects (no nested objects that need deep clone) |
| Chart rendering | Custom SVG/Canvas | Chart.js (already loaded) | Already in the page, well-tested, supports bar, line, and annotations |
| Sortable tables | Custom sort implementation | Vanilla JS `Array.sort()` + DOM manipulation | The optimizer table needs client-side sorting; no need for a table library |
| Statistical functions | External stats library | ~20 lines of custom code per metric | Sharpe, Sortino, drawdown, max drawdown are simple formulas; no library needed |

**Key insight:** This phase is entirely about computation (pure functions) and presentation (vanilla JS + Chart.js). The existing stack handles everything. Zero new dependencies.

## Common Pitfalls

### Pitfall 1: Null Handling for Historical Trades
**What goes wrong:** Historical trades lack the new enriched fields. Code that assumes `trade.macdHist` exists will throw or produce NaN.
**Why it happens:** Backfill strategy is nulls for historical trades.
**How to avoid:** Every analytics/backtest function must use null-safe access patterns: `trade.macdHist ?? null`, `typeof trade.spreadAtEntry === 'number'`. The `evaluateHistoricalEntry()` function should skip threshold checks when the relevant field is null (treat as "unknown, don't filter").
**Warning signs:** `NaN` in analytics output, empty backtest results despite having trades.

### Pitfall 2: Annualization of Sharpe/Sortino for High-Frequency Trading
**What goes wrong:** Standard Sharpe ratio uses daily returns annualized by sqrt(252). But 5-minute trades can have multiple trades per day with very different characteristics than daily returns.
**Why it happens:** Sharpe/Sortino formulas assume independent, identically distributed returns over equal time periods.
**How to avoid:** Use daily PnL as the return period (not per-trade returns). Group trades by day, sum PnL per day, compute daily return as dayPnL / startingBalance. Then annualize by sqrt(252). This is the standard approach for day trading strategies. If fewer than 30 daily returns are available, flag the metric as LOW confidence.
**Warning signs:** Extremely high Sharpe (>5.0) from per-trade calculation; negative Sortino despite positive PnL.

### Pitfall 3: Backtest Look-Ahead Bias
**What goes wrong:** The backtester uses information that would not have been available at the time of the trade decision.
**Why it happens:** Trade objects contain exit information (exitPrice, exitReason, pnl). The backtest evaluates whether a trade would have been *entered* -- it must only look at entry-time data.
**How to avoid:** The `evaluateHistoricalEntry()` function should only access fields with "AtEntry" suffix or fields that existed at entry time (rsi, vwapSlope, modelUp, edge). Never use exitPrice, exitReason, or pnl to decide entry.
**Warning signs:** Suspiciously perfect backtest results; "oracle" parameter sets that look too good.

### Pitfall 4: Grid Search Combinatorial Explosion
**What goes wrong:** Too many parameters with fine step sizes creates millions of combinations, freezing the server.
**Why it happens:** 5 parameters x 10 values each = 100,000 combinations. Each combo iterates over all trades.
**How to avoid:** Bound the grid: max 5 parameters, max 6-8 values per parameter. Warn in the UI if total combos exceed 10,000. The API endpoint should have a timeout and return partial results if needed. With ~500 trades and ~1,000 combos, runtime should be <1 second.
**Warning signs:** API timeout on `/api/optimizer`; server unresponsive during grid search.

### Pitfall 5: Config Apply Affecting Live Trading
**What goes wrong:** User applies optimizer results while live trading is active, causing unintended parameter changes in real money trading.
**Why it happens:** The config object is shared between paper and live modes.
**How to avoid:** The `/api/config` endpoint should only apply to the *current mode's config*. If live mode is active, either refuse the apply or clearly warn. Store the previous config for revert.
**Warning signs:** Live trading behavior changes unexpectedly after optimizer use.

### Pitfall 6: JSON Ledger Size Growth
**What goes wrong:** Enriched trades are significantly larger (~2-3x more fields per trade). With hundreds of trades, the JSON file grows.
**Why it happens:** Each trade now stores 20+ additional fields including the entryGateSnapshot (25 blockers with margins).
**How to avoid:** The entryGateSnapshot should store a compact representation (not full blocker strings). E.g., `{ clearedCount: 23, failedCount: 2, margins: { prob: 0.02, edge: 0.01 } }` rather than repeating all 25 blocker texts. The ledger already handles 500+ trades fine; enriched trades at ~1KB each means ~500KB for 500 trades, well within limits.
**Warning signs:** Slow ledger reads; large file size warnings.

### Pitfall 7: Dashboard Tab State vs Polling
**What goes wrong:** The existing 1.5s polling loop fetches `/api/status` and `/api/trades` every cycle. If analytics tab is active, these fetches are wasted. If analytics data is fetched every cycle, it adds unnecessary load.
**Why it happens:** The single polling loop does not know which tab is active.
**How to avoid:** Only fetch analytics data when the analytics tab is active. Only fetch optimizer results on-demand (not polling). The main dashboard tab continues its existing polling. Tab switch triggers an immediate data fetch for the new tab.
**Warning signs:** Increased API load; slow page when all tabs are fetching.

## Code Examples

### Existing Trade Object Schema (from trades.json)
```javascript
// Source: paper_trading/trades.json -- current trade shape
{
  "id": "17718349538668x7uxj",
  "timestamp": "2026-02-23T08:22:33.867Z",
  "marketSlug": "btc-updown-5m-1771834800",
  "side": "UP",
  "instrument": "POLY",
  "entryPrice": 0.2285,
  "shares": 350.08,
  "contractSize": 80,
  "status": "CLOSED",
  "entryTime": "2026-02-23T08:22:33.867Z",
  "exitPrice": 0.1828,
  "exitTime": "2026-02-23T08:23:16.229Z",
  "pnl": -16,
  "entryPhase": "MID",
  "entryReason": "Rec",
  "maxUnrealizedPnl": 0,
  "minUnrealizedPnl": 0,
  "tokenID": "470949...",
  "modelUp": 0.7035,
  "modelDown": 0.2964,
  "edge": 0.5015,
  "rsi": 68.91,
  "vwapSlope": 1.629,
  "exitReason": "Max Loss ($16.00)"
}
```

### Enriched Trade Object Schema (new fields)
```javascript
// New fields added to trade objects (in addition to all existing fields)
{
  // MACD snapshot at entry
  "macdValueAtEntry": -0.5,
  "macdHistAtEntry": 0.3,
  "macdSignalAtEntry": -0.8,
  // Market quality at entry
  "spreadAtEntry": 0.005,
  "liquidityAtEntry": 25000,
  "volumeNumAtEntry": 150000,
  // BTC spot
  "btcSpotAtEntry": 96500.25,
  "btcSpotAtExit": 96480.10,
  "spotImpulsePctAtEntry": 0.0005,
  // Additional indicators at entry
  "timeLeftMinAtEntry": 3.5,
  "modelProbAtEntry": 0.7035,
  "edgeAtEntry": 0.5015,
  "rsiAtEntry": 68.91,   // (aliases existing 'rsi' for clarity)
  "vwapDistAtEntry": 0.001,
  "heikenColorAtEntry": "green",
  "heikenCountAtEntry": 3,
  "rangePct20AtEntry": 0.0025,
  "recActionAtEntry": "ENTER",
  "sideInferred": false,
  // Entry gate evaluation
  "entryGateSnapshot": {
    "totalChecks": 25,
    "passedCount": 25,
    "failedCount": 0,
    "margins": {
      "prob": 0.17,       // how much above threshold
      "edge": 0.47,       // how much above threshold
      "rsi": 23.91,       // distance from no-trade band
      "spread": 0.007,    // how much below max spread
      "liquidity": 24500, // how much above min liquidity
      "impulse": 0.0002   // how much above min impulse
    }
  },
  // Exit context (added at close time)
  "rsiAtExit": 55.2,
  "macdHistAtExit": -0.1,
  "vwapSlopeAtExit": -0.5,
  "modelUpAtExit": 0.45,
  "modelDownAtExit": 0.55
}
```

### Max Drawdown Computation
```javascript
// Source: analyticsService.js (to be added)
function computeMaxDrawdown(closedTrades, startingBalance) {
  let equity = startingBalance;
  let peak = startingBalance;
  let maxDD = 0;
  let maxDDPct = 0;

  for (const trade of closedTrades) {
    equity += (typeof trade.pnl === 'number' ? trade.pnl : 0);
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDD) maxDD = dd;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }

  return { maxDrawdownUsd: maxDD, maxDrawdownPct: maxDDPct };
}
```

### Daily Returns for Sharpe/Sortino
```javascript
// Source: analyticsService.js (to be added)
function computeDailyReturns(closedTrades, startingBalance) {
  // Group PnL by day (Pacific time)
  const dailyPnl = new Map();
  for (const t of closedTrades) {
    const dk = dayKeyFromTrade(t);
    if (dk === 'unknown') continue;
    dailyPnl.set(dk, (dailyPnl.get(dk) || 0) + (t.pnl || 0));
  }

  // Convert to daily returns (PnL / starting balance)
  return Array.from(dailyPnl.values()).map(pnl => pnl / startingBalance);
}
```

### Suggested Parameter Ranges for Grid Search
```javascript
// Recommended default ranges (Claude's discretion)
const DEFAULT_PARAM_RANGES = {
  minProbMid: { min: 0.50, max: 0.58, step: 0.01 },    // 9 values
  edgeMid: { min: 0.01, max: 0.06, step: 0.01 },        // 6 values
  noTradeRsiMin: { min: 25, max: 40, step: 5 },          // 4 values
  noTradeRsiMax: { min: 40, max: 55, step: 5 },          // 4 values
  maxEntryPolyPrice: { min: 0.004, max: 0.008, step: 0.001 }, // 5 values
};
// Total: 9 * 6 * 4 * 4 * 5 = 4,320 combinations
// At ~500 trades per combo, ~2M evaluations = <2 seconds
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-trade Sharpe ratio | Daily-returns Sharpe ratio | Standard practice for HFT | Avoids inflated ratios from autocorrelated trade returns |
| Fixed threshold backtesting | Grid search with min-sample filter | Standard in quant | Prevents overfitting to small samples |
| Storing all raw blocker strings | Compact margin-based gate snapshot | This phase | Reduces ledger size while preserving analytical value |

**Deprecated/outdated:**
- None -- this is greenfield analytics code built on a stable codebase.

## Open Questions

1. **BTC spot price at exit timing**
   - What we know: Entry spot price can be captured from `signals.spot.price` in `processSignals()`. Exit spot price needs to be captured when `closePosition()` is called.
   - What's unclear: The `closePosition()` request object does not currently carry signals. The signals are available in `TradingEngine.processSignals()` at the time of exit evaluation.
   - Recommendation: Capture exit indicators in TradingEngine when `evaluateExits()` triggers a close, and pass them as additional metadata to `closePosition()`. This keeps the executor interface clean.

2. **Chart.js date adapter requirement**
   - What we know: Chart.js time scale requires a date adapter. The existing equity curve uses simple index-based labels.
   - What's unclear: Whether period bar charts need time scale or can use category scale.
   - Recommendation: Use category scale with formatted date strings (e.g., "2026-02-23", "2026-W08"). This avoids the date adapter dependency entirely. Already confirmed that category scale works for bar charts.

3. **Analytics data freshness during polling**
   - What we know: Analytics are computed from ledger data on each API call. The ledger is updated on every trade close.
   - What's unclear: Whether analytics computation is expensive enough to need caching.
   - Recommendation: Start without caching. `computeAnalytics()` already runs on every `/api/analytics` call. With <1000 trades, the computation is trivial (<10ms). Add caching later if profiling shows a need.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/paper_trading/ledger.js`, `src/domain/entryGate.js`, `src/infrastructure/executors/PaperExecutor.js`, `src/application/TradingEngine.js`, `src/services/analyticsService.js`, `src/ui/script.js`, `src/ui/index.html`, `src/config.js`, `paper_trading/trades.json`
- Chart.js documentation: [Time Cartesian Axis](https://www.chartjs.org/docs/latest/axes/cartesian/time.html), [Bar Chart](https://www.chartjs.org/docs/latest/charts/bar.html), [Stacked Bar with Groups](https://www.chartjs.org/docs/latest/samples/bar/stacked-groups.html)

### Secondary (MEDIUM confidence)
- Sharpe/Sortino calculation methodology: [DayTradingBias - Sharpe Ratio for Day Trading](https://www.daytradingbias.com/how-to-calculate-sharpe-ratio-and-sortino-ratio-correctly-on-day-trading-strategies/) -- recommends using initial capital as baseline for day trading
- Trading performance metrics: [Luxalgo - Top 7 Backtesting Metrics](https://www.luxalgo.com/blog/top-7-metrics-for-backtesting-results/), [uTrade - Essential Backtesting Metrics](https://www.utradealgos.com/blog/what-are-the-key-metrics-to-track-in-algo-trading-backtesting)
- Grid search best practices: [NumberAnalytics - Grid Search Techniques](https://www.numberanalytics.com/blog/grid-search-techniques-ml)

### Tertiary (LOW confidence)
- None -- all findings verified through codebase analysis and authoritative sources.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies; all patterns verified against existing codebase
- Architecture: HIGH -- follows established clean architecture layers; pure functions for domain logic
- Trade enrichment: HIGH -- exact fields and code locations identified from source analysis
- Financial metrics (Sharpe/Sortino): MEDIUM -- formulas are standard but annualization for 5-min HFT trades requires care; daily-return approach is the standard recommendation
- Grid search: HIGH -- straightforward cartesian product over bounded ranges; performance validated by estimation
- Dashboard layout: MEDIUM -- tab recommendation is Claude's discretion; alternatives (accordion, new page) are also viable

**Research date:** 2026-02-23
**Valid until:** 2026-03-23 (stable domain; no external API dependencies)
