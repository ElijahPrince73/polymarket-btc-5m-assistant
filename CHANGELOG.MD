# Changelog

All notable changes to Polymarket BTC 5m Assistant are documented in this file.

## [1.0.7] - 2026-02-26

### Changed (data-driven tuning from 234-trade analysis)

- **Raised min entry price floor**: minPolyPrice 0.35→0.40. Entries <40¢ had 29% WR and -$107 PnL across 38 trades all-time.
- **Tightened max loss**: dynamicStopLossPct 0.12→0.10. Avg max loss was $9.82 across 63 trades. Saves ~$1-2 per loss.
- **Added RSI directional bias**: When RSI < 40, only DOWN entries allowed. When RSI > 60, only UP entries allowed. Aligns trade direction with momentum — RSI<40 UP entries were the worst performers.
- **Widened trailing TP drawdown**: $2.00→$2.50. Trailing TP had 16 losses from tight tolerance. Wider room lets more recover. Big winners ($25-$47) prove the engine can capture large moves.
- **Lowered EARLY edge requirement**: edgeEarly 0.02→0.015. 84% of trades are EARLY phase with PF near 1.0. Slightly looser lets more volume through.

### Analysis Notes (234 trades, 2026-02-26)
- v1.0.5 (146 trades): 46% WR, PF 0.97, -$19.60 (near breakeven)
- Trailing TP: 81% WR (67W/16L), +$599 net — the profit engine
- Max Loss: 0% WR (0W/63L), -$618 net — the sole loss source
- RSI >60 entries: 51% WR (best). RSI <40: 39% WR (worst)
- Entry price >55¢: 55% WR. Entry <40¢: 31% WR
- UP trades profitable post-v1.0.5 (53% WR). DOWN trades bled (42% WR)

## [1.0.6] - 2026-02-26

### Added
- **Auto-start trading on boot**: Trading now auto-enables on startup (default: `AUTO_START_TRADING=true`). No more manual "Start Trading" click after every DigitalOcean deploy. Set `AUTO_START_TRADING=false` to disable.

## [1.0.5] - 2026-02-26

### Changed (data-driven tuning from 84-trade analysis)

- **Raised probability thresholds**: minProbEarly 0.52→0.57, minProbMid 0.53→0.58, minProbLate 0.55→0.60. Higher conviction entries had 63% WR (>60¢ entries) vs 27% WR (<40¢ entries). This filters out low-confidence setups that were going straight to max loss.
- **Raised minimum entry price floor**: minPolyPrice 0.05→0.35. Entries below 40¢ had 27% WR and -$72.60 PnL across 22 trades — cheap long-shot contracts that rarely paid off.
- **Widened trailing TP drawdown**: trailingDrawdownUsd $1.50→$2.00. Trailing TP had 16 losses averaging -$2.47 from tight drawdown tolerance. Slightly more room should let more trades recover. Big winners ($47, $32, $25) show the trailing TP engine works well when given space.

### Analysis Notes (84 trades, 2026-02-25)
- Overall: 37% WR, -$116.83 PnL, 0.72 profit factor
- DOWN trades profitable: 45% WR, +$29.62 PnL (31 trades)
- UP trades bleeding: 32% WR, -$155.92 PnL (53 trades)
- Trailing TP net: +$243.50 (working well). Max Loss net: -$368.26 (the problem)
- EARLY phase: 40% WR but -$76.65 PnL (67 trades) — volume is there but quality needs filtering

## [1.0.4] - 2026-02-25

### Fixed

- **MFE/MAE not persisting to trade records**: Trailing take-profit tracked MFE/MAE in TradingState but never wrote values back to the executor openTrade before closing. Trade journal entries were missing maxUnrealizedPnl/minUnrealizedPnl data. Now writes tracked MFE/MAE to executor trade record immediately before closePosition call.

### Changed

- **Trailing take-profit defaults tightened**: trailingStartUsd $20 -> $3 (activate trailing after +$3 instead of +$20), trailingDrawdownUsd $10 -> $1.50 (exit if drops $1.50 from peak instead of $10). Captures small wins on 5m contracts instead of waiting for rare large moves.
- **Dynamic stop loss defaults tightened**: dynamicStopLossPct 0.20 -> 0.12 (max loss ~$9.60 per $80 trade instead of ~$16), maxMaxLossUsd $40 -> $20 (absolute ceiling halved). Reduces single-trade damage to protect bankroll.

### Added

- **RSI overbought/oversold directional entry blocker**: Blocks UP entries when RSI > 78 (overbought, likely to reverse down) and DOWN entries when RSI < 22 (oversold, likely to reverse up). Configurable via noTradeRsiOverbought/noTradeRsiOversold in config.
- **Stale candle data entry blocker**: Blocks entries when the most recent 1m candle is older than 2 minutes. Prevents trading on stale/delayed price data that could lead to adverse fills.

## [1.0.3] - 2026-02-24

### Changed

