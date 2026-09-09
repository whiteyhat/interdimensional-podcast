import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['sponsor-client']);
const C = await import('../work/tests/sponsor-client.js');

void test('checkout persistence retains an unfinished draft and asset without trusting storage', () => {
  const saved = C.readCheckout(
    JSON.stringify({
      version: 1,
      draft: { product: 'cap', name: 'ser', message: 'gm', target: 'guest' },
      asset: 'FROGCLENCH',
      token: 'a'.repeat(48),
    }),
  );
  assert.equal(saved.draft.product, 'cap');
  assert.equal(saved.asset, 'FROGCLENCH');
  assert.equal(saved.token, 'a'.repeat(48));
  assert.equal(C.readCheckout('{broken').draft.product, 'message');
  assert.equal(
    C.readCheckout(
      JSON.stringify({ version: 1, asset: 'BTC', draft: { product: 'scam' } }),
    ).asset,
    'USDC',
  );
  assert.equal(
    C.readCheckout(JSON.stringify({ version: 1, token: 'javascript:bad' }))
      .token,
    null,
  );
});
void test('an ambiguous wallet response stays attached to its receipt and must not offer payment again', () => {
  const receipt = {
    status: 'payment-pending',
    attempts: [{ id: 'a', status: 'issued' }],
  };
  assert.equal(C.receiptStage(receipt), 'payment');
  assert.equal(C.receiptStage({ ...receipt, status: 'paid' }), 'queued');
  assert.equal(C.receiptStage({ ...receipt, status: 'playing' }), 'on-air');
  assert.equal(
    C.receiptStage({ ...receipt, status: 'fulfilled' }),
    'delivered',
  );
  assert.equal(
    C.receiptStage({ ...receipt, status: 'refund-pending' }),
    'refund',
  );
});
void test('receipt progress reflects delivery evidence rather than generation', () => {
  assert.equal(
    C.deliveryProgress({
      visibleMs: 300000,
      appearances: 3,
      intro: true,
      callback: false,
    }),
    50,
  );
  assert.equal(
    C.deliveryProgress({
      visibleMs: 600000,
      appearances: 6,
      intro: true,
      callback: false,
    }),
    99,
  );
  assert.equal(
    C.deliveryProgress({
      visibleMs: 600000,
      appearances: 6,
      intro: true,
      callback: true,
    }),
    100,
  );
});
