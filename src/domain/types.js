/**
 * Domain type definitions for the trading system.
 * Pure JSDoc typedefs — no runtime code.
 */

/**
 * @typedef {'UP' | 'DOWN'} TradeSide
 */

/**
 * @typedef {'OPEN' | 'CLOSED'} TradeStatus
 */

/**
 * @typedef {'EARLY' | 'MID' | 'LATE'} TradePhase
 */

/**
 * Unified view of an open position, used by both paper and live executors.
 *
 * @typedef {Object} PositionView
 * @property {string} id              - Trade ID (paper) or tokenID (live)
 * @property {TradeSide} side         - 'UP' or 'DOWN'
 * @property {string} marketSlug      - Market slug at entry
 * @property {number} entryPrice      - Average entry price (dollars, 0..1)
 * @property {number} shares          - Current share count
 * @property {number} contractSize    - Dollar notional at entry
 * @property {number|null} mark       - Current mark price (dollars, 0..1)
 * @property {number|null} unrealizedPnl - Current unrealized PnL ($)
 * @property {number} maxUnrealizedPnl   - MFE (maximum favorable excursion)
 * @property {number} minUnrealizedPnl   - MAE (maximum adverse excursion)
 * @property {string} entryTime       - ISO timestamp of entry
 * @property {number|null} lastTradeTime - Epoch seconds of last trade (live)
 * @property {string|null} [tokenID]  - CLOB token ID (for live executor)
 * @property {string|null} [outcome]  - 'UP'/'DOWN' label from CLOB outcome
 * @property {Object} [metadata]      - Analytics fields from entry
 */

/**
 * Request to open a new position.
 *
 * @typedef {Object} OrderRequest
 * @property {TradeSide} side         - 'UP' or 'DOWN'
 * @property {string} marketSlug      - Current market slug
 * @property {number} sizeUsd         - Dollar amount to risk
 * @property {number} price           - Entry price (dollars, 0..1)
 * @property {TradePhase} phase       - 'EARLY' | 'MID' | 'LATE'
 * @property {boolean} [sideInferred] - Whether side was inferred (loose mode)
 * @property {Object} [metadata]      - Analytics fields to attach to trade record
 */

/**
 * Result of opening a position.
 *
 * @typedef {Object} OrderResult
 * @property {boolean} filled         - Whether the order was filled
 * @property {string|null} tradeId    - Unique trade identifier
 * @property {number} fillPrice       - Actual fill price (may differ due to slippage)
 * @property {number} fillShares      - Number of shares filled
 * @property {number} fillSizeUsd     - Actual dollar amount filled
 * @property {string} [orderId]       - CLOB order ID (live only)
 */

/**
 * Request to close a position.
 *
 * @typedef {Object} CloseRequest
 * @property {string} tradeId         - Trade to close (paper) or position ID (live)
 * @property {TradeSide} side         - 'UP' or 'DOWN'
 * @property {number} shares          - Number of shares to sell
 * @property {string} reason          - Exit reason string
 * @property {string} [tokenID]       - CLOB token ID (live only)
 */

/**
 * Result of closing a position.
 *
 * @typedef {Object} CloseResult
 * @property {boolean} closed         - Whether the close succeeded
 * @property {number} exitPrice       - Realized exit price
 * @property {number} pnl             - Realized PnL for this close ($)
 * @property {string} reason          - Exit reason
 */

/**
 * Decision to exit a position.
 *
 * @typedef {Object} ExitDecision
 * @property {string} reason          - Human-readable exit reason
 * @property {boolean} [flip]         - Whether to immediately open the opposite side
 */

/**
 * Snapshot of current account balance.
 *
 * @typedef {Object} BalanceSnapshot
 * @property {number} balance         - Current available balance ($)
 * @property {number} starting        - Starting balance ($)
 * @property {number} realized        - Total realized PnL ($)
 */

/**
 * Per-position grace-window state, managed by TradingEngine.
 *
 * @typedef {Object} GraceState
 * @property {number|null} breachAtMs - Timestamp when max-loss was first breached
 * @property {boolean} used           - Whether grace has already been used once
 */

/**
 * Full exit evaluation result returned by evaluateExits().
 *
 * @typedef {Object} ExitResult
 * @property {ExitDecision|null} decision         - Exit to execute, or null (hold)
 * @property {'START_GRACE'|'CLEAR_GRACE'|null} graceAction - Grace-timer action for engine
 * @property {number|null} pnlNow                - Current unrealized PnL (for MFE/MAE tracking)
 * @property {boolean} opposingMoreLikely         - Whether opposing model prob dominates
 */

export {};
