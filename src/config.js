export const CONFIG = {
  // Symbol for display/labels
  symbol: "BTCUSD",

  // Price feed source
  priceFeed: process.env.PRICE_FEED || "kraken",

  // Kraken configuration
  kraken: {
    baseUrl: process.env.KRAKEN_REST_BASE_URL || "https://api.kraken.com",
    wsUrl: process.env.KRAKEN_WS_URL || "wss://ws.kraken.com",
    pair: process.env.KRAKEN_PAIR || "XXBTZUSD"
  },

  // Spot reference feed (used for impulse/basis comparisons)
  // Note: current implementation uses Coinbase Exchange WS/REST.
  coinbase: {
    symbol: process.env.COINBASE_SYMBOL || "BTC-USD",
    baseUrl: process.env.COINBASE_REST_BASE_URL || "https://api.exchange.coinbase.com",
    wsBaseUrl: process.env.COINBASE_WS_URL || "wss://ws-feed.exchange.coinbase.com"
  },

  // Polymarket API endpoints
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  // Polling and candle settings
  pollIntervalMs: 2_000, // faster for 5m markets (higher frequency)
  candleWindowMinutes: 5,

  // Indicator settings (faster defaults for 5m markets)
  vwapSlopeLookbackMinutes: 3,
  rsiPeriod: 9,
  rsiMaPeriod: 9,
  macdFast: 6,
  macdSlow: 13,
  macdSignal: 5,

  // Polymarket market settings
  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    // BTC Up/Down 5m series id (Gamma). Override with POLYMARKET_SERIES_ID if needed.
    seriesId: process.env.POLYMARKET_SERIES_ID || "10684",
    seriesSlug: process.env.POLYMARKET_SERIES_SLUG || "btc-up-or-down-5m",
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down"
  },

  // Chainlink settings (Polygon RPC for fallback)
  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  },

  // Paper trading settings
  paperTrading: {
    enabled: (process.env.PAPER_TRADING_ENABLED || "true").toLowerCase() === "true",

    // Bankroll + position sizing
    startingBalance: Number(process.env.STARTING_BALANCE) || 1000,
    stakePct: Number(process.env.STAKE_PCT) || 0.08, // 8% of balance per trade
    minTradeUsd: Number(process.env.MIN_TRADE_USD) || 25,
    maxTradeUsd: Number(process.env.MAX_TRADE_USD) || 250,

    // Back-compat (legacy fixed size). If stakePct is set, we use dynamic sizing.
    contractSize: Number(process.env.PAPER_CONTRACT_SIZE) || 100,
    
    // Thresholds (higher = more hesitation)
    // 5m defaults tuned for higher-frequency paper trading
    minProbEarly: Number(process.env.MIN_PROB_EARLY) || 0.52,
    minProbMid: Number(process.env.MIN_PROB_MID) || 0.53,
    minProbLate: Number(process.env.MIN_PROB_LATE) || 0.55,
    
    edgeEarly: Number(process.env.EDGE_EARLY) || 0.02,
    edgeMid: Number(process.env.EDGE_MID) || 0.03,
    edgeLate: Number(process.env.EDGE_LATE) || 0.05,

    // Extra strictness knobs (used to improve odds without killing trade count)
    // MID entries tend to be weaker; require a bit more strength.
    midProbBoost: Number(process.env.MID_PROB_BOOST) || 0.01,
    midEdgeBoost: Number(process.env.MID_EDGE_BOOST) || 0.01,

    // In loose mode (rec gating ignored) when side is inferred, require stronger signals.
    inferredProbBoost: Number(process.env.INFERRED_PROB_BOOST) || 0.01,
    inferredEdgeBoost: Number(process.env.INFERRED_EDGE_BOOST) || 0.01,
    
    // Exit settings
    // Close before settlement to avoid rollover weirdness.
    exitBeforeEndMinutes: Number(process.env.EXIT_BEFORE_END_MIN) || 1.00,
    // Time stop: if a trade can't go green quickly, cut it.
    loserMaxHoldSeconds: Number(process.env.LOSER_MAX_HOLD_SECONDS) || 120,

    // Hard max loss cap (USD): prevents one trade from wiping multiple small wins.
    // If pnlNow <= -maxLossUsdPerTrade, force exit (unless max-loss grace is enabled).
    maxLossUsdPerTrade: Number(process.env.MAX_LOSS_USD_PER_TRADE) || 15,

    // Max-loss grace (optional): when pnl breaches -maxLossUsdPerTrade, allow a short grace window
    // to recover (helps avoid wick/chop stop-outs) *only when conditions are supportive*.
    maxLossGraceEnabled: (process.env.MAX_LOSS_GRACE_ENABLED || "true").toLowerCase() === "true",
    maxLossGraceSeconds: Number(process.env.MAX_LOSS_GRACE_SECONDS) || 60,
    // If PnL recovers above -maxLossRecoverUsd during grace, we cancel the pending stop.
    maxLossRecoverUsd: Number(process.env.MAX_LOSS_RECOVER_USD) || 10,
    // Require the model to still support the trade side during grace.
    maxLossGraceRequireModelSupport: (process.env.MAX_LOSS_GRACE_REQUIRE_MODEL_SUPPORT || "true").toLowerCase() === "true",

    // Cooldown after a losing trade (seconds): prevents rapid back-to-back losses.
    lossCooldownSeconds: Number(process.env.LOSS_COOLDOWN_SECONDS) || 30,
    // Cooldown after a winning trade (seconds): reduces bursty trade patterns (safer for live).
    winCooldownSeconds: Number(process.env.WIN_COOLDOWN_SECONDS) || 30,

    // If true: after a Max Loss stopout, do not enter again until the market rolls to the next slug.
    skipMarketAfterMaxLoss: (process.env.SKIP_MARKET_AFTER_MAX_LOSS || "true").toLowerCase() === "true",

    // Stop loss (disabled by default for 5m; rollover + chop made it a big drag)
    stopLossEnabled: (process.env.STOP_LOSS_ENABLED || "false").toLowerCase() === "true",
    // Example: 0.25 => cut the trade if it loses 25% of contractSize.
    stopLossPct: Number(process.env.STOP_LOSS_PCT) || 0.20,

    // Take profit
    // NOTE: Immediate TP exits as soon as mark-to-market PnL is >= takeProfitPnlUsd.
    // For 5m, trailing TP tends to behave better (lets winners run, then protects gains).
    takeProfitImmediate: (process.env.TAKE_PROFIT_IMMEDIATE || "false").toLowerCase() === "true",
    // Default loosened to let winners run a bit (can override via TAKE_PROFIT_PNL_USD env var)
    takeProfitPnlUsd: Number(process.env.TAKE_PROFIT_PNL_USD) || 25.0,

    // Trailing take profit (recommended):
    // - Once maxUnrealizedPnl >= trailingStartUsd, we track a trail = maxUnrealizedPnl - trailingDrawdownUsd.
    // - If pnlNow falls back below the trail, we exit (locking in gains).
    trailingTakeProfitEnabled: (process.env.TRAILING_TAKE_PROFIT_ENABLED || "true").toLowerCase() === "true",
    trailingStartUsd: Number(process.env.TRAILING_TAKE_PROFIT_START_USD) || 20,
    trailingDrawdownUsd: Number(process.env.TRAILING_TAKE_PROFIT_DRAWDOWN_USD) || 10,

    // Legacy/unused
    takeProfitPct: Number(process.env.TAKE_PROFIT_PCT) || 0.08,

    // Dynamic exit: close when opposite side becomes more likely.
    // Example: if you're in UP and modelDown >= modelUp + exitFlipMargin AND modelDown >= exitFlipMinProb → exit.
    exitFlipMinProb: Number(process.env.EXIT_FLIP_MIN_PROB) || 0.62,
    exitFlipMargin: Number(process.env.EXIT_FLIP_MARGIN) || 0.06,
    // Avoid noisy early flips: require trade to be open at least this long before flip-exit is allowed.
    exitFlipMinHoldSeconds: Number(process.env.EXIT_FLIP_MIN_HOLD_SECONDS) || 15,

    // When a probability flip happens, optionally close and immediately open the other side.
    // Default OFF (analytics showed flips were a major drag on PnL). Set FLIP_ON_PROB_FLIP=true to re-enable.
    flipOnProbabilityFlip: (process.env.FLIP_ON_PROB_FLIP || "false").toLowerCase() === "true",
    flipCooldownSeconds: Number(process.env.FLIP_COOLDOWN_SECONDS) || 60,
    
    // Market quality filters
    // Liquidity filter (Polymarket market.liquidityNum). Raise this to avoid thin markets.
    minLiquidity: Number(process.env.MIN_LIQUIDITY) || 500,
    // (disabled) Market volume filter. Use volatility/chop filters instead.
    // Set MIN_MARKET_VOLUME_NUM > 0 to re-enable.
    minMarketVolumeNum: Number(process.env.MIN_MARKET_VOLUME_NUM) || 0,
    // Max allowed Polymarket orderbook spread (dollars). 0.008 = 0.8¢
    // Tighten spread for better fills
    // Tightened to reduce adverse selection / churn in wide markets
    maxSpread: Number(process.env.MAX_SPREAD) || 0.012,

    // Trading schedule filter (America/Los_Angeles)
    // If enabled, blocks weekend entries (with optional Sunday exception).
    weekdaysOnly: (process.env.WEEKDAYS_ONLY || "false").toLowerCase() === "true",
    // Optional exception: allow Sunday entries after this hour (0-23). Set negative/empty to disable.
    allowSundayAfterHour: Number(process.env.ALLOW_SUNDAY_AFTER_HOUR) || -1,
    // Block new entries after this hour on Friday (0-23). Set empty/negative to disable.
    noEntryAfterFridayHour: Number(process.env.NO_ENTRY_AFTER_FRIDAY_HOUR) || 17,

    // Weekend tightening: allow weekend trading, but require stronger signals/market quality.
    weekendTighteningEnabled: (process.env.WEEKEND_TIGHTENING || "true").toLowerCase() === "true",
    weekendMaxSpread: Number(process.env.WEEKEND_MAX_SPREAD) || 0.008, // 0.8¢
    weekendMinLiquidity: Number(process.env.WEEKEND_MIN_LIQUIDITY) || 20000,
    weekendMinRangePct20: Number(process.env.WEEKEND_MIN_RANGE_PCT_20) || 0.0025, // 0.25%
    weekendMinModelMaxProb: Number(process.env.WEEKEND_MIN_MODEL_MAX_PROB) || 0.60,
    weekendProbBoost: Number(process.env.WEEKEND_PROB_BOOST) || 0.03,
    weekendEdgeBoost: Number(process.env.WEEKEND_EDGE_BOOST) || 0.03,
    requiredCandlesInDirection: Number(process.env.REQUIRED_CANDLES) || 2,

    // Spot impulse filter (uses Coinbase spot as reference)
    // Require the BTC spot price to have moved at least this much over the last 60s.
    // Set to 0 to disable.
    minBtcImpulsePct1m: Number(process.env.MIN_BTC_IMPULSE_PCT_1M) || 0.0003, // 0.03%

    // Volume filters (set to 0 to disable)
    // volumeRecent is sum of last 20x 1m candle volumes
    minVolumeRecent: Number(process.env.MIN_VOLUME_RECENT) || 0,
    // require volumeRecent >= volumeAvg * minVolumeRatio (volumeAvg is approx avg per-20m block)
    minVolumeRatio: Number(process.env.MIN_VOLUME_RATIO) || 0,

    // Polymarket price sanity (dollars, 0..1). Prevent "0.00" entries.
    // Example: 0.002 = 0.2¢
    // Avoid "dust" Polymarket prices where spread/tick noise dominates.
    // 0.005 = 0.5¢
    // 5m markets often have tiny prices; allow smaller but avoid true dust.
    minPolyPrice: Number(process.env.MIN_POLY_PRICE) || 0.002,
    maxPolyPrice: Number(process.env.MAX_POLY_PRICE) || 0.98,
    // Profitability filter: avoid paying up in 5m (most losses came from >=0.5¢ entries)
    // Entry price cap (dollars). 0.0055 = 0.55¢
    maxEntryPolyPrice: Number(process.env.MAX_ENTRY_POLY_PRICE) || 0.0055,
    // Avoid extremely skewed markets where one side is near-zero.
    minOppositePolyPrice: Number(process.env.MIN_OPPOSITE_POLY_PRICE) || 0.002,
    
    // Chop/volatility filter (BTC reference): block entries when recent movement is too small.
    // rangePct20 = (max(close,last20) - min(close,last20)) / lastClose
    // Moderate default: require ~0.20% range over last 20 minutes.
    // More permissive for 5m (higher frequency): require ~0.12% range over last 20 minutes.
    minRangePct20: Number(process.env.MIN_RANGE_PCT_20) || 0.0012,

    // Confidence filter: avoid coin-flip markets where the model is near 50/50.
    // We require max(modelUp, modelDown) >= this value to allow entries.
    minModelMaxProb: Number(process.env.MIN_MODEL_MAX_PROB) || 0.53,

    // RSI consolidation/regime filter: enabled for profitability (avoid bad band)
    noTradeRsiMin: Number(process.env.NO_TRADE_RSI_MIN) || 30,
    noTradeRsiMax: Number(process.env.NO_TRADE_RSI_MAX) || 45,

    // Time filters
    // For 5m, avoid new entries too close to settlement (rollover risk)
    noEntryFinalMinutes: Number(process.env.NO_ENTRY_FINAL_MIN) || 1.50,

    // Require enough 1m candles before allowing entries (helps avoid 50/50 startup)
    minCandlesForEntry: Number(process.env.MIN_CANDLES_FOR_ENTRY) || 12,
    
    // Rec gating controls whether we require the engine to explicitly say ENTER.
    // - strict: must be Rec=ENTER
    // - loose: allow entry if thresholds hit, even when Rec=NO_TRADE/HOLD
    recGating: (process.env.REC_GATING || "loose").toLowerCase(),

    // Forced entries OFF by default
    forcedEntriesEnabled: (process.env.FORCED_ENTRIES || "false").toLowerCase() === "true"
  },

  // Live trading settings (Polymarket CLOB)
  liveTrading: {
    enabled: (process.env.LIVE_TRADING_ENABLED || "false").toLowerCase() === "true",

    // Conservative defaults; scale up later as bankroll grows.
    maxPerTradeUsd: Number(process.env.LIVE_MAX_PER_TRADE_USD) || 7,
    maxOpenExposureUsd: Number(process.env.LIVE_MAX_OPEN_EXPOSURE_USD) || 10,
    // Kill switch: if realized PnL for the day <= -maxDailyLossUsd, stop live trading.
    // Reset mode: "midnight_pt" (default)
    maxDailyLossUsd: Number(process.env.LIVE_MAX_DAILY_LOSS_USD) || 30,
    dailyLossReset: (process.env.LIVE_DAILY_LOSS_RESET || "midnight_pt").toLowerCase(),

    // Optional: ignore fills before this epoch second when computing today's realized PnL
    // (useful if we deployed risk controls late and want a clean slate without deleting history)
    pnlStartEpochSec: (process.env.LIVE_PNL_START_EPOCH_SEC != null && String(process.env.LIVE_PNL_START_EPOCH_SEC).trim() !== '')
      ? Number(process.env.LIVE_PNL_START_EPOCH_SEC)
      : null,

    // Execution preferences
    allowMarketOrders: (process.env.LIVE_ALLOW_MARKET_ORDERS || "false").toLowerCase() === "true",
    // Safety default: post-only until full position lifecycle (fills + exits) is implemented.
    postOnly: (process.env.LIVE_POST_ONLY || "true").toLowerCase() === "true",

    // Take-profit on high-priced outcome token regardless of time left.
    // Example: 0.90 means if mark >= 0.90 (90¢), exit.
    takeProfitPrice: (process.env.LIVE_TAKE_PROFIT_PRICE != null && String(process.env.LIVE_TAKE_PROFIT_PRICE).trim() !== '')
      ? Number(process.env.LIVE_TAKE_PROFIT_PRICE)
      : null
  },

  // UI server settings
  uiPort: Number(process.env.UI_PORT) || 3000
};
