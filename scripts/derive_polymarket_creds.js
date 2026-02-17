// Derive Polymarket CLOB User API credentials from an EVM private key.
// Usage:
//   cd PolymarketBTC5mAssistant
//   cp .env.example .env   (optional)
//   # Put PRIVATE_KEY=... in .env (DO NOT COMMIT)
//   node scripts/derive_polymarket_creds.js
//
// Output: apiKey/secret/passphrase (store these somewhere safe; treat as secrets).

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers'; // v5

const HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com';
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY || !PRIVATE_KEY.startsWith('0x') || PRIVATE_KEY.length < 64) {
  console.error('Missing/invalid PRIVATE_KEY in environment. Put PRIVATE_KEY=0x... in .env');
  process.exit(1);
}

const signer = new Wallet(PRIVATE_KEY);
const client = new ClobClient(HOST, CHAIN_ID, signer);

console.log('Deriving/creating User API key for address:', signer.address);
const creds = await client.createOrDeriveApiKey();

console.log('\n--- Polymarket User API Credentials (KEEP SECRET) ---');
console.log('CLOB_API_KEY=' + creds.apiKey);
console.log('CLOB_SECRET=' + creds.secret);
console.log('CLOB_PASSPHRASE=' + creds.passphrase);
console.log('SIGNATURE_TYPE=0');
console.log('FUNDER_ADDRESS=' + signer.address);
console.log('---');

console.log('\nNext: store these in your .env (and remove PRIVATE_KEY if you want), then we can wire live order auth.');
