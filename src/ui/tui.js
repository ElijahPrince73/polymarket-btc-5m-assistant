import readline from "node:readline";
import { formatNumber } from "../utils.js";

export const ANSI = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", gray: "\x1b[90m", white: "\x1b[97m", dim: "\x1b[2m" };

export function screenWidth() { const w = Number(process.stdout?.columns); return Number.isFinite(w) && w >= 40 ? w : 80; }

export function sepLine(ch = "─") { const w = screenWidth(); return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`; }

export function renderScreen(text) { try { readline.cursorTo(process.stdout, 0, 0); readline.clearScreenDown(process.stdout); } catch { /* ignore */ } process.stdout.write(text + "\n"); }

export function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ""); }

export function padLabel(label, width) { const visible = stripAnsi(label).length; if (visible >= width) return label; return label + " ".repeat(width - visible); }

export function centerText(text, width) { const visible = stripAnsi(text).length; if (visible >= width) return text; const left = Math.floor((width - visible) / 2); const right = width - visible - left; return " ".repeat(left) + text + " ".repeat(right); }

export const LABEL_W = 16;

export function kv(label, value) { const l = padLabel(String(label), LABEL_W); return `${l}${value}`; }

export function section(title) { return `${ANSI.white}${title}${ANSI.reset}`; }

export function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  const p = Number(price); const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);
  let color = ANSI.reset; let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) { color = ANSI.green; arrow = " ↑"; } else { color = ANSI.red; arrow = " ↓"; }
  }
  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

export function formatSignedDelta(delta, base) { if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`; const sign = delta > 0 ? "+" : delta < 0 ? "-" : ""; const pct = (Math.abs(delta) / Math.abs(base)) * 100; return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`; }

export function colorByNarrative(text, narrative) { if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`; if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`; return `${ANSI.gray}${text}${ANSI.reset}`; }

export function formatNarrativeValue(label, value, narrative) { return `${label}: ${colorByNarrative(value, narrative)}`; }

export function narrativeFromSign(x) { if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL"; return Number(x) > 0 ? "LONG" : "SHORT"; }

export function narrativeFromRsi(rsi) { if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL"; const v = Number(rsi); if (v >= 55) return "LONG"; if (v <= 45) return "SHORT"; return "NEUTRAL"; }

export function narrativeFromSlope(slope) { if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL"; return Number(slope) > 0 ? "LONG" : "SHORT"; }

export function formatProbPct(p, digits = 0) { if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-"; return `${(Number(p) * 100).toFixed(digits)}%`; }

export function fmtEtTime(now = new Date()) { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now); } catch { return "-"; } }

export function fmtTimeLeft(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "-";
  const clamped = Math.max(0, minutes);
  const m = Math.floor(clamped);
  const s = Math.floor((clamped - m) * 60);
  return `${m}m ${s}s`;
}

export function getBtcSession(now = new Date()) { const h = now.getUTCHours(); const inAsia = h >= 0 && h < 8; const inEurope = h >= 7 && h < 16; const inUs = h >= 13 && h < 22; if (inEurope && inUs) return "Europe/US overlap"; if (inAsia && inEurope) return "Asia/Europe overlap"; if (inAsia) return "Asia"; if (inEurope) return "Europe"; if (inUs) return "US"; return "Off-hours"; }
