# Polymarket BTC 5m Assistant

A real-time console trading assistant for Polymarket **"Bitcoin Up or Down" 5-minute** markets.

## Features

### Market + data feeds

- **Auto-select latest 5m Polymarket market** (or pin a slug via `POLYMARKET_SLUG`).
- Pulls **Polymarket prices** (UP/DOWN) + orderbook spread + market metadata.
- BTC reference price primarily from **Chainlink BTC/USD** (via Polymarket live feed + on-chain fallback on Polygon RPC/WSS).
- Optional Kraken REST used for seeding/backfilling candles (rate-limited + cached).

### Indicators + signal engine

- Builds **1m candles** from ticks (warm-starts with REST backfill so indicators populate quickly).
- Computes and displays: **Heiken Ashi**, **RSI**, **MACD**, **VWAP** (+ slope/dist), plus helper regime/score outputs.
- Produces a simple **direction probability** (LONG/SHORT) used for paper-trading decisions.

### Paper trading (Polymarket contracts)

- Trades the **Polymarket UP/DOWN contracts** (not BTC spot). Entry/exit/PnL are based on Polymarket contract prices.
- **Local JSON ledger** persisted to `paper_trading/trades.json`.
- **Bankroll-based position sizing**:
  - `STARTING_BALANCE`, `STAKE_PCT`, `MIN_TRADE_USD`, `MAX_TRADE_USD`.
- **Dynamic exits**:
  - Always closes **near the end of the 5m market window** (“End of Candle”) to avoid rollover weirdness.
  - Closes on **market slug rollover** (safety backstop).
  - **Conditional stop loss** (`STOP_LOSS_PCT`) that triggers only when loss threshold is hit _and_ the model is against the position (reduces chop-outs).
- **Safety guards**:
  - Requires indicators to be populated before entering.
  - Avoids "dust"/invalid Polymarket prices (`MIN_POLY_PRICE`, `MAX_POLY_PRICE`).
  - Market quality gating: minimum Polymarket **liquidity** + **tight max spread**.
  - Consolidation avoidance: blocks entries when BTC is too choppy (range filter) and when the model is near 50/50 (conviction filter).
  - Schedule gating: **weekday-only entries** with a **Friday cutoff** (exits always allowed).

### UI + debugging

- Runs a lightweight UI at **http://localhost:3000**:
  - **/api/status**: runtime snapshot + open trade + balance + “Why no entry?” blockers.
  - **/api/trades**: recent trades (newest first in the UI).
  - **/api/analytics**: performance analytics tables (PnL by exit reason/phase/price bucket/etc.) + liquidity sampling stats.
- “**Why no entry?**” explains exactly which gates are blocking entries.

### Analytics (performance + market conditions)

- Analytics breakdowns include:
  - by **exit reason**, **entry phase**, **entry price bucket**, **prob bucket**, **time-left bucket**, **liquidity bucket**, **spread bucket**, **side**, **rec action**.
- Captures **entry metadata** on new trades (prob/edge/liquidity/spread/time-left) for better post-trade analysis.
- Samples Polymarket **liquidity over time** to `paper_trading/liquidity_samples.jsonl` and reports 1h/6h/24h stats.

### Ops / reliability

- Designed to run under a process manager (e.g. **PM2**) to avoid session SIGTERM/SIGKILL issues.
- Built-in REST throttling/caching and defensive error handling to avoid crashes.

It combines:

- Polymarket market selection + UP/DOWN prices + liquidity
- Polymarket live WS **Chainlink BTC/USD CURRENT PRICE** (same feed shown on the Polymarket UI)
- Fallback to on-chain Chainlink (Polygon) via HTTP/WSS RPC
- Binance spot price for reference
- Short-term TA snapshot (Heiken Ashi, RSI, MACD, VWAP, Delta 1/3m)
- A simple live **Predict (LONG/SHORT %)** derived from the assistant’s current TA scoring

## Requirements

