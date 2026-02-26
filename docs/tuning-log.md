# Tuning Log — Parameter Changes & Data

Tracks every config change with the data that drove it. Never change parameters without updating this file.

---

## v1.0.7 — 2026-02-26 (234 trades)

### Dataset
- 234 closed trades total (146 post-v1.0.5)
- v1.0.5 performance: 46% WR, PF 0.97, -$19.60

### Changes

| Parameter | Old | New | Data Rationale |
|-----------|-----|-----|----------------|
| `minPolyPrice` | 0.35 | 0.40 | 38 trades <40¢: 29% WR, -$107 PnL |
| `dynamicStopLossPct` | 0.12 | 0.10 | 63 max losses avg $9.82. Reducing saves ~$1-2/trade = $60-120 over sample |
| `rsiDirectionalBiasEnabled` | N/A | true | RSI<40 UP entries worst bucket (39% WR, -$68). RSI>60 UP best (51%) |
| `rsiBearishThreshold` | N/A | 40 | Below 40: only DOWN allowed |
| `rsiBullishThreshold` | N/A | 60 | Above 60: only UP allowed |
| `trailingDrawdownUsd` | 2.00 | 2.50 | 16 trailing TP losses from tight tolerance. Wider gives recovery room |
| `edgeEarly` | 0.02 | 0.015 | 84% of trades are EARLY, PF ~1.0. More volume at best timing window |

### Expected Impact
- Fewer bad entries (price floor + RSI bias cuts lowest WR buckets)
- Smaller max losses (~$8 instead of ~$10)
- More trailing TP recovery (fewer false exits)
- Slightly more trade volume from looser EARLY edge

### Risks
- RSI directional bias may reduce trade count significantly if RSI oscillates 40-60
- Wider trailing TP drawdown means giving back more profit on reversals
- Looser EARLY edge could let in marginal trades

---

## v1.0.5 — 2026-02-26 (84 trades)

### Dataset
- 84 closed trades (pre-v1.0.5 config)
- Overall: 37% WR, PF 0.72, -$117 PnL

### Changes

| Parameter | Old | New | Data Rationale |
|-----------|-----|-----|----------------|
| `minProbEarly` | 0.52 | 0.57 | Entries >60¢ had 63% WR vs 27% at <40¢ |
| `minProbMid` | 0.53 | 0.58 | Same analysis |
| `minProbLate` | 0.55 | 0.60 | Same analysis |
| `minPolyPrice` | 0.05 | 0.35 | 22 trades <40¢: 27% WR, -$72.60 |
| `trailingDrawdownUsd` | 1.50 | 2.00 | 16 TP losses avg -$2.47, many would have recovered |

### Outcome (146 trades post-change)
- WR: 39% → 46%
- PF: 0.72 → 0.97
- Trailing TP went 67W/16L (81% WR)
- Near breakeven: -$19.60

---

## v1.0.4 — 2026-02-25 (initial)

### Changes (from analysis of first 10 trades)

| Parameter | Old | New | Rationale |
|-----------|-----|-----|-----------|
| `trailingStartUsd` | 20 | 3 | $20 threshold rarely hit on 5m contracts |
| `trailingDrawdownUsd` | 10 | 1.50 | Tighter to capture small wins |
| `dynamicStopLossPct` | 0.20 | 0.12 | Losses avg $16, cut to ~$10 |
| `maxMaxLossUsd` | 40 | 20 | Absolute ceiling halved |
| `noTradeRsiOverbought` | N/A | 78 | Blocked UP entries at extreme RSI (89) |
| `noTradeRsiOversold` | N/A | 22 | Blocked DOWN entries at extreme RSI |