- **Live gate status table replaces static "ELIGIBLE" message**: The entry status now shows a real-time threshold comparison table with 13 checks (Rec, Prob, Edge, RSI, Impulse, Range20, Conviction, Spread, Liquidity, Entry Px, Opp Px, Time, Candles). Each row displays current value, PASS/FAIL indicator, and required threshold. Summary header shows pass/fail count. Weekend-tightened effective thresholds applied automatically when active.
- **New live signal values exposed to UI**: Added `rsiNow`, `rangePct20`, `spreadUp`, `spreadDown`, `liquidityNum`, `recAction`, `recSide`, `recPhase`, `recEdge` to `__uiStatus` in `index.js` so the dashboard can compare live values against thresholds.
- **Missing thresholds added to status API**: `entryThresholds` now includes `minOppositePolyPrice`, `minPolyPrice`, `maxPolyPrice`, `weekendMinRangePct20`, and `minCandlesForEntry`.

### Removed

- **Static threshold config rows**: Replaced the old Prob E/M/L, Edge E/M/L, Spread/Liq, Conviction, and Filters rows with the live gate status table that shows both config and current values side-by-side.

## [1.0.2] - 2026-02-24

### Fixed

- **Polymarket prices divided by 100 (critical)**: CLOB `/price` and Gamma API both return decimal prices (0–1 range, e.g. 0.56 = 56¢), but `polyPrices` in `index.js` divided by 100 again producing 0.0056. This cascaded through `entryGate.js` (effectivePolyPrices), `TradingEngine.js` (entry price resolution), and `PaperExecutor.js` (mark-to-market) — causing incorrect unrealized PnL, wrong "Current" price display (0.5600¢ instead of 56.00¢), and entry prices submitted at 1/100th of market value. Removed all erroneous `/100` divisions and `*100` conversions on price values (display-only `*100` for ¢ formatting preserved).
- **Config thresholds calibrated to buggy scale**: `maxEntryPolyPrice` default was `0.0055` (matching the old 0.005 price bug), blocking every single trade since correct prices (0.56) far exceed 0.0055. Updated all price-related thresholds to proper decimal scale: `maxEntryPolyPrice` 0.0055→0.65, `minPolyPrice` 0.002→0.05, `maxPolyPrice` 0.98→0.95, `minOppositePolyPrice` 0.002→0.10. Also fixed stale fallbacks in `statusService.js` and `ui/server.js`, and optimizer search ranges in `optimizer.js` and `analytics.js`.
- **Dashboard data flashing/disappearing**: With 2 DO instances behind a load balancer, polls alternating between instances caused the trades table, equity curve, and PnL to flash. Root cause: (1) instance locking returned early from the entire fetch function, preventing trades from being fetched; (2) catch blocks on fetch errors cleared the UI with error messages, replacing cached data. Fixed by skipping the entire poll cycle on foreign instance detection (preserving all cached data) and only showing error messages on first load when no cache exists.
- **Paper trading ledger not persisting on DigitalOcean**: The JSON ledger wrote to `./paper_trading/trades.json` on the ephemeral filesystem, wiped on every redeploy. Now uses `$DATA_DIR/paper_ledger.json` when `DATA_DIR` is set (persistent volume), falling back to the local path for development.

### Changed

- **Optimizer grid search ranges**: Updated `maxEntryPolyPrice` search range from 0.004–0.008 to 0.45–0.70 to match corrected decimal price scale.
- **Test signals**: Updated `paperE2E.test.js` to use realistic decimal prices (0.56/0.44 instead of 0.004/0.996), added missing `vwapNow` indicator, and fixed analytics assertion field names (`closedTrades`/`totalPnL`).

## [1.0.1] - 2026-02-24

### Fixed

- **SQLite fallback banner false positive**: `initTradeStore()` in `server.js` used a hand-rolled `require()` shim that was circularly dependent on `globalThis.__tradeStore_getTradeStore` — which it was itself supposed to set. First call always threw `"TradeStore not initialized"`, setting `_tradeStoreAvailable = false` regardless of whether `better-sqlite3` was installed. Fixed by replacing the shim with a real `await import()` and making `initTradeStore()` async.
- **Trades table / Equity Curve / PnL today / Analytics not updating after trades**: `PaperExecutor` wrote trades to the JSON ledger but never called `syncTradeToStore()`. Since `/api/trades` and `/api/analytics` prefer SQLite when available, they served a frozen snapshot from the initial migration. Fixed by calling `globalThis.__syncTradeToStore?.(trade, 'paper')` after both `addTrade()` (on entry) and `updateTrade()` (on exit) in `PaperExecutor.js`.
- **"Position open: N" in Why no entry?**: `TradingEngine` was emitting `` `Position open: ${positions.length}` `` as a blocker string (where `N` was the raw array length). Changed to `"Trade already open"` for consistency with `entryGate.js` check #9.
- **"Trade already open" blocker showing in Why no entry? while position is open**: When `openTrade` is present the open trade panel already shows full position details, so the redundant blocker in the entry reason field is now filtered out and replaced with `"Monitoring open position"`.

### Added

