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

  // Polymarket API endpoints
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  // Polling and candle settings
  pollIntervalMs: 3_000, // slightly faster for 5m markets
  candleWindowMinutes: 5,

  // Indicator settings
  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  // Polymarket market settings
  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: process.env.POLYMARKET_SERIES_ID || "10192",
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
    minProbEarly: Number(process.env.MIN_PROB_EARLY) || 0.56,
    minProbMid: Number(process.env.MIN_PROB_MID) || 0.59,
    minProbLate: Number(process.env.MIN_PROB_LATE) || 0.63,
    
    edgeEarly: Number(process.env.EDGE_EARLY) || 0.05,
    edgeMid: Number(process.env.EDGE_MID) || 0.08,
    edgeLate: Number(process.env.EDGE_LATE) || 0.16,

    // Extra strictness knobs (used to improve odds without killing trade count)
    // MID entries tend to be weaker; require a bit more strength.
    midProbBoost: Number(process.env.MID_PROB_BOOST) || 0.02,
    midEdgeBoost: Number(process.env.MID_EDGE_BOOST) || 0.02,

    // In loose mode (rec gating ignored) when side is inferred, require stronger signals.
    inferredProbBoost: Number(process.env.INFERRED_PROB_BOOST) || 0.03,
    inferredEdgeBoost: Number(process.env.INFERRED_EDGE_BOOST) || 0.03,
    
    // Exit settings
    // Stop loss is enabled for Polymarket paper trades.
    // Example: 0.25 => cut the trade if it loses 25% of contractSize.
    stopLossPct: Number(process.env.STOP_LOSS_PCT) || 0.20,
    // Take profit remains unused for now.
    takeProfitPct: Number(process.env.TAKE_PROFIT_PCT) || 0.08, // unused

    // Dynamic exit: close when opposite side becomes more likely.
    // Example: if you're in UP and modelDown >= modelUp + exitFlipMargin AND modelDown >= exitFlipMinProb → exit.
    exitFlipMinProb: Number(process.env.EXIT_FLIP_MIN_PROB) || 0.62,
    exitFlipMargin: Number(process.env.EXIT_FLIP_MARGIN) || 0.06,
    // Avoid noisy early flips: require trade to be open at least this long before flip-exit is allowed.
    exitFlipMinHoldSeconds: Number(process.env.EXIT_FLIP_MIN_HOLD_SECONDS) || 30,

    // When a probability flip happens, optionally close and immediately open the other side.
    // Default OFF (analytics showed flips were a major drag on PnL). Set FLIP_ON_PROB_FLIP=true to re-enable.
    flipOnProbabilityFlip: (process.env.FLIP_ON_PROB_FLIP || "false").toLowerCase() === "true",
    flipCooldownSeconds: Number(process.env.FLIP_COOLDOWN_SECONDS) || 180,
    
    // Market quality filters
    // Liquidity filter (Polymarket market.liquidityNum). Raise this to avoid thin markets.
    minLiquidity: Number(process.env.MIN_LIQUIDITY) || 10000,
    // (disabled) Market volume filter. Use volatility/chop filters instead.
    // Set MIN_MARKET_VOLUME_NUM > 0 to re-enable.
    minMarketVolumeNum: Number(process.env.MIN_MARKET_VOLUME_NUM) || 0,
    // Max allowed Polymarket orderbook spread (dollars). 0.008 = 0.8¢
    maxSpread: Number(process.env.MAX_SPREAD) || 0.008,

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

    // Volume filters (set to 0 to disable)
    // volumeRecent is sum of last 20x 1m candle volumes
    minVolumeRecent: Number(process.env.MIN_VOLUME_RECENT) || 0,
    // require volumeRecent >= volumeAvg * minVolumeRatio (volumeAvg is approx avg per-20m block)
    minVolumeRatio: Number(process.env.MIN_VOLUME_RATIO) || 0,

    // Polymarket price sanity (dollars, 0..1). Prevent "0.00" entries.
    // Example: 0.002 = 0.2¢
    // Avoid "dust" Polymarket prices where spread/tick noise dominates.
    // 0.005 = 0.5¢
    minPolyPrice: Number(process.env.MIN_POLY_PRICE) || 0.005,
    maxPolyPrice: Number(process.env.MAX_POLY_PRICE) || 0.98,
    // Avoid extremely skewed markets where one side is near-zero (often leads to bad fills/marking).
    // Require the opposite side price to be at least this value (dollars).
    minOppositePolyPrice: Number(process.env.MIN_OPPOSITE_POLY_PRICE) || 0.004,
    
    // Chop/volatility filter (BTC reference): block entries when recent movement is too small.
    // rangePct20 = (max(close,last20) - min(close,last20)) / lastClose
    // Moderate default: require ~0.20% range over last 20 minutes.
    minRangePct20: Number(process.env.MIN_RANGE_PCT_20) || 0.002,

    // Confidence filter: avoid coin-flip markets where the model is near 50/50.
    // We require max(modelUp, modelDown) >= this value to allow entries.
    minModelMaxProb: Number(process.env.MIN_MODEL_MAX_PROB) || 0.53,

    // RSI consolidation/regime filter: avoid known-bad RSI band.
    // Default blocks entries when RSI is in [30,45) (observed as a losing bucket).
    noTradeRsiMin: Number(process.env.NO_TRADE_RSI_MIN) || 30,
    noTradeRsiMax: Number(process.env.NO_TRADE_RSI_MAX) || 45,

    // Time filters
    noEntryFinalMinutes: Number(process.env.NO_ENTRY_FINAL_MIN) || 1,

    // Require enough 1m candles before allowing entries (helps avoid 50/50 startup)
    minCandlesForEntry: Number(process.env.MIN_CANDLES_FOR_ENTRY) || 20,
    
    // Rec gating controls whether we require the engine to explicitly say ENTER.
    // - strict: must be Rec=ENTER
    // - loose: allow entry if thresholds hit, even when Rec=NO_TRADE/HOLD
    recGating: (process.env.REC_GATING || "loose").toLowerCase(),

    // Forced entries OFF by default
    forcedEntriesEnabled: (process.env.FORCED_ENTRIES || "false").toLowerCase() === "true"
  },

  // UI server settings
  uiPort: Number(process.env.UI_PORT) || 3000
};
