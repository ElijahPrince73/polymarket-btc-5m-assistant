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
const sigType = Number(process.env.SIGNATURE_TYPE || 0);
const funder = process.env.FUNDER_ADDRESS || signer.address;

const client = new ClobClient(host, chainId, signer, creds, sigType, funder);

console.log('--- update_balance_allowance ---');
console.log('signer:', signer.address);
console.log('funder:', funder);

const before = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
console.log('before:', before);

try {
  await client.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
  console.log('updateBalanceAllowance: OK');
} catch (e) {
  console.error('updateBalanceAllowance FAILED:', e?.message || e);
  if (e?.response?.data) console.error('response.data:', e.response.data);
}

const after = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
console.log('after:', after);
