// The deployed half of a cap render: the site reads the buyer's qualified logo from its own
// bucket, asks the media service for a take, and files only a take that proves to be what
// the service says it is. The media service is a mocked fetch here; the lease, the order and
// the qualified design are real rows, so the checks run against the same queries production
// does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const { renderSponsorMedia } = await import('../work/tests/sponsor-media.js');
const db = await import('../work/tests/sponsor-db.js');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const STUDIO_TOKEN = 'studio-token-for-render-tests';
const MEDIA_TOKEN = 'm'.repeat(32);
const logo = Buffer.from('normalized-original-mark');
const LOGO_SHA = sha(logo);
const ASSET_ID = sha('qualified-cap-design');
const VIDEO_URL = 'https://v3.fal.media/files/take.mp4';
const KEY = sha(`${VIDEO_URL}|${LOGO_SHA}|host|caps-v1`);
const take = Buffer.from('composited-branded-take');
const MiB = 1024 * 1024;
const realSetTimeout = globalThis.setTimeout;

const qualityOf = (bytes) => ({
  accepted: true,
  audioVerified: true,
  frames: 240,
  durationMs: 8000,
  outputSha256: sha(bytes),
});
const encodeQuality = (quality) =>
  Buffer.from(JSON.stringify(quality)).toString('base64');
/** A 200 from the media service. A header given as null is left off. */
const success = (bytes = take, headers = {}) =>
  new Response(bytes, {
    headers: Object.entries({
      'content-type': 'video/mp4',
      'x-sponsor-quality': encodeQuality(qualityOf(bytes)),
      'x-sponsor-key': KEY,
      ...headers,
    }).filter(([, value]) => value !== null),
  });
const busy = (retryAfterMs) =>
  Response.json(
    { code: 'BUSY', error: 'The wardrobe desk is busy.', retryAfterMs },
    { status: 503 },
  );

/** An R2 bucket that keeps objects in memory and remembers every write. */
function bucket() {
  const objects = new Map(),
    puts = [];
  const view = (key, o) => ({
    key,
    size: o.bytes.length,
    httpEtag: '"etag"',
    httpMetadata: o.httpMetadata,
    customMetadata: o.customMetadata,
  });
  return {
    objects,
    puts,
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        ...view(key, o),
        body: new Blob([o.bytes]).stream(),
        async arrayBuffer() {
          return new Uint8Array(o.bytes).buffer;
        },
        async text() {
          return o.bytes.toString();
        },
      };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? view(key, o) : null;
    },
    async put(key, value, options = {}) {
      objects.set(key, {
        bytes: Buffer.from(value),
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata,
      });
      puts.push(key);
      return view(key, objects.get(key));
    },
  };
}

/** A paid cap order leased to the heartbeating studio, with its design qualified. */
async function fixture({ logoBytes = logo } = {}) {
  const DB = d1(),
    now = Date.now(),
    caps = {
      message: true,
      spotlight: true,
      cap: true,
      capTemplateVersion: 'caps-v1',
    };
  await db.ensureSponsorSchema(DB);
  await db.heartbeat(DB, 'studio', caps, now);
  DB.sql
    .prepare(
      'INSERT INTO sponsor_assets(id,status,url,mime,created_at,metadata) VALUES(?,?,?,?,?,?)',
    )
    .run(
      ASSET_ID,
      'qualified',
      `https://frogclench.test/api/sponsorship/assets/${ASSET_ID}`,
      'image/png',
      now,
      JSON.stringify({
        kind: 'cap',
        target: 'host',
        sha256: sha('preview'),
        logoSha256: LOGO_SHA,
        logoUrl: `https://frogclench.test/api/sponsorship/assets/${ASSET_ID}?part=logo`,
        templateId: 'pepe-cap-v1',
        templateVersion: 'caps-v1',
        qualificationVersion: 'caps-v1',
      }),
    );
  await db.createOrder(DB, {
    id: 'order',
    tokenHash: 'receipt',
    now,
    draft: {
      product: 'cap',
      target: 'host',
      name: 'Alice',
      projectName: 'GM',
      message: 'Builders ship',
      assetId: ASSET_ID,
    },
  });
  DB.sql
    .prepare(
      "UPDATE sponsor_orders SET status='paid',paid_at=? WHERE id='order'",
    )
    .run(now);
  const [leased] = await db.leaseOrders(DB, 'studio', now, 1, caps);
  assert.ok(leased, 'the fixture cap order is leased');
  const assets = bucket();
  if (logoBytes)
    assets.objects.set(`${ASSET_ID}/logo.png`, {
      bytes: logoBytes,
      httpMetadata: { contentType: 'image/png' },
    });
  const v = {
    DB,
    STUDIO_TOKEN,
    SPONSOR_ASSETS: assets,
    SPONSOR_MEDIA_URL: 'https://media.test',
    SPONSOR_MEDIA_TOKEN: MEDIA_TOKEN,
    SITE_URL: 'https://frogclench.test',
  };
  // The Worker's own hostname differs from SITE_URL, so a URL built from the request would
  // show up in the assertions.
  const render = (videoUrl = VIDEO_URL) =>
    renderSponsorMedia(
      new Request('https://site.workers.test/api/sponsorship/media', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-studio-token': STUDIO_TOKEN,
          'x-studio-id': 'studio',
        },
        body: JSON.stringify({
          orderId: leased.id,
          leaseToken: leased.lease_token,
          videoUrl,
        }),
      }),
      v,
    );
  return { DB, assets, render };
}

