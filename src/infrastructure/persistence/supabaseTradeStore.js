/**
 * @file Supabase trade store — hosted PostgreSQL persistence replacing SQLite.
 *
 * Async implementation of the same interface as TradeStore (tradeStore.js).
 * All methods return Promises. Uses @supabase/supabase-js client.
 *
 * Setup:
 *   1. Create a Supabase project at supabase.com
 *   2. Run the SQL schema from .planning/supabase-schema.sql in the SQL editor
 *   3. Set env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 *
 * Architecture: Infrastructure layer (I/O).
 */

import { createClient } from '@supabase/supabase-js';

// ── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;

/**
 * Get the singleton SupabaseTradeStore instance.
 * @returns {SupabaseTradeStore}
 */
export function getSupabaseTradeStore() {
  if (_instance) return _instance;
  _instance = new SupabaseTradeStore();
  return _instance;
}

/**
 * Reset singleton (for testing).
 */
export function resetSupabaseTradeStore() {
  _instance = null;
}

// ── Store class ────────────────────────────────────────────────────────────

export class SupabaseTradeStore {
  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. ' +
        'Create a project at supabase.com and add credentials to .env'
      );
    }

    this.client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }

  // ─── Trade CRUD ──────────────────────────────────────────────────────────

  /**
   * Insert or upsert a trade record.
   * @param {Object} trade
   * @param {string} [mode='paper']
   */
  async insertTrade(trade, mode = 'paper') {
    if (!trade) return;

    const row = this._normalizeTradeToRow(trade, mode);

    const { error } = await this.client
      .from('trades')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      throw new Error(`[SupabaseTradeStore] insertTrade failed: ${error.message}`);
    }
  }

  /**
   * Insert multiple trades in chunks (for migration).
   * @param {Object[]} trades
   * @param {string} [mode='paper']
   * @returns {{ migrated: number, skipped: number }}
   */
  async insertMany(trades, mode = 'paper') {
    if (!Array.isArray(trades) || trades.length === 0) {
      return { migrated: 0, skipped: 0 };
    }

    const CHUNK_SIZE = 50;
    let migrated = 0;
    let skipped = 0;

    for (let i = 0; i < trades.length; i += CHUNK_SIZE) {
      const chunk = trades.slice(i, i + CHUNK_SIZE);
      const rows = chunk
        .filter(t => t && t.id)
        .map(t => this._normalizeTradeToRow(t, mode));

      skipped += chunk.length - rows.length;

      if (rows.length === 0) continue;

      const { error } = await this.client
        .from('trades')
        .upsert(rows, { onConflict: 'id' });

      if (error) {
        console.warn(`[SupabaseTradeStore] insertMany chunk error: ${error.message}`);
        skipped += rows.length;
      } else {
        migrated += rows.length;
      }
    }

    return { migrated, skipped };
  }

  /**
   * Update an existing trade (e.g., close it).
   * @param {string} tradeId
   * @param {Object} updateData
   */
  async updateTrade(tradeId, updateData) {
    if (!tradeId || !updateData) return;

    const patch = {};
    const numFields = [
      'exitPrice', 'pnl', 'maxUnrealizedPnl', 'minUnrealizedPnl',
      'btcSpotAtExit', 'rsiAtExit', 'macdHistAtExit', 'vwapSlopeAtExit',
      'modelUpAtExit', 'modelDownAtExit',
    ];

    if (updateData.status !== undefined) patch.status = updateData.status;
    if (updateData.exitTime !== undefined) patch.exitTime = updateData.exitTime;
    if (updateData.exitReason !== undefined) patch.exitReason = updateData.exitReason;

    for (const field of numFields) {
      const val = this._toNum(updateData[field]);
      if (val !== null) patch[field] = val;
    }

    patch.updatedAt = new Date().toISOString();

    const { error } = await this.client
      .from('trades')
      .update(patch)
      .eq('id', tradeId);

    if (error) {
      throw new Error(`[SupabaseTradeStore] updateTrade failed: ${error.message}`);
    }
  }

  /**
   * Get a trade by ID.
   * @param {string} tradeId
   * @returns {Object|null}
   */
  async getTradeById(tradeId) {
    const { data, error } = await this.client
      .from('trades')
      .select('*')
      .eq('id', tradeId)
      .maybeSingle();

    if (error) throw new Error(`[SupabaseTradeStore] getTradeById failed: ${error.message}`);
    return data ? this._rowToTrade(data) : null;
  }

  /**
   * Get all trades ordered by timestamp ASC.
   * @returns {Object[]}
   */
  async getAllTrades() {
    const { data, error } = await this.client
      .from('trades')
      .select('*')
      .order('timestamp', { ascending: true });

    if (error) throw new Error(`[SupabaseTradeStore] getAllTrades failed: ${error.message}`);
    return (data || []).map(r => this._rowToTrade(r));
  }

  /**
   * Get closed trades only.
   * @returns {Object[]}
   */
  async getClosedTrades() {
    const { data, error } = await this.client
      .from('trades')
      .select('*')
      .eq('status', 'CLOSED')
      .order('timestamp', { ascending: true });

    if (error) throw new Error(`[SupabaseTradeStore] getClosedTrades failed: ${error.message}`);
    return (data || []).map(r => this._rowToTrade(r));
  }

  /**
   * Get open trades.
   * @returns {Object[]}
   */
  async getOpenTrades() {
    const { data, error } = await this.client
      .from('trades')
      .select('*')
      .eq('status', 'OPEN')
      .order('timestamp', { ascending: true });

    if (error) throw new Error(`[SupabaseTradeStore] getOpenTrades failed: ${error.message}`);
    return (data || []).map(r => this._rowToTrade(r));
  }

  /**
   * Get first open trade (replaces getOpenTrade()).
   * @returns {Object|null}
   */
  async getFirstOpenTrade() {
    const trades = await this.getOpenTrades();
    return trades.length > 0 ? trades[0] : null;
  }

  /**
   * Get total trade count.
   * @returns {number}
   */
  async getTradeCount() {
    const { count, error } = await this.client
      .from('trades')
      .select('*', { count: 'exact', head: true });

    if (error) throw new Error(`[SupabaseTradeStore] getTradeCount failed: ${error.message}`);
    return count || 0;
  }

  /**
   * Get closed trade count.
   * @returns {number}
   */
  async getClosedTradeCount() {
    const { count, error } = await this.client
      .from('trades')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'CLOSED');

    if (error) throw new Error(`[SupabaseTradeStore] getClosedTradeCount failed: ${error.message}`);
    return count || 0;
  }

  // ─── Summary / Meta ──────────────────────────────────────────────────────

  /**
   * Recalculate summary from closed trades (computed client-side).
   * @returns {{ totalTrades: number, wins: number, losses: number, totalPnL: number, winRate: number }}
   */
  async recalculateSummary() {
    const [allTrades, closedTrades] = await Promise.all([
      this.getAllTrades(),
      this.getClosedTrades(),
    ]);

    let wins = 0, losses = 0, totalPnL = 0;
    for (const t of closedTrades) {
      const pnl = typeof t.pnl === 'number' ? t.pnl : 0;
      totalPnL += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    }

    const closedCount = wins + losses;
    const winRate = closedCount > 0 ? Number(((wins / closedCount) * 100).toFixed(2)) : 0;

    return {
      totalTrades: allTrades.length,
      wins,
      losses,
      totalPnL,
      winRate,
    };
  }

  /**
   * Get the trade summary (computed from trades).
   * @returns {{ totalTrades: number, wins: number, losses: number, totalPnL: number, winRate: number }}
   */
  async getSummary() {
    return this.recalculateSummary();
  }

  /**
   * Get meta data ({ realizedOffset }).
   * Meta is stored in local memory only (Supabase version doesn't need a meta table).
   * @returns {{ realizedOffset: number }}
   */
  getMeta() {
    return { realizedOffset: this._realizedOffset ?? 0 };
  }

  /**
   * Update meta data.
   * @param {{ realizedOffset: number }} meta
   */
  updateMeta(meta) {
    this._realizedOffset = meta?.realizedOffset ?? 0;
  }

  // ─── Ledger-compatible interface ─────────────────────────────────────────

  /**
   * Get data in the same shape as loadLedger() for backward compatibility.
   * @returns {{ trades: Object[], summary: Object, meta: Object }}
   */
  async getLedgerData() {
    const [trades, summary] = await Promise.all([
      this.getAllTrades(),
      this.getSummary(),
    ]);
    return { trades, summary, meta: this.getMeta() };
  }

  // ─── Migration ───────────────────────────────────────────────────────────

  /**
   * Migrate trades from JSON ledger to Supabase.
   * @param {{ trades: Object[], summary: Object, meta: Object }} ledgerData
   * @param {string} [mode='paper']
   * @returns {{ migrated: number, skipped: number }}
   */
  async migrateFromLedger(ledgerData, mode = 'paper') {
    if (!ledgerData || !Array.isArray(ledgerData.trades)) {
      return { migrated: 0, skipped: 0 };
    }

    console.log(`[SupabaseTradeStore] Migrating ${ledgerData.trades.length} trades from JSON ledger...`);

    const result = await this.insertMany(ledgerData.trades, mode);

    if (ledgerData.meta) {
      this.updateMeta(ledgerData.meta);
    }

    console.log(
      `[SupabaseTradeStore] Migration complete: ${result.migrated} migrated, ${result.skipped} skipped`
    );

    return result;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * No-op — Supabase client manages its own connection pool.
   */
  close() {
    // no-op
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  /**
   * Convert a trade object to a Supabase row.
   * Column names match the PostgreSQL schema (camelCase, quoted in SQL but plain in JS).
   */
  _normalizeTradeToRow(trade, mode) {
    const knownFields = new Set([
      'id', 'timestamp', 'status', 'side', 'entryPrice', 'exitPrice', 'shares',
      'contractSize', 'pnl', 'entryTime', 'exitTime', 'exitReason', 'entryPhase',
      'marketSlug', 'sideInferred', 'modelProbAtEntry', 'edgeAtEntry', 'rsiAtEntry',
      'vwapDistAtEntry', 'spreadAtEntry', 'liquidityAtEntry', 'volumeNumAtEntry',
      'btcSpotAtEntry', 'spotImpulsePctAtEntry', 'heikenColorAtEntry',
      'heikenCountAtEntry', 'rangePct20AtEntry', 'recActionAtEntry',
      'macdValueAtEntry', 'macdHistAtEntry', 'macdSignalAtEntry', 'vwapSlopeAtEntry',
      'modelUpAtEntry', 'modelDownAtEntry', 'timeLeftMinAtEntry',
      'maxEntryPolyPriceAtEntry', 'btcSpotAtExit', 'rsiAtExit', 'macdHistAtExit',
      'vwapSlopeAtExit', 'modelUpAtExit', 'modelDownAtExit',
      'maxUnrealizedPnl', 'minUnrealizedPnl', 'entryGateSnapshot', 'mode',
    ]);

    const extra = {};
    for (const [k, v] of Object.entries(trade)) {
      if (!knownFields.has(k) && v !== undefined && v !== null) {
        extra[k] = v;
      }
    }

    const gateSnapshot = trade.entryGateSnapshot
      ? (typeof trade.entryGateSnapshot === 'string'
        ? trade.entryGateSnapshot
        : JSON.stringify(trade.entryGateSnapshot))
      : null;

    return {
      id: trade.id || `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: trade.timestamp || new Date().toISOString(),
      status: trade.status || 'OPEN',
      side: trade.side || null,
      entryPrice: this._toNum(trade.entryPrice),
      exitPrice: this._toNum(trade.exitPrice),
      shares: this._toNum(trade.shares),
      contractSize: this._toNum(trade.contractSize),
      pnl: this._toNum(trade.pnl) ?? 0,
      entryTime: trade.entryTime || trade.timestamp || null,
      exitTime: trade.exitTime || null,
      exitReason: trade.exitReason || null,
      entryPhase: trade.entryPhase || null,
      marketSlug: trade.marketSlug || null,
      sideInferred: trade.sideInferred ?? null,
      modelProbAtEntry: this._toNum(trade.modelProbAtEntry),
      edgeAtEntry: this._toNum(trade.edgeAtEntry),
      rsiAtEntry: this._toNum(trade.rsiAtEntry),
      vwapDistAtEntry: this._toNum(trade.vwapDistAtEntry),
      spreadAtEntry: this._toNum(trade.spreadAtEntry),
      liquidityAtEntry: this._toNum(trade.liquidityAtEntry),
      volumeNumAtEntry: this._toNum(trade.volumeNumAtEntry),
      btcSpotAtEntry: this._toNum(trade.btcSpotAtEntry),
      spotImpulsePctAtEntry: this._toNum(trade.spotImpulsePctAtEntry),
      heikenColorAtEntry: trade.heikenColorAtEntry || null,
      heikenCountAtEntry: typeof trade.heikenCountAtEntry === 'number' ? trade.heikenCountAtEntry : null,
      rangePct20AtEntry: this._toNum(trade.rangePct20AtEntry),
      recActionAtEntry: trade.recActionAtEntry || null,
      macdValueAtEntry: this._toNum(trade.macdValueAtEntry),
      macdHistAtEntry: this._toNum(trade.macdHistAtEntry),
      macdSignalAtEntry: this._toNum(trade.macdSignalAtEntry),
      vwapSlopeAtEntry: this._toNum(trade.vwapSlopeAtEntry) ?? this._toNum(trade.vwapSlope),
      modelUpAtEntry: this._toNum(trade.modelUpAtEntry) ?? this._toNum(trade.modelUp),
      modelDownAtEntry: this._toNum(trade.modelDownAtEntry) ?? this._toNum(trade.modelDown),
      timeLeftMinAtEntry: this._toNum(trade.timeLeftMinAtEntry),
      maxEntryPolyPriceAtEntry: this._toNum(trade.maxEntryPolyPriceAtEntry),
      btcSpotAtExit: this._toNum(trade.btcSpotAtExit),
      rsiAtExit: this._toNum(trade.rsiAtExit),
      macdHistAtExit: this._toNum(trade.macdHistAtExit),
      vwapSlopeAtExit: this._toNum(trade.vwapSlopeAtExit),
      modelUpAtExit: this._toNum(trade.modelUpAtExit),
      modelDownAtExit: this._toNum(trade.modelDownAtExit),
      maxUnrealizedPnl: this._toNum(trade.maxUnrealizedPnl),
      minUnrealizedPnl: this._toNum(trade.minUnrealizedPnl),
      entryGateSnapshot: gateSnapshot,
      mode: mode || 'paper',
      extraJson: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Convert a Supabase row back to a trade object (matching JSON ledger shape).
   */
  _rowToTrade(row) {
    if (!row) return null;

    const trade = {
      id: row.id,
      timestamp: row.timestamp,
      status: row.status,
      side: row.side,
      entryPrice: row.entryPrice,
      exitPrice: row.exitPrice,
      shares: row.shares,
      contractSize: row.contractSize,
      pnl: row.pnl,
      entryTime: row.entryTime,
      exitTime: row.exitTime,
      exitReason: row.exitReason,
      entryPhase: row.entryPhase,
      marketSlug: row.marketSlug,
      sideInferred: row.sideInferred,
    };

    const enrichments = [
      'modelProbAtEntry', 'edgeAtEntry', 'rsiAtEntry', 'vwapDistAtEntry',
      'spreadAtEntry', 'liquidityAtEntry', 'volumeNumAtEntry', 'btcSpotAtEntry',
      'spotImpulsePctAtEntry', 'heikenColorAtEntry', 'heikenCountAtEntry',
      'rangePct20AtEntry', 'recActionAtEntry', 'macdValueAtEntry',
      'macdHistAtEntry', 'macdSignalAtEntry', 'vwapSlopeAtEntry',
      'modelUpAtEntry', 'modelDownAtEntry', 'timeLeftMinAtEntry',
      'maxEntryPolyPriceAtEntry', 'btcSpotAtExit', 'rsiAtExit',
      'macdHistAtExit', 'vwapSlopeAtExit', 'modelUpAtExit', 'modelDownAtExit',
      'maxUnrealizedPnl', 'minUnrealizedPnl',
    ];

    for (const field of enrichments) {
      if (row[field] !== null && row[field] !== undefined) {
        trade[field] = row[field];
      }
    }

    if (row.entryGateSnapshot) {
      try {
        trade.entryGateSnapshot = JSON.parse(row.entryGateSnapshot);
      } catch {
        trade.entryGateSnapshot = row.entryGateSnapshot;
      }
    }

    if (row.extraJson) {
      try {
        const extra = JSON.parse(row.extraJson);
        Object.assign(trade, extra);
      } catch {
        // ignore malformed extra
      }
    }

    return trade;
  }

  /**
   * Safely convert to number or null.
   */
  _toNum(val) {
    if (val === null || val === undefined) return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
}
