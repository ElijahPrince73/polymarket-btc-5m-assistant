import 'dotenv/config';
import { ClobClient, OrderType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { CONFIG } from '../src/config.js';
import { fetchMarketBySlug, fetchClobPrice } from '../src/data/polymarket.js';

function pickTokenId(market, label) {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : JSON.parse(market?.outcomes || '[]');
  const clobTokenIds = Array.isArray(market?.clobTokenIds)
    ? market.clobTokenIds
    : JSON.parse(market?.clobTokenIds || '[]');

  for (let i = 0; i < outcomes.length; i += 1) {
    if (String(outcomes[i]).toLowerCase() === String(label).toLowerCase()) {
      const tid = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
      if (tid) return tid;
    }
  }
  return null;
}

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return null;
}

const slug = getArg('slug') || process.env.MARKET_SLUG;
const funderOverride = getArg('funder') || process.env.FUNDER_ADDRESS;
const outcome = (getArg('outcome') || 'UP').toUpperCase();
const targetUsd = Number(getArg('usd') || '1');

if (!slug) {
  console.error('Missing slug. Provide --slug <market-slug> or MARKET_SLUG env var.');
  process.exit(2);
}

const host = process.env.CLOB_HOST || 'https://clob.polymarket.com';
const chainId = Number(process.env.CHAIN_ID || 137);
const signer = new Wallet(process.env.PRIVATE_KEY);

const creds = {
  key: process.env.CLOB_API_KEY,
  secret: process.env.CLOB_SECRET,
  passphrase: process.env.CLOB_PASSPHRASE,
};
const sigType = Number(process.env.SIGNATURE_TYPE || 0);
const funder = funderOverride || signer.address;

const client = new ClobClient(host, chainId, signer, creds, sigType, funder);

console.log('--- live_test_order ---');
console.log('slug:', slug);
console.log('signer:', signer.address);
console.log('funder:', funder);
console.log('outcome:', outcome);

const market = await fetchMarketBySlug(slug);
if (!market) {
  console.error('Market not found for slug:', slug);
  process.exit(2);
}

const upTokenId = pickTokenId(market, CONFIG.polymarket.upOutcomeLabel);
const downTokenId = pickTokenId(market, CONFIG.polymarket.downOutcomeLabel);
const tokenID = outcome === 'DOWN' ? downTokenId : upTokenId;

if (!tokenID) {
  console.error('Missing tokenID for outcome. upTokenId=%s downTokenId=%s', upTokenId, downTokenId);
  process.exit(2);
}

// Use current buy price as a safe limit, but post-only so we should not take.
let price = null;
try {
  price = await fetchClobPrice({ tokenId: tokenID, side: 'buy' });
} catch {
  price = null;
}
if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
  price = 0.01;
}

// Size is in shares; cost ~= price * size. Round to integer shares.
const size = Math.max(1, Math.floor(targetUsd / price));

console.log('tokenID:', tokenID);
console.log('limit price:', price);
console.log('size (shares):', size);
console.log('notional ~$:', (price * size).toFixed(4));

// Print collateral check before trying.
const bal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
console.log('collateral:', bal);

let resp;
try {
  resp = await client.createAndPostOrder(
    {
      tokenID,
      price,
      size,
      side: 'BUY',
    },
    {},
    OrderType.GTC,
    false,
    true // postOnly
  );
  console.log('post response:', resp);
} catch (e) {
  console.error('ORDER FAILED:', e?.message || e);
  if (e?.response?.data) console.error('response.data:', e.response.data);
  process.exit(1);
}

const orderID = resp?.orderID || resp?.id || resp?.order_id;
if (!orderID) {
  console.log('No orderID returned; not attempting cancel.');
  process.exit(0);
}

try {
  const cancelResp = await client.cancelOrder({ orderID });
  console.log('cancel response:', cancelResp);
} catch (e) {
  console.error('CANCEL FAILED:', e?.message || e);
  if (e?.response?.data) console.error('response.data:', e.response.data);
}
