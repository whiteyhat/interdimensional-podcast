import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['requests', 'sponsor-delivery-client', 'playback-health']);
const { createSponsorServices } =
  await import('../work/tests/sponsor-delivery-client.js');
const { PlaybackHealth } = await import('../work/tests/playback-health.js');

void test('the playback watchdog permits normal progress and bounds missing-frame or stalled playback', () => {
  const loading = new PlaybackHealth(1000);
  assert.equal(loading.stalled(0, 8999), false);
  assert.equal(loading.stalled(0, 9000), true);
  const playing = new PlaybackHealth(1000);
  for (let second = 1; second <= 10; second++)
    assert.equal(playing.stalled(second, 1000 + second * 1000), false);
  assert.equal(playing.stalled(10, 18999), false);
  assert.equal(playing.stalled(10, 19000), true);
});

void test('a reloaded producer recovers a durable pause before sending another heartbeat', async (t) => {
  const originalStorage = globalThis.localStorage;
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  t.after(() => {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalStorage,
      });
  });
  const actions = [];
  let available = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('assets?action=health'))
      return Response.json({ ready: false, capQualified: false });
    const body = JSON.parse(options.body);
    actions.push(body.action === 'event' ? body.type : body.action);
    if (body.action === 'event')
      return available
        ? Response.json({ status: 'paused' })
        : Response.json({ error: 'Network recovery pending' }, { status: 503 });
    return Response.json(
      body.action === 'pull' ? { orders: [] } : { ok: true },
    );
  });
  const intent = {
    orderId: 'order',
    leaseToken: 'lease',
    eventId: 'lease:clip:pause',
    type: 'paused',
  };
  await assert.rejects(createSponsorServices().event(intent));
  assert.match(
    storage.get('podcast:sponsor-pause-intents:v1'),
    /lease:clip:pause/,
  );
  const resumed = createSponsorServices();
  await assert.rejects(resumed.sync());
  assert.ok(
    !actions.includes('heartbeat'),
    'a reload cannot renew the ambiguous delivery',
  );
  available = true;
  await resumed.sync();
  assert.deepEqual(actions.slice(-3), ['paused', 'heartbeat', 'pull']);
  assert.equal(storage.get('podcast:sponsor-pause-intents:v1'), '[]');
});
