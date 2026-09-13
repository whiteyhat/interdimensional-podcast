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
