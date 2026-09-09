import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build([
  'topics',
  'gestures',
  'video-frames',
  'show',
  'chat',
  'requests',
  'coin',
  'sponsor-program',
  'engine',
]);
const { Podcast, readySeconds } = await import('../work/tests/engine.js');
const { shotDuration } = await import('../work/tests/show.js');
const { gestureConfig, gestureNames } =
  await import('../work/tests/gestures.js');

// A virtual provider clock exercises production defaults without spending credits or sleeping.
async function simulate(
  t,
  {
    seconds = 900,
    policy,
    interaction,
    renderMs = () => 18000,
    writeMs = 0,
    clipSeconds = (line) => shotDuration(line.text, line.gesture),
  } = {},
) {
  let now = 0,
    active = 0,
    peak = 0,
    startedAt,
    startupSeconds,
    lastId,
    responseSeconds,
    maxCommitted = 0;
  const events = [],
    aired = [],
    stalls = [];
  t.mock.method(Date, 'now', () => now);
  const later = (ms, run) => events.push({ at: now + ms, run });
  const engine = new Podcast(
    {
      write: (_recent, start) =>
        new Promise((resolve) => {
          later(writeMs, () =>
            resolve(
              Array.from({ length: 4 }, (_, i) => ({
                id: start + i,
                speaker: (start + i) % 2 ? 'guest' : 'host',
                text: 'Of course.',
              })),
            ),
          );
        }),
      render: (line) =>
        new Promise((resolve) => {
          active++;
          peak = Math.max(peak, active);
          const latency = renderMs(line.id);
          later(latency, () => {
            active--;
            resolve({
              ...line,
              url: `blob:${line.id}`,
              rawUrl: '',
              duration: clipSeconds(line),
              renderMs: latency,
            });
          });
        }),
      release: () => {},
    },
    policy,
  );
  engine.subscribe(() => {
    const s = engine.getSnapshot();
    maxCommitted = Math.max(
      maxCommitted,
      s.slots.reduce(
        (sum, slot) =>
          sum + (slot.clip?.duration ?? shotDuration(slot.text, slot.gesture)),
        0,
      ),
    );
    if (
      responseSeconds === undefined &&
      (s.topics.some(
        (topic) => topic.source === 'chat' && topic.status === 'on-air',
      ) ||
        s.requests.some((request) => request.status === 'on-air'))
    )
      responseSeconds = (now - 200000) / 1000;
    if (s.phase === 'waiting' && stalls.at(-1)?.id !== s.current?.id)
      stalls.push({
        id: s.current?.id,
        at: now,
        active,
        slots: s.slots.map((s) => [s.id, s.status]),
      });
    if (s.phase !== 'playing' || s.current.id === lastId) return;
    if (startedAt === undefined) {
      startedAt = now;
      startupSeconds = s.current.duration;
      for (const slot of s.slots) {
        if (slot.status !== 'ready') break;
        startupSeconds += slot.clip.duration;
      }
    }
    lastId = s.current.id;
    const clip = s.current;
    aired.push({
      id: clip.id,
      at: now,
      gesture: clip.gesture,
      duration: clip.duration,
    });
    later(clip.duration * 1000, () => engine.clipEnded(clip.id));
  });
  engine.start();
  if (interaction)
    later(200000, () => {
      if (interaction === 'chat')
        engine.ingestComments([
          {
            id: 'question',
            author: 'deb',
            text: 'why is the whole timeline mad at the SEC again today?',
          },
        ]);
      else
        engine.request({
          id: 'request',
          reference: 'ref',
          from: 'deb',
          wallet: 'wallet',
          text: 'haunted air fryer',
          amount: 1,
          status: 'queued',
          at: now,
        });
    });
  await new Promise(setImmediate);
  while (events.length && now < seconds * 1000) {
    events.sort((a, b) => a.at - b.at);
    const event = events.shift();
    now = event.at;
    event.run();
    await new Promise(setImmediate);
  }
  const result = {
    stalls: engine.getSnapshot().stalls,
    responseSeconds,
    maxCommitted,
    startupSeconds,
    startedAt,
    peak,
    aired: aired.length,
    trace: stalls,
    gestures: aired.filter((c) => c.gesture),
  };
  engine.dispose();
  return result;
}

void test('a smaller committed queue brings live chat and paid responses forward without stalls', async (t) => {
  for (const interaction of ['chat', 'paid']) {
    const previous = await simulate(t, {
      interaction,
      policy: {
        startupSeconds: 60,
        targetSeconds: 90,
        recoverySeconds: 30,
        concurrency: 3,
        maxSlots: 12,
      },
    });
    const current = await simulate(t, { interaction });
    t.diagnostic(
      `${interaction}: ${previous.responseSeconds}s before, ${current.responseSeconds}s after`,
    );
    assert.equal(current.stalls, 0);
    assert.ok(
      current.maxCommitted <= 60,
      `committed footage stays within a minute: ${current.maxCommitted}`,
    );
    assert.ok(
      current.responseSeconds <= previous.responseSeconds - 20,
      JSON.stringify({
        interaction,
        previous: previous.responseSeconds,
        current: current.responseSeconds,
      }),
    );
  }
});

