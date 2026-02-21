# Polymarket BTC 5m Assistant

## CHANGELOG

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
