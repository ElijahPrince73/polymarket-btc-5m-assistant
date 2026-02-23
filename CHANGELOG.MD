# Polymarket BTC 5m Assistant

## CHANGELOG

### 2026-02-23

#### Fix: Instance Locking with Seeking Mode — Prevent Multi-Instance Oscillation
- **Root cause:** On production (DigitalOcean), multiple server instances run behind a load balancer. POSTs (e.g., `/api/trading/start`) go to one instance, but status polls may lock to another, causing inconsistent responses and stale data (e.g., "Trading disabled" stuck forever).
- **Fix:** Frontend locks to the first server `_instanceId` it sees. After any user action POST (Start/Stop/Mode), it enters **seeking mode** — unlocks and polls until it finds an instance whose `tradingEnabled` AND `mode` both match the local UI state, then re-locks to that instance. If the locked instance dies (5 consecutive foreign responses), the fallback also enters seeking mode instead of blindly switching — so a LIVE instance can never replace a PAPER lock. First-poll locking also validates mode+trading after initial sync.
- **Benefit:** All three lock paths (seeking, first-poll, fallback) now validate mode+trading. Eliminates oscillation, "waiting for server sync…" stuck state, and cross-mode data leaks (e.g., LIVE "Position open: 95" showing in PAPER mode).
- **Implementation:** `_resetInstanceLock()` called after Start/Stop/Mode POSTs. Seeking mode checks both `tradingEnabled` and `mode` match before locking. Fallback switch enters seeking mode (not blind lock). First-poll validates after `_initialSyncDone`.

#### Fix: Definitive Oscillation Fix — First-Poll-Only Sync
- **Root cause:** The polling loop overwrote mode and tradingEnabled from the server every 1.5s. If the server returned inconsistent values (multiple instances, restarts, fallback values), the UI oscillated. Previous guard-based and stabilization-based approaches were insufficient.
- **Fix:** Mode and tradingEnabled are now synced from the server **only once on page load** (first poll). After that, these values are exclusively controlled by user actions (Start/Stop buttons, mode dropdown). The polling loop never touches them again. This eliminates oscillation regardless of server-side inconsistencies.
- **Removed:** `_tradingToggleInFlight`, `_modeSwitchInFlight`, `_stableMode`, `_stableTrading` guards — no longer needed since polling never overwrites these fields.
- **Kept:** `_fetchInProgress` guard (prevents overlapping polls), server diagnostics (`_instanceId`, `_uptimeS`), cache-busting headers.

### 2026-02-22

#### Dashboard Redesign
- **Full UI redesign** from analytics-heavy layout to clean two-column fintech monitoring dashboard.
- **Left column** (~60%): Status card (key/value table), Open Trade card, Trades table with filters.
- **Right column** (~40%): KPI tiles (2×2 grid: Balance, PnL Today, PnL Yesterday, Win Rate), Ledger Summary, Equity Curve chart.
- **Removed:** All 17 analytics mini-tables, analytics overview section, 3 analytics charts (PnL by Exit Reason, Entry Price Bucket, PnL Distribution), and all related JS rendering code (`renderGroupTable()`, `updateBarChart()`, `updatePnlHistogram()`).
- **Visual refresh:** Shadow-based card depth, 28px KPI values, neutral dark background, 16px spacing. Green/red reserved for PnL values only.
- **Responsive:** Below 900px columns stack vertically with KPIs on top.
- **No backend changes.** The `/api/analytics` endpoint remains available for programmatic/AI access.

#### CLOB Circuit Breaker + Fetch Timeouts
- **New: Module-level circuit breaker in `polymarket.js`** — after 3 consecutive CLOB failures, halts all CLOB requests for an exponentially increasing backoff period (5s → 10s → 20s → … → 60s cap). Resets on first success.
- `fetchClobPrice()` returns `null` when circuit is open (callers already handle null gracefully).
- `fetchOrderBook()` returns empty book `{ bids: [], asks: [] }` when circuit is open.
- All CLOB fetches (`fetchClobPrice`, `fetchOrderBook`, `fetchOrderBookQuiet`) now use a 5s `AbortController` timeout to prevent stuck TLS connections from hanging the event loop.
- Exported `isClobCircuitOpen()` for use by other modules.
- `fetchOrderBookQuiet()` in `positions.js` checks the circuit breaker and has its own 5s abort timeout.

#### LiveExecutor Memory Bounds + Circuit-Aware Polling
- `getOpenPositions()` skips `client.getTrades()` when the CLOB circuit is open, using cached trades instead.
- `_cachedTrades` capped at 500 entries (`.slice(-500)`) to prevent unbounded memory growth.
- `_lastExitAttemptMsByToken` Map auto-prunes entries older than 10 minutes when the map size exceeds 50.

#### Heap Safety Net
- Start script now includes `--max-old-space-size=1024` to cap Node.js heap at 1 GB (vs. the default ~4 GB), preventing OOM crashes on long-running sessions.

