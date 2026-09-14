import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';

await build(['services']);
const { createServices } = await import('../work/tests/services.js');

// A dressed shot used to skip fal's scaler and go to the media desk to have a cap composited
// onto the take, per clip, behind a tracker that refused two takes in three. The look is now
// in the frames the model is conditioned on, so a dressed clip is scaled, audited and
// downloaded exactly like any other clip, and nothing is ever posted to a media route.
const wardrobe = {
  orderId: 'order',
  leaseToken: 'lease',
  target: 'host',
  assetId: 'asset1',
  designHash: 'look1',
  sourceUrl: 'https://show.test/api/sponsorship/assets/asset1?part=look&v=look1',
  templateVersion: 'looks-v1',
};
/** A browser that decodes any blob as ten seconds of playable video. */
function decodable(t) {
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
}

void test('a dressed clip is scaled and audited like any other clip, and nothing is composited', async (t) => {
  decodable(t);
  const actions = [];
  const downloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/podcast') {
      const body = JSON.parse(options.body);
      if (body.action !== 'poll') actions.push(body.action);
      if (body.action === 'shot') {
        assert.ok(body.line.wardrobe, 'the take is bought dressed');
        return Response.json({ token: 'shot-job' });
      }
      if (body.action === 'scale') {
        assert.equal(
          body.url,
          'https://fal.media/native.mp4',
          'the scaler gets the take the model made',
        );
        return Response.json({ token: 'scale-job' });
      }
      if (body.action === 'speech')
        return Response.json({ token: 'speech-job' });
      if (body.action === 'poll')
        return Response.json({
          status: 'COMPLETED',
          ...(body.token === 'speech-job'
            ? { speechEnd: 0.8, hasExtraSpeech: false }
            : {}),
          url:
            body.token === 'shot-job'
              ? 'https://fal.media/native.mp4'
              : 'https://fal.media/scaled.mp4',
        });
      throw Error(`unexpected action ${body.action}`);
    }
    assert.ok(
      !String(url).includes('/api/sponsorship/media'),
      'no compositor is called for a dressed clip',
    );
    downloads.push(url);
    return new Response(new Blob(['video']));
  });
  const services = createServices();
  const clip = await services.render({
    id: 0,
    speaker: 'host',
    text: 'Of course.',
    wardrobe,
  });
  assert.deepEqual(actions, ['shot', 'scale', 'speech']);
  assert.deepEqual(
    downloads,
    ['/api/media?url=https%3A%2F%2Ffal.media%2Fscaled.mp4'],
    'the scaled take is downloaded through the media proxy, like any clip',
  );
  assert.equal(clip.rawUrl, 'https://fal.media/scaled.mp4');
  assert.equal(
    clip.wardrobe.designHash,
    'look1',
    'the clip still carries the look it was made with',
  );
  assert.equal(clip.speechEnd, 0.8);
  assert.equal(clip.duration, 10, 'a clean dressed take keeps its complete native ending');
  services.release(clip.url);
});

// The route answers a lost lease or a replaced look with its own status and code; the studio
// drops the placement at once instead of buying takes that can only be refused the same way.
for (const code of ['LEASE', 'ASSET'])
  void test(`a placement the site refuses with ${code} is dropped at once, not retaken`, async (t) => {
    const shots = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, '/api/podcast');
      const body = JSON.parse(options.body);
      if (body.action === 'shot') {
        shots.push(body);
        return Response.json(
          {
            code,
            error:
              code === 'LEASE'
                ? 'The delivery lease ended.'
                : 'The wardrobe revision does not match this purchased cap.',
          },
          { status: 409 },
        );
      }
      throw Error(`unexpected action ${body.action}`);
    });
    await assert.rejects(
      createServices().render({
        id: 0,
        speaker: 'host',
        text: 'Of course.',
        wardrobe,
      }),
      (e) => e.code === code && e.constructor.name === 'PlacementLostError',
    );
    assert.equal(
      shots.length,
      1,
      'no new take is bought for a placement that is gone',
    );
  });
