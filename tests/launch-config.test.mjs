import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
const C = await import('../lib/launch/config.mjs').catch(() => ({}));
const creator = Keypair.generate().publicKey.toBase58();
const config = () => ({ schemaVersion: 1, network: 'devnet', name: 'Frogclench', symbol: 'FROGCLENCH',
  description: 'A live meme podcast.', imagePath: 'public/logo.png', website: 'https://example.com',
  creator, treasury: creator, buyLamports: '1000000', maxTotalLamports: '50000000', priorityMicroLamports: '0',
  wallets: [{ address: creator, label: 'Treasury', purpose: 'Creator holdings', plannedTokens: '100', maySell: false }] });

void test('config validates financial inputs without number coercion and strips unknown fields', () => {
  assert.equal(typeof C.validateConfig, 'function');
  const result = C.validateConfig({ ...config(), maxTotalLamports: '9007199254740993', secretKey: 'never export' });
  assert.equal(result.maxTotalLamports, '9007199254740993');
  assert.equal(result.secretKey, undefined);
  for (const buyLamports of [1, '1e9', '-1', '0', '1.2', '18446744073709551616'])
    assert.throws(() => C.validateConfig({ ...config(), buyLamports }), /buyLamports/);
});
void test('requires complete wallet disclosure including creator and treasury', () => {
  assert.equal(typeof C.validateConfig, 'function');
  assert.throws(() => C.validateConfig({ ...config(), wallets: [] }), /wallet/i);
  assert.throws(() => C.validateConfig({ ...config(), wallets: [...config().wallets, ...config().wallets] }), /duplicate/i);
  assert.throws(() => C.validateConfig({ ...config(), treasury: Keypair.generate().publicKey.toBase58() }), /treasury/i);
  assert.throws(() => C.validateConfig({ ...config(), wallets: [{ ...config().wallets[0], maySell: undefined }] }), /maySell/);
});
void test('rejects unsafe URLs and unapproved launch modes', () => {
  assert.equal(typeof C.validateConfig, 'function');
  for (const website of ['javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com/?api_key=secret'])
    assert.throws(() => C.validateConfig({ ...config(), website }), /website/);
  assert.throws(() => C.validateConfig({ ...config(), cashback: true }), /standard/i);
  assert.throws(() => C.validateConfig({ ...config(), maxTotalLamports: '1' }), /total/i);
});
void test('token formatting retains base-unit precision', () => {
  assert.equal(typeof C.tokenUnits, 'function');
  assert.equal(C.tokenUnits('9007199254740993', 6), '9007199254.740993');
  assert.equal(C.tokenUnits('0', 6), '0');
  assert.equal(C.tokenUnits('1000000', 6), '1');
});
export { config };
