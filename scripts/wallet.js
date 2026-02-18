import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
const host = process.env.CLOB_HOST || 'https://clob.polymarket.com';
const chainId = Number(process.env.CHAIN_ID || 137);
const signer = new Wallet(process.env.PRIVATE_KEY);

const creds = {
  key: process.env.CLOB_API_KEY,
  secret: process.env.CLOB_SECRET,
  passphrase: process.env.CLOB_PASSPHRASE,
};
const sig = Number(process.env.SIGNATURE_TYPE || 0);
const funder = process.env.FUNDER_ADDRESS || signer.address;

const client = new ClobClient(host, chainId, signer, creds, sig, funder);

// COLLATERAL balance/allowance (don’t pass token_id="USDC")
const bal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
console.log(bal);
