# Polymarket BTC 5m Assistant

## What This Is

A high-frequency automated trading bot for Polymarket's 5-minute BTC Up/Down prediction contracts. It monitors BTC price movements across multiple feeds (Chainlink, Kraken, Coinbase, Polymarket), computes trading signals using technical indicators (RSI, MACD, VWAP, Heiken Ashi), and executes trades in both paper mode (simulated ledger) and live mode (CLOB via Polymarket API). Includes a real-time dashboard for monitoring, trade history, KPIs, and diagnostics.

## Core Value

Profitable automated BTC contract trading with configurable risk controls that protect capital while maximizing opportunity capture across market conditions.

## Requirements

### Validated

- TRADE-01: 25-condition entry gate with configurable thresholds (probability, edge, RSI, spread, liquidity, etc.) -- existing
- TRADE-02: Multi-condition exit evaluator (max loss, profit target, probability flip, time-based rollover, trailing TP) -- existing
- TRADE-03: Dynamic bankroll-based position sizing with min/max bounds -- existing
- TRADE-04: Circuit breaker halting after consecutive losses with exponential backoff -- existing
- TRADE-05: Loss/win cooldowns between trades -- existing
- TRADE-06: Skip-market-after-max-loss safety gate -- existing
- TRADE-07: Max-loss grace window with model-support requirement -- existing
- TRADE-08: Weekend tightening with stricter thresholds -- existing
- FEED-01: Chainlink WebSocket + REST BTC price feed with 1m candle builder -- existing
- FEED-02: Kraken REST fallback for price and historical candle seeding -- existing
- FEED-03: Coinbase trade stream for spot impulse metrics -- existing
- FEED-04: Polymarket live WS + Gamma API for contract prices and orderbook -- existing
- IND-01: RSI with slope detection (period=9) -- existing
- IND-02: MACD with histogram and histogram delta (6/13/5) -- existing
- IND-03: VWAP with slope and distance metrics -- existing
- IND-04: Heiken Ashi with consecutive color counting -- existing
- IND-05: Range percentage and VWAP cross counting -- existing
- UI-01: Real-time dashboard with status table, open trade, ledger summary -- existing
- UI-02: Paper/Live mode toggle with first-poll-only sync -- existing
- UI-03: Start/Stop trading controls with pill status display -- existing
- UI-04: Trade history table with filters (limit, reason, side, losses only) -- existing
- UI-05: KPI cards (balance, realized PnL, win rate, profit factor, daily stats) -- existing
- UI-06: Equity curve chart with auto-downsampling -- existing
- UI-07: Entry blocker diagnostics (frequency tracking, top blockers row, /api/diagnostics) -- existing
- INFRA-01: Multi-instance oscillation prevention via instance locking and seeking mode -- existing
- INFRA-02: First-poll-only sync preventing server overwrite of user-controlled state -- existing
- INFRA-03: Paper trading ledger with JSON persistence and backup -- existing
- INFRA-04: Cache-busting headers and fetch timeout guards -- existing
- EXEC-01: Paper executor with simulated fills and ledger recording -- existing
- EXEC-02: Live executor with CLOB order submission, fills, approvals -- existing
- EXEC-03: Executor abstraction (OrderExecutor interface) for runtime swapping -- existing

### Active

- [ ] PROF-01: Backtest harness for paper trade history analysis
- [ ] PROF-02: Threshold optimizer testing parameter combinations on historical data
- [ ] PROF-03: Win rate and profit factor tracking by entry phase, time of day, market conditions
- [ ] PROF-04: Entry filter tuning informed by blocker diagnostics data
- [ ] LIVE-01: Full order lifecycle management (submit, fill, exit, reconcile)
- [ ] LIVE-02: Position reconciliation between CLOB state and local tracking
- [ ] LIVE-03: Fee-aware sizing incorporating fee estimates into trade decisions
- [ ] LIVE-04: Graceful error recovery for CLOB failures with retry logic
- [ ] LIVE-05: Daily PnL tracking with automated kill-switch validation
- [ ] ANLYT-01: Historical trade performance dashboard (per-day, per-week, per-session)
- [ ] ANLYT-02: Strategy parameter backtesting framework
- [ ] ANLYT-03: Trade journal capturing entry/exit context (indicators, market state, signals)
- [ ] ANLYT-04: Drawdown analysis and advanced equity curve metrics
- [ ] INFRA-05: Health monitoring with webhook alerts (Slack/Discord)
- [ ] INFRA-06: Auto-restart on crash with state recovery
- [ ] INFRA-07: Structured data persistence beyond JSON ledger (SQLite or structured logs)
- [ ] INFRA-08: Deployment hardening (zero-downtime deploys, instance coordination)

### Out of Scope

- Mobile app -- web dashboard is sufficient for monitoring
- Multi-asset trading -- focused on BTC 5m contracts only
- Social/copy trading -- single-user bot
- ML model training -- uses rule-based indicators, not trainable models
- Exchange trading -- Polymarket CLOB only, not Binance/Coinbase exchange

## Context

- **Runtime**: Node.js 20+ with ESM modules, started with `--max-old-space-size=1024`
- **Deployment**: DigitalOcean App Platform with multiple instances behind load balancer
- **Architecture**: Clean architecture (domain/application/infrastructure/presentation layers)
- **Key Pattern**: Executor abstraction enables Paper/Live swap at runtime
- **Multi-Instance Challenge**: POSTs and GETs may hit different server instances; solved with frontend instance locking + seeking mode
- **Market Structure**: 5-minute BTC Up/Down contracts on Polymarket, new market every 5 minutes
- **Price Feeds**: 4-tier fallback (Chainlink WS -> Chainlink REST -> Polymarket WS -> Kraken REST)
- **Recent Work**: Fixed frontend oscillation (mode, trading status, entry debug), added blocker diagnostics

## Constraints

- **Tech Stack**: Node.js/ESM, Express for API, vanilla JS dashboard (no React/framework)
- **Deployment**: DigitalOcean App Platform with multi-instance load balancing
- **API Limits**: Polymarket CLOB has rate limits; circuit breaker prevents cascade
- **Memory**: 1GB heap cap (--max-old-space-size=1024)
- **Latency**: 1s main loop, 1.5s UI poll interval -- cannot be slower
- **Data**: Paper ledger is JSON file; not shared across instances

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Clean architecture layers | Separation of concerns, testability | Good |
| Executor abstraction | Runtime Paper/Live swap without code changes | Good |
| Instance locking + seeking mode | Multi-instance oscillation prevention | Good |
| Dropdown as source of truth | Prevents server overwriting user state | Good |
| First-poll-only sync | Mode/trading only synced once, then user-controlled | Good |
| 25 entry blockers (all must pass) | Conservative by design, protects capital | Revisit -- may be too strict |
| JSON paper ledger | Simple persistence, no DB needed | Revisit -- not shared across instances |
| Vanilla JS dashboard | No build step, simple deployment | Pending |

---
*Last updated: 2026-02-23 after GSD project initialization*
