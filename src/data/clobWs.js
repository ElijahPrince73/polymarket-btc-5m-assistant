/**
 * @file CLOB WebSocket orderbook stream.
 *
 * Connects to the Polymarket CLOB WebSocket for real-time orderbook updates.
 * Maintains in-memory best bid/ask/spread per tokenId.
 * Uses exponential backoff for reconnects (same pattern as polymarketLiveWs.js).
 *
 * WebSocket endpoint: wss://ws-subscriptions-sink.polymarket.com/ws/market
 * Subscribe by sending: { "type": "subscribe", "channel": "book", "assets_ids": [...tokenIds] }
 */

import WebSocket from 'ws';
import { wsAgentForUrl } from '../net/proxy.js';

const WS_URL = 'wss://ws-subscriptions-sink.polymarket.com/ws/market';

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} BookSnapshot
 * @property {number|null} bestBid
 * @property {number|null} bestAsk
 * @property {number|null} spread
 * @property {number} updatedAtMs
 */

/**
 * Start a CLOB orderbook WebSocket stream.
 *
 * @param {Object} opts
 * @param {string[]} opts.tokenIds - CLOB token IDs to subscribe to
 * @param {Function} [opts.onBookUpdate] - Called with (tokenId, bookSnapshot)
 * @returns {{ getBook: (tokenId: string) => BookSnapshot|null, updateSubscriptions: (tokenIds: string[]) => void, close: () => void }}
 */
export function startClobOrderbookStream({ tokenIds = [], onBookUpdate } = {}) {
  /** @type {Map<string, BookSnapshot>} */
  const books = new Map();

  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let currentTokenIds = [...tokenIds];

  const connect = () => {
    if (closed) return;

    try {
      const agent = wsAgentForUrl?.(WS_URL) ?? undefined;
      ws = new WebSocket(WS_URL, {
        handshakeTimeout: 10_000,
        ...(agent ? { agent } : {}),
      });
    } catch (e) {
      console.warn('clobWs: Failed to create WebSocket:', e?.message);
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      console.log('clobWs: Connected to CLOB orderbook stream');
      reconnectMs = 500; // Reset backoff

      // Subscribe to book channel
      if (currentTokenIds.length > 0) {
        sendSubscribe(currentTokenIds);
      }
    });

    ws.on('message', (raw) => {
      const msg = safeJsonParse(String(raw));
      if (!msg) return;

      // Handle book updates
      if (msg.channel === 'book' || msg.type === 'book') {
        processBookMessage(msg);
      }
    });

    ws.on('close', (code) => {
      if (!closed) {
        console.log(`clobWs: Disconnected (code ${code}), reconnecting...`);
        scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      console.warn('clobWs: WebSocket error:', err?.message);
      // close event will fire and trigger reconnect
    });
  };

  const scheduleReconnect = () => {
    if (closed) return;
    setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, 30_000); // Cap at 30s
  };

  const sendSubscribe = (ids) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'book',
        assets_ids: ids,
      }));
      console.log(`clobWs: Subscribed to ${ids.length} tokens`);
    } catch (e) {
      console.warn('clobWs: Failed to subscribe:', e?.message);
    }
  };

  const sendUnsubscribe = (ids) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({
        type: 'unsubscribe',
        channel: 'book',
        assets_ids: ids,
      }));
    } catch {
      // best-effort
    }
  };

  const processBookMessage = (msg) => {
    // Parse different possible message formats
    const tokenId = msg.asset_id || msg.token_id || msg.market || null;
    if (!tokenId) return;

    const bids = Array.isArray(msg.bids) ? msg.bids : [];
    const asks = Array.isArray(msg.asks) ? msg.asks : [];

    // Get current snapshot or create new one
    const prev = books.get(tokenId) || { bestBid: null, bestAsk: null, spread: null, updatedAtMs: 0 };

    // Parse best bid/ask from levels
    const bestBid = bids.length > 0 ? Number(bids[0].price ?? bids[0][0]) : prev.bestBid;
    const bestAsk = asks.length > 0 ? Number(asks[0].price ?? asks[0][0]) : prev.bestAsk;

    const validBid = Number.isFinite(bestBid) && bestBid > 0 ? bestBid : null;
    const validAsk = Number.isFinite(bestAsk) && bestAsk > 0 ? bestAsk : null;

    const spread = (validBid !== null && validAsk !== null) ? validAsk - validBid : null;

    const snapshot = {
      bestBid: validBid,
      bestAsk: validAsk,
      spread,
      updatedAtMs: Date.now(),
    };

    books.set(tokenId, snapshot);

    if (onBookUpdate) {
      try {
        onBookUpdate(tokenId, snapshot);
      } catch {
        // callback error shouldn't crash the WS
      }
    }
  };

  // Start connection
  connect();

  return {
    /**
     * Get the latest book snapshot for a token.
     * @param {string} tokenId
     * @returns {BookSnapshot|null}
     */
    getBook(tokenId) {
      return books.get(tokenId) || null;
    },

    /**
     * Update subscriptions (e.g., on market rollover).
     * @param {string[]} newTokenIds
     */
    updateSubscriptions(newTokenIds) {
      // Unsubscribe from removed tokens
      const removed = currentTokenIds.filter((id) => !newTokenIds.includes(id));
      if (removed.length > 0) {
        sendUnsubscribe(removed);
      }

      // Subscribe to new tokens
      const added = newTokenIds.filter((id) => !currentTokenIds.includes(id));
      if (added.length > 0) {
        sendSubscribe(added);
      }

      currentTokenIds = [...newTokenIds];
    },

    /**
     * Close the WebSocket connection.
     */
    close() {
      closed = true;
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    },
  };
}
