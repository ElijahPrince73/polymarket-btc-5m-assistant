# Requirements: Polymarket BTC 5m Assistant

**Defined:** 2026-02-23
**Core Value:** Profitable automated BTC contract trading with configurable risk controls

## v1 Requirements

Requirements for next development cycle. Each maps to roadmap phases.

### Analytics & Backtesting

- [x] **ANLYT-01**: User can view historical trade performance grouped by day, week, and trading session
- [x] **ANLYT-02**: User can backtest strategy parameters against historical paper trade data
- [x] **ANLYT-03**: Each trade records full context at entry/exit (indicators, signals, market state) as a trade journal
- [x] **ANLYT-04**: User can view drawdown analysis, max drawdown, and advanced equity curve metrics (Sharpe, Sortino)

### Profitability Tuning

- [x] **PROF-01**: System provides a backtest harness that replays historical trades with modified parameters
- [x] **PROF-02**: System can test parameter combinations (thresholds, filters) and report expected win rate/PF
- [ ] **PROF-03**: User can view win rate and profit factor segmented by entry phase, time of day, and market conditions
- [ ] **PROF-04**: System suggests entry filter adjustments based on blocker diagnostics frequency data

### Live Trading Readiness

- [ ] **LIVE-01**: Full order lifecycle tracked from submission through fill to exit with status at each stage
- [ ] **LIVE-02**: System reconciles CLOB position state with local tracking and flags discrepancies
- [ ] **LIVE-03**: Position sizing accounts for estimated fees before submitting orders
- [ ] **LIVE-04**: CLOB failures trigger automatic retry with exponential backoff and alert
- [ ] **LIVE-05**: Daily PnL kill-switch is validated end-to-end (triggers correctly at threshold)

### Infrastructure Reliability

- [ ] **INFRA-05**: System sends webhook alerts (Slack/Discord) on critical events (crash, circuit breaker, kill-switch)
- [ ] **INFRA-06**: System auto-restarts after crash and recovers in-memory state from persisted data
- [ ] **INFRA-07**: Trade history persisted in structured format (SQLite or append-only log) beyond JSON ledger
- [ ] **INFRA-08**: Deployment supports zero-downtime updates with instance coordination

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Advanced Strategy

- **STRAT-01**: Multiple concurrent strategy profiles with A/B comparison
- **STRAT-02**: Machine learning signal augmentation (feature engineering from indicators)
- **STRAT-03**: Cross-market correlation signals (ETH, SOL contracts)

### Platform

- **PLAT-01**: Multi-user support with separate portfolios
- **PLAT-02**: Mobile-responsive dashboard with push notifications
- **PLAT-03**: API for external integrations (webhook triggers, third-party dashboards)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Mobile native app | Web dashboard sufficient; vanilla JS already responsive |
| Multi-asset trading | Focused on BTC 5m contracts; architecture allows future extension |
| Social/copy trading | Single-user bot; no multi-user infra needed |
| ML model training pipeline | Rule-based indicators sufficient for current strategy |
| Exchange trading (Binance, etc.) | Polymarket CLOB only; different order book mechanics |
| React/framework migration | Vanilla JS dashboard works; no build step complexity |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ANLYT-01 | Phase 1 | Complete |
| ANLYT-02 | Phase 1 | Complete |
| ANLYT-03 | Phase 1 | Complete |
| ANLYT-04 | Phase 1 | Complete |
| PROF-01 | Phase 1 | Complete |
| PROF-02 | Phase 1 | Complete |
| PROF-03 | Phase 2 | Pending |
| PROF-04 | Phase 2 | Pending |
| LIVE-01 | Phase 3 | Pending |
| LIVE-02 | Phase 3 | Pending |
| LIVE-03 | Phase 3 | Pending |
| LIVE-04 | Phase 3 | Pending |
| LIVE-05 | Phase 3 | Pending |
| INFRA-05 | Phase 4 | Pending |
| INFRA-06 | Phase 4 | Pending |
| INFRA-07 | Phase 4 | Pending |
| INFRA-08 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-02-23*
*Last updated: 2026-02-23 after GSD project initialization*
