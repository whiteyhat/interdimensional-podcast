// Only the parts of lib/solana.ts that need no network: the module must import cleanly
// (it pulls @solana/pay and @solana/kit) and references must be fresh, valid addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['requests', 'interact', 'http', 'solana']);
const S = await import('../work/tests/solana.js');
const { isAddress, getAddressEncoder } = await import('@solana/kit');

test('a reference is a fresh 32-byte address every time', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const reference = S.randomReference();
    assert.ok(isAddress(reference), `not an address: ${reference}`);
    assert.equal(getAddressEncoder().encode(reference).length, 32);
    seen.add(reference);
  }
  assert.equal(seen.size, 50);
});

test('the relay refuses transactions that are not the viewer\'s own quote', () => {
  assert.throws(() => S.inspectSigned('not base64!!', { wallet: 'x', reference: 'y' }), /not a signed Solana transaction/);
  assert.throws(() => S.inspectSigned('AAAA', { wallet: 'x', reference: 'y' }), /not a signed Solana transaction/);
});

test('error text includes the RPC server message hidden in the error context', () => {
  const e = Object.assign(new Error('JSON-RPC error'), { context: { __serverMessage: 'Blockhash not found' } });
  assert.match(S.errorText(e), /Blockhash not found/);
  assert.equal(S.errorText('plain'), 'plain');
});

test('one RPC client per URL', () => {
  const a = S.rpcFor('https://api.devnet.solana.com');
  assert.equal(S.rpcFor('https://api.devnet.solana.com'), a);
  assert.notEqual(S.rpcFor('https://api.mainnet-beta.solana.com'), a);
});
