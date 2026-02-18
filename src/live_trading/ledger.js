import fs from 'fs';
import path from 'path';

const ROOT = path.join(process.cwd(), 'live_trading');
const TRADES_PATH = path.join(ROOT, 'trades.json');

let state = {
  trades: [],
  meta: {
    createdAt: new Date().toISOString(),
  }
};

function ensureRoot() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}

export async function initializeLiveLedger() {
  ensureRoot();
  if (!fs.existsSync(TRADES_PATH)) {
    fs.writeFileSync(TRADES_PATH, JSON.stringify(state, null, 2));
    return state;
  }
  try {
    const raw = fs.readFileSync(TRADES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') state = parsed;
  } catch {
    // keep default
  }
  return state;
}

export function getLiveLedger() {
  return state;
}

export async function appendLiveTrade(trade) {
  ensureRoot();
  state.trades = Array.isArray(state.trades) ? state.trades : [];
  state.trades.push(trade);
  fs.writeFileSync(TRADES_PATH, JSON.stringify(state, null, 2));
}
