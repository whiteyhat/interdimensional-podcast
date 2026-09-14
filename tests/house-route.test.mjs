import { test } from 'node:test';
import assert from 'node:assert/strict';
import { podcastRoute } from './build.mjs';

const { POST } = await podcastRoute('house-route', {
  FAL_KEY: 'house-route-test-key',
  STUDIO_TOKEN: 'house-route-token',
  COIN_TICKER: 'FROGCLENCH',
  COIN_NAME: 'FROGCLENCH',
});
const write = (extra) =>
  POST(
    new Request('http://127.0.0.1:3212/api/podcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'write', start: 8, recent: [], ...extra }),
    }),
  );

// The house cue reaches the writer as one paragraph, with nothing for sale when the site is
// not selling, and never on an audience request.
void test('a house cue adds the plug paragraph to an ordinary exchange only', async (t) => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === 'https://queue.fal.run/openrouter/router') {
      asked.push(JSON.parse(options.body));
      return Response.json({
        status_url: 'https://queue.fal.run/requests/w1/status',
        response_url: 'https://queue.fal.run/requests/w1',
        request_id: 'w1',
      });
    }
    throw Error(`unexpected fetch ${url}`);
  });
  assert.equal((await write({ house: { coinLive: true } })).status, 200);
  assert.equal(asked.length, 1);
  const prompt = asked[0].prompt;
  assert.match(prompt, /HOUSE MESSAGE/);
  assert.match(prompt, /pump dot fun/);
  assert.match(prompt, /frogclench dot fun/);
  assert.match(prompt, /nothing is on sale right now/);
  assert.doesNotMatch(prompt, /sponsor the podcast/);
  assert.equal((await write({ house: { coinLive: false } })).status, 200);
  assert.doesNotMatch(asked[1].prompt, /pump dot fun/);
  assert.match(asked[1].prompt, /frogclench dot fun/);
  assert.equal((await write({ house: { coinLive: true }, cue: 'say hi to my cat', from: 'deb' })).status, 200);
  assert.doesNotMatch(asked[2].prompt, /HOUSE MESSAGE/, 'a paid request never carries the plug');
  assert.equal((await write({ house: 'yes' })).status, 200);
  assert.doesNotMatch(asked[3].prompt, /HOUSE MESSAGE/, 'a malformed cue is no cue');
});
