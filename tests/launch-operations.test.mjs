import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchFixture } from './fixtures/launch.mjs';
import { makeSignedEnvelope } from '../lib/launch/artifact.mjs';
const CH = await import('../scripts/launch/chain.mjs').catch(() => ({}));
const M = await import('../scripts/launch/metadata.mjs').catch(() => ({}));
const R = await import('../scripts/launch/report.mjs').catch(() => ({}));
function memoryStore(state) { const files = new Map([['state.json', state]]); return { read: async n => { if (!files.has(n)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return files.get(n); }, write: async (n,v) => { files.set(n,structuredClone(v)); }, files }; }
void test('lost submission response is recorded before broadcast and does not permit a replacement', async () => {
  assert.equal(typeof CH.submitPrepared, 'function');
  const f = await launchFixture(); f.tx.sign([f.creator]);
  const state = { id: f.artifact.id, mint: f.artifact.mint, revision: 1, submissions: [] };
  const store = memoryStore(state); await store.write('prepared-1.json', f.artifact);
  let sends = 0;
  const connection = { ...f.connection,
    getSignatureStatuses: async () => ({ value: [null] }), getEpochInfo: async () => ({ blockHeight: 900 }),
    getMultipleAccountsInfo: async keys => keys.map(() => null), getFeeForMessage: async () => ({ value: 10000 }),
    getMinimumBalanceForRentExemption: async () => 1000000,
    simulateTransaction: async (_tx, options) => ({ value: { err: null, accounts: options.accounts?.addresses.map(() => ({ data: ['', 'base64'] })) } }),
    sendRawTransaction: async () => { assert.equal((await store.read('state.json')).submissions.length, 1); sends++; throw Error('timeout'); } };
  const signed = makeSignedEnvelope(f.artifact, f.tx);
  const result = await CH.submitPrepared(store, state, signed, connection);
  assert.equal(result.status, 'unknown');
  assert.equal(sends, 1);
  const reconciled = await CH.reconcile(store, await store.read('state.json'), connection);
  assert.equal(reconciled.submissions[0].status, 'unknown');
  assert.throws(() => CH.requireSettled(reconciled), /unresolved/i);
  await CH.submitPrepared(store, reconciled, signed, connection);
  assert.equal(sends, 1, 'a pending signature is reconciled, not broadcast again');
});
void test('missing signature becomes expired only after finalized blockheight AND invalid blockhash', async () => {
  assert.equal(typeof CH.reconcile, 'function');
  const state = { submissions: [{ signature: 'sig', status: 'unknown', blockhash: 'hash', lastValidBlockHeight: 10 }] };
  const store = memoryStore(state);
  const conn = { getSignatureStatuses: async () => ({ value: [null] }), getEpochInfo: async () => ({ blockHeight: 11 }), isBlockhashValid: async () => ({ value: true }) };
  assert.equal((await CH.reconcile(store, state, conn)).submissions[0].status, 'unknown');
  conn.isBlockhashValid = async () => ({ value: false });
  assert.equal((await CH.reconcile(store, state, conn)).submissions[0].status, 'expired');
});
void test('metadata uploads reuse receipts and never expose a pinning credential', async () => {
  assert.equal(typeof M.uploadMetadata, 'function');
  const store = memoryStore({}); let calls = 0;
  const fetcher = async (_url, init) => { calls++; assert.equal(init.headers.Authorization, 'Bearer private'); return { ok: true, json: async () => ({ IpfsHash: calls === 1 ? 'QmImage' : 'QmMetadata' }) }; };
  const config = { name: 'Test', symbol: 'TEST', description: 'A test', website: 'https://example.com', imagePath: 'tests/not-read' };
  const options = { fetcher, imageBytes: Buffer.from([137,80,78,71,13,10,26,10]), imageType: 'image/png' };
  const first = await M.uploadMetadata(config, store, 'private', options);
  const second = await M.uploadMetadata(config, store, 'private', options);
  assert.equal(calls, 2); assert.deepEqual(first, second);
  assert.equal(JSON.stringify([...store.files.values()]).includes('private'), false);
});
void test('report exports allowlisted declarations and keeps unknown holdings distinct from zero', () => {
  assert.equal(typeof R.publicSnapshot, 'function');
  const config = { name: 'Test', symbol: 'TEST', network: 'devnet', secret: 'private', wallets: [{ address: 'wallet', label: 'Treasury', purpose: 'Holdings', plannedTokens: '0', maySell: false, secretKey: 'private' }] };
  const report = R.publicSnapshot(config, { mint: null, decimals: null, totalSupplyBase: null, wallets: [{ address: 'wallet', balanceBase: null, transactions: [], error: 'Unavailable' }] }, '2026-09-09T00:00:00.000Z');
  assert.equal(report.wallets[0].balanceTokens, null); assert.equal(report.complete, false);
  assert.equal(JSON.stringify(report).includes('private'), false);
  assert.equal(report.historyLimit, 20);
});
void test('metadata cannot be replaced after a transaction has been prepared', async () => {
  const store = memoryStore({ revision: 1, submissions: [] });
  await assert.rejects(() => M.uploadMetadata({}, store, 'private', { fetcher: async () => { throw Error('must not upload'); } }), /frozen/i);
});
void test('submission binds the budget reviewed in the browser to the stored artifact', async () => {
  const f = await launchFixture(); f.tx.sign([f.creator]);
  const state = { id: f.artifact.id, mint: f.artifact.mint, revision: 1, submissions: [] };
  const store = memoryStore(state); await store.write('prepared-1.json', f.artifact);
  const forged = { ...f.artifact, maxTotalLamports: '1000000', estimatedTotalLamports: '1000000' };
  const signed = makeSignedEnvelope(forged, f.tx);
  await assert.rejects(() => CH.submitPrepared(store, state, signed, f.connection), /review|intent/i);
});
void test('submission rejects a newly increased fee estimate before journaling or sending', async () => {
  const f = await launchFixture(); f.tx.sign([f.creator]);
  const state = { id: f.artifact.id, mint: f.artifact.mint, revision: 1, submissions: [] };
  const store = memoryStore(state); await store.write('prepared-1.json', f.artifact);
  const connection = { ...f.connection, getMultipleAccountsInfo: async keys => keys.map(() => null),
    getFeeForMessage: async () => ({ value: 60000000 }), getMinimumBalanceForRentExemption: async () => 1000000,
    simulateTransaction: async (_tx, options) => ({ value: { err: null, accounts: options.accounts?.addresses.map(() => ({ data: ['', 'base64'] })) } }),
    sendRawTransaction: async () => { throw Error('must not send'); } };
  await assert.rejects(() => CH.submitPrepared(store, state, makeSignedEnvelope(f.artifact, f.tx), connection), /budget|spending/i);
  assert.equal((await store.read('state.json')).submissions.length, 0);
});
void test('missing history with an existing mint remains unknown until its launch intent is verified', async () => {
  const f = await launchFixture();
  const state = { mint: f.artifact.mint, submissions: [{ signature: 'sig', kind: 'create', status: 'unknown', blockhash: 'hash', lastValidBlockHeight: 10 }] };
  const store = memoryStore(state);
  const conn = { getSignatureStatuses: async () => ({ value: [null] }), getEpochInfo: async () => ({ blockHeight: 11 }), isBlockhashValid: async () => ({ value: false }), getAccountInfo: async () => ({ owner: 'unverified mint' }) };
  assert.equal((await CH.reconcile(store, state, conn)).submissions[0].status, 'unknown');
  let verified = 0;
  const recovered = await CH.reconcile(store, state, conn, async () => { verified++; });
  assert.equal(verified, 1); assert.equal(recovered.submissions[0].status, 'recovered');
});
