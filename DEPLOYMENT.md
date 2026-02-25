# Deployment Guide

Operational runbook for deploying Polymarket BTC 5m Assistant to production.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Variables](#environment-variables)
3. [Local Development](#local-development)
4. [DigitalOcean App Platform](#digitalocean-app-platform)
5. [Health Checks & Monitoring](#health-checks--monitoring)
6. [Webhook Configuration](#webhook-configuration)
7. [Supabase Data Persistence](#supabase-data-persistence)
8. [Graceful Shutdown & Zero-Downtime Deploys](#graceful-shutdown--zero-downtime-deploys)
9. [Crash Recovery](#crash-recovery)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js 18+** (recommended: 20 LTS)
- **npm** (bundled with Node.js)
- **Supabase account** (free tier) — for persistent trade history that survives deploys
- **PM2** or equivalent process manager (recommended for production)

```bash
npm install
```

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `POLYMARKET_SLUG` or `POLYMARKET_AUTO_SELECT_LATEST=true` | Target market | `btc-updown-5m-...` |
| `POLYGON_RPC_URL` | Chainlink BTC price feed (Polygon) | `https://polygon-rpc.com` |

### Recommended

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `UI_PORT` / `PORT` | HTTP server port | `8080` / `3000` |
| `STARTING_BALANCE` | Paper trading bankroll | `1000` |
| `DAILY_LOSS_LIMIT` | Kill-switch threshold (USD) | `50` |

### Live Trading

| Variable | Description | Default |
|----------|-------------|---------|
| `LIVE_TRADING_ENABLED` | Enable live CLOB trading | `false` |
| `LIVE_ENV_GATE` | Environment gate (set to `production` to gate) | `null` |
| `LIVE_MAX_PER_TRADE_USD` | Max trade size | `7` |
| `LIVE_MAX_OPEN_EXPOSURE_USD` | Max open exposure | `10` |
| `LIVE_MAX_DAILY_LOSS_USD` | Live daily loss limit | `30` |
| `FUNDER_ADDRESS` | CLOB funder wallet address | (required for live) |

### Webhooks

| Variable | Description | Example |
|----------|-------------|---------|
| `WEBHOOK_URL` | Slack/Discord webhook URL | `https://hooks.slack.com/services/...` |
| `WEBHOOK_TYPE` | Alert destination type | `slack` or `discord` |

### Data & Persistence

| Variable | Description | Default |
|----------|-------------|---------|
| `DATA_DIR` | Directory for SQLite DB, state files, PID lock | `./data` |
| `POLYGON_RPC_URLS` | Comma-separated fallback RPCs | (optional) |
| `POLYGON_WSS_URLS` | Comma-separated WebSocket RPCs | (optional) |

## Local Development

```bash
# 1. Clone and install
git clone <repo-url>
cd polymarket-btc-5m-assistant
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your settings

# 3. Run pre-flight checks
npm run preflight

# 4. Start
npm start

# 5. Open dashboard
open http://localhost:3000
```

### Running Tests

```bash
npm test
```

Tests use Node.js native test runner (`node:test`). All unit tests and integration tests run together.

## DigitalOcean App Platform

### App Spec (YAML)

```yaml
name: polymarket-btc-5m
services:
  - name: bot
    github:
      repo: your-org/polymarket-btc-5m-assistant
      branch: main
      deploy_on_push: true
    build_command: npm install
    run_command: node --max-old-space-size=1024 src/index.js
    instance_size_slug: basic-xxs
    instance_count: 1
    http_port: 3000
    health_check:
      http_path: /health
      initial_delay_seconds: 15
      period_seconds: 30
      timeout_seconds: 5
      success_threshold: 1
      failure_threshold: 3
    envs:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "3000"
      - key: POLYGON_RPC_URL
        value: "https://polygon-rpc.com"
      - key: POLYMARKET_AUTO_SELECT_LATEST
        value: "true"
      - key: DAILY_LOSS_LIMIT
        value: "50"
      - key: WEBHOOK_URL
        type: SECRET
      - key: WEBHOOK_TYPE
        value: "slack"
```

### Key Configuration Notes

1. **Single instance**: Set `instance_count: 1` to avoid trading lock contention. The trading lock system handles multi-instance scenarios, but single-instance is simpler.

2. **Health check**: The `/health` endpoint returns JSON with status, uptime, mode, and persistence info. Configure the load balancer to probe this path.

3. **Supabase persistence**: Trade history is stored in Supabase (hosted PostgreSQL) and survives deploys automatically. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — no volume mount needed.

4. **Graceful shutdown**: DigitalOcean sends SIGTERM before stopping. The bot will:
   - Stop accepting new trades
   - Wait for open position to close (up to 5 minutes)
   - Persist state
   - Release trading lock
   - Exit cleanly

5. **Deploy hooks**: No special deploy hooks needed. The bot handles startup, state recovery, and lock acquisition automatically.

## Health Checks & Monitoring

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Load balancer probe (status, uptime, mode, memory, PID) |
| `/api/status` | GET | Full engine state (signals, positions, entry debug) |
| `/api/metrics` | GET | Operational metrics (uptime, memory, circuit breaker, Supabase status) |
| `/api/diagnostics` | GET | Entry blocker diagnostics with effective thresholds |
| `/api/kill-switch/status` | GET | Daily PnL vs. limit, override state |

### Health Check Response

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "2026-02-23T12:00:00.000Z",
    "uptime": 3600,
    "lastTick": "2026-02-23T12:00:00.000Z",
    "mode": "paper",
    "tradingEnabled": true,
    "memoryMb": 85.5,
    "pid": 12345,
    "persistence": { "supabase": true }
  }
}
```

### Monitoring Recommendations

- Alert on `/health` returning non-200 or uptime dropping to 0 (crash restart)
- Monitor `memoryMb` for memory leaks (heap capped at 1 GB)
- Watch `persistence.supabase` — if false, trades are only in JSON ledger (won't survive deploys)
- Check `lastTick` freshness — if stale by more than 30s, the main loop may be stuck

## Webhook Configuration

### Slack

1. Create an Incoming Webhook in your Slack workspace
2. Set `WEBHOOK_URL` to the webhook URL
3. Set `WEBHOOK_TYPE=slack`

### Discord

1. Create a Webhook in your Discord channel settings
2. Set `WEBHOOK_URL` to the webhook URL
3. Set `WEBHOOK_TYPE=discord`

### Alert Types

| Alert | When | Severity |
|-------|------|----------|
| Kill-switch triggered | Daily loss exceeds limit | Critical |
| Circuit breaker tripped | N consecutive CLOB failures | Warning |
| Order failed | CLOB order submission fails after retries | Error |
| Crash recovery | Process restarted after crash, state restored | Info |

Alerts are fire-and-forget with 60-second deduplication per event type to prevent alert storms.

## Supabase Data Persistence

Trade history is stored in Supabase (hosted PostgreSQL) so it survives DigitalOcean deploys, server restarts, and region moves.

### Setup

1. Create a free project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** and run the schema from `.planning/supabase-schema.sql`
3. Go to **Project Settings → API** and copy:
   - **Project URL** → set as `SUPABASE_URL`
   - **service_role** key → set as `SUPABASE_SERVICE_ROLE_KEY`
4. Add both to your `.env` and DigitalOcean App Spec environment variables

### Behavior

The bot automatically:
1. Connects to Supabase on startup
2. Migrates existing JSON ledger trades to Supabase (one-time, only if table is empty)
3. Writes every new trade to Supabase in real-time
4. Falls back to JSON ledger if `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are not set

### Backup

The JSON ledger at `data/paper_trading/ledger.json` serves as a secondary backup for local development. Supabase provides built-in backups on paid plans.

## Graceful Shutdown & Zero-Downtime Deploys

### Shutdown Sequence

When SIGTERM is received:

1. Trading disabled immediately (no new entries)
2. Open position drain (wait up to 5 minutes for exit)
3. Critical state persisted to `data/state.json`
4. Trading lock released
5. HTTP server closed
6. Supabase client released (no-op — connection pool managed automatically)
7. Process exits with code 0

### Trading Lock

The file-based trading lock (`data/.trading-lock`) prevents duplicate trade execution during rolling deploys:

- Lock acquired on startup (with 35s timeout)
- Heartbeat updated every 10s
- Stale lock detected and reclaimed after 60s of inactivity
- Released on clean shutdown

### Rolling Deploy Pattern

1. New instance starts, attempts to acquire trading lock
2. Old instance receives SIGTERM, begins graceful shutdown
3. Old instance releases trading lock during shutdown
4. New instance acquires lock and begins trading
5. Brief gap (seconds) between old shutdown and new startup

## Crash Recovery

### Detection

On startup, the state manager checks for a stale PID lock file. If the PID in the file is not running, a crash is detected.

### Recovery

1. Read persisted state from `data/state.json`
2. Restore critical fields: daily PnL, kill-switch, circuit breaker, consecutive losses
3. Write new PID to lock file
4. Send crash recovery webhook alert (if configured)
5. Resume trading with restored state

### What IS Restored

- Daily realized PnL (kill-switch accounting)
- Kill-switch state (active, override count, override log)
- Circuit breaker state (consecutive losses, trip timestamp)
- Open position flag

### What is NOT Restored (Safe to Reset)

- Cooldown timestamps (short-lived, stale after restart)
- MFE/MAE per-position tracking (reset on position close anyway)
- Grace window state (short-lived)
- Blocker frequency counts (rebuilt quickly from live data)

## Troubleshooting

### Bot Not Entering Trades

1. Check `/api/status` — look at the "Why no entry?" field
2. Check `/api/diagnostics` — shows effective thresholds and top blockers
3. Common causes:
   - "Trading disabled" — click Start Trading in UI
   - "Insufficient candles" — wait for 12+ 1-minute candles after startup
   - "Model conviction low" — market is near 50/50, no clear direction
   - "Spread too wide" — Polymarket orderbook spread exceeds `MAX_SPREAD`
   - "Kill-switch active" — daily loss limit hit, override or wait for midnight reset

### Supabase Not Working

1. Check that `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set in your environment
2. Check `/api/metrics` — `persistence.supabase` should be `true`
3. Dashboard shows "Supabase: Fallback (JSON)" banner if unavailable
4. Verify the SQL schema was run in Supabase SQL editor (`.planning/supabase-schema.sql`)
5. Confirm the `trades` table exists: Supabase dashboard → Table Editor → `trades`

### Webhook Alerts Not Firing

1. Verify `WEBHOOK_URL` and `WEBHOOK_TYPE` are set
2. Check server logs for `[Phase 4] Webhook alerts configured`
3. Alerts are deduplicated (60s cooldown) — rapid triggers may be suppressed
4. Test by triggering kill-switch with a low `DAILY_LOSS_LIMIT`

### High Memory Usage

1. Heap is capped at 1 GB (`--max-old-space-size=1024`)
2. Check `/api/metrics` for `memoryMb`
3. Trade cache is capped at 500 entries
4. Candle history is capped at 240 entries
5. If growing unbounded, check for WebSocket reconnection storms

### Multi-Instance Issues

1. The trading lock prevents duplicate trades
2. If lock acquisition fails, check for stale `data/.trading-lock` file
3. Delete stale lock file and restart
4. Dashboard instance locking prevents UI oscillation from multiple backends

---
*Last updated: 2026-02-23*
