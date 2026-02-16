import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js"; // Assuming proxy support is needed/available

// Helper to convert string numbers to finite numbers, null if invalid
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Prepare the subscription message for Coinbase Exchange WebSocket
function getSubscriptionMessage(symbol) {
  // Coinbase Exchange product id format: e.g. BTC-USD
  const formattedSymbol = String(symbol || CONFIG.coinbase.symbol).toUpperCase();

  // Subscription request payload as per Coinbase Exchange WS docs:
  // Channel 'matches' emits messages of type 'match' (one trade per message).
  return JSON.stringify({
    type: "subscribe",
    product_ids: [formattedSymbol],
    channels: ["matches"]
  });
}

export function startCoinbaseTradeStream({ symbol = CONFIG.coinbase.symbol, onUpdate } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let lastPrice = null;
  let lastTs = null;
  const MAX_RECONNECT_INTERVAL = 10000; // Max delay between reconnections

  const connect = () => {
    if (closed) return;

    const url = CONFIG.coinbase.wsBaseUrl || "wss://ws-feed.exchange.coinbase.com";
    const subscribeMessage = getSubscriptionMessage(symbol);

    const agent = wsAgentForUrl(url); // Get agent for proxy if configured

    ws = new WebSocket(url, { agent });

    ws.on("open", () => {
      console.log(`WebSocket connected to ${url}. Sending subscription message...`);
      reconnectMs = 500; // Reset backoff on successful connection
      try {
        ws.send(subscribeMessage); // Send the subscription message after connection opens
      } catch (e) {
        console.error("Failed to send subscription message:", e);
        // If sending fails, it's likely a connection/protocol issue that needs reconnect.
        scheduleReconnect(); 
      }
    });

    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());

        // Subscription confirmation
        if (msg.type === "subscriptions") {
          // Example: { type:'subscriptions', channels:[{name:'matches', product_ids:['BTC-USD']}] }
          // Don't spam logs; just accept.
          return;
        }

        // Trade messages (one trade per message)
        if (msg.type === "match") {
          const price = toNumber(msg.price);
          const t = msg.time ? Date.parse(msg.time) : null;
          if (price !== null) {
            lastPrice = price;
            lastTs = Number.isFinite(t) ? t : Date.now();
            if (typeof onUpdate === "function") onUpdate({ price: lastPrice, ts: lastTs });
          }
          return;
        }

        if (msg.type === "error") {
          console.error("Coinbase WebSocket Error:", msg.message, "Reason:", msg.reason);
          scheduleReconnect();
          return;
        }
      } catch (e) {
        console.error("Error processing WebSocket message:", e);
      }
    });

    const scheduleReconnect = () => {
      if (closed) return;

      try {
        ws?.terminate(); // Use terminate for immediate closure if connection is bad
      } catch { /* ignore */ }
      ws = null;

      // Exponential backoff for reconnections
      const wait = reconnectMs;
      reconnectMs = Math.min(MAX_RECONNECT_INTERVAL, Math.floor(reconnectMs * 1.5));
      
      setTimeout(connect, wait);
    };

    ws.on("close", () => {
      console.log("Coinbase WebSocket disconnected.");
      scheduleReconnect();
    });
    ws.on("error", (err) => {
      console.error("Coinbase WebSocket encountered an error:", err);
      scheduleReconnect();
    });
  };

  connect();

  return {
    getLast() {
      return { price: lastPrice, ts: lastTs };
    },
    close() {
      closed = true;
      try {
        ws?.close(); // Graceful close
      } catch { /* ignore */ }
      ws = null;
    }
  };
}
