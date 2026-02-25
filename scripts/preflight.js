#!/usr/bin/env node

/**
 * @file Pre-flight production readiness check.
 *
 * Validates:
 *   1. All tests pass (runs `npm test`)
 *   2. Required environment variables are set
 *   3. Optional environment variables are checked with warnings
 *   4. Supabase credentials are present (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *   5. Config values are sane (no obvious misconfigurations)
 *   6. Webhook URL is reachable (if configured)
 *
 * Usage:
 *   npm run preflight
 *   node scripts/preflight.js
 *
 * Exit codes:
 *   0 — All checks pass
 *   1 — One or more checks failed
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Formatting ────────────────────────────────────────────────────

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const WARN = '\x1b[33mWARN\x1b[0m';
const INFO = '\x1b[36mINFO\x1b[0m';

let failures = 0;
let warnings = 0;

function pass(msg) { console.log(`  ${PASS}  ${msg}`); }
function fail(msg) { console.log(`  ${FAIL}  ${msg}`); failures++; }
function warn(msg) { console.log(`  ${WARN}  ${msg}`); warnings++; }
function info(msg) { console.log(`  ${INFO}  ${msg}`); }

// ── 1. Tests ──────────────────────────────────────────────────────

console.log('\n--- Pre-flight Check ---\n');
console.log('1. Running tests...\n');

try {
  execSync('node --test', {
    cwd: process.cwd(),
    stdio: 'pipe',
    timeout: 120_000,
  });
  pass('All tests pass');
} catch (err) {
  const output = err.stdout ? err.stdout.toString().slice(-500) : '';
  fail('Tests failed');
  if (output) console.log(`     Last output: ${output.trim().split('\n').slice(-3).join('\n     ')}`);
}

// ── 2. Required Environment Variables ─────────────────────────────

console.log('\n2. Checking environment variables...\n');

// Load .env if available (mimic dotenv behavior for checking)
const envPath = path.join(process.cwd(), '.env');
const envVars = {};
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      envVars[key] = val;
    }
  }
}

function getEnv(key) {
  return process.env[key] || envVars[key] || '';
}

// Required: at least one price feed must be available
const hasPolySlug = getEnv('POLYMARKET_SLUG') || getEnv('POLYMARKET_AUTO_SELECT_LATEST') === 'true';
if (hasPolySlug) {
  pass('Polymarket market configured');
} else {
  warn('Neither POLYMARKET_SLUG nor POLYMARKET_AUTO_SELECT_LATEST=true is set');
}

const hasRpcUrl = getEnv('POLYGON_RPC_URL');
if (hasRpcUrl) {
  pass(`POLYGON_RPC_URL set: ${hasRpcUrl.slice(0, 40)}...`);
} else {
  warn('POLYGON_RPC_URL not set — will use default (https://polygon-rpc.com)');
}

// Optional but recommended
const optionalVars = [
  { key: 'WEBHOOK_URL', label: 'Webhook alerts' },
  { key: 'DAILY_LOSS_LIMIT', label: 'Kill-switch limit' },
  { key: 'DATA_DIR', label: 'Data directory' },
];

for (const { key, label } of optionalVars) {
  const val = getEnv(key);
  if (val) {
    pass(`${label}: ${key} = ${val.slice(0, 40)}`);
  } else {
    info(`${label}: ${key} not set (optional)`);
  }
}

// Live trading checks
if (getEnv('LIVE_TRADING_ENABLED') === 'true') {
  info('Live trading is ENABLED');
  const funder = getEnv('FUNDER_ADDRESS');
  if (funder) {
    pass(`FUNDER_ADDRESS set: ${funder.slice(0, 10)}...`);
  } else {
    fail('LIVE_TRADING_ENABLED=true but FUNDER_ADDRESS is not set');
  }
}

// ── 3. Supabase Availability ─────────────────────────────────────

console.log('\n3. Checking Supabase...\n');

const supabaseUrl = getEnv('SUPABASE_URL');
const supabaseKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

if (supabaseUrl && supabaseKey) {
  pass('SUPABASE_URL is set');
  pass('SUPABASE_SERVICE_ROLE_KEY is set');
} else {
  if (!supabaseUrl) warn('SUPABASE_URL is not set — trade history will not survive deploys');
  if (!supabaseKey) warn('SUPABASE_SERVICE_ROLE_KEY is not set — trade history will not survive deploys');
  info('Create a project at https://supabase.com and add credentials to .env');
  info('Run the SQL schema from .planning/supabase-schema.sql in the Supabase SQL editor');
}

// ── 4. Config Sanity ──────────────────────────────────────────────

console.log('\n4. Checking config sanity...\n');

const startBal = Number(getEnv('STARTING_BALANCE')) || 1000;
const stakePct = Number(getEnv('STAKE_PCT')) || 0.08;
const minTrade = Number(getEnv('MIN_TRADE_USD')) || 25;
const maxTrade = Number(getEnv('MAX_TRADE_USD')) || 250;
const dailyLoss = Number(getEnv('DAILY_LOSS_LIMIT') || getEnv('MAX_DAILY_LOSS_USD')) || 50;

if (stakePct > 0 && stakePct < 1) {
  pass(`STAKE_PCT = ${stakePct} (${(stakePct * 100).toFixed(0)}% of balance)`);
} else if (stakePct >= 1) {
  warn(`STAKE_PCT = ${stakePct} — this seems very high (>= 100% of balance per trade)`);
} else {
  warn(`STAKE_PCT = ${stakePct} — this will produce zero-size trades`);
}

const typicalSize = startBal * stakePct;
if (typicalSize >= minTrade && typicalSize <= maxTrade) {
  pass(`Typical trade size $${typicalSize.toFixed(0)} is within bounds [$${minTrade}, $${maxTrade}]`);
} else if (typicalSize < minTrade) {
  warn(`Typical trade size $${typicalSize.toFixed(0)} < MIN_TRADE_USD ($${minTrade}) — will use min`);
} else {
  warn(`Typical trade size $${typicalSize.toFixed(0)} > MAX_TRADE_USD ($${maxTrade}) — will be capped`);
}

if (dailyLoss > 0 && dailyLoss < startBal) {
  pass(`Daily loss limit $${dailyLoss} < starting balance $${startBal}`);
} else if (dailyLoss >= startBal) {
  warn(`Daily loss limit ($${dailyLoss}) >= starting balance ($${startBal}) — kill-switch may never trigger`);
}

// NODE_ENV check
const nodeEnv = getEnv('NODE_ENV');
if (nodeEnv === 'production') {
  pass('NODE_ENV = production');
} else {
  info(`NODE_ENV = ${nodeEnv || '(not set)'} — production defaults will not apply`);
}

// ── 5. Webhook Reachability ───────────────────────────────────────

console.log('\n5. Checking webhook reachability...\n');

const webhookUrl = getEnv('WEBHOOK_URL');
if (webhookUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(webhookUrl, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok || res.status === 405 || res.status === 400) {
      // 405 = method not allowed (Slack returns this for HEAD) — endpoint exists
      // 400 = bad request — endpoint exists but needs POST body
      pass(`Webhook URL reachable (HTTP ${res.status})`);
    } else {
      warn(`Webhook URL returned HTTP ${res.status}`);
    }
  } catch (err) {
    warn(`Webhook URL unreachable: ${err.message}`);
  }
} else {
  info('WEBHOOK_URL not configured — webhook check skipped');
}

// ── Summary ───────────────────────────────────────────────────────

console.log('\n--- Summary ---\n');

if (failures === 0) {
  console.log(`  \x1b[32m${PASS}\x1b[0m  All pre-flight checks passed${warnings > 0 ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}\n`);
  process.exit(0);
} else {
  console.log(`  \x1b[31m${FAIL}\x1b[0m  ${failures} check${failures > 1 ? 's' : ''} failed, ${warnings} warning${warnings > 1 ? 's' : ''}\n`);
  process.exit(1);
}
