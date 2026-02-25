# Roadmap: Polymarket BTC 5m Assistant

**Created:** 2026-02-23
**Depth:** Quick (5 phases)
**Core Value:** Profitable automated BTC contract trading with configurable risk controls

## Phase Overview

| Phase | Name | Goal | Requirements | Est. Effort |
|-------|------|------|-------------|-------------|
| 1 | Analytics Foundation | Build trade analysis and backtesting framework | ANLYT-01..04, PROF-01..02 | Medium |
| 2 | Profitability Optimization | Tune entry/exit thresholds using analytics data | PROF-03..04 | Small |
| 3 | Live Trading Hardening | Production-ready CLOB execution and order lifecycle | LIVE-01..05 | Large |
| 4 | Infrastructure & Monitoring | Alerting, recovery, persistence, deployment hardening | INFRA-05..08 | Medium |
| 5 | Integration & Polish | End-to-end validation, docs, production deploy readiness | Cross-cutting | Small |
| 6 | Supabase Persistence | Replace SQLite with hosted PostgreSQL for deploy-proof trade history | DB-01..05, CFG-01..02 | Small |

---

## Phase 1: Analytics Foundation

**Goal:** Build the trade analysis and backtesting framework so users can understand historical performance and replay trades with modified parameters.

**Requirements:**
- ANLYT-01: Historical trade performance dashboard (per-day, per-week, per-session)
- ANLYT-02: Strategy parameter backtesting framework
- ANLYT-03: Trade journal capturing entry/exit context (indicators, market state, signals)
- ANLYT-04: Drawdown analysis and advanced equity curve metrics (Sharpe, Sortino)
- PROF-01: Backtest harness that replays historical trades with modified parameters
- PROF-02: Threshold optimizer testing parameter combinations and reporting expected win rate/PF

**Plans:** 3 plans

Plans:
- [x] 01-01-PLAN.md -- Trade journal enrichment + period analytics + advanced metrics
- [x] 01-02-PLAN.md -- Backtest harness (pure backtester + API endpoint)
- [x] 01-03-PLAN.md -- Grid search optimizer + dashboard UI (tabs, analytics views, optimizer interface)

**Success Criteria:**
1. User can view trade history grouped by day, week, and trading session in the dashboard
2. Each trade in the ledger includes full entry/exit context (indicators, signals, market state)
3. Backtest harness can replay paper trade history with modified thresholds and report results
4. Parameter optimizer can test combinations and output win rate / profit factor comparisons
5. Dashboard shows drawdown chart, max drawdown, Sharpe ratio, and Sortino ratio
6. All analytics data derived from existing paper ledger (no new data collection required)

**Key Risks:**
- Paper ledger may not have enough historical context per trade for meaningful backtesting
- Need to enrich trade recording before backtesting will be useful

**Dependencies:** None (builds on existing paper ledger and dashboard)

---

## Phase 2: Profitability Optimization

**Goal:** Use analytics data from Phase 1 to tune entry/exit thresholds and improve trade selection quality.

**Requirements:**
- PROF-03: Win rate and profit factor segmented by entry phase, time of day, and market conditions
- PROF-04: Entry filter adjustments suggested based on blocker diagnostics frequency data

**Plans:** 2 plans

Plans:
- [x] 02-01-PLAN.md -- Segmented performance views (profitFactor + byMarketRegime + 3-tab UI)
- [x] 02-02-PLAN.md -- Suggestion engine (blocker-to-threshold mapping + backtest validation + suggestion cards UI)

**Success Criteria:**
1. Dashboard shows win rate and profit factor broken down by entry phase, hour of day, and market regime
2. System analyzes blocker diagnostics data and suggests which thresholds to relax or tighten
3. Suggested adjustments include expected impact on win rate and trade frequency
4. User can apply suggested adjustments and compare before/after in backtest harness

**Key Risks:**
- Insufficient trade volume for statistically significant segmentation
- Blocker diagnostics may not have enough history for meaningful suggestions

**Dependencies:** Phase 1 (analytics framework, backtest harness, trade journal)

---

## Phase 3: Live Trading Hardening

**Goal:** Make the live CLOB execution path production-ready with full order lifecycle management, reconciliation, fee awareness, and graceful error recovery.

**Requirements:**
- LIVE-01: Full order lifecycle tracked from submission through fill to exit with status at each stage
- LIVE-02: Position reconciliation between CLOB state and local tracking with discrepancy flagging
- LIVE-03: Position sizing accounts for estimated fees before submitting orders
- LIVE-04: CLOB failures trigger automatic retry with exponential backoff and alert
- LIVE-05: Daily PnL kill-switch validated end-to-end (triggers correctly at threshold)

**Success Criteria:**
1. Every order has a tracked lifecycle: SUBMITTED -> PENDING -> FILLED -> MONITORING -> EXITED
2. System periodically reconciles local position state with CLOB API and logs discrepancies
3. Trade sizing subtracts estimated fees so actual position matches intended risk
4. CLOB submission failures retry with exponential backoff (1s -> 2s -> 4s -> ... -> 30s cap)
5. Failed CLOB operations trigger alerts (logged + available for Phase 4 webhook integration)
6. Daily PnL kill-switch activates correctly when loss threshold is hit in both paper and live modes
7. Kill-switch activation is logged and prevents further trades for the rest of the trading day

**Key Risks:**
- CLOB API rate limits may conflict with retry logic
- Fee estimation accuracy depends on current Polymarket fee structure
- Kill-switch testing requires simulating loss scenarios

**Plans:** 4 plans

