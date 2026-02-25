# Project State: Polymarket BTC 5m Assistant

**Current Phase:** Not started (defining requirements)
**Current Plan:** —
**Phase Status:** v1.1 Supabase Persistence — defining requirements
**Last Updated:** 2026-02-24

## Phase Progress

### v1.0.0 (Complete)

| Phase | Name | Status | Completed |
|-------|------|--------|-----------|
| 1 | Analytics Foundation | ✓ Complete | 2026-02-23 |
| 2 | Profitability Optimization | ✓ Complete | 2026-02-23 |
| 3 | Live Trading Hardening | ✓ Complete | 2026-02-23 |
| 4 | Infrastructure & Monitoring | ✓ Complete | 2026-02-23 |
| 5 | Integration & Polish | ✓ Complete | 2026-02-23 |

### v1.1 (Current)

| Phase | Name | Status |
|-------|------|--------|
| 6 | Supabase Persistence | ○ Pending |

## Current Context

### What's Been Done (v1.0.0)
- Full trading engine: 25-condition entry gate, multi-exit, kill-switch, circuit breaker
- Analytics: trade journal, backtester, optimizer, segmented performance
- Live trading: order lifecycle, reconciliation, fee-aware sizing, retry policy
- Infrastructure: SQLite persistence, webhooks, crash recovery, zero-downtime deploy
- Integration tests (24 E2E) + production readiness + documentation

### What's Been Done (v1.1 so far)
- Diagnosed: DigitalOcean Amsterdam has no persistent volumes → SQLite wiped on every deploy
- Diagnosed: `storage:` field in DO App Spec rejected — not supported in region
- Decision: Replace SQLite with Supabase (hosted PostgreSQL) for deploy-proof persistence
- Plan written: `src/infrastructure/persistence/supabaseTradeStore.js` to replace `tradeStore.js`

### What's Next
- Phase 6: Implement Supabase persistence — new store, update server.js, update package.json

### Blockers
- User needs to create a Supabase project and run the SQL schema before testing

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-24)

**Core value:** Profitable automated BTC contract trading with configurable risk controls
**Current focus:** Phase 6 — Supabase Persistence

## Accumulated Context (carried from v1.0.0)

- Daily returns (not per-trade) for Sharpe/Sortino to avoid inflated ratios from HFT autocorrelation
- Backtester pure domain layer (no imports) to enable optimizer grid search without I/O overhead
- globalThis pattern for cross-module trade store access in ESM context
- better-sqlite3 is synchronous; Supabase is async — all store methods will become async in v1.1
- syncTradeToStore is fire-and-forget (no await in PaperExecutor) — safe to stay that way with async Supabase
- getTradesFromStore is already in async route handlers — safe to make async
- JSON ledger fallback must be preserved for dev/offline use
- Tab-aware polling: only fetch active tab data to reduce unnecessary API calls
- Config apply warns when live mode active; stores previous config for revert
- Suggestion engine uses startsWith prefix matching for normalized blocker keys
- 30-second fill timeout with partial fill acceptance (Phase 3)
- Kill-switch: absolute dollar loss, midnight PT reset, manual override with re-trigger

## Session Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-02-23 | Project initialized | Created .planning/ with PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md |
| 2026-02-23 | ALL v1.0.0 PHASES COMPLETE | 17 plans across 5 phases. Project ready for production deployment. |
| 2026-02-24 | v1.1 milestone started | Supabase persistence — replacing SQLite due to DO volume limitations |

---
*Last updated: 2026-02-24 after v1.1 milestone started*
