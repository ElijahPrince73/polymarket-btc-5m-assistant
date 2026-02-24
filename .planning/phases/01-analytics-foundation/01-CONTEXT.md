# Phase 1: Analytics Foundation - Context

**Gathered:** 2026-02-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the trade analysis and backtesting framework so users can understand historical performance and replay trades with modified parameters. This phase enriches the existing paper trading ledger with full indicator snapshots, adds period-based analytics to the dashboard, creates a backtest harness for replaying trades, and provides a threshold optimizer for parameter tuning.

Requirements covered: ANLYT-01, ANLYT-02, ANLYT-03, ANLYT-04, PROF-01, PROF-02.

What this phase does NOT include: win rate segmentation by entry phase/time of day (Phase 2 — PROF-03), entry filter suggestions from blocker diagnostics (Phase 2 — PROF-04), live trading changes, infrastructure changes.

</domain>

<decisions>
## Implementation Decisions

### Trade Journal Enrichment
- Full indicator snapshot at entry and exit: MACD (value, histogram, signal line), RSI (already stored), VWAP slope (already stored), spread, liquidity depth, spot impulse %
- BTC spot price captured at both entry and exit — enables slippage analysis (spot vs contract price) and correlation with price movements
- Entry gate evaluation stored per trade — full list of which blockers were clear and by how much margin at the moment of entry. Enables near-miss analysis for threshold tuning
- Historical trades (pre-enrichment) backfilled with null for new fields. Analytics code must gracefully handle null/missing indicator data. New trades going forward get full snapshots

### Optimizer Output & Decisions
- Grid search for parameter space exploration — test all combinations within defined ranges. Deterministic, exhaustive, easy to interpret. With 5-min trade cycles and bounded param ranges, performance should be acceptable
- Results displayed as sortable dashboard table with best combo highlighted. Columns: parameters tested, trade count, win rate, profit factor, max drawdown. User can sort by any column
- One-click apply button — updates running config with selected parameter set. Changes take effect on next engine tick. Revert available if performance drops
- Minimum 30 historical trades required per parameter combination before optimizer produces recommendations. Prevents overfitting to small samples

### Claude's Discretion
- Analytics dashboard layout — whether analytics appear in the existing right column, a new tab/page, or an expanded layout. Claude should choose based on information density and existing dashboard patterns
- Backtester interaction model — whether backtest is triggered from a dashboard UI form, CLI command, or API endpoint. Claude should pick the approach that integrates best with the existing Express + vanilla JS architecture
- Visualization choices — chart types, color schemes, and grouping UX for the analytics views
- Exact parameter ranges and step sizes for the grid search optimizer

</decisions>

<specifics>
## Specific Ideas

- The existing paper ledger already stores: RSI, VWAP slope, modelUp, modelDown, edge, entryPhase, entryReason, exitReason, MFE/MAE — these should be preserved and the new fields added alongside them
- The ledger is JSON-based (`paper_trading/trades.json`) — enriched fields add to per-trade objects without schema migration
- Entry gate has 25 blockers — the gate evaluation snapshot should capture all 25 with pass/fail + margin values
- Blocker frequency diagnostics (recently added to TradingState) already normalize blocker keys — the optimizer can reuse this normalization pattern

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-analytics-foundation*
*Context gathered: 2026-02-23*
