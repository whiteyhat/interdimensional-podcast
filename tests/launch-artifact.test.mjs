import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SystemProgram, Keypair } from '@solana/web3.js';
import { launchFixture } from './fixtures/launch.mjs';
const A = await import('../lib/launch/artifact.mjs').catch(() => ({}));

void test('pinned SDK produces a supported atomic create-and-buy transaction for wallet review', async () => {
  assert.equal(typeof A.reviewPrepared, 'function');
  const f = await launchFixture();
  const { transaction } = await A.reviewPrepared(f.artifact, f.connection);
  assert.ok(transaction.serialize().length <= 1232);
  transaction.sign([f.creator]);
  const signed = A.makeSignedEnvelope(f.artifact, transaction);
  assert.equal(signed.id, f.artifact.id);
  assert.equal(typeof signed.transaction, 'string');
  assert.equal(typeof signed.reviewHash, 'string');
  assert.equal(signed.secretKey, undefined);
});
void test('rejects forged descriptions, spending changes, and additional transfers even with recomputed hash', async () => {
  assert.equal(typeof A.reviewPrepared, 'function');
  const f = await launchFixture();
  await assert.rejects(() => A.reviewPrepared({ ...f.artifact, name: 'Another coin' }, f.connection), /metadata|name|intent/i);
  await assert.rejects(() => A.reviewPrepared({ ...f.artifact, buyLamports: '1' }, f.connection), /purchase|spend|amount/i);
  const tx = f.build([...f.instructions, SystemProgram.transfer({ fromPubkey: f.creator.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 10 })]);
  const forged = { ...f.artifact, transaction: Buffer.from(tx.serialize()).toString('base64'), messageHash: Buffer.from(await crypto.subtle.digest('SHA-256', tx.message.serialize())).toString('hex') };
  await assert.rejects(() => A.reviewPrepared(forged, f.connection), /instruction/i);
});
void test('refuses wrong network, expired blockhash, missing lookup accounts, and missing signatures', async () => {
  assert.equal(typeof A.reviewPrepared, 'function');
  const f = await launchFixture();
  await assert.rejects(() => A.reviewPrepared(f.artifact, { ...f.connection, getGenesisHash: async () => 'wrong' }), /network/i);
  await assert.rejects(() => A.reviewPrepared(f.artifact, { ...f.connection, isBlockhashValid: async () => ({ value: false }) }), /expired/i);
  await assert.rejects(() => A.reviewPrepared(f.artifact, { ...f.connection, getAddressLookupTable: async () => ({ value: null }) }), /lookup/i);
  assert.throws(() => A.makeSignedEnvelope(f.artifact, f.tx), /signature/i);
  f.tx.sign([f.creator]); f.tx.signatures[1][0] ^= 1;
  assert.throws(() => A.makeSignedEnvelope(f.artifact, f.tx), /signature/i);
});
