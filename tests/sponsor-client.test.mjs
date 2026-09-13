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
void test('the cap chooser and receipt say how many caps go on first, never that a host is reserved', () => {
  assert.equal(C.capQueueLabel(undefined), 'Checking the line…');
  assert.equal(C.capQueueLabel(0), 'Available now');
  assert.equal(C.capQueueLabel(1), '1 ahead · yours starts after it');
  assert.equal(C.capQueueLabel(3), '3 ahead · yours starts after them');
  assert.equal(
    C.capAheadCopy(1, 'host'),
    'Another cap is ahead of yours on Pepe. Yours starts the moment it finishes.',
  );
  assert.equal(
    C.capAheadCopy(2, 'guest'),
    '2 caps are ahead of yours on GigaChad. Yours starts the moment they finish.',
  );
  for (const copy of [
    C.capQueueLabel(0),
    C.capQueueLabel(2),
    C.capAheadCopy(1, 'host'),
  ])
    assert.doesNotMatch(copy, /reserved/i);
});

void test('the cap sells as a tee and a cap made for the brand, and every waiting line is pinned', () => {
  assert.deepEqual(C.productCopy.cap, {
    title: 'Dress the host',
    short: 'Your logo on the tee, a cap in your colours',
    description:
      'Your logo printed on the tee and a cap in your colours, worn by Pepe or Chad for 10 live minutes. Six clear appearances, an introduction and a callback.',
    icon: 'cap',
  });
  assert.deepEqual(C.LOOK_COPY, {
    previewCaption:
      'Your tee and cap are tailored right after payment · usually one to two minutes',
    tailoring: 'Tailoring your tee and cap · usually one to two minutes',
    anotherFit: 'Still tailoring — trying another fit',
    slow: 'This is taking longer than usual',
    replace: 'Use a different logo',
    improving: "We'll keep improving the fit",
    refused: 'This logo could not be dressed.',
  });
});