- Node.js **18+** (https://nodejs.org/en)
- npm (comes with Node)

## Run from terminal (step-by-step)

### 1) Clone the repository

```bash
git clone <YOUR_5M_REPO_URL_HERE>
```

Alternative (no git):

- Click the green `<> Code` button on GitHub
- Choose `Download ZIP`
- Extract the ZIP
- Open a terminal in the extracted project folder

Then open a terminal in the project folder.

### 2) Install dependencies

```bash
npm install
```

### 3) (Optional) Set environment variables

You can run without extra config (defaults are included), but for more stable Chainlink fallback it’s recommended to set at least one Polygon RPC.

#### Windows PowerShell (current terminal session)

```powershell
$env:POLYGON_RPC_URL = "https://polygon-rpc.com"
$env:POLYGON_RPC_URLS = "https://polygon-rpc.com,https://rpc.ankr.com/polygon"
$env:POLYGON_WSS_URLS = "wss://polygon-bor-rpc.publicnode.com"
```

Optional Polymarket settings:

```powershell
$env:POLYMARKET_AUTO_SELECT_LATEST = "true"
# $env:POLYMARKET_SLUG = "btc-updown-5m-1771019100"   # pin a specific market
```

#### Windows CMD (current terminal session)

```cmd
set POLYGON_RPC_URL=https://polygon-rpc.com
set POLYGON_RPC_URLS=https://polygon-rpc.com,https://rpc.ankr.com/polygon
set POLYGON_WSS_URLS=wss://polygon-bor-rpc.publicnode.com
```

Optional Polymarket settings:

```cmd
set POLYMARKET_AUTO_SELECT_LATEST=true
REM set POLYMARKET_SLUG=btc-updown-5m-1771019100
```

Notes:

- These environment variables apply only to the current terminal window.
- If you want permanent env vars, set them via Windows System Environment Variables or use a `.env` loader of your choice.

## Configuration

This project reads configuration from environment variables.

You can set them in your shell, or create a `.env` file and load it using your preferred method.

### Polymarket

- `POLYMARKET_AUTO_SELECT_LATEST` (default: `true`)
  - When `true`, automatically picks the latest 5m market.
- `POLYMARKET_SERIES_ID` (default: `10192`)
- `POLYMARKET_SERIES_SLUG` (default: `btc-up-or-down-5m`)
- `POLYMARKET_SLUG` (optional)
  - If set, the assistant will target a specific market slug.
- `POLYMARKET_LIVE_WS_URL` (default: `wss://ws-live-data.polymarket.com`)

### Chainlink on Polygon (fallback)

- `CHAINLINK_BTC_USD_AGGREGATOR`
  - Default: `0xc907E116054Ad103354f2D350FD2514433D57F6f`

HTTP RPC:

- `POLYGON_RPC_URL` (default: `https://polygon-rpc.com`)
- `POLYGON_RPC_URLS` (optional, comma-separated)
  - Example: `https://polygon-rpc.com,https://rpc.ankr.com/polygon`

WSS RPC (optional but recommended for more real-time fallback):

- `POLYGON_WSS_URL` (optional)
- `POLYGON_WSS_URLS` (optional, comma-separated)

### Proxy support

The bot supports HTTP(S) proxies for both HTTP requests (fetch) and WebSocket connections.

Supported env vars (standard):

- `HTTPS_PROXY` / `https_proxy`
- `HTTP_PROXY` / `http_proxy`
- `ALL_PROXY` / `all_proxy`

Examples:

PowerShell:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:8080"
# or
$env:ALL_PROXY = "socks5://127.0.0.1:1080"
```

CMD:

```cmd
set HTTPS_PROXY=http://127.0.0.1:8080
REM or
set ALL_PROXY=socks5://127.0.0.1:1080
```

#### Proxy with username + password (simple guide)

1. Take your proxy host and port (example: `1.2.3.4:8080`).

2. Add your login and password in the URL:

- HTTP/HTTPS proxy:
  - `http://USERNAME:PASSWORD@HOST:PORT`
- SOCKS5 proxy:
  - `socks5://USERNAME:PASSWORD@HOST:PORT`

3. Set it in the terminal and run the bot.

PowerShell:

```powershell
$env:HTTPS_PROXY = "http://USERNAME:PASSWORD@HOST:PORT"
npm start
```

CMD:

```cmd
set HTTPS_PROXY=http://USERNAME:PASSWORD@HOST:PORT
npm start
```

Important: if your password contains special characters like `@` or `:` you must URL-encode it.

Example:

- password: `p@ss:word`
- encoded: `p%40ss%3Aword`
- proxy URL: `http://user:p%40ss%3Aword@1.2.3.4:8080`

## Run

```bash
npm start
```

### Stop

Press `Ctrl + C` in the terminal.

### Update to latest version

```bash
git pull
npm install
npm start
```

## Notes / Troubleshooting

- If you see no Chainlink updates:
  - Polymarket WS might be temporarily unavailable. The bot falls back to Chainlink on-chain price via Polygon RPC.
  - Ensure at least one working Polygon RPC URL is configured.
- If the console looks like it “spams” lines:
  - The renderer uses `readline.cursorTo` + `clearScreenDown` for a stable, static screen, but some terminals may still behave differently.

## Safety

This is not financial advice. Use at your own risk.

created by @krajekis