#### Bug Fix: Frontend Mode Oscillation
- Fixed the UI incorrectly switching between Live and Paper mode on its own.
- **Root cause**: the 1.5s polling loop unconditionally overwrote the mode dropdown every cycle; overlapping `fetchData()` calls (triggered when CLOB fetches hung past 1.5s) raced each other and produced conflicting updates.
- **Fix 1**: Added `_modeSwitchInFlight` guard — the poll skips dropdown updates while a user-initiated mode switch POST is pending.
- **Fix 2**: Mode dropdown is only updated when the server-reported mode actually differs from the current value.
- **Fix 3**: Added `_fetchInProgress` concurrency guard — overlapping poll cycles are skipped entirely, preventing racing UI updates.

#### Bug Fix: Trading Status (ACTIVE/STOPPED) Oscillation
- Fixed the trading status indicator oscillating between ACTIVE and STOPPED after clicking Start/Stop Trading.
- **Root cause**: same polling race as the mode oscillation — `updateTradingStatus()` was called unconditionally every 1.5s poll, overwriting user-initiated state changes while the POST was still in-flight.
- **Fix**: Added `_tradingToggleInFlight` guard — the poll skips trading status updates while a user-initiated start/stop POST is pending.

### 2026-02-20

#### Dynamic Stop Loss
- **New: Dynamic stop loss** that scales proportionally with trade size instead of a fixed dollar cap.
  - Formula: `maxLoss = contractSize * dynamicStopLossPct` (default 20%), clamped to `[$8, $40]`.
  - Example: $80 trade → $16 max loss (was fixed at $10-$15 regardless of size).
  - Config: `DYNAMIC_STOP_LOSS_ENABLED` (default: true), `DYNAMIC_STOP_LOSS_PCT`, `MIN_MAX_LOSS_USD`, `MAX_MAX_LOSS_USD`.
  - Instant rollback: set `DYNAMIC_STOP_LOSS_ENABLED=false` to revert to fixed `MAX_LOSS_USD_PER_TRADE`.
- Applies to exit evaluator, PnL cap, and PaperExecutor exit reason formatting.
- Added 13 unit tests for `computeMaxLossUsd()` and dynamic stop loss integration.

#### Analytics UI Fix
- Fixed missing analytics data: added all 17 analytics mini-tables and the overview div to `index.html`.
- Tables now populate: By Exit Reason, Entry Price, Phase, Side, RSI, Hold Time, MAE, MFE, Liquidity, Spread, Edge, VWAP Distance, Market Volume, Model Probability, Time Left, Rec Action, Side Source.

#### Clean Architecture Refactor (completed)
- Restructured entire codebase into Clean Architecture layers: domain, application, infrastructure, presentation.
- **Domain layer**: `entryGate.js` (24 blockers), `exitEvaluator.js` (8 exit conditions), `sizing.js` (dynamic position sizing).
- **Application layer**: `TradingEngine.js` (unified engine), `TradingState.js` (MFE/MAE tracking, circuit breaker), `ModeManager.js` (paper/live toggle), `ExecutorInterface.js`.
- **Infrastructure**: `PaperExecutor` and `LiveExecutor` implementing `OrderExecutor` interface with CLOB-simulated fills.
- **Services**: `statusService.js`, `analyticsService.js` (17 group summaries).
- **UI**: Trading controls (start/stop, mode switch), KPI tiles, chart grid, trade table with filters.

#### Polymarket API Upgrade (Phases 1-10)
- **Phase 1 — Fee Observability**: `FeeService` with TTL cache and fee impact computation.
- **Phase 2 — Proactive Approvals**: `ApprovalService` managing COLLATERAL and CONDITIONAL token allowances with cooldowns.
- **Phase 3 — Safety Rails**: Circuit breaker (consecutive loss tracking + cooldown), token-bucket rate limiter, admin kill-switch endpoint (`POST /api/trading/kill`), order validation, environment gating.
- **Phase 4 — Order Management**: `OrderManager` with tracking, cancel, reconcile, and prune. REST endpoints: `GET /api/orders`, `DELETE /api/orders/:id`.
- **Phase 5 — Fills & Portfolio**: `FillTracker` polling CLOB trades with dedup. `GET /api/portfolio` endpoint.
- **Phase 6 — Market Discovery**: Shared `pickTokenId()` in `tokenMapping.js`, `MarketCatalog` with background sync. `GET /api/markets` endpoint.
- **Phase 7 — CLOB WebSocket**: `clobWs.js` streaming orderbook with exponential backoff reconnect.
- **Phase 8 — Unified Service**: `polymarketService.js` composing all services with lifecycle management.
- **Phase 9 — Observability**: JSON structured `Logger`, alert service with deduplication, `GET /api/metrics` endpoint.
- **Phase 10 — Testing**: 74+ unit tests across 9 test files covering all new services.