/** Replace the media service. Each call gets the next scripted answer, then the last one. */
function media(t, ...answers) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    return typeof answer === 'function' ? answer() : answer;
  });
  return calls;
}

/** Skip the real retry pause, but keep what was asked for so the tests can check it. */
function pauses(t) {
  const waits = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    waits.push(ms);
    return realSetTimeout(fn, 0);
  });
  return waits;
}

async function failure(response) {
  return { status: response.status, ...(await response.json()) };
}

void test('the stored logo travels inline with an idempotency key and the verified take is filed', async (t) => {
  const f = await fixture();
  const calls = media(t, () => success());
  const response = await f.render();
  assert.equal(response.status, 200);
  const digest = sha(take);
  assert.deepEqual(await response.json(), {
    url: `https://frogclench.test/api/sponsorship/assets/${digest}?part=video`,
    quality: qualityOf(take),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://media.test/render');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${MEDIA_TOKEN}`);
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, {
    videoUrl: VIDEO_URL,
    logo: logo.toString('base64'),
    logoSha256: LOGO_SHA,
    target: 'host',
    templateVersion: 'caps-v1',
    key: KEY,
  });
  assert.ok(
    calls[0].init.body.length <= 8 * MiB,
    'the body fits the media service limit',
  );
  const video = f.assets.objects.get(`${digest}/video.mp4`);
  assert.deepEqual(video.bytes, take);
  assert.deepEqual(video.httpMetadata, { contentType: 'video/mp4' });
  assert.deepEqual(video.customMetadata, {
    orderId: 'order',
    designId: ASSET_ID,
    quality: JSON.stringify(qualityOf(take)),
  });
  assert.deepEqual(
    JSON.parse(f.assets.objects.get(`renders/${KEY}.json`).bytes.toString()),
    { sha: digest, quality: qualityOf(take) },
  );
  assert.deepEqual(
    f.assets.puts,
    [`${digest}/video.mp4`, `renders/${KEY}.json`],
    'the pointer is written after the video it names',
  );
});

void test('a take already filed for the same key is returned without calling the media service', async (t) => {
  const f = await fixture();
  const calls = media(t, () => success());
  const first = await (await f.render()).json();
  assert.equal(calls.length, 1);
  const again = await f.render();
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), first);
  assert.equal(calls.length, 1, 'the pointer answered, not the media service');
  assert.equal(f.assets.puts.length, 2, 'nothing was written twice');

  // A pointer whose video is gone is not a take; render again rather than hand out a 404.
  f.assets.objects.delete(`${sha(take)}/video.mp4`);
  const rebuilt = await f.render();
  assert.equal(rebuilt.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(f.assets.objects.has(`${sha(take)}/video.mp4`));
});

