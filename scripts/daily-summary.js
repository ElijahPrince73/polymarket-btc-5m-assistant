#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function fmtUsd(x) {
  const n = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  const sign = n >= 0 ? '' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function ptDayKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function summarizeLedger({ label, filePath, todayKey }) {
  const data = loadJson(filePath);
  const trades = Array.isArray(data?.trades) ? data.trades : [];
  const closed = trades.filter(t => t && t.status === 'CLOSED');
  const today = closed.filter(t => ptDayKey(t.exitTime || t.exitTimeIso || t.timestamp) === todayKey);

  const pnl = today.reduce((acc, t) => acc + (typeof t.pnl === 'number' && Number.isFinite(t.pnl) ? t.pnl : 0), 0);
  const wins = today.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = today.filter(t => (t.pnl ?? 0) <= 0).length;

  const byReason = new Map();
  for (const t of today) {
    const k = String(t.exitReason || 'unknown');
    byReason.set(k, (byReason.get(k) || 0) + (t.pnl || 0));
  }

  const reasons = Array.from(byReason.entries())
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5)
    .map(([k, v]) => `  - ${k}: ${fmtUsd(v)}`)
    .join('\n');

  return {
    label,
    count: today.length,
    wins,
    losses,
    pnl,
    reasons: reasons || '  - (none)'
  };
}

const projectRoot = process.cwd();
const todayKey = ptDayKey(new Date().toISOString());

const ledgers = [
  { label: 'A (baseline)', file: path.join(projectRoot, 'paper_trading', 'trades.json') },
  { label: 'B (candidate)', file: path.join(projectRoot, 'paper_trading', 'trades.candidate.json') }
].filter(x => fs.existsSync(x.file));

const lines = [];
lines.push(`Daily Paper Trading Summary (${todayKey} PT)`);

for (const l of ledgers) {
  const s = summarizeLedger({ label: l.label, filePath: l.file, todayKey });
  lines.push('');
  lines.push(`${s.label}:`);
  lines.push(`- Closed trades today: ${s.count} (W ${s.wins} / L ${s.losses})`);
  lines.push(`- Realized PnL today: ${fmtUsd(s.pnl)}`);
  lines.push(`- PnL by exit reason:`);
  lines.push(s.reasons);
}

console.log(lines.join('\n'));