void test('production defaults sustain fifteen minutes at the measured full-pipeline latency', async (t) => {
  const result = await simulate(t);
  assert.ok(result.aired > 50, JSON.stringify(result));
  assert.equal(result.stalls, 0, JSON.stringify(result));
  assert.ok(
    result.startupSeconds >= 40,
    'start with at least forty seconds of decoded, ordered footage',
  );
  for (const name of gestureNames)
    assert.ok(
      result.gestures.some((g) => g.gesture === name),
      `${name} still airs`,
    );
  const last = new Map();
  for (const [i, clip] of result.gestures.entries()) {
    const at = (clip.at - result.startedAt) / 1000;
    assert.ok(
      at - (last.get(clip.gesture) ?? 0) >=
        gestureConfig[clip.gesture].interval,
    );
    if (i) {
      const previous = result.gestures[i - 1];
      assert.ok(
        (clip.at - previous.at) / 1000 - previous.duration >= gestureConfig.gap,
      );
    }
    last.set(clip.gesture, at);
  }
});

void test('the playable reserve absorbs variable render times and an occasional slow shot', async (t) => {
  const result = await simulate(t, {
    renderMs: (id) =>
      id > 10 && id % 17 === 0 ? 45000 : 16000 + (id % 4) * 2000,
  });
  assert.ok(result.aired > 50, JSON.stringify(result));
  assert.equal(result.stalls, 0, JSON.stringify(result));
  assert.ok(result.peak <= 3, 'provider work stays bounded');
});

void test('reserve survives writer latency and clips decoding shorter than requested', async (t) => {
  const result = await simulate(t, {
    writeMs: 8000,
    renderMs: (id) => 18000 + (id % 4) * 2000,
    clipSeconds: (line) =>
      shotDuration(line.text, line.gesture) - 0.4 + (line.id % 3) * 0.3,
  });
  assert.ok(result.aired > 50, JSON.stringify(result));
  assert.equal(result.stalls, 0, JSON.stringify(result));
  assert.ok(result.startupSeconds >= 40);
});

void test('out-of-order completions cannot start playback and recovery rebuilds a reserve', async () => {
  const jobs = new Map();
  const engine = new Podcast({
    write: async (_recent, start) =>
      Array.from({ length: 4 }, (_, i) => ({
        id: start + i,
        speaker: (start + i) % 2 ? 'guest' : 'host',
        text: 'Of course.',
      })),
    render: (line) =>
      new Promise((resolve) =>
        jobs.set(line.id, () =>
          resolve({
            ...line,
            url: `blob:${line.id}`,
            rawUrl: '',
            duration: 10,
            renderMs: 18000,
          }),
        ),
      ),
    release: () => {},
  });
  const finish = async (id) => {
    assert.ok(jobs.has(id));
    jobs.get(id)();
    await new Promise(setImmediate);
  };
  try {
    engine.start();
    // Forty seconds exist after a missing opening shot. None of it is playable yet.
    for (let id = 1; id <= 4; id++) await finish(id);
    assert.equal(engine.getSnapshot().phase, 'buffering');
    assert.equal(readySeconds(engine.getSnapshot().slots), 0);
    await finish(0);
    assert.equal(engine.getSnapshot().phase, 'playing');
    assert.equal(engine.getSnapshot().current.id, 0);
    while (engine.getSnapshot().phase === 'playing')
      engine.clipEnded(engine.getSnapshot().current.id);
    assert.equal(engine.getSnapshot().stalls, 1);
    const held = engine.getSnapshot().current.id;
    const next = engine.getSnapshot().slots[0].id;
    await finish(next);
    assert.equal(
      engine.getSnapshot().phase,
      'waiting',
      'one ready clip is not a recovery reserve',
    );
    await finish(next + 1);
    assert.equal(engine.getSnapshot().phase, 'waiting');
    assert.equal(
      engine.getSnapshot().current.id,
      held,
      'hold the last frame without repeating speech',
    );
    await finish(next + 2);
    assert.equal(engine.getSnapshot().phase, 'playing');
    assert.equal(engine.getSnapshot().current.id, next);
    assert.equal(
      engine.getSnapshot().current.duration +
        readySeconds(engine.getSnapshot().slots),
      30,
    );
  } finally {
    engine.dispose();
  }
});
