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
const { uploadSponsorAsset, sponsorAssetHealth, readSponsorAsset, receiveLook } =
  await import('../work/tests/sponsor-assets.js');
const { ensureSponsorSchema } = await import('../work/tests/sponsor-db.js');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('an uploaded mark'),
]);
const normalised = Buffer.from('normalised-rgba-png');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const PALETTE = {
  clusters: [{ hex: '#112233', share: 1 }],
  primary: '#112233',
  secondary: '#112233',
  accent: '#112233',
  monochrome: false,
};
function request({
  ip = 'asset-test',
  origin = 'https://show.test',
  bytes = PNG,
  kind = 'cap',
  target = 'host',
} = {}) {
  const form = new FormData();
  form.set('image', new File([bytes], 'logo.png', { type: 'image/png' }));
  form.set('kind', kind);
  form.set('target', target);
  return new Request('https://show.test/api/sponsorship/assets', {
    method: 'POST',
    headers: { origin, 'cf-connecting-ip': ip },
    body: form,
  });
}
/** A site with a desk address, a token, a database and an in-memory bucket. */
function siteVars() {
  const DB = d1(),
    objects = new Map();
  return {
    DB,
    objects,
    v: {
      DB,
      SITE_URL: 'https://show.test',
      SPONSOR_ENABLED: 'true',
      SPONSOR_MEDIA_URL: 'https://media.test',
      SPONSOR_MEDIA_TOKEN: 'a'.repeat(32),
      SPONSOR_ASSETS: {
        async put(key, bytes) {
          objects.set(key, Buffer.from(bytes));
        },
      },
    },
  };
}
const ASSET_ID = hash(JSON.stringify([hash(normalised), 'host', 'looks-v1']));
const LOGO_URL = `https://show.test/api/sponsorship/assets/${ASSET_ID}?part=logo`;
void test('an upload is normalised by the desk and stored as a logo waiting for its look', async (t) => {
  const { DB, objects, v } = siteVars();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({
      logo: normalised.toString('base64'),
      logoSha256: hash(normalised),
      width: 640,
      height: 200,
      palette: PALETTE,
    });
  });
  const response = await uploadSponsorAsset(request(), v);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { id: ASSET_ID, status: 'logo', url: LOGO_URL, logoUrl: LOGO_URL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://media.test/logo?target=host');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${'a'.repeat(32)}`);
  assert.equal(calls[0].init.headers['content-type'], 'image/png');
  assert.deepEqual(Buffer.from(calls[0].init.body), PNG, 'the raw upload travels to the desk');
  assert.deepEqual(objects.get(`${ASSET_ID}/logo.png`), normalised);
  assert.equal(objects.size, 1, 'nothing but the normalised logo is stored');
  const row = DB.sql.prepare('SELECT * FROM sponsor_assets WHERE id=?').get(ASSET_ID);
  assert.equal(row.status, 'logo');
  assert.equal(row.url, LOGO_URL);
  assert.equal(row.mime, 'image/png');
  assert.deepEqual(JSON.parse(row.metadata), {
    kind: 'cap',
    target: 'host',
    logoSha256: hash(normalised),
    logoUrl: LOGO_URL,
    palette: PALETTE,
    templateVersion: 'looks-v1',
  });
  // The same logo again is the same asset, and a look already made for it is answered at once.
  DB.sql
    .prepare("UPDATE sponsor_assets SET status='qualified',url=? WHERE id=?")
    .run('https://show.test/look', ASSET_ID);
  const again = await (await uploadSponsorAsset(request({ ip: 'asset-test-2' }), v)).json();
  assert.equal(again.id, ASSET_ID);
  assert.equal(again.status, 'qualified');
  assert.equal(again.url, 'https://show.test/look');
  assert.equal(DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n, 1);
  // A spotlight logo is its own asset and is ready at once: nothing to tailor.
  const spotlight = await (await uploadSponsorAsset(request({ ip: 'spot', kind: 'logo' }), v)).json();
  assert.equal(spotlight.status, 'qualified');
  assert.notEqual(spotlight.id, ASSET_ID);
  assert.equal(JSON.parse(DB.sql.prepare('SELECT metadata FROM sponsor_assets WHERE id=?').get(spotlight.id).metadata).kind, 'logo');
});
void test('what the desk refuses is relayed to the buyer, and nothing is stored', async (t) => {
  const { DB, objects, v } = siteVars();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: 'This logo is too thin to print.', code: 'LOGO_TOO_THIN' },
      { status: 422 },
    ),
  );
  const r = await uploadSponsorAsset(request({ ip: 'thin' }), v);
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), {
    error: 'This logo is too thin to print.',
    code: 'LOGO_TOO_THIN',
  });
  assert.equal(objects.size, 0);
  assert.equal(DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n, 0);
});
void test('a file that is not an image never reaches the desk, and a desk that is down says so', async (t) => {
  const { v } = siteVars();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('fetch failed');
  });
  const junk = await uploadSponsorAsset(
    request({ ip: 'junk', bytes: Buffer.from('not an image at all') }),
    v,
  );
  assert.equal(junk.status, 422);
  assert.equal(calls, 0, 'the magic bytes are checked here');
  const down = await uploadSponsorAsset(request({ ip: 'down' }), v);
  assert.equal(down.status, 503);
  assert.match((await down.json()).error, /try again in a minute/);
  assert.equal(calls, 1);
});
void test('a desk answer that does not hash to what it says is refused', async (t) => {
  const { DB, objects, v } = siteVars();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      logo: normalised.toString('base64'),
      logoSha256: 'corrupted',
      width: 1,
      height: 1,
      palette: PALETTE,
    }),
  );
  const r = await uploadSponsorAsset(request({ ip: 'corrupt' }), v);
  assert.equal(r.status, 502);
  assert.equal(objects.size, 0);
  assert.equal(DB.sql.prepare('SELECT count(*) n FROM sponsor_assets').get().n, 0);
});
// Production has an armed desk long before it sells anything. Until checkout is on, an upload
// is refused before it can write a rate-limit row, an asset row or an object, or call the desk.
void test('while checkout is off an upload stores nothing and never reaches the desk', async (t) => {
  const { DB, objects, v } = siteVars();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return Response.json({});
  });
  for (const [i, enabled] of [undefined, 'false', ''].entries()) {
    const r = await uploadSponsorAsset(request({ ip: `closed-${i}` }), { ...v, SPONSOR_ENABLED: enabled });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /checkout is not enabled/);
  }
  assert.equal(calls.length, 0, 'the desk was called');
  assert.equal(objects.size, 0, 'an object was stored');
  const tables = DB.sql
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sponsor_%'")
    .all()
    .map((row) => String(row.name));
  for (const table of tables)
    assert.equal(DB.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} was written`);
});

void test('cross-origin artwork requests fail before storage or worker calls', async () => {
  const response = await uploadSponsorAsset(
    request({ ip: 'other', origin: 'https://attacker.test' }),
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
  tailor: true,
  templateVersion: 'looks-v1',
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
      tailor: true,
      templateVersion: 'looks-v1',
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
    return Response.json({ ...readyBody, tailor: false });
  });
  const v = healthVars('https://media-together.test');
  const pending = Array.from({ length: 8 }, () => checkHealth(v));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  for (const body of await Promise.all(pending))
    assert.deepEqual(body, {
      ready: true,
      tailor: false,
      templateVersion: 'looks-v1',
    });
  assert.equal(calls, 1);
});
void test('a 503 from the media health check means not ready, whatever its body says', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(readyBody, { status: 503 }),
  );
  assert.deepEqual(await checkHealth(healthVars('https://media-down.test')), {
    ready: false,
    tailor: false,
  });
});

const ready = { ready: true, tailor: true, templateVersion: 'looks-v1' },
  notReady = { ready: false, tailor: false };
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
      { ...readyBody, ready: false, tailor: false },
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
      tailor: false,
    });
  assert.equal(calls, 0);
});
void test('a desk that is up but cannot tailor is reported as such, on the current wardrobe', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ...readyBody, tailor: false }),
  );
  assert.deepEqual(await checkHealth(healthVars('https://media-no-key.test')), {
    ready: true,
    tailor: false,
    templateVersion: 'looks-v1',
  });
});
// ---- serving: the logo and every look are immutable; a bare address follows the asset.
/** A bucket holding what was put, answering get() the way R2 does for whole objects. */
function bucket(entries = {}) {
  const objects = new Map(
    Object.entries(entries).map(([key, bytes]) => [key, Buffer.from(bytes)]),
  );
  return {
    objects,
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes
        ? {
            body: new Blob([bytes]).stream(),
            size: bytes.length,
            httpEtag: '"etag"',
            range: undefined,
          }
        : null;
    },
  };
}
function assetRow(DB, status, url, metadata) {
  DB.sql
    .prepare(
      'INSERT OR REPLACE INTO sponsor_assets(id,status,url,mime,created_at,metadata) VALUES(?,?,?,?,?,?)',
    )
    .run(ASSET_ID, status, url, 'image/png', 100, JSON.stringify(metadata));
}
const LOOK_SHA = 'b'.repeat(64);
const LOOK_URL = `https://show.test/api/sponsorship/assets/${ASSET_ID}?part=look&v=${LOOK_SHA}`;
void test('the logo and each look are served immutable and cross-origin; a bare address follows the asset', async () => {
  const DB = d1();
  const assets = bucket({
    [`${ASSET_ID}/logo.png`]: normalised,
    [`${ASSET_ID}/look-${LOOK_SHA}.png`]: Buffer.from('the look'),
  });
  const v = { DB, SITE_URL: 'https://show.test', SPONSOR_ASSETS: assets };
  const get = (query, headers = {}) =>
    readSponsorAsset(
      new Request(`https://show.test/api/sponsorship/assets/${ASSET_ID}${query}`, { headers }),
      v,
      ASSET_ID,
    );
  const logo = await get('?part=logo');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.equal(logo.headers.get('cache-control'), 'public,max-age=31536000,immutable');
  assert.equal(logo.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), normalised);
  const look = await get(`?part=look&v=${LOOK_SHA}`);
  assert.equal(look.status, 200);
  assert.equal(await look.text(), 'the look');
  assert.equal((await get('?part=look')).status, 404, 'a look is named by its hash');
  assert.equal((await get('?part=preview')).status, 404, 'the preview is gone');
  assert.equal((await get('?part=video')).status, 404);
  // Bare: 404 for no row; the logo while tailoring; the look once qualified; never cached.
  assert.equal((await get('')).status, 404, 'no such asset');
  assetRow(DB, 'logo', LOGO_URL, { kind: 'cap', tailor: { round: 1, requestedAt: 5 } });
  let bare = await get('', { accept: 'image/*' });
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get('location'), LOGO_URL);
  assert.equal(bare.headers.get('cache-control'), 'no-store');
  assetRow(DB, 'qualified', LOOK_URL, { kind: 'cap', look: { sha256: LOOK_SHA } });
  bare = await get('', { accept: 'image/*' });
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get('location'), LOOK_URL);
  const status = await get('', { accept: 'application/json' });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status.json(), { status: 'qualified', url: LOOK_URL, lookUrl: LOOK_URL });
  const tailor = { round: 3, requestedAt: 5, outcome: 'refused', at: 9, reasons: ['Too thin.'] };
  assetRow(DB, 'refused', LOGO_URL, { kind: 'cap', reason: 'Too thin.', tailor });
  assert.deepEqual(await (await get('', { accept: 'application/json' })).json(), {
    status: 'refused',
    url: LOGO_URL,
    reason: 'Too thin.',
    tailor,
  });
});
// ---- the desk's callback: every tailor round ends in one PUT.
const MEDIA_TOKEN = 'm'.repeat(32);
const lookBytes = Buffer.from('a tailored look png');
const LOOK = hash(lookBytes);
const verdict = {
  model: 'fal-ai/nano-banana-pro/edit',
  fit: 2,
  round: 1,
  palette: PALETTE,
  plan: { shirtHex: '#F2EFE8', capHex: '#112233' },
  judge: { shirtLogo: true, logoFidelity: 9 },
  candidateUrl: 'https://v3.fal.media/files/candidate.png',
};
function callback({
  token = MEDIA_TOKEN,
  outcome = 'look',
  round = 1,
  bytes = lookBytes,
  sha = hash(bytes),
  verdictBody = verdict,
  reason = 'The tailor ran out of time.',
  headers = {},
} = {}) {
  const h = {
    ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    'x-look-outcome': outcome,
    'x-look-round': String(round),
  };
  if (outcome === 'look')
    Object.assign(h, {
      'content-type': 'image/png',
      'x-look-sha256': sha,
      'x-look-verdict': Buffer.from(JSON.stringify(verdictBody)).toString('base64'),
    });
  else h['x-look-reason'] = reason;
  Object.assign(h, headers);
  return new Request(`https://show.test/api/sponsorship/assets/${ASSET_ID}?part=look`, {
    method: 'PUT',
    headers: h,
    body: outcome === 'look' ? bytes : null,
  });
}
async function tailoringSite() {
  const DB = d1(),
    assets = bucket();
  await ensureSponsorSchema(DB);
  const v = {
    DB,
    SITE_URL: 'https://show.test',
    SPONSOR_MEDIA_URL: 'https://media.test',
    SPONSOR_MEDIA_TOKEN: MEDIA_TOKEN,
    SPONSOR_ASSETS: assets,
  };
  const row = () => {
    const r = DB.sql.prepare('SELECT * FROM sponsor_assets WHERE id=?').get(ASSET_ID);
    return r && { ...r, metadata: JSON.parse(r.metadata) };
  };
  return { DB, assets, v, row };
}
const logoMeta = (extra = {}) => ({
  kind: 'cap',
  target: 'host',
  templateVersion: 'looks-v1',
  logoSha256: hash(normalised),
  logoUrl: LOGO_URL,
  palette: PALETTE,
  tailor: { round: 1, requestedAt: 5 },
  ...extra,
});
const lookUrlFor = (sha) =>
  `https://show.test/api/sponsorship/assets/${ASSET_ID}?part=look&v=${sha}`;

