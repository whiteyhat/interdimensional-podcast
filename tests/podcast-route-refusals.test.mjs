import { test } from 'node:test';
import assert from 'node:assert/strict';
import { podcastRoute } from './build.mjs';

const { POST } = await podcastRoute('podcast-refusals', {
  FAL_KEY: 'route-refusal-test-key',
  STUDIO_TOKEN: 'route-refusal-token',
  INTERACT_ORIGIN: 'https://sponsor.test',
});

// A lost lease used to come back as a 400 with only a sentence, so the studio counted it as a
// generation failure and retried it into an outage hold.
void test("the site's own refusal reaches the studio with its status and code", async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === 'https://sponsor.test/api/sponsorship')
      return Response.json(
        { error: 'The delivery lease ended.', code: 'LEASE' },
        { status: 409 },
      );
    throw Error(`unexpected fetch ${url}`);
  });
  const response = await POST(
    new Request('http://127.0.0.1:3212/api/podcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'write',
        start: 8,
        recent: [],
        sponsorship: { orderId: 'order', leaseToken: 'lease', stage: 'intro' },
      }),
    }),
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'LEASE');
  assert.match(body.error, /lease ended/);
});

// A look the site has since replaced (a new tailor round, an upgrade from the fallback) is
// the site's own refusal, with a status and a code, so the studio drops the dressing at once
// instead of buying four takes that can only be refused the same way.
void test('a stale wardrobe pin is refused as 409 ASSET, and a current one buys the take', async (t) => {
  const look = (sha) =>
    `https://sponsor.test/api/sponsorship/assets/asset1?part=look&v=${sha}`;
  const order = {
    id: 'order',
    leaseToken: 'lease',
    leaseUntil: Date.now() + 45000,
    draft: {
      product: 'cap',
      name: 'alice',
      message: 'We make tools for artists.',
      projectName: 'Canvas',
      target: 'host',
      assetId: 'asset1',
    },
    assetUrl: look('look2'),
    assetMetadata: {
      kind: 'cap',
      target: 'host',
      templateVersion: 'looks-v1',
      sourceUrl: look('look2'),
      sha256: 'look2',
    },
    fulfillment: {
      visibleMs: 0,
      appearances: 0,
      intro: false,
      callback: false,
      startedAt: null,
      completedAt: null,
    },
  };
  const bought = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === 'https://sponsor.test/api/sponsorship')
      return Response.json({ order });
    if (String(url).startsWith('https://queue.fal.run/')) {
      bought.push(JSON.parse(options.body));
      return Response.json({
        status_url: 'https://queue.fal.run/requests/r1/status',
        response_url: 'https://queue.fal.run/requests/r1',
        request_id: 'r1',
      });
    }
    throw Error(`unexpected fetch ${url}`);
  });
  const shot = (sha) =>
    POST(
      new Request('http://127.0.0.1:3212/api/podcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'shot',
          attempt: 0,
          line: {
            id: 8,
            speaker: 'host',
            text: 'Of course.',
            wardrobe: {
              orderId: 'order',
              leaseToken: 'lease',
              target: 'host',
              assetId: 'asset1',
              designHash: sha,
              sourceUrl: look(sha),
              templateVersion: 'looks-v1',
            },
          },
        }),
      }),
    );
  const stale = await shot('look1');
  assert.equal(stale.status, 409);
  const refused = await stale.json();
  assert.equal(refused.code, 'ASSET');
  assert.match(refused.error, /wardrobe revision does not match/);
  assert.equal(bought.length, 0, 'no take is bought for a stale look');
  const current = await shot('look2');
  assert.equal(current.status, 200, JSON.stringify(await current.clone().json()));
  assert.equal(bought.length, 1, 'the current look buys the take');
  assert.equal(bought[0].image_url, look('look2'));
  assert.equal(bought[0].end_image_url, look('look2'));
  assert.match(bought[0].prompt, /Headphones keep their exact placement/);
});
