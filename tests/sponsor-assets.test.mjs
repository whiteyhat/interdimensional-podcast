import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { d1 } from './fixtures/d1.mjs';
import { build } from './build.mjs';
await build([
  'sponsor-assets',
  'sponsor-server',
  'sponsor-db',
  'sponsor-pay',
  'sponsorship',
  'requests',
  'interact',
  'producer-lease',
  'throttle',
]);
const { uploadSponsorAsset, sponsorAssetHealth } =
  await import('../work/tests/sponsor-assets.js');
const png = Buffer.from('canonical-media-worker-output'),
  logo = Buffer.from('normalized-original-mark');
const hash = (b) => createHash('sha256').update(b).digest('hex');
function request(ip = 'asset-test', origin = 'https://show.test') {
  const form = new FormData();
  form.set('image', new File([png], 'logo.png', { type: 'image/png' }));
  form.set('kind', 'cap');
  form.set('target', 'host');
  return new Request('https://show.test/api/sponsorship/assets', {
    method: 'POST',
    headers: { origin, 'cf-connecting-ip': ip },
    body: form,
  });
}
void test('canonical uploads bind qualification and original logo into immutable asset identities', async () => {
  const DB = d1(),
    objects = new Map(),
    v = {
      DB,
      SITE_URL: 'https://show.test',
      SPONSOR_MEDIA_URL: 'https://media.test',
      SPONSOR_MEDIA_TOKEN: 'a'.repeat(32),
      SPONSOR_ASSETS: {
        async put(key, bytes) {
          objects.set(key, Buffer.from(bytes));
        },
      },
    };
  const originalFetch = globalThis.fetch;
  let qualified = false,
    corrupt = false;
  globalThis.fetch = async () =>
    Response.json({
      preview: png.toString('base64'),
      logo: logo.toString('base64'),
      sha256: corrupt ? 'corrupted' : hash(png),
      logoSha256: hash(logo),
      templateId: 'pepe-cap-v1',
      templateVersion: 'caps-v1',
      qualificationVersion: qualified ? 'caps-v1' : null,
    });
  try {
    const preview = await (await uploadSponsorAsset(request(), v)).json();
    assert.equal(preview.status, 'preview');
    qualified = true;
    const accepted = await (await uploadSponsorAsset(request(), v)).json();
    assert.equal(accepted.status, 'qualified');
    assert.notEqual(accepted.id, preview.id);
    assert.equal(
      DB.sql
        .prepare('SELECT status FROM sponsor_assets WHERE id=?')
        .get(preview.id).status,
      'preview',
      'qualification never rewrites the earlier design',
    );
    const repeated = await (await uploadSponsorAsset(request(), v)).json();
    assert.equal(repeated.id, accepted.id);
    assert.equal(
      DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n,
      2,
    );
    assert.deepEqual(objects.get(`${accepted.id}/logo.png`), logo);
    corrupt = true;
    const invalid = await uploadSponsorAsset(request(), v);
    assert.equal(invalid.status, 502);
    assert.equal(
      DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n,
      2,
      'corrupt media cannot enter inventory',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
void test('cross-origin artwork requests fail before storage or worker calls', async () => {
  const response = await uploadSponsorAsset(
    request('other', 'https://attacker.test'),
    {},
  );
  assert.equal(response.status, 403);
});

// The health answer is cached per isolate, keyed by the media URL, so each test below uses a
// URL of its own and starts from an empty cache.
const healthVars = (url) => ({
  SPONSOR_MEDIA_URL: url,
  SPONSOR_MEDIA_TOKEN: 'a'.repeat(32),
  SPONSOR_ASSETS: {},
});
const checkHealth = async (v) =>
  (
    await sponsorAssetHealth(
      new Request('https://show.test/api/sponsorship/assets?action=health'),
      v,
    )
  ).json();
const readyBody = {
  ready: true,
  capQualified: true,
  templateVersion: 'caps-v1',
  templates: [],
  tools: { python: true, cv2: true, numpy: true, ffmpeg: true, node: true },
  version: 'test',
};
void test('the public health check asks the media service at most once per 15 seconds', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(readyBody);
  });
  const v = healthVars('https://media-ttl.test');
  for (let i = 0; i < 5; i++)
    assert.deepEqual(await checkHealth(v), {
      ready: true,
      capQualified: true,
      templateVersion: 'caps-v1',
    });
  assert.equal(calls.length, 1, 'five page views, one probe');
  assert.equal(calls[0].url, 'https://media-ttl.test/health');
  assert.equal(
    new Headers(calls[0].init?.headers).get('authorization'),
    null,
    '/health is unauthenticated, so the render secret is not sent',
  );
  clock += 14999;
  await checkHealth(v);
  assert.equal(calls.length, 1, 'still inside the 15 seconds');
  clock += 1;
  await checkHealth(v);
  assert.equal(calls.length, 2, 'a stale answer is asked again');
});
void test('health checks that arrive together share one probe', async (t) => {
  let release;
  const answered = new Promise((resolve) => (release = resolve));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    await answered;
    return Response.json({ ...readyBody, capQualified: false });
  });
  const v = healthVars('https://media-together.test');
  const pending = Array.from({ length: 8 }, () => checkHealth(v));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  for (const body of await Promise.all(pending))
    assert.deepEqual(body, {
      ready: true,
      capQualified: false,
      templateVersion: 'caps-v1',
    });
  assert.equal(calls, 1);
});
void test('a 503 from the media health check means not ready, whatever its body says', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(readyBody, { status: 503 }),
  );
  assert.deepEqual(await checkHealth(healthVars('https://media-down.test')), {
    ready: false,
    capQualified: false,
  });
});