#### Bug Fixes
- Fixed exit reason always showing "Max Loss" for all trades (including winners) in PaperExecutor.
- Fixed slow UI updates (reduced polling from 5s to 1.5s, backend loop from 2s to 1s).

### Recent Changes

- Integrated a trading status management system for both live and paper trading modes.
- Enhanced signal processing with detailed logging for better debugging and tracking of trading behavior.
- Removed redundant API calls for controlling trading states. Immediate feedback now provided in the UI.
- Consolidated trading logic to ensure robust handling of indicators for decision-making in trading actions.

### 2026-02-10

- Tuning preset: "More trades but still safe" (lower prob/edge thresholds, slightly lower conviction gate, reduced stakePct) while keeping market-quality + anti-chop filters.

### 2026-02-04

- Tests: added basic node:test coverage (VWAP fallback + Trader loose-gating entry) and enabled `npm test`.
- UI: added /api/analytics + an Analytics section (win rate, avg win/loss, profit factor, expectancy + grouped PnL).
- UI: improved Analytics layout (overview + 4 small tables).
- Tuning: raised MIN_POLY_PRICE default to 0.5¢ and made Stop Loss conditional on probability flip (reduces chop-outs).
- Tuning: tightened Probability Flip exits (higher min prob/margin + min hold time) and made MID/inferred entries slightly stricter.
- Tuning: disabled auto-flipping on Probability Flip by default (FLIP_ON_PROB_FLIP=false) to reduce churn.
- Tuning: disabled Probability Flip exits (still used for conditional stop-loss logic).
- Analytics: added more breakdowns (entry prob bucket, entry time-left bucket, side, rec action at entry, entry liquidity bucket, entry spread bucket) and started storing richer entry metadata on new trades.
- Tuning: raised default MIN_LIQUIDITY to 10,000 to avoid thin markets.
- Tuning: added Polymarket market volume filter (MIN_MARKET_VOLUME_NUM) + analytics bucket for it.

### 2026-02-04

- Ledger: reset paper trading ledger to defaults (recent trades cleared). A backup JSON is saved in paper_trading/.

### 2026-02-03

- UI: Status section switched to a 2-column key/value layout for readability.
- Paper trading: added stop loss (STOP_LOSS_PCT) and optional flip-on-probability-flip (FLIP_ON_PROB_FLIP).
- Paper trading: added bankroll-based position sizing (STARTING_BALANCE + STAKE_PCT, with MIN_TRADE_USD/MAX_TRADE_USD).
- Paper trading: close open trades on Polymarket market rollover (prevents stuck open trades when slug changes).
- Strategy tuning: avoid extreme Poly prices (MIN*POLY_PRICE/MAX_POLY_PRICE), tighten entry thresholds, and reduce flip churn (EXIT_FLIP*\* + cooldown).
- Safety: require indicators to be populated before allowing entries (prevents trading during 50/50 / undefined indicator warm states).
- Startup: backfill 1m candles from REST (Kraken) so indicators are ready immediately (Option B).
- Indicators: VWAP now falls back to an unweighted typical-price average when volume is unavailable (prevents perpetual "Indicators not ready" on Chainlink candles).
- Tuning: loosened entry thresholds slightly to increase trade frequency (while keeping quality filters).
- Tuning: lowered MIN_POLY_PRICE default to 0.2¢ to allow trades when markets are priced under 1¢.
- UI: added "Why no entry?" debug line showing the current entry blockers.
- Fix: entry debug now updates even when signals are missing (so UI never shows blank blockers).
- Fix: entry debug reports Rec=HOLD/NONE when strategy isn't signaling an entry.
- UI: status/trade fetch errors now display the actual error message (easier debugging).
- Fix: UI no longer crashes due to entryDbg variable initialization order.
- Trading: loosened rec gating (REC_GATING=loose default) so entries can occur when thresholds hit even if Rec!=ENTER.
- Trading: in loose mode, infer side from model probabilities when rec.side is missing.
- Fix: trader indicator readiness check now uses macd.hist (was incorrectly checking macdHist).
- Paper trading: bankroll-based position sizing (STARTING_BALANCE, STAKE_PCT, MIN_TRADE_USD, MAX_TRADE_USD).
- Switched BTC reference feed to Chainlink (WS + REST fallback) and removed reliance on Kraken WebSocket.
- Paper trading executes on Polymarket UP/DOWN contract prices (not BTC spot).
- Added safety guards: refuse invalid open trades (entryPrice<=0 / bad shares) and sanity-close corrupted open trades.
- Added dynamic exit on probability flip (configurable `EXIT_FLIP_MIN_PROB`, `EXIT_FLIP_MARGIN`).
- Added entry gating: require `MIN_CANDLES_FOR_ENTRY` candles before entering trades.
- UI improvements: Polymarket market link, recent trades table (newest first), and timestamps.
- Stability: main loop try/catch, safer MACD handling, REST throttling/caching.
