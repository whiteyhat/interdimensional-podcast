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
  assert.equal(C.readCheckout('{broken').draft.product, 'spotlight');
  // A draft saved for the withdrawn five-dollar message keeps its words under an offer on sale.
  const withdrawn = C.readCheckout(
    JSON.stringify({
      version: 1,
      draft: { product: 'message', name: 'ser', message: 'gm frens' },
    }),
  ).draft;
  assert.equal(withdrawn.product, 'spotlight');
  assert.equal(withdrawn.message, 'gm frens');
  assert.equal(
    C.readCheckout(
      JSON.stringify({ version: 1, asset: 'BTC', draft: { product: 'scam' } }),
    ).asset,
    'FROGCLENCH',
  );
  assert.equal(
    C.readCheckout(JSON.stringify({ version: 1, token: 'javascript:bad' }))
      .token,
    null,
  );
});
void test('fresh and unreadable checkout storage defaults to FROGCLENCH', () => {
  for (const raw of [null, '', '{broken', 'null', '{}', '{"version":2,"asset":"SOL"}', '{"version":1,"asset":"BTC"}'])
    assert.equal(C.readCheckout(raw).asset, 'FROGCLENCH', raw);
});
void test('valid saved currency choices survive the new checkout default', () => {
  for (const asset of ['FROGCLENCH', 'SOL', 'USDC'])
    assert.equal(C.readCheckout(JSON.stringify({ version: 1, asset })).asset, asset);
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
      'An example look. Yours is tailored right after payment · usually one to two minutes',
    tailoring: 'Tailoring your tee and cap · usually one to two minutes',
    anotherFit: 'Still tailoring — trying another fit',
    slow: 'This is taking longer than usual',
    replace: 'Use a different logo',
    improving: "We'll keep improving the fit",
    refused: 'This logo could not be dressed.',
  });
});

