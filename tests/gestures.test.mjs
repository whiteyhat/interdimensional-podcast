import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

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
const { GestureSchedule, gestureConfig } =
  await import('../work/tests/gestures.js');
const { videoFrames } = await import('../work/tests/video-frames.js');

void test('both video references match the native 1344 by 768 canvas before uniform 1080P scaling', async () => {
  for (const speaker of ['host', 'guest']) {
    assert.equal(
      show.shotInput({ id: 0, speaker, text: 'Of course.' }).image_url,
      videoFrames[speaker].source,
    );
    const png = await readFile(`public${show.cast[speaker].image}`);
    assert.equal(
      png.readUInt32BE(16),
      1344,
      `${speaker} frame width must match the native canvas`,
    );
    assert.equal(png.readUInt32BE(20), 768);
    const original = await readFile(videoFrames[speaker].original);
    assert.equal(
      createHash('sha256').update(original).digest('hex'),
      videoFrames[speaker].originalSha256,
      'regenerated artwork must go through scripts/video-frames.mjs before use',
    );
  }
});

void test('room gestures match each character and keep spoken text separate from choreography', () => {
  for (const [gesture, speaker, words] of [
    ['headphones', 'host', /ear cup/],
    ['watch', 'host', /wristwatch/],
    ['beard', 'guest', /beard/],
    ['shoulders', 'guest', /shoulders/],
  ]) {
    assert.equal(gestureConfig[gesture]?.speaker, speaker);
    const input = show.shotInput({
      id: 5,
      speaker,
      text: 'Of course.',
      gesture,
    });
    assert.match(input.prompt, words);
    // Mentioning smoking props even in a prohibition made them appear in a beard preview.
    assert.doesNotMatch(input.prompt, /\b(cigar|lighter|smoke)\b/i);
    assert.equal(input.end_image_url, input.image_url);
    assert.ok(input.duration >= 6 && input.duration <= 7);
    assert.match(input.prompt, /finishes the entire quoted line before/);
    assert.throws(
      () =>
        show.shotInput({
          id: 5,
          speaker: speaker === 'host' ? 'guest' : 'host',
          text: 'Sure.',
          gesture,
        }),
      /gesture/i,
    );
  }
});

void test('the director rotates through overdue gestures without starving tea or the cigar', () => {
  const schedule = new GestureSchedule();
  const seen = new Map();
  for (let t = 0, id = 0; t < 2400; t += 5, id++) {
    const gesture = schedule.reserve(id % 2 ? 'guest' : 'host', true, t, id);
    if (!gesture) continue;
    seen.set(gesture, (seen.get(gesture) ?? 0) + 1);
    schedule.rendered(id, gestureConfig[gesture].duration);
  }
  for (const gesture of [
    'tea',
    'cigar',
    'headphones',
    'watch',
    'beard',
    'shoulders',
  ])
    assert.ok(seen.get(gesture) >= 3, `${gesture} must recur`);
});

void test('decoded gesture duration moves the end of the cooldown', () => {
  const schedule = new GestureSchedule();
  assert.equal(schedule.reserve('guest', true, 70, 10), 'tea');
  schedule.rendered(10, 11);
  assert.equal(schedule.reserve('host', true, 92, 11), undefined);
  assert.equal(schedule.reserve('host', true, 93, 12), 'cigar');
});

void test('the schedule waits for a short turn and spaces overdue actions from the previous end', () => {
  const schedule = new GestureSchedule();
  assert.equal(schedule.reserve('guest', true, 69, 0), undefined);
  assert.equal(schedule.reserve('guest', false, 70, 1), undefined);
  assert.equal(schedule.reserve('guest', true, 75, 2), 'tea');
  assert.equal(schedule.reserve('host', true, 90, 3), undefined);
  assert.equal(schedule.reserve('host', true, 95, 4), 'cigar');
  assert.equal(schedule.reserve('guest', true, 144, 5), undefined);
  assert.equal(schedule.reserve('guest', true, 145, 6), 'tea');
  assert.equal(schedule.reserve('host', true, 184, 7), 'headphones');
  assert.equal(schedule.reserve('host', true, 185, 8), undefined);
  assert.equal(schedule.reserve('host', true, 202, 9), 'cigar');
});