void test('a look callback must carry the desk secret and the hash of what it sends', async (t) => {
  const site = await tailoringSite();
  assetRow(site.DB, 'logo', LOGO_URL, logoMeta());
  for (const [name, request, vars, status] of [
    ['no token', callback({ token: null }), site.v, 401],
    ['the wrong token', callback({ token: 'x'.repeat(32) }), site.v, 401],
    ['no secret configured on the site', callback(), { ...site.v, SPONSOR_MEDIA_TOKEN: undefined }, 401],
    ['a hash that is not the body', callback({ sha: 'f'.repeat(64) }), site.v, 400],
    ['no hash', callback({ headers: { 'x-look-sha256': '' } }), site.v, 400],
    ['an outcome the site does not know', callback({ outcome: 'maybe' }), site.v, 400],
    ['a round outside 1..3', callback({ round: 7 }), site.v, 400],
  ]) {
    await t.test(name, async () => {
      assert.equal((await receiveLook(request, vars, ASSET_ID)).status, status);
      assert.equal(site.row().status, 'logo', 'nothing changed');
      assert.equal(site.assets.objects.size, 0, 'nothing stored');
    });
  }
});

void test('a look lands: stored under its hash, the asset qualified and its address rewritten', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const site = await tailoringSite();
  assetRow(site.DB, 'logo', LOGO_URL, logoMeta());
  const r = await receiveLook(callback(), site.v, ASSET_ID);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { status: 'qualified' });
  assert.deepEqual(site.assets.objects.get(`${ASSET_ID}/look-${LOOK}.png`), lookBytes);
  const row = site.row();
  assert.equal(row.status, 'qualified');
  assert.equal(row.url, lookUrlFor(LOOK));
  assert.equal(row.metadata.sourceUrl, row.url);
  assert.equal(row.metadata.sha256, LOOK);
  assert.deepEqual(row.metadata.look, { sha256: LOOK, model: verdict.model, fit: 2, round: 1, verdict });
  assert.equal(row.metadata.tailor.outcome, 'look');
  assert.equal(row.metadata.logoUrl, LOGO_URL, 'the logo stays where it was');
  // The same look again is a no-op; a different look for a finished asset is superseded.
  assert.deepEqual(await (await receiveLook(callback(), site.v, ASSET_ID)).json(), { status: 'qualified' });
  const other = Buffer.from('another fit');
  assert.deepEqual(
    await (await receiveLook(callback({ bytes: other, round: 2 }), site.v, ASSET_ID)).json(),
    { status: 'qualified' },
  );
  assert.equal(site.assets.objects.has(`${ASSET_ID}/look-${hash(other)}.png`), false, 'not stored');
  assert.equal(site.row().metadata.sha256, LOOK);
  // Nor does a late refusal or deadline touch it.
  await receiveLook(callback({ outcome: 'refused', round: 2, reason: 'Late.' }), site.v, ASSET_ID);
  await receiveLook(callback({ outcome: 'deadline', round: 2 }), site.v, ASSET_ID);
  assert.equal(site.row().status, 'qualified');
  assert.equal(site.row().metadata.reason, undefined);
});