void test('the wardrobe card follows the order: the payment clock while tailoring, then the look, never the stored asset', () => {
  const paid = {
    status: 'paid',
    draft: {
      product: 'cap',
      name: '',
      message: 'gm',
      target: 'host',
      assetId: 'asset-1',
    },
    paidAt: 1_000_000,
    look: { status: 'tailoring' },
  };
  assert.equal(
    C.lookView(
      { ...paid, draft: { ...paid.draft, product: 'spotlight' } },
      1_000_000,
    ),
    null,
  );
  assert.equal(
    C.lookView({ ...paid, status: 'draft', paidAt: null }, 1_000_000),
    null,
  );
  assert.equal(
    C.lookView(
      { ...paid, status: 'payment-pending', paidAt: null },
      1_000_000,
    ),
    null,
  );
  assert.deepEqual(C.lookView(paid, 1_000_000 + 119_000), {
    kind: 'tailoring',
    label: 'TAILORING',
    line: 'Tailoring your tee and cap · usually one to two minutes',
    replace: false,
    url: null,
  });
  assert.deepEqual(C.lookView(paid, 1_000_000 + 120_000), {
    kind: 'tailoring',
    label: 'TAILORING',
    line: 'Still tailoring — trying another fit',
    replace: false,
    url: null,
  });
  assert.deepEqual(C.lookView(paid, 1_000_000 + 600_000), {
    kind: 'tailoring',
    label: 'TAILORING',
    line: 'This is taking longer than usual',
    replace: true,
    url: null,
  });
  // A missing look on a paid cap is a tailor that has not reported yet, not a finished pass.
  assert.equal(C.lookView({ ...paid, look: undefined }, 1_000_000).kind, 'tailoring');
  // A replaced logo restarts the clock from the replacement, not from the payment: the page
  // knows the moment it swapped, and the receipt itself carries it for a reload elsewhere.
  assert.equal(
    C.lookView(paid, 1_000_000 + 700_000, 1_000_000 + 650_000).line,
    'Tailoring your tee and cap · usually one to two minutes',
  );
  assert.deepEqual(
    C.lookView(
      { ...paid, look: { status: 'tailoring', since: 1_000_000 + 650_000 } },
      1_000_000 + 700_000,
    ),
    {
      kind: 'tailoring',
      label: 'TAILORING',
      line: 'Tailoring your tee and cap · usually one to two minutes',
      replace: false,
      url: null,
    },
  );
  const url = '/api/sponsorship/assets/asset-1?part=look&v=' + 'c'.repeat(64);
  assert.deepEqual(
    C.lookView({ ...paid, look: { status: 'ready', url } }, 1_000_000 + 900_000),
    { kind: 'ready', label: 'YOUR ON-AIR PASS', line: null, replace: false, url },
  );
  assert.deepEqual(
    C.lookView(
      { ...paid, look: { status: 'ready', url, fallback: 'cap-v1' } },
      1_000_000,
    ),
    {
      kind: 'ready',
      label: 'YOUR ON-AIR PASS',
      line: "We'll keep improving the fit",
      replace: true,
      url,
    },
  );
  assert.deepEqual(
    C.lookView(
      {
        ...paid,
        look: {
          status: 'refused',
          reason: 'This logo could not be dressed. Use a different logo.',
        },
      },
      1_000_000,
    ),
    {
      kind: 'refused',
      label: 'TAILORING',
      line: 'This logo could not be dressed. Use a different logo.',
      replace: true,
      url: null,
    },
  );
  assert.equal(
    C.lookView({ ...paid, look: { status: 'refused' } }, 1_000_000).line,
    'This logo could not be dressed.',
  );
  // The site takes a different logo only from a paid cap that is not on air yet, so the
  // receipt stops offering it once the cap is leased, playing, paused or delivered.
  for (const status of ['leased', 'prepared', 'playing', 'paused', 'delivered']) {
    assert.equal(
      C.lookView(
        { ...paid, status, look: { status: 'ready', url, fallback: 'cap-v1' } },
        1_000_000,
      ).replace,
      false,
      status,
    );
    assert.equal(
      C.lookView({ ...paid, status, look: { status: 'refused' } }, 1_000_000)
        .replace,
      false,
      status,
    );
  }
  assert.equal(C.lookAlt('host'), 'Pepe wearing your tee and cap');
  assert.equal(C.lookAlt('guest'), 'Chad wearing your tee and cap');
  assert.equal(C.lookAlt(undefined), 'Pepe wearing your tee and cap');
  assert.equal(
    C.logoSwatchUrl('asset/1'),
    '/api/sponsorship/assets/asset%2F1?part=logo',
  );
  assert.equal(C.logoSwatchUrl(undefined), null);
  assert.equal(C.logoSwatchUrl(''), null);
  assert.equal(C.baseStill('host'), '/pepe-video.avif');
  assert.equal(C.baseStill('guest'), '/gigachad-video.avif');
  assert.equal(C.baseStill(undefined), '/pepe-video.avif');
  assert.equal(C.exampleLook('host'), '/looks/pepe-northwind.avif');
  assert.equal(C.exampleLook('guest'), '/looks/gigachad-northwind.avif');
  assert.equal(C.exampleLook(undefined), '/looks/pepe-northwind.avif');
  assert.equal(C.exampleAlt('guest'), "An example: Chad wearing Northwind's tee and cap");
  assert.equal(C.exampleAlt('host'), "An example: Pepe wearing Northwind's tee and cap");
});

void test('a paid cap waits on its tailor before it is in the queue; every other paid order is queued', () => {
  const cap = {
    status: 'paid',
    draft: { product: 'cap', name: '', message: 'gm', target: 'host' },
    attempts: [],
  };
  assert.equal(C.receiptStage({ ...cap, look: { status: 'tailoring' } }), 'tailoring');
  assert.equal(C.receiptStage(cap), 'tailoring');
  assert.equal(
    C.receiptStage({ ...cap, look: { status: 'ready', url: '/look' } }),
    'queued',
  );
  assert.equal(
    C.receiptStage({ ...cap, look: { status: 'refused', reason: 'no' } }),
    'queued',
  );
  assert.equal(
    C.receiptStage({ ...cap, status: 'leased', look: { status: 'tailoring' } }),
    'queued',
  );
  assert.equal(
    C.receiptStage({ ...cap, draft: { ...cap.draft, product: 'spotlight' } }),
    'queued',
  );
});
