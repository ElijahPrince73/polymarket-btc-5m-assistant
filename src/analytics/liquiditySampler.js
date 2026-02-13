import fs from 'fs';
import path from 'path';

const DEFAULT_PATH = path.join(process.cwd(), 'paper_trading', 'liquidity_samples.jsonl');

function safeMkdirp(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

export function recordLiquiditySample({ marketSlug, liquidityNum, spreadUp, spreadDown }) {
  try {
    if (!marketSlug) return;
    if (typeof liquidityNum !== 'number' || !Number.isFinite(liquidityNum)) return;

    const outPath = process.env.LIQ_SAMPLES_PATH || DEFAULT_PATH;
    safeMkdirp(path.dirname(outPath));

    const now = Date.now();
    // De-dupe to roughly 1/minute per market slug.
    const key = `${marketSlug}`;
    const last = globalThis.__lastLiqSample || {};
    const lastAt = last[key] || 0;
    if (now - lastAt < 55_000) return;
    globalThis.__lastLiqSample = { ...last, [key]: now };

    const row = {
      at: new Date(now).toISOString(),
      marketSlug,
      liquidityNum,
      spreadUp: (typeof spreadUp === 'number' && Number.isFinite(spreadUp)) ? spreadUp : null,
      spreadDown: (typeof spreadDown === 'number' && Number.isFinite(spreadDown)) ? spreadDown : null
    };

    fs.appendFileSync(outPath, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    // never crash main loop
  }
}

export function readLiquiditySamples({ limit = 5000 } = {}) {
  const outPath = process.env.LIQ_SAMPLES_PATH || DEFAULT_PATH;
  if (!fs.existsSync(outPath)) return [];
  const text = fs.readFileSync(outPath, 'utf8');
  const lines = text.trim().split('\n').filter(Boolean);
  const slice = lines.slice(Math.max(0, lines.length - limit));
  const rows = [];
  for (const ln of slice) {
    try { rows.push(JSON.parse(ln)); } catch {}
  }
  return rows;
}

export function computeLiquidityStats(rows, { windowHours = 24, tzOffsetMinutes = null } = {}) {
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const filtered = (rows || []).filter(r => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t >= cutoff;
  });

  const liqs = filtered.map(r => r.liquidityNum).filter(n => typeof n === 'number' && Number.isFinite(n)).sort((a,b)=>a-b);
  const avg = liqs.length ? (liqs.reduce((a,b)=>a+b,0) / liqs.length) : null;
  const pct = (p) => liqs.length ? liqs[Math.floor((liqs.length - 1) * p)] : null;

  return {
    windowHours,
    samples: filtered.length,
    avg,
    p25: pct(0.25),
    p50: pct(0.50),
    p75: pct(0.75)
  };
}
