import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
import { d1 } from './fixtures/d1.mjs';
await build([
  'requests',
  'interact',
  'producer-lease',
  'sponsorship',
  'sponsor-db',
  'sponsor-pay',
  'sponsor-server',
  'sponsor-context',
  'sponsor-assets',
  'sponsor-media',
  'throttle',
]);
const { resolveTrustedSponsor } =
  await import('../work/tests/sponsor-context.js');
const { renderSponsorMedia } = await import('../work/tests/sponsor-media.js');
const db = await import('../work/tests/sponsor-db.js');
const vars = {
  STUDIO_TOKEN: 'a-secret-studio-token-for-testing',
  STUDIO_ID: 'studio-a',
  INTERACT_ORIGIN: 'https://show.test',
};
const reference = { orderId: 'order', leaseToken: 'lease' };
void test('public callers and cross-site localhost calls cannot obtain a producer sponsorship brief', async () => {
  await assert.rejects(
    resolveTrustedSponsor(
      new Request('https://show.test/api/podcast'),
      vars,
      reference,
    ),
    /Studio token rejected/,
  );
  await assert.rejects(
    resolveTrustedSponsor(
      new Request('http://127.0.0.1:3212/api/podcast', {
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
      vars,
      reference,
    ),
    /own machine/,
  );
  await assert.rejects(
    resolveTrustedSponsor(
      new Request('http://127.0.0.1:3212/api/podcast', {
        headers: { origin: 'https://malicious.test' },
      }),
      vars,
      reference,
    ),
    /Origin not allowed/,
  );
});
void test('the local producer resolves purchased fields from its authenticated upstream lease', async (t) => {
  const order = {
    id: 'order',
    draft: {
      product: 'spotlight',
      name: 'alice',
      message: 'The approved brief',
    },
    leaseToken: 'lease',
    fulfillment: {},
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://show.test/api/sponsorship');
    assert.equal(options.headers['x-studio-token'], vars.STUDIO_TOKEN);
    assert.equal(options.headers['x-studio-id'], 'studio-a');
    assert.deepEqual(JSON.parse(options.body), {
      action: 'context',
      ...reference,
    });
    return Response.json({ order });
  });
  assert.deepEqual(
    await resolveTrustedSponsor(
      new Request('http://127.0.0.1:3212/api/podcast'),
      vars,
      reference,
    ),
    order,
  );
});

void test('local context uses the incoming producer identity when there is no bridge', async (t) => {
  for (const [name, id, expected] of [
    ['absent', undefined, 'studio'],
    ['trimmed', '  studio-a  ', 'studio-a'],
    ['invalid', 'studio/a', 'studio'],
    ['long', 'a'.repeat(40), 'a'.repeat(32)],
  ]) {
    await t.test(name, async () => {
      const DB = d1();
      const now = Date.now();
      await db.ensureSponsorSchema(DB);
      await db.heartbeat(DB, expected, { message: true }, now);
      await db.createOrder(DB, {
        id: 'order', tokenHash: 'receipt', now,
        draft: { product: 'message', name: 'Alice', message: 'The approved message' },
      });
      DB.sql.prepare("UPDATE sponsor_orders SET status='paid',paid_at=? WHERE id='order'").run(now);
      const [leased] = await db.leaseOrders(DB, expected, now);
      const order = await resolveTrustedSponsor(
        new Request('http://127.0.0.1:3212/api/podcast', {
          headers: id === undefined ? {} : { 'x-studio-id': id },
        }),
        { DB, STUDIO_TOKEN: vars.STUDIO_TOKEN, STUDIO_ID: 'configured-bridge-id' },
        { orderId: leased.id, leaseToken: leased.lease_token },
      );
      assert.equal(order.id, leased.id);
      assert.equal(order.draft.message, 'The approved message');
    });
  }
});

void test('context and media bridges forward the canonical legacy producer identity', async (t) => {
  for (const [name, id, expected] of [
    ['absent', undefined, 'studio'],
    ['trimmed', '  studio-a  ', 'studio-a'],
    ['invalid', 'studio/a', 'studio'],
    ['long', 'a'.repeat(40), 'a'.repeat(32)],
  ]) {
    await t.test(name, async (t) => {
      const calls = [];
      t.mock.method(globalThis, 'fetch', (url, options) => {
        calls.push(new URL(url).pathname);
        assert.equal(options.headers['x-studio-token'], vars.STUDIO_TOKEN);
        assert.equal(options.headers['x-studio-id'], expected);
        return Promise.resolve(Response.json({ order: { id: 'order' }, url: 'https://show.test/video' }));
      });
      const configured = { ...vars, STUDIO_ID: id };
      const order = await resolveTrustedSponsor(
        new Request('http://127.0.0.1:3212/api/podcast'),
        configured,
        reference,
      );
      assert.equal(order.id, 'order');
      const response = await renderSponsorMedia(
        new Request('http://127.0.0.1:3212/api/sponsorship/media', {
          method: 'POST',
          body: JSON.stringify({ ...reference, videoUrl: 'https://fal.media/video.mp4' }),
        }),
        configured,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(calls, ['/api/sponsorship', '/api/sponsorship/media']);
    });
  }
});
