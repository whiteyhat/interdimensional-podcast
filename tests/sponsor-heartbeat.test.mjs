import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['sponsor-delivery-client']);
const { createSponsorServices, HEALTH_GRACE_MS } =
  await import('../work/tests/sponsor-delivery-client.js');

// One failed health check used to heartbeat cap:false, which made the site refuse the lease of
// a cap already on air and discard its finished take: the paid order then paused.
void test('one failed cap health check does not take the cap off air; a long outage does', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let healthy = true;
  const offered = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('/api/sponsorship/assets')) {
      if (!healthy) throw new TypeError('fetch failed');
      return Response.json({
        ready: true,
        capQualified: true,
        templateVersion: 'caps-v1',
      });
    }
    const body = JSON.parse(options.body);
    if (body.action === 'heartbeat') offered.push(body.capabilities.cap);
    return Response.json(
      body.action === 'pull' ? { orders: [] } : { ok: true },
    );
  });
  const services = createSponsorServices();
  await services.sync();
  healthy = false;
  now += 21_000;
  await services.sync();
  now += 21_000;
  await services.sync();
  assert.deepEqual(
    offered,
    [true, true, true],
    'a brief outage keeps the cap on offer',
  );
  now += HEALTH_GRACE_MS;
  await services.sync();
  assert.equal(
    offered.at(-1),
    false,
    'an outage longer than the grace takes it off',
  );
});

void test('a site that says the cap is not ready is believed at once', async (t) => {
  let now = 2_000_000;
  t.mock.method(Date, 'now', () => now);
  let ready = true;
  const offered = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('/api/sponsorship/assets'))
      return Response.json({
        ready,
        capQualified: ready,
        templateVersion: 'caps-v1',
      });
    const body = JSON.parse(options.body);
    if (body.action === 'heartbeat') offered.push(body.capabilities.cap);
    return Response.json(
      body.action === 'pull' ? { orders: [] } : { ok: true },
    );
  });
  const services = createSponsorServices();
  await services.sync();
  ready = false;
  now += 21_000;
  await services.sync();
  assert.deepEqual(offered, [true, false]);
});
