import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js"; // Assuming proxy support is needed/available

// Helper to convert string numbers to finite numbers, null if invalid
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Prepare the subscription message for Coinbase WebSocket
function getSubscriptionMessage(symbol) {
  // Coinbase symbol format is typically BTC-USD. Ensure it's formatted correctly.
  const formattedSymbol = String(symbol || CONFIG.coinbase.symbol).toUpperCase().replace('-0', '-'); 
  // Example: BTC-USD remains BTC-USD, BTC0USD becomes BTC-USD. Ensure consistency.

  // Subscription request payload as per Coinbase WebSocket API docs:
  // https://docs.cloud.coinbase.com/exchange/docs/websocket-feed
  // Channel 'matches' for trades.
  const message = JSON.stringify({
    type: "subscribe",
    channels: [{
      name: "matches", // Channel for trades
      product_ids: [formattedSymbol] // Expects an array of product IDs, like ["BTC-USD"]
    }]
  });
  return message;
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

        // Process messages from the 'matches' channel for trades
        if (msg.type === "subscriptions") {
          console.log("WebSocket subscription confirmation:", msg);
          // Check if the expected product_id is confirmed.
          // This message structure might vary depending on subscription response.
          // For basic setup, just logging is often enough.
          if (msg.channels && msg.channels.length > 0 && msg.channels[0].product_ids.includes(symbol.toUpperCase().replace('-', '0'))) {
              console.log(`Successfully subscribed to trades for ${symbol}.`);
          } else {
              console.warn("Subscription confirmation does not match expected symbol. Resending subscription.");
              // Potentially resend subscription if confirmation is wrong.
              try { ws.send(subscribeMessage); } catch(e) { console.error("Error resending subscription:", e); scheduleReconnect(); }
          }
        } else if (msg.type === "matches" && Array.isArray(msg.matches)) {
          // Coinbase trade format in 'matches': [trade_id, timestamp_seconds, size, price, side]
          for (const trade of msg.matches) {
            if (Array.isArray(trade) && trade.length >= 4) {
              const price = toNumber(trade[3]); // Price is the 4th element (index 3)
              const timestampSeconds = toNumber(trade[1]); // Timestamp is the 2nd element (index 1)

              if (price !== null && !isNaN(timestampSeconds)) {
                lastPrice = price;
                lastTs = timestampSeconds * 1000; // Convert seconds to milliseconds
                if (typeof onUpdate === "function") {
                  onUpdate({ price: lastPrice, ts: lastTs });
                }
              }
            }
          }
        } else if (msg.type === "error") {
          console.error("Coinbase WebSocket Error:", msg.message, "Reason:", msg.reason);
          // Handle specific errors. "unsubscribed" reason might mean the subscription was invalid.
          if (msg.reason === "unsubscribed" || msg.reason === "websocket_closed" || msg.reason === "service_unavailable") {
             console.log("WebSocket error requires reconnection.");
             scheduleReconnect();
          }
        } else {
            // Log other message types for debugging if needed
            // console.log("Received WebSocket message type:", msg.type, msg);
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
