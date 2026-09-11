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