const ready = { ready: true, capQualified: true, templateVersion: 'caps-v1' },
  notReady = { ready: false, capQualified: false };
const realSetTimeout = globalThis.setTimeout;
/** Let every timer fire at once, keeping what was asked for. */
function instantTimers(t) {
  const waits = [];
  const timers = t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    waits.push(ms);
    return realSetTimeout(fn, 0);
  });
  return { waits, restore: () => timers.mock.restore() };
}

// The studio heartbeats cap:false the moment this says not ready, and a lease whose producer
// stops reporting cap:true is refused mid-take. One lost probe must not do that.
void test('a failed probe keeps the last answer the service gave, for 75 seconds', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let answer = () => Response.json(readyBody);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return answer();
  });
  const v = healthVars('https://media-stale.test');
  assert.deepEqual(await checkHealth(v), ready);
  for (const [name, fault] of [
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    [
      'timeout',
      () =>
        Promise.reject(
          new DOMException('The operation timed out.', 'TimeoutError'),
        ),
    ],
    ['proxy error page', () => new Response('Bad gateway', { status: 502 })],
    [
      'proxy 503 page',
      () => new Response('upstream connect error', { status: 503 }),
    ],
    [
      'a web page from the wrong host',
      () =>
        new Response('<!doctype html><title>Welcome</title>', {
          headers: { 'content-type': 'text/html' },
        }),
    ],
  ]) {
    clock += 15000;
    answer = fault;
    assert.deepEqual(await checkHealth(v), ready, name);
  }
  assert.equal(calls.length, 6, 'each fault was a fresh probe');
  clock += 1;
  assert.deepEqual(
    await checkHealth(v),
    notReady,
    'out of reach for over 75 seconds',
  );
  clock += 15000;
  answer = () => Response.json(readyBody);
  assert.deepEqual(await checkHealth(v), ready, 'back as soon as it answers');
});
void test('a 503 the service writes itself takes caps off sale at once', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let answer = () => Response.json(readyBody);
  t.mock.method(globalThis, 'fetch', async () => answer());
  const v = healthVars('https://media-closing.test');
  assert.deepEqual(await checkHealth(v), ready);
  clock += 15000;
  answer = () =>
    Response.json(
      { ...readyBody, ready: false, capQualified: false },
      {
        status: 503,
      },
    );
  assert.deepEqual(await checkHealth(v), notReady);
});
void test('a slow probe does not hold a caller that has an answer to give', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let release;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async () => {
    calls.push(clock);
    if (calls.length === 1) return Response.json(readyBody);
    await new Promise((resolve) => (release = resolve));
    return Response.json({ ...readyBody, ready: false }, { status: 503 });
  });
  const v = healthVars('https://media-slow.test');
  assert.deepEqual(await checkHealth(v), ready);
  clock += 15000;
  const timers = instantTimers(t);
  assert.deepEqual(await checkHealth(v), ready, 'the standing answer');
  assert.ok(
    timers.waits.length && Math.max(...timers.waits) < 5000,
    `waited ${timers.waits.join(', ')} ms, not the probe's 5 s`,
  );
  assert.deepEqual(await checkHealth(v), ready);
  assert.equal(calls.length, 2, 'the second caller joined the probe');
  timers.restore();
  release();
  assert.deepEqual(
    await checkHealth(v),
    notReady,
    'the late answer counts once it comes',
  );
  assert.equal(calls.length, 2);
});
void test('a probe that never settles is not waited on for ever', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    // The first probe is lost with the request that sent it.
    return calls === 1 ? new Promise(() => {}) : Response.json(readyBody);
  });
  const v = healthVars('https://media-lost.test');
  const timers = instantTimers(t);
  assert.deepEqual(await checkHealth(v), notReady);
  assert.ok(
    Math.max(...timers.waits) <= 6000,
    `bounded by the probe's own timeout: ${timers.waits.join(', ')} ms`,
  );
  clock += 1000;
  assert.deepEqual(await checkHealth(v), notReady);
  assert.equal(calls, 1, 'still inside its timeout, so it is joined');
  timers.restore();
  clock += 5000;
  assert.deepEqual(await checkHealth(v), ready);
  assert.equal(calls, 2, 'past it, a new probe replaces the lost one');
});
void test('the studio bridge keeps the site answer through a lost hop', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let answer = () => Response.json(ready);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return answer();
  });
  const v = { INTERACT_ORIGIN: 'https://relay-site.test' };
  const bridge = async () =>
    (
      await sponsorAssetHealth(
        new Request(
          'http://127.0.0.1:3212/api/sponsorship/assets?action=health',
        ),
        v,
      )
    ).json();
  assert.deepEqual(await bridge(), ready);
  assert.equal(
    calls[0],
    'https://relay-site.test/api/sponsorship/assets?action=health',
  );
  clock += 60000;
  answer = () => Promise.reject(new TypeError('fetch failed'));
  assert.deepEqual(await bridge(), ready, 'a lost hop');
  clock += 15000;
  answer = () => new Response('Bad gateway', { status: 502 });
  assert.deepEqual(await bridge(), ready, 'an error page at 75 s');
  clock += 1;
  assert.deepEqual(await bridge(), notReady, 'the site gone for over 75 s');
  answer = () => Response.json(ready);
  assert.deepEqual(await bridge(), ready);
  answer = () => Response.json(notReady);
  assert.deepEqual(
    await bridge(),
    notReady,
    'the site saying not ready passes straight through',
  );
});
void test('a site that cannot render reports not ready without probing', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json(readyBody);
  });
  for (const v of [
    { ...healthVars('https://media-unset.test'), SPONSOR_MEDIA_TOKEN: '' },
    { ...healthVars('https://media-unset.test'), SPONSOR_ASSETS: undefined },
    { ...healthVars('https://media-unset.test'), SPONSOR_MEDIA_URL: undefined },
    healthVars('not a url'),
  ])
    assert.deepEqual(await checkHealth(v), {
      ready: false,
      capQualified: false,
    });
  assert.equal(calls, 0);
});
