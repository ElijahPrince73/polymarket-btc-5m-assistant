import { clamp } from "../utils.js";
import { CONFIG } from "../config.js";

export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp = sum > 0 ? marketYes / sum : null;
  const marketDown = sum > 0 ? marketNo / sum : null;

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

export function decide({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null }) {
  const winMin = Number(CONFIG?.candleWindowMinutes) || 15;

  // Phase boundaries: scale with market window.
  // For 5m markets we want phases to update much faster.
  const earlyCut = winMin <= 6 ? 3.5 : 10;
  const midCut = winMin <= 6 ? 2.0 : 5;

  const phase = remainingMinutes > earlyCut ? "EARLY" : remainingMinutes > midCut ? "MID" : "LATE";

  // Use configurable thresholds (defaults tuned in config.js)
  const threshold = phase === "EARLY"
    ? CONFIG.paperTrading.edgeEarly
    : phase === "MID"
      ? CONFIG.paperTrading.edgeMid
      : CONFIG.paperTrading.edgeLate;

  const minProb = phase === "EARLY"
    ? CONFIG.paperTrading.minProbEarly
    : phase === "MID"
      ? CONFIG.paperTrading.minProbMid
      : CONFIG.paperTrading.minProbLate;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold}` };
  }

  if (bestModel !== null && bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };
  }

  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}
