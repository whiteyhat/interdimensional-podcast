import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  'speech',
  'sponsor-delivery-client',
  'services',
]);
const show = await import('../work/tests/show.js');
const { videoFrames } = await import('../work/tests/video-frames.js');
const { createServices } = await import('../work/tests/services.js');

void test('generate on the native canvas and uniformly scale only the output height', () => {
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

// The tailor edits the uncropped 1376×768 original of each host, so the model's 16:9 1K
// answer lines up pixel for pixel with the still it was handed. That original was uploaded
// to fal once, when the stills were branded (character-assets.json); the generated frames
// module is where the show and the desk read it, so it is pinned to that source here.
void test('each host carries the fal URL of its uncropped original, the still the tailor edits', async () => {
  const { sources } = JSON.parse(await readFile('character-assets.json', 'utf8'));
  assert.equal(videoFrames.host.originalUrl, sources['pepe-cartoon']);
  assert.equal(videoFrames.guest.originalUrl, sources['gigachad-cartoon']);
  for (const role of ['host', 'guest']) {
    const url = new URL(videoFrames[role].originalUrl);
    assert.equal(url.protocol, 'https:');
    assert.ok(
      url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'),
      url.href,
    );
    assert.notEqual(
      videoFrames[role].originalUrl,
      videoFrames[role].source,
      'the original is not the cropped 1344×768 conditioning frame',
    );
    assert.equal(videoFrames[role].width, 1344);
  }
  // The next regeneration must keep writing the field from the same source.
  const generator = await readFile('scripts/video-frames.mjs', 'utf8');
  assert.match(generator, /character-assets\.json/);
  assert.match(generator, /\boriginalUrl\b/);
});

// A dressed line is conditioned, at both ends, on the look: the host already wearing the tee
// with the logo printed on the chest and the cap in the brand's colours. The prompt keeps that
// print visible and invents nothing on it; a gesture would put a hand or a mug over the chest,
// so it is dropped on a dressed line and the shot is timed as plain speech.
void test('a dressed line conditions both frames on the look, keeps the print in shot and drops the gesture', () => {
  const sourceUrl =
    'https://show.test/api/sponsorship/assets/asset1?part=look&v=look1';
  const line = {
    id: 0,
    speaker: 'guest',
    text: 'Of course.',
    gesture: 'tea',
    wardrobe: {
      orderId: 'order',
      leaseToken: 'lease',
      target: 'guest',
      assetId: 'asset1',
      designHash: 'look1',
      sourceUrl,
      templateVersion: 'looks-v1',
    },
  };
  const input = show.shotInput(line);
  assert.equal(input.image_url, sourceUrl, 'the look is the start frame');
  assert.equal(input.end_image_url, sourceUrl, 'and the end frame');
  assert.ok(
    input.prompt.endsWith(
      ' Keep the cap and the printed T-shirt exactly as in the reference: no new lettering, logos or accessories. Hands stay below the chest so the print stays visible. Headphones keep their exact placement; the camera stays fixed.',
    ),
    input.prompt.slice(-320),
  );
  assert.doesNotMatch(input.prompt, /blank cap|cap front unobstructed|cap scale/);
  const plain = show.shotInput({ ...line, gesture: undefined });
  assert.equal(input.prompt, plain.prompt, 'the gesture is dropped on a dressed line');
  assert.equal(input.duration, plain.duration, 'and the shot is timed as plain speech');
  assert.match(
    show.shotInput({ ...line, wardrobe: undefined }).prompt,
    /unhurried sip/,
    'the same line undressed would have performed the gesture',
  );
  assert.doesNotMatch(input.prompt, /unhurried sip/);
});

void test('uncertain cap tracking retries a bounded number of takes and never downloads the failed result', async (t) => {
  const shots = [];
  let composites = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/api/sponsorship/media') {
      composites++;
      return Response.json(
        { code: 'INVALID_WEARABLE', error: 'Tracking could not be verified.' },
        { status: 422 },
      );
    }
    assert.equal(url, '/api/podcast', 'a failed cap never reaches the player');
    if (body.action === 'shot') {
      shots.push(body);
      return Response.json({ token: `native-${body.attempt}` });
    }
    if (body.action === 'scale')
      return Response.json({ token: `scale-${shots.length}` });
    if (body.action === 'speech')
      return Response.json({ token: `speech-${shots.length}` });
    return Response.json({
      status: 'COMPLETED',
      speechEnd: 0.8,
      url: `https://fal.media/${body.token}.mp4`,
    });
  });
  const wardrobe = {
    orderId: 'order',
    leaseToken: 'lease',
    target: 'host',
    assetId: 'design',
    designHash: 'hash',
    sourceUrl: 'https://show.test/cap.png',
    templateVersion: 'caps-v1',
  };
  await assert.rejects(
    createServices().render({
      id: 0,
      speaker: 'host',
      text: 'Of course.',
      wardrobe,
    }),
    /Tracking could not/,
  );
  assert.deepEqual(
    shots.map((s) => s.attempt),
    [0, 1, 2],
  );
  assert.equal(composites, 3);
});