void test('media service refusals map to what the studio can act on', async (t) => {
  for (const [name, answer, status, code] of [
    [
      '422 is a take that failed its checks',
      () =>
        Response.json(
          { code: 'TRACKING', error: 'The cap lost tracking.' },
          { status: 422 },
        ),
      422,
      'INVALID_WEARABLE',
    ],
    [
      '409 is artwork that no longer matches',
      () =>
        Response.json(
          { code: 'HASH', error: 'Artwork hash changed.' },
          { status: 409 },
        ),
      409,
      'ASSET',
    ],
    [
      'a crash is the wardrobe desk, not the buyer',
      () =>
        Response.json(
          { code: 'CRASH', error: 'The renderer stopped.' },
          { status: 503 },
        ),
      503,
      'WARDROBE',
    ],
    [
      'a proxy error page is the wardrobe desk too',
      () => new Response('<html>Bad gateway</html>', { status: 502 }),
      503,
      'WARDROBE',
    ],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture();
      const calls = media(t, answer);
      const result = await failure(await f.render());
      assert.equal(result.status, status);
      assert.equal(result.code, code);
      assert.equal(calls.length, 1, 'only BUSY and network errors retry');
      assert.deepEqual(f.assets.puts, []);
    });
  }
});

void test('a busy media service is asked once more after the pause it asked for', async (t) => {
  await t.test('a short pause is honoured', async (t) => {
    const f = await fixture();
    const waits = pauses(t);
    const calls = media(
      t,
      () => busy(250),
      () => success(),
    );
    const response = await f.render();
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(
      calls[1].init.body,
      calls[0].init.body,
      'the retry is the same job',
    );
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 250 && waits[0] < 750, `waited ${waits[0]} ms`);
  });
  await t.test('a long one is capped at 5 s plus jitter', async (t) => {
    const f = await fixture();
    const waits = pauses(t);
    media(
      t,
      () => busy(60000),
      () => success(),
    );
    assert.equal((await f.render()).status, 200);
    assert.ok(waits[0] >= 5000 && waits[0] < 5500, `waited ${waits[0]} ms`);
  });
});

void test('a busy answer with too little budget left fails as WARDROBE without a retry', async (t) => {
  const f = await fixture();
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const calls = media(t, () => {
    clock += 70000;
    return busy(1000);
  });
  const result = await failure(await f.render());
  assert.equal(result.status, 503);
  assert.equal(result.code, 'WARDROBE');
  assert.equal(calls.length, 1);
  assert.deepEqual(f.assets.puts, []);
});

void test('a network error is retried once, and a second one fails as WARDROBE', async (t) => {
  await t.test('recovers', async (t) => {
    const f = await fixture();
    const waits = pauses(t);
    const calls = media(
      t,
      () => Promise.reject(new TypeError('fetch failed')),
      () => success(),
    );
    assert.equal((await f.render()).status, 200);
    assert.equal(calls.length, 2);
    assert.ok(waits[0] >= 1000 && waits[0] < 1500, `waited ${waits[0]} ms`);
  });
  await t.test('gives up', async (t) => {
    const f = await fixture();
    pauses(t);
    const calls = media(t, () => Promise.reject(new TypeError('fetch failed')));
    const result = await failure(await f.render());
    assert.equal(result.status, 503);
    assert.equal(result.code, 'WARDROBE');
    assert.equal(calls.length, 2);
  });
});

void test('a render that runs out of time is not retried', async (t) => {
  const f = await fixture();
  const calls = media(t, () =>
    Promise.reject(
      new DOMException('The operation timed out.', 'TimeoutError'),
    ),
  );
  const result = await failure(await f.render());
  assert.equal(result.status, 503);
  assert.equal(result.code, 'WARDROBE');
  assert.equal(calls.length, 1);
});

void test('a take without a readable quality summary is refused as INVALID_WEARABLE', async (t) => {
  for (const [name, headers] of [
    ['missing', { 'x-sponsor-quality': null }],
    ['not base64', { 'x-sponsor-quality': '%%%not-base64%%%' }],
    ['not JSON', { 'x-sponsor-quality': btoa('{accepted: true') }],
    [
      'not accepted',
      {
        'x-sponsor-quality': encodeQuality({
          ...qualityOf(take),
          accepted: false,
        }),
      },
    ],
    [
      'audio unverified',
      {
        'x-sponsor-quality': encodeQuality({
          ...qualityOf(take),
          audioVerified: false,
        }),
      },
    ],
    ['for a different key', { 'x-sponsor-key': sha('another take') }],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture();
      media(t, () => success(take, headers));
      const result = await failure(await f.render());
      assert.equal(result.status, 422);
      assert.equal(result.code, 'INVALID_WEARABLE');
      assert.deepEqual(f.assets.puts, []);
    });
  }
});