void test('refusals and non-verdicts are recorded without touching the logo', async () => {
  const site = await tailoringSite();
  assetRow(site.DB, 'logo', LOGO_URL, logoMeta());
  assert.deepEqual(
    await (await receiveLook(callback({ outcome: 'deadline' }), site.v, ASSET_ID)).json(),
    { status: 'logo' },
  );
  let row = site.row();
  assert.equal(row.status, 'logo');
  assert.equal(row.metadata.tailor.outcome, 'deadline');
  assert.equal(row.url, LOGO_URL);
  assert.deepEqual(
    await (
      await receiveLook(
        callback({ outcome: 'refused', round: 2, reason: 'Too thin to print.' }),
        site.v,
        ASSET_ID,
      )
    ).json(),
    { status: 'refused' },
  );
  row = site.row();
  assert.equal(row.status, 'refused');
  assert.equal(row.metadata.reason, 'Too thin to print.');
  assert.deepEqual(row.metadata.tailor.reasons, ['Too thin to print.']);
  // A later round that lands a look rescues a refused asset.
  assert.deepEqual(await (await receiveLook(callback({ round: 3 }), site.v, ASSET_ID)).json(), {
    status: 'qualified',
  });
  assert.equal(site.row().metadata.reason, undefined);
  assert.equal(site.assets.objects.size, 1);
});

void test('a fallback look is upgraded by a real fit once', async () => {
  const site = await tailoringSite();
  assetRow(site.DB, 'logo', LOGO_URL, logoMeta());
  await receiveLook(callback({ verdictBody: { ...verdict, fallback: 'cap-v1' } }), site.v, ASSET_ID);
  assert.equal(site.row().metadata.look.fallback, 'cap-v1');
  const fit = Buffer.from('a real fit');
  await receiveLook(callback({ bytes: fit, round: 2 }), site.v, ASSET_ID);
  const row = site.row();
  assert.equal(row.metadata.sha256, hash(fit), 'the real fit replaced the fallback');
  assert.equal(row.metadata.look.fallback, undefined);
  assert.equal(row.url, lookUrlFor(hash(fit)));
  assert.ok(site.assets.objects.has(`${ASSET_ID}/look-${hash(fit)}.png`));
});
