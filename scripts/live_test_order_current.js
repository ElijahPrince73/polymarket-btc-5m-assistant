import 'dotenv/config';
import { fetchLiveEventsBySeriesId, flattenEventMarkets, filterBtcUpDown5mMarkets, pickLatestLiveMarket, fetchClobPrice } from '../src/data/polymarket.js';
import { CONFIG } from '../src/config.js';
import { ClobClient, OrderType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

function pickTokenId(market, label) {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : JSON.parse(market?.outcomes || '[]');
  const clobTokenIds = Array.isArray(market?.clobTokenIds) ? market.clobTokenIds : JSON.parse(market?.clobTokenIds || '[]');
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

const outcome = (getArg('outcome') || 'UP').toUpperCase();
const targetUsd = Number(getArg('usd') || '1');

const host = process.env.CLOB_HOST || 'https://clob.polymarket.com';
const chainId = Number(process.env.CHAIN_ID || 137);
const signer = new Wallet(process.env.PRIVATE_KEY);

const creds = {
  key: process.env.CLOB_API_KEY,
  secret: process.env.CLOB_SECRET,
  passphrase: process.env.CLOB_PASSPHRASE,
};

const sigType = Number(process.env.SIGNATURE_TYPE || 0);
const funder = process.env.FUNDER_ADDRESS || signer.address;
const client = new ClobClient(host, chainId, signer, creds, sigType, funder);

console.log('--- live_test_order_current ---');
console.log('signer:', signer.address);
console.log('funder:', funder);
console.log('signatureType:', sigType);
console.log('outcome:', outcome);

const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 50 });
const markets = flattenEventMarkets(events);
// Gamma event markets returned by series_id do not include seriesSlug/events, so filter by slug prefix.
const btc5m = filterBtcUpDown5mMarkets(markets, { slugPrefix: 'btc-updown-5m-' });
const market = pickLatestLiveMarket(btc5m);

if (!market) {
  console.error('No live BTC 5m market found');
  process.exit(2);
}

console.log('marketSlug:', market.slug);

const upTokenId = pickTokenId(market, CONFIG.polymarket.upOutcomeLabel);
const downTokenId = pickTokenId(market, CONFIG.polymarket.downOutcomeLabel);
const tokenID = outcome === 'DOWN' ? downTokenId : upTokenId;
if (!tokenID) {
  console.error('Missing tokenID', { upTokenId, downTokenId });
  process.exit(2);
}

const priceOverride = getArg('price');

let price = null;
if (priceOverride) {
  price = Number(priceOverride);
}
if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) {
  try {
    price = await fetchClobPrice({ tokenId: tokenID, side: 'buy' });
  } catch {
    price = null;
  }
}

if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
  // fallback to a tiny maker price
  price = 0.01;
}

const size = Math.max(1, Math.floor(targetUsd / price));

console.log('tokenID:', tokenID);
console.log('limit price:', price);
console.log('size:', size);
console.log('notional ~$:', (price * size).toFixed(4));

const bal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
console.log('collateral:', bal);

let resp;
try {
  resp = await client.createAndPostOrder(
    { tokenID, price, size, side: 'BUY' },
    {},
    OrderType.GTC,
    false,
    true
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