void test('a successful compositor preserves the verified speech boundary and decoded timing', async (t) => {
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      createElement: () => ({
        duration: 10,
        src: '',
        muted: false,
        preload: '',
        removeAttribute() {
          this.src = '';
        },
        load() {
          if (this.src) queueMicrotask(() => this.onloadeddata?.());
        },
      }),
    },
  });
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://show.test/api/sponsorship/assets/composed?part=video')
      return new Response(new Blob(['video']));
    const body = JSON.parse(options.body);
    if (url === '/api/sponsorship/media')
      return Response.json({
        url: 'https://show.test/api/sponsorship/assets/composed?part=video',
        quality: {
          accepted: true,
          audioVerified: true,
          duration: 10,
          frames: 250,
        },
      });
    assert.equal(url, '/api/podcast');
    if (body.action !== 'poll')
      return Response.json({ token: `${body.action}-job` });
    return Response.json({
      status: 'COMPLETED',
      speechEnd: 0.8,
      url: 'https://fal.media/video.mp4',
    });
  });
  const services = createServices();
  const wardrobe = {
    orderId: 'order',
    leaseToken: 'lease',
    target: 'host',
    assetId: 'design',
    designHash: 'hash',
    sourceUrl: 'https://show.test/cap.png',
    templateVersion: 'caps-v1',
  };
  const clip = await services.render({
    id: 0,
    speaker: 'host',
    text: 'Of course.',
    wardrobe,
  });
  assert.equal(clip.speechEnd, 0.8);
  assert.equal(clip.duration, 10);
  assert.equal(clip.wardrobe.designHash, 'hash');
  services.release(clip.url);
});

void test('only the scaled clip is downloaded; retries reuse both native and scale jobs', async (t) => {
  const calls = [];
  const downloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/podcast') {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.action === 'shot') return Response.json({ token: 'native-job' });
      if (body.action === 'speech')
        return Response.json({ token: 'speech-job' });
      if (body.action === 'scale') {
        assert.equal(body.url, 'https://fal.media/native.mp4');
        return Response.json({ token: 'scale-job' });
      }
      if (body.action === 'poll')
        return Response.json({
          status: 'COMPLETED',
          ...(body.token === 'speech-job' ? { speechEnd: 0.8 } : {}),
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
    ['shot', 'scale', 'speech'],
  );
  assert.deepEqual(
    downloads,
    Array(2).fill('/api/media?url=https%3A%2F%2Ffal.media%2Fscaled.mp4'),
  );
});

void test('unverified speech never downloads or airs, and retry submits a new take', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(
      url,
      '/api/podcast',
      'unverified audio must never reach media download',
    );
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.action !== 'poll')
      return Response.json({ token: `${body.action}-job` });
    if (body.token === 'speech-job')
      return Response.json(
        { code: 'INVALID_SPEECH', error: 'Wrong speech' },
        { status: 422 },
      );
    return Response.json({
      status: 'COMPLETED',
      url: 'https://fal.media/native.mp4',
    });
  });
  const services = createServices();
  const line = { id: 0, speaker: 'host', text: 'Of course.' };
  await assert.rejects(services.render(line), /Wrong speech/);
  await assert.rejects(services.render(line), /Wrong speech/);
  const shots = calls.filter((c) => c.action === 'shot');
  assert.equal(
    shots.length,
    2,
    'a rejected soundtrack must not stay in the retry cache',
  );
  assert.equal(shots[1].attempt, 1);
});

void test('a completed audit without a valid boundary is rejected and invalidated', async (t) => {
  const shots = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/podcast');
    const body = JSON.parse(options.body);
    if (body.action === 'shot') shots.push(body);
    if (body.action !== 'poll')
      return Response.json({ token: `${body.action}-job` });
    return Response.json({
      status: 'COMPLETED',
      url: 'https://fal.media/native.mp4',
    });
  });
  const services = createServices();
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      services.render({ id: 0, speaker: 'guest', text: 'Neither.' }),
      /verified speech/,
    );
  assert.equal(shots.length, 2);
});