Plans:
- [x] 03-01-PLAN.md -- Order lifecycle state machine + retry policy (TDD)
- [x] 03-02-PLAN.md -- Fee-aware sizing + kill-switch hardening (TDD)
- [x] 03-03-PLAN.md -- Position reconciliation + sync status
- [x] 03-04-PLAN.md -- Dashboard lifecycle UI + kill-switch controls + fee-aware sizing integration

**Dependencies:** None (builds on existing LiveExecutor, but can be developed independently)

---

## Phase 4: Infrastructure & Monitoring

**Goal:** Add operational reliability features -- alerting, crash recovery, structured persistence, and deployment hardening.

**Requirements:**
- INFRA-05: Webhook alerts (Slack/Discord) on critical events (crash, circuit breaker, kill-switch)
- INFRA-06: Auto-restart after crash with state recovery from persisted data
- INFRA-07: Trade history persisted in structured format (SQLite or append-only log) beyond JSON ledger
- INFRA-08: Zero-downtime deployment with instance coordination

**Plans:** 4 plans

Plans:
- [x] 04-01-SUMMARY.md -- SQLite persistence (tradeStore with full schema, migration, all reads migrated)
- [x] 04-02-SUMMARY.md -- Webhook alerting (Slack/Discord adapters, fire-and-forget, deduplication)
- [x] 04-03-SUMMARY.md -- Crash recovery (PID lock, state persistence, startup restoration)
- [x] 04-04-SUMMARY.md -- Zero-downtime deployment (trading lock, graceful drain, enhanced /health)

**Success Criteria:**
1. Critical events (crash, circuit breaker trip, kill-switch activation) send webhook to configured Slack/Discord URL
2. After process crash, system auto-restarts and recovers in-memory state from persisted data within 30s
3. No trades lost during crash recovery -- ledger and structured store are consistent
4. Trade history stored in SQLite (or structured append-only log) with queryable schema
5. JSON paper ledger remains as compatibility layer, synced with structured store
6. Deployment supports rolling updates -- new instance starts before old stops
7. Instance coordination prevents duplicate trade execution during rolling deploy

**Key Risks:**
- SQLite migration requires careful data migration from existing JSON ledger
- Multi-instance coordination during deploys is complex with DigitalOcean App Platform
- Webhook reliability (external dependency)

**Dependencies:** Phase 3 (order lifecycle states needed for proper crash recovery)

---

## Phase 5: Integration & Polish

**Goal:** End-to-end validation across all phases, documentation, and production deployment readiness.

**Requirements:** Cross-cutting (validates all prior phases work together)

**Plans:** 4 plans

Plans:
- [x] 05-01-PLAN.md -- Integration tests (24 E2E tests: paper trading, live mock, crash recovery)
- [x] 05-02-PLAN.md -- Documentation suite (README rewrite, CHANGELOG, DEPLOYMENT.md, CLAUDE.md updates)
- [x] 05-03-PLAN.md -- Dashboard polish (status bar, SQLite fallback banner, mobile responsive)
- [x] 05-04-PLAN.md -- Production readiness (preflight script, env validation, NODE_ENV defaults)

**Success Criteria:**
1. Full paper trading cycle works: signals -> entry gate -> trade -> journal -> analytics -> backtest
2. Full live trading cycle works: signals -> entry gate -> CLOB order -> lifecycle -> reconcile -> exit
3. Crash recovery preserves all state and resumes trading within 30s
4. Dashboard displays all analytics, diagnostics, and monitoring data correctly
5. Webhook alerts fire correctly for all critical event types
6. Documentation updated: CLAUDE.md, README, deployment guide
7. All tests pass (`npm test`)

**Key Risks:**
- Integration issues between independently developed phases
- Edge cases in crash recovery + live trading interaction

**Dependencies:** Phases 1-4

---

---

## Phase 6: Supabase Persistence

**Goal:** Replace ephemeral SQLite with Supabase (hosted PostgreSQL) so trade history survives DigitalOcean deploys permanently.

**Requirements:**
- DB-01: Every trade insert/update written to Supabase in real-time
- DB-02: All trade reads routed through Supabase client
- DB-03: Automatic migration of JSON ledger trades on first empty-table startup
- DB-04: JSON ledger retained as offline/fallback when Supabase unavailable
- DB-05: Supabase connection status logged on startup
- CFG-01: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY documented in .env.example
- CFG-02: package.json updated (add @supabase/supabase-js, remove better-sqlite3)

**Plans:** 1 plan

Plans:
- [ ] 06-01-PLAN.md -- Supabase trade store + server.js integration + migration

**Success Criteria:**
1. Paper trade recorded during a session appears in Supabase `trades` table immediately after it closes
2. After a simulated "deploy" (server restart with empty disk), all prior trades are still visible in the dashboard
3. When `SUPABASE_URL` is unset, system starts normally using JSON ledger fallback with a clear warning log
4. `npm test` passes with no regressions

**Key Risks:**
- Supabase async API requires updating all callers of `getAllTrades()`, `insertTrade()` etc. from sync to async
- `better-sqlite3` removal may break preflight script or other references

**Dependencies:** Phase 4 (tradeStore interface), Phase 5 (integration tests must pass after)

---

## Phase Dependency Graph

```
Phase 1 (Analytics) --> Phase 2 (Profitability) --> Phase 5 (Integration)
                                                        ^
Phase 3 (Live Trading) --> Phase 4 (Infrastructure) ----+
```

Phases 1 and 3 can be developed in parallel.
Phase 2 depends on Phase 1.
Phase 4 depends on Phase 3.
Phase 5 depends on all prior phases.

---
*Roadmap created: 2026-02-23*
*Last updated: 2026-02-24 — Phase 6 (Supabase Persistence) added for v1.1 milestone*