void test('a long delay reserves one action without a burst of missed repetitions', () => {
  const schedule = new GestureSchedule();
  assert.equal(schedule.reserve('guest', true, 700, 9), 'tea');
  assert.notEqual(schedule.reserve('guest', true, 720, 10), 'tea');
  assert.notEqual(schedule.reserve('guest', true, 750, 11), 'tea');
  assert.equal(schedule.reserve('guest', true, 780, 12), 'tea');
});

void test('tea and cigar shots give the gesture time after a short line', () => {
  assert.equal(show.shotDuration('Neither.', 'tea'), 8);
  assert.equal(show.shotDuration('Oh no.', 'cigar'), 10);
  assert.equal(show.shotDuration('Neither.'), 5);
});

void test('scheduled shots anchor both ends on the native canvas before 1080P scaling', () => {
  assert.equal(typeof show.shotInput, 'function');
  for (const [speaker, gesture, duration] of [
    ['guest', 'tea', 8],
    ['host', 'cigar', 10],
  ]) {
    const input = show.shotInput({
      id: 1,
      speaker,
      text: 'Of course.',
      gesture,
    });
    assert.equal(input.image_url, show.cast[speaker].source);
    assert.equal(input.end_image_url, input.image_url);
    assert.equal(input.resolution, '768P');
    assert.equal(input.duration, duration);
    assert.match(input.prompt, /finishes the entire quoted line before/);
    assert.match(input.prompt, /final second/);
  }
  const ordinary = show.shotInput({
    id: 2,
    speaker: 'host',
    text: 'Of course.',
  });
  assert.equal(ordinary.end_image_url, ordinary.image_url);
});

void test('unknown, mismatched, and overlong gesture requests are rejected', () => {
  assert.equal(typeof show.shotInput, 'function');
  assert.throws(
    () => show.shotInput({ speaker: 'host', text: 'Sure.', gesture: 'tea' }),
    /gesture/i,
  );
  assert.throws(
    () => show.shotInput({ speaker: 'guest', text: 'Sure.', gesture: 'dance' }),
    /gesture/i,
  );
  assert.throws(
    () =>
      show.shotInput({
        speaker: 'guest',
        text: 'word '.repeat(12).trim(),
        gesture: 'tea',
      }),
    /short/i,
  );
});

void test('tea returns the existing mug; cigar props leave the frame before the resting pose', () => {
  assert.match(
    show.shotPrompt('guest', 'Neither.', 'tea'),
    /mug.*original spot/,
  );
  const cigar = show.shotPrompt('host', 'Oh no.', 'cigar');
  assert.match(cigar, /lighter/);
  assert.match(cigar, /below the frame/);
  assert.match(cigar, /smoke.*clear/);
});

void test('render retries reuse a job, while identical dialogue with a gesture submits a distinct job', async (t) => {
  const { createServices } = await import('../work/tests/services.js');
  const submissions = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/podcast') {
      const body = JSON.parse(options.body);
      if (body.action === 'shot') {
        submissions.push(body.line);
        return Response.json({ token: `job-${submissions.length}` });
      }
      if (body.action === 'scale') return Response.json({ token: 'scale-job' });
      return Response.json({
        status: 'COMPLETED',
        url: 'https://fal.media/test.mp4',
      });
    }
    // A failed download lets us exercise caching without a browser or paid generation.
    return new Response('', { status: 503 });
  });
  const services = createServices();
  const line = { id: 4, speaker: 'guest', text: 'Of course.' };
  await assert.rejects(services.render(line), /Video download failed/);
  await assert.rejects(services.render(line), /Video download failed/);
  await assert.rejects(
    services.render({ ...line, gesture: 'tea' }),
    /Video download failed/,
  );
  await assert.rejects(
    services.render({ ...line, gesture: 'tea' }),
    /Video download failed/,
  );
  assert.equal(submissions.length, 2);
  assert.equal(submissions[0].gesture, undefined);
  assert.equal(submissions[1].gesture, 'tea');
});
