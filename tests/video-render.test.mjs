import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';

await build([
  'topics',
  'gestures',
  'video-frames',
  'show',
  'requests',
  'coin',
  'hooks/use-poll',
  'hooks/use-coin',
  'services',
]);
const show = await import('../work/tests/show.js');
const { createServices } = await import('../work/tests/services.js');

test('generate on the native canvas and uniformly scale only the output height', () => {
  const input = show.shotInput({ id: 0, speaker: 'guest', text: 'Of course.' });
  assert.equal(
    input.resolution,
    '768P',
    'avoid the provider refinement that warps boundary frames',
  );
  assert.equal(input.image_url, input.end_image_url);
  const scale = show.scaleInput('https://v3.fal.media/native.mp4');
  assert.equal(scale.height, 1080);
  assert.equal(
    scale.width,
    undefined,
    'one target dimension preserves the source aspect ratio',
  );
  assert.equal(scale.video_url, 'https://v3.fal.media/native.mp4');
  assert.equal(scale.codec, 'libx264');
  for (const url of [
    'http://fal.media/video.mp4',
    'https://example.com/video.mp4',
    'https://fal.media.example.com/video.mp4',
    'https://name:password@fal.media/video.mp4',
    undefined,
  ])
    assert.throws(() => show.scaleInput(url), /video URL/i);
});

test('only the scaled clip is downloaded; retries reuse both native and scale jobs', async (t) => {
  const calls = [];
  const downloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/podcast') {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.action === 'shot') return Response.json({ token: 'native-job' });
      if (body.action === 'scale') {
        assert.equal(body.url, 'https://fal.media/native.mp4');
        return Response.json({ token: 'scale-job' });
      }
      if (body.action === 'poll')
        return Response.json({
          status: 'COMPLETED',
          url:
            body.token === 'native-job'
              ? 'https://fal.media/native.mp4'
              : 'https://fal.media/scaled.mp4',
        });
      throw Error('Unexpected action');
    }
    downloads.push(url);
    return new Response('', { status: 503 });
  });
  const services = createServices();
  const line = { id: 0, speaker: 'guest', text: 'Of course.' };
  await assert.rejects(services.render(line), /Video download failed/);
  await assert.rejects(services.render(line), /Video download failed/);
  assert.deepEqual(
    calls.filter((c) => c.action !== 'poll').map((c) => c.action),
    ['shot', 'scale'],
  );
  assert.deepEqual(
    downloads,
    Array(2).fill('/api/media?url=https%3A%2F%2Ffal.media%2Fscaled.mp4'),
  );
});