void test('bytes that do not match the quality digest are refused and never stored', async (t) => {
  const f = await fixture();
  media(t, () =>
    success(take, {
      'x-sponsor-quality': encodeQuality(qualityOf(Buffer.from('other'))),
    }),
  );
  const result = await failure(await f.render());
  assert.equal(result.status, 422);
  assert.equal(result.code, 'INVALID_WEARABLE');
  assert.deepEqual(f.assets.puts, []);
});

/**
 * A 50 MiB take served a MiB at a time, counting how much of it the site asks for. It does
 * end, so code that buffers the whole body fails these tests instead of hanging them.
 */
function fiftyMiB(headers = {}) {
  const stats = { pulled: 0, cancelled: false },
    chunk = new Uint8Array(MiB);
  const response = () =>
    new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (stats.pulled === 50) return controller.close();
            stats.pulled++;
            controller.enqueue(chunk);
          },
          cancel() {
            stats.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      {
        headers: {
          'x-sponsor-quality': encodeQuality(qualityOf(take)),
          'x-sponsor-key': KEY,
          ...headers,
        },
      },
    );
  return { stats, response };
}

void test('an oversized take is refused before it is buffered', async (t) => {
  await t.test('declared too large: nothing is read', async (t) => {
    const f = await fixture();
    const body = fiftyMiB({ 'content-length': String(50 * MiB) });
    media(t, body.response);
    const result = await failure(await f.render());
    assert.equal(result.status, 413);
    assert.equal(body.stats.pulled, 0, 'no byte of the body was read');
    assert.ok(body.stats.cancelled, 'the body was released');
    assert.deepEqual(f.assets.puts, []);
  });
  await t.test('undeclared: cut off as it crosses 40 MiB', async (t) => {
    const f = await fixture();
    const body = fiftyMiB();
    media(t, body.response);
    const result = await failure(await f.render());
    assert.equal(result.status, 413);
    assert.ok(
      body.stats.pulled <= 41,
      `read ${body.stats.pulled} MiB before refusing`,
    );
    assert.ok(body.stats.cancelled);
    assert.deepEqual(f.assets.puts, []);
  });
});

void test('the logo must be in storage and still hash to what was qualified', async (t) => {
  for (const [name, logoBytes] of [
    ['missing', null],
    ['changed', Buffer.from('a different mark')],
    ['too large to send', Buffer.alloc(5 * MiB + 1)],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture({ logoBytes });
      const calls = media(t, () => success());
      const result = await failure(await f.render());
      assert.equal(result.status, 409);
      assert.equal(result.code, 'ASSET');
      assert.equal(calls.length, 0, 'the media service was never asked');
      assert.deepEqual(f.assets.puts, []);
    });
  }
});

void test('a lease that ends while the take renders stores nothing', async (t) => {
  const f = await fixture();
  const calls = media(t, () => {
    f.DB.sql
      .prepare(
        "UPDATE sponsor_orders SET lease_token='replaced' WHERE id='order'",
      )
      .run();
    return success();
  });
  const result = await failure(await f.render());
  assert.equal(calls.length, 1);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'LEASE');
  assert.deepEqual(f.assets.puts, []);
});

void test('only fal.media footage is sent for branding', async (t) => {
  for (const videoUrl of [
    'https://evil.test/take.mp4',
    'http://v3.fal.media/take.mp4',
    'https://fal.media.evil.test/take.mp4',
    'https://user:pass@v3.fal.media/take.mp4',
    'not a url',
  ]) {
    await t.test(videoUrl, async (t) => {
      const f = await fixture();
      const calls = media(t, () => success());
      const result = await failure(await f.render(videoUrl));
      assert.equal(result.status, 400);
      assert.equal(calls.length, 0);
      assert.deepEqual(f.assets.puts, []);
    });
  }
});
