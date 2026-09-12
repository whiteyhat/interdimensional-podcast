import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';

await build(['services']);
const { createServices } = await import('../work/tests/services.js');

// Caps were qualified on the take exactly as the model makes it. Compositing on fal's 1080p
// rescale instead doubled the tracker's work and grew every tracking error by the scale, so
// real paid takes lost tracking or ran out the media desk's deadline on devnet.
function studio(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url === '/api/sponsorship/media')
      return Response.json(
        { code: 'INVALID_WEARABLE', error: 'Tracking could not be verified.' },
        { status: 422 },
      );
    if (body.action === 'poll')
      return Response.json({
        status: 'COMPLETED',
        speechEnd: 0.8,
        hasExtraSpeech: false,
        url: `https://fal.media/${body.token}.mp4`,
      });
    return Response.json({ token: `${body.action}-${body.attempt ?? 0}` });
  });
  return requests;
}
const wardrobe = {
  orderId: 'order',
  leaseToken: 'lease',
  target: 'host',
  assetId: 'design',
  designHash: 'hash',
  sourceUrl: 'https://show.test/cap.png',
  templateVersion: 'caps-v1',
};

void test('a cap is composited on the native take, and fal never rescales a cap shot', async (t) => {
  const requests = studio(t);
  const services = createServices();
  await assert.rejects(
    services.render({
      id: 0,
      speaker: 'host',
      text: 'Of course.',
      wardrobe,
    }),
    /Tracking could not/,
  );
  const composites = requests.filter((r) => r.url === '/api/sponsorship/media');
  assert.ok(composites.length > 0, 'the cap shot reached the compositor');
  for (const [i, composite] of composites.entries())
    assert.equal(
      composite.body.videoUrl,
      `https://fal.media/shot-${i}.mp4`,
      'the compositor gets the take the model made',
    );
  assert.equal(
    requests.filter((r) => r.body.action === 'scale').length,
    0,
    'no rescale is paid for a shot the media desk scales itself',
  );
  // The desk refused three takes; a retry from the engine must buy a fourth, never send the
  // third back to be refused again.
  const before = requests.length;
  await assert.rejects(
    services.render({
      id: 0,
      speaker: 'host',
      text: 'Of course.',
      wardrobe,
    }),
  );
  const again = requests
    .slice(before)
    .filter((r) => r.url === '/api/sponsorship/media')
    .map((r) => r.body.videoUrl);
  assert.ok(again.length >= 1, 'the retry reached the compositor');
  assert.ok(
    again.every((url) => !composites.some((c) => c.body.videoUrl === url)),
    `a fresh take was composited, not a refused one: ${again.join(', ')}`,
  );
});