- **Entry thresholds visible in dashboard**: Status table now shows 7 new rows: Schedule (Pacific day/hour + weekday/weekend detection), Prob E/M/L, Edge E/M/L, Spread/Liq, Conviction, Filters, and Guardrails — all reflecting live config values. Weekend tightening rows display effective tightened thresholds in amber when active.
- **Weekend/weekday detection exposed to UI**: `assembleStatus()` now calls `getPacificTimeInfo()` and includes `isWeekend`, `pacificDay`, `pacificHour`, and `weekendTighteningActive` in the `entryThresholds` payload so the dashboard can confirm the bot's schedule context at a glance.

## [1.0.0] - 2026-02-23

First production-ready release. Combines four development phases into a unified, deployable trading system.

### Phase 1: Analytics Foundation

- **Trade Journal Enrichment**: Every trade now records 20+ indicator values at entry and exit (RSI, MACD, VWAP slope, spot price, spread, liquidity, entry gate snapshot)
- **Period Analytics**: Performance grouped by day, week, and trading session with win rate, profit factor, PnL, and trade count
- **Advanced Metrics**: Sharpe ratio, Sortino ratio, max drawdown (USD + percentage), confidence classification
- **Backtest Harness**: Pure-function backtester replays historical paper trades with modified thresholds; no network I/O
- **Grid Search Optimizer**: Tests parameter combinations (up to 10,000) and ranks by profit factor; safety valve prevents overfitting with 30-trade minimum per combination
- **Three-Tab Dashboard**: Dashboard (live status + trades), Analytics (period performance + drawdown chart), Optimizer (parameter tuning + apply/revert)

### Phase 2: Profitability Optimization

- **Segmented Performance Views**: Win rate and profit factor broken down by entry phase, trading session, and market regime (Oversold/Ranging/Overbought)
- **Suggestion Engine**: Analyzes blocker frequency data, maps blockers to threshold parameters, validates suggestions via backtest, and presents ranked suggestions with projected impact
- **Suggestion Cards UI**: Interactive cards with confidence indicators, current vs. suggested values, projected metrics, and one-click apply
- **Post-Apply Tracking**: Monitors actual performance after applying suggestions and flags underperforming changes

### Phase 3: Live Trading Hardening

- **Order Lifecycle State Machine**: Tracks every order through SUBMITTED -> PENDING -> FILLED -> MONITORING -> EXITED (or CANCELLED/TIMED_OUT/FAILED)
- **Retry Policy**: Classifies CLOB errors (NETWORK, RATE_LIMIT, SERVER, VALIDATION, UNKNOWN), retries with exponential backoff (1s -> 2s -> 4s), circuit breaker after 3 consecutive failures
- **Fee-Aware Sizing**: Subtracts estimated Polymarket fees from trade size so actual position matches intended risk exposure
- **Kill-Switch**: Absolute dollar daily loss limit with midnight PT reset, manual override with 10% additional buffer, re-trigger capability
- **Position Reconciliation**: Every-tick comparison of local position state vs. CLOB API; logs discrepancies without auto-correcting
- **Dashboard Integration**: Order lifecycle badges, kill-switch progress bar with override button, sync indicator dot

### Phase 4: Infrastructure & Monitoring

- **SQLite Persistence**: Trade history stored in structured SQLite database (better-sqlite3) with full schema for SQL-based analytics; automatic migration from JSON ledger; JSON remains as compatibility fallback
- **Webhook Alerting**: Slack and Discord adapters for critical event alerts (kill-switch, circuit breaker, order failure, crash recovery); fire-and-forget delivery with 60s deduplication per event type
- **Crash Recovery**: PID lock file for crash detection, JSON state file for critical state persistence (kill-switch, daily PnL, circuit breaker), automatic restoration on startup
- **Zero-Downtime Deployment**: File-based trading lock with heartbeat for instance coordination; graceful shutdown (SIGTERM handler drains open positions up to 5 minutes); enhanced /health endpoint for load balancer probes

### Phase 5: Integration & Polish

- **Integration Tests**: End-to-end test suite covering paper trading flow, live mock flow (with stubbed CLOB), and crash recovery flow
- **Dashboard Status Bar**: Compact 6-indicator status bar (Mode, Trading, Kill-switch, SQLite, Webhooks, Uptime) with graceful degradation for unconfigured features
- **SQLite Fallback Banner**: Dashboard shows subtle info banner when SQLite is unavailable, nudging user to install better-sqlite3
- **Production Pre-flight Script**: `npm run preflight` validates environment (tests, env vars, SQLite access, config sanity)
- **Startup Env Validation**: Required and optional env var validation on boot with clear log messages
- **NODE_ENV Production Defaults**: Stricter behavior in production (no debug logging, kill-switch required)
- **Documentation**: Full documentation suite (README rewrite, DEPLOYMENT.md operational runbook, CHANGELOG.md, CLAUDE.md update)

## [0.1.0] - Pre-release

Initial trading bot with paper trading, BTC price feeds, technical indicators, and basic web dashboard.

---
*Maintained by @krajekis*
