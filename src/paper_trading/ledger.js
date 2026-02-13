import fs from "node:fs";
import path from "node:path";
import { sleep } from "../utils.js";

const MEMORY_DIR = "./memory"; // Assuming memory directory is accessible or relevant

// Ledger path can be overridden for A/B tests or multiple instances.
// Example: LEDGER_PATH=./paper_trading/trades.breakout.json
const TRADES_FILE = process.env.LEDGER_PATH || "./paper_trading/trades.json";

// Ensure directories exist
function ensureDirs() {
  if (!fs.existsSync("./paper_trading")) {
    fs.mkdirSync("./paper_trading");
  }
  // If MEMORY_DIR is intended for this, adjust path accordingly.
  // For simplicity, placing trades.json in paper_trading folder.
}

// Load trades and summary from JSON file
export function loadLedger() {
  ensureDirs();
  try {
    if (fs.existsSync(TRADES_FILE)) {
      const data = fs.readFileSync(TRADES_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`Error loading ledger from ${TRADES_FILE}:`, error);
  }
  // Default structure if file doesn't exist or is invalid
  return {
    trades: [],
    summary: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      winRate: 0
    }
  };
}

let currentLedger = null;

// Save trades and summary to JSON file
export async function saveLedger(ledger) {
  ensureDirs();
  try {
    // Use JSON.stringify with indentation for readability
    fs.writeFileSync(TRADES_FILE, JSON.stringify(ledger, null, 2), "utf8");
  } catch (error) {
    console.error(`Error saving ledger to ${TRADES_FILE}:`, error);
  }
}

// Update ledger and persist it
export async function updateLedger(updateFn) {
  if (currentLedger === null) {
    currentLedger = loadLedger();
  }
  
  try {
    updateFn(currentLedger);
    await saveLedger(currentLedger); // Save changes to file
  } catch (error) {
    console.error("Error updating ledger:", error);
  }
}

// Recalculate summary statistics
export function recalculateSummary(trades) {
  let wins = 0;
  let losses = 0;
  let totalPnL = 0;
  
  for (const trade of trades) {
    if (trade.status === "CLOSED") {
      totalPnL += trade.pnl;
      if (trade.pnl > 0) {
        wins += 1;
      } else {
        losses += 1;
      }
    }
  }
  
  const totalClosedTrades = wins + losses;
  const winRate = totalClosedTrades > 0 ? (wins / totalClosedTrades) * 100 : 0;
  
  return {
    totalTrades: trades.length,
    wins,
    losses,
    totalPnL,
    winRate: Number(winRate.toFixed(2)) // Format win rate
  };
}

// Initialize ledger
export async function initializeLedger() {
  if (currentLedger !== null) return currentLedger;

  currentLedger = loadLedger();
  // Ensure summary is up-to-date on load
  currentLedger.summary = recalculateSummary(currentLedger.trades);
  await saveLedger(currentLedger); // Save to ensure clean format
  console.log("Ledger initialized. Trades:", currentLedger.trades.length, "Summary:", currentLedger.summary);
  return currentLedger;
}

// Add a new trade record
export async function addTrade(trade) {
  // Ledger-level sanity: never persist an invalid OPEN trade.
  const isOpen = (trade?.status ?? "OPEN") === "OPEN";
  if (isOpen) {
    const ep = trade?.entryPrice;
    const sh = trade?.shares;
    const badEp = typeof ep !== "number" || !Number.isFinite(ep) || ep <= 0;
    const badSh = sh !== null && sh !== undefined && (!Number.isFinite(Number(sh)) || Number(sh) <= 0);
    if (badEp || badSh) {
      console.warn("Refusing to add invalid OPEN trade to ledger:", { entryPrice: ep, shares: sh, side: trade?.side });
      return;
    }
  }

  await updateLedger((ledger) => {
    const newTrade = {
      ...trade,
      // Only generate if missing (don't break caller references)
      id: trade.id ?? (Date.now().toString() + Math.random().toString(36).substring(2, 7)),
      timestamp: trade.timestamp ?? new Date().toISOString(),
      status: trade.status ?? "OPEN",
      pnl: typeof trade.pnl === "number" ? trade.pnl : 0
    };
    ledger.trades.push(newTrade);
    ledger.summary = recalculateSummary(ledger.trades);
  });
  console.log("Trade added:", trade.side, "at", trade.entryPrice);
}

// Update an existing trade (e.g., close it)
export async function updateTrade(tradeId, updateData) {
  await updateLedger((ledger) => {
    const tradeIndex = ledger.trades.findIndex(t => t.id === tradeId);
    if (tradeIndex !== -1) {
      ledger.trades[tradeIndex] = { ...ledger.trades[tradeIndex], ...updateData };
      ledger.summary = recalculateSummary(ledger.trades); // Recalculate summary after update
      console.log("Trade updated:", tradeId, "with data:", updateData);
    } else {
      console.warn(`Trade with ID ${tradeId} not found for update.`);
    }
  });
}

// Get a specific open trade (if any)
export function getOpenTrade() {
  if (currentLedger === null) {
    currentLedger = loadLedger();
  }
  // Assuming only one trade can be open at a time for simplicity in this strategy
  return currentLedger.trades.find(t => t.status === "OPEN");
}

// Get all trades and summary
export function getLedger() {
  if (currentLedger === null) {
    currentLedger = loadLedger();
  }
  return { ...currentLedger }; // Return a copy to prevent direct mutation
}

// NOTE: Do not auto-initialize on module import.
// Call initializeLedger() explicitly from the app bootstrap (index.js) so we don't double-log / double-write.

