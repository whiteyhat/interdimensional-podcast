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
  'engine',
  'sponsor-program',
]);
const { SponsorProgram } = await import('../work/tests/sponsor-program.js');
const { Podcast } = await import('../work/tests/engine.js');
const lease = (product = 'spotlight') => ({
  id: 'order1',
  leaseToken: 'lease1',
  leaseUntil: Date.now() + 45000,
  draft: {
    product,
    name: 'alice',
    message: 'We make tools for artists.',
    projectName: 'Canvas',
    target: 'host',
    assetId: 'design1',
  },
  assetUrl: 'https://site.test/preview.png',
  assetMetadata: {
    sourceUrl: 'https://site.test/cap.png',
    sha256: 'design1',
    templateVersion: 'caps-v1',
  },
  fulfillment: {
    visibleMs: 0,
    appearances: 0,
    intro: false,
    callback: false,
    startedAt: null,
    completedAt: null,
  },
});
function harness(order = lease()) {
  const events = [];
  const service = {
    sync: async () => [order],
    event: async (event) => {
      events.push(event);
      const f = order.fulfillment;
      if (event.type === 'start') f.startedAt ??= Date.now();
      if (event.type === 'progress') {
        f.visibleMs += event.visibleMs || 0;
        f.appearances += event.appearanceId ? 1 : 0;
        if (event.stage) f[event.stage] = true;
      }
      if (event.type === 'complete') f.completedAt = Date.now();
      return {
        fulfillment: { ...f },
        status:
          event.type === 'complete'
            ? 'fulfilled'
            : event.type === 'paused'
              ? 'paused'
              : 'playing',
      };
    },
  };
  return { events, order, service, program: new SponsorProgram(service) };
}
const lines = (start = 0) =>
  Array.from({ length: 4 }, (_, i) => ({
    id: start + i,
    speaker: i % 2 ? 'guest' : 'host',
    text: 'An ordinary spoken line.',
  }));
void test('generation never delivers a spotlight; the last played turn completes it exactly once', async () => {
  const h = harness();
  await h.program.sync();
  const cue = h.program.nextCue(0);
  const batch = h.program.written(cue, lines());
  assert.equal(h.events.length, 0);
  for (const line of batch) {
    await h.program.before(line);
    await h.program.ended({ ...line, duration: 10 });
  }
  assert.equal(h.events.filter((e) => e.type === 'complete').length, 1);
  assert.equal(
    h.events.find((e) => e.stage === 'intro').eventId.includes(':3:'),
    true,
  );
  assert.equal(h.program.nextCue(120), undefined);
});
void test('a failed authorization prevents the next sponsored clip from playing', async () => {
  const h = harness();
  await h.program.sync();
  const cue = h.program.nextCue(0);
  const batch = h.program.written(cue, lines());
  h.service.event = async () => {
    throw Error('The delivery lease ended.');
  };
  await assert.rejects(h.program.before(batch[0]), /lease ended/);
  assert.equal(h.program.snapshot()[0].phase, 'paused');
});
void test('caps count only played footage, require both mentions and six separate appearances', async () => {
  const h = harness(lease('cap'));
  await h.program.sync();
  const cue = h.program.nextCue(0);
  const batch = h.program.written(cue, lines());
  assert.equal(h.program.snapshot()[0].fulfillment.visibleMs, 0);
  for (const line of batch) {
    const pinned = h.program.decorate(line);
    await h.program.before(pinned);
    await h.program.ended({ ...pinned, duration: 10 });
  }
  assert.equal(h.order.fulfillment.appearances, 2);
  assert.equal(
    h.order.fulfillment.visibleMs,
    40000,
    'the opposite host counts toward a healthy broadcast block',
  );
  assert.equal(h.events.filter((e) => e.type === 'complete').length, 0);
  for (let id = 4; id < 52; id++) {
    const line = h.program.decorate({
      id,
      speaker: id % 2 ? 'guest' : 'host',
      text: 'The editorial conversation continues.',
    });
    await h.program.before(line);
    await h.program.ended({ ...line, duration: 10 });
  }
  const callback = h.program.nextCue(520);
  assert.equal(callback.stage, 'callback');
  const callbackBatch = h.program.written(callback, lines(52));
  for (const draft of callbackBatch) {
    const line = h.program.decorate(draft);
    await h.program.before(line);
    await h.program.ended({ ...line, duration: 10 });
  }
  assert.equal(
    h.events.filter((e) => e.type === 'complete').length,
    0,
    'the block still owes healthy airtime',
  );
  for (let id = 56; id < 60; id++) {
    const line = h.program.decorate({
      id,
      speaker: id % 2 ? 'guest' : 'host',
      text: 'The editorial conversation continues.',
    });
    await h.program.before(line);
    await h.program.ended({ ...line, duration: 10 });
  }
  assert.equal(h.events.filter((e) => e.type === 'complete').length, 1);
  assert.equal(h.order.fulfillment.visibleMs, 600000);
});
void test('paid exchanges reserve a two-minute gap and release a failed draft reservation', async () => {
  const h = harness();
  await h.program.sync();
  const cue = h.program.nextCue(10);
  h.program.written(cue, lines());
  assert.equal(h.program.canSchedulePaid(129), false);
  assert.equal(h.program.canSchedulePaid(130), true);
  h.program.reservePaid(150);
  assert.equal(h.program.canSchedulePaid(269), false);
  assert.equal(h.program.canSchedulePaid(270), true);
  const retry = harness();
  await retry.program.sync();
  const failed = retry.program.nextCue(0);
  retry.program.failedWrite(failed);
  assert.ok(
    retry.program.nextCue(0),
    'a rejected draft does not consume the next paid slot',
  );
});
void test('a restart resets the program clock after a long run', async () => {
  const h = harness();
  await h.program.sync();
  h.program.reservePaid(3600);
  assert.equal(h.program.nextCue(120), undefined);
  h.program.beginRun();
  assert.ok(
    h.program.nextCue(120),
    'a fresh playback clock must not wait through the old hour again',
  );
});
void test('a cap introduced after rescheduling waits for a cut away from the same host', async () => {
  const order = lease('cap');
  order.fulfillment.intro = true;
  order.fulfillment.visibleMs = 100000;
  const h = harness(order);
  await h.program.sync();
  assert.equal(
    h.program.decorate(
      { id: 3, speaker: 'host', text: 'Still the same camera.' },
      'host',
    ).wardrobe,
    undefined,
  );
  assert.ok(
    h.program.decorate(
      { id: 5, speaker: 'host', text: 'Now back to this camera.' },
      'guest',
    ).wardrobe,
  );
});
void test('stopping waits for a pending heartbeat before announcing offline', async () => {
  const calls = [];
  let release;
  const p = new SponsorProgram({
    sync: async () => {
      calls.push('heartbeat');
      await new Promise((resolve) => {
        release = resolve;
      });
      calls.push('heartbeat-finished');
      return [];
    },
    event: async () => ({}),
    offline: async () => {
      calls.push('offline');
    },
  });
  const sync = p.sync();
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = p.stop();
  assert.deepEqual(calls, ['heartbeat']);
  release();
  await Promise.all([sync, stopped]);
  assert.deepEqual(calls, ['heartbeat', 'heartbeat-finished', 'offline']);
});
void test('an interrupted cap resumes its existing clock and retires only at a cut to the other host', async () => {
  const order = lease('cap');
  order.fulfillment = {
    visibleMs: 590000,
    appearances: 8,
    intro: true,
    callback: true,
    startedAt: Date.now() - 590000,
    completedAt: null,
  };
  const h = harness(order);
  await h.program.sync();
  const line = h.program.decorate({
    id: 80,
    speaker: 'host',
    text: 'The editorial conversation continues.',
  });
  assert.ok(
    line.wardrobe,
    'the new producer lease restores the purchased wardrobe',
  );
  await h.program.before(line);
  await h.program.ended({ ...line, duration: 10 });
  const held = { ...line, id: 81 };
  await h.program.before(held);
  const cut = { id: 82, speaker: 'guest', text: 'I am still listening.' };
  assert.equal(h.program.needsGate(cut), true);
  await h.program.before(cut);
  await assert.rejects(
    h.program.before({ ...line, id: 83 }),
    /cancelled|rescheduled/,
  );
  assert.equal(h.events.filter((e) => e.type === 'complete').length, 1);
});
void test('a mid-block pause preserves verified progress and never credits the held frame', async () => {
  const h = harness(lease('cap'));
  await h.program.sync();
  const cue = h.program.nextCue(0);
  const [draft] = h.program.written(cue, lines());
  const line = h.program.decorate(draft);
  await h.program.before(line);
  await h.program.stop();
  await h.program.ended({ ...line, duration: 10 });
  assert.equal(h.order.fulfillment.visibleMs, 0);
  assert.equal(h.events.filter((e) => e.type === 'paused').length, 1);
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function engineHarness(h, extra = {}) {
  const writes = [];
  const engine = new Podcast(
    {
      sponsors: h.service,
      render: async (line) => ({
        ...line,
        url: `blob:${line.id}`,
        rawUrl: `https://fal.media/${line.id}.mp4`,
        duration: 10,
        renderMs: 1,
        speechEnd: 1,
      }),
      write: async (recent, start, cue, topic, from, sponsorship) => {
        writes.push({ start, sponsorship });
        const first = recent.at(-1)?.speaker === 'host' ? 'guest' : 'host';
        return Array.from({ length: 4 }, (_, i) => ({
          id: start + i,
          speaker: i % 2 ? (first === 'host' ? 'guest' : 'host') : first,
          text: 'This is a fully spoken sponsored turn.',
        }));
      },
      release: () => {},
      ...extra,
    },
    {
      startupSeconds: 20,
      targetSeconds: 40,
      recoverySeconds: 10,
      concurrency: 3,
      maxSlots: 6,
    },
  );
  return { engine, writes };
}
void test('repeated sponsored writer failures pause that order and preserve editorial playback', async () => {
  const h = harness();
  let paidWrites = 0;
  const { engine } = engineHarness(h, {
    write: async (recent, start, cue, topic, from, sponsorship) => {
      if (sponsorship) {
        paidWrites++;
        throw Error('The sponsored exchange could not be verified.');
      }
      const first = recent.at(-1)?.speaker === 'host' ? 'guest' : 'host';
      return Array.from({ length: 4 }, (_, i) => ({
        id: start + i,
        speaker: i % 2 ? (first === 'host' ? 'guest' : 'host') : first,
        text: 'The editorial conversation continues.',
      }));
    },
  });
  try {
    engine.start();
    for (let step = 0; step < 35; step++) {
      await tick();
      const state = engine.getSnapshot();
      if (state.phase === 'playing') engine.clipEnded(state.current.id);
    }
    assert.equal(paidWrites, 3);
    assert.ok(h.events.some((event) => event.type === 'paused'));
    assert.equal(engine.getSnapshot().error, '');
    assert.ok(engine.getSnapshot().aired > 5);
  } finally {
    engine.dispose();
    await tick();
  }
});
void test('the engine keeps a generated sponsorship behind its authorization gate and completes after playback', async () => {
  const h = harness();
  const { engine } = engineHarness(h);
  try {
    engine.start();
    for (
      let step = 0;
      step < 40 && !h.events.some((e) => e.type === 'complete');
      step++
    ) {
      await tick();
      const state = engine.getSnapshot();
      if (state.phase === 'playing' && state.current) {
        engine.shown(state.current.id);
        engine.clipEnded(state.current.id);
      }
    }
    await tick();
    assert.equal(h.events.filter((e) => e.type === 'complete').length, 1);
    const paid = engine
      .getSnapshot()
      .history.filter((line) => line.sponsorship);
    assert.equal(paid.length, 4);
    assert.equal(
      h.events.filter((e) => e.type === 'start').length,
      4,
      'every sponsored cut verifies ownership again',
    );
  } finally {
    engine.dispose();
    await tick();
  }
});
void test('a cancellation during preparation removes every buffered sponsored turn before it airs', async () => {
  const h = harness();
  h.service.event = async (event) => {
    h.events.push(event);
    if (event.type === 'prepare') throw Error('The delivery lease ended.');
    return {};
  };
  const { engine } = engineHarness(h);
  try {
    engine.start();
    for (let step = 0; step < 30; step++) {
      await tick();
      const state = engine.getSnapshot();
      if (state.phase === 'playing' && state.current)
        engine.clipEnded(state.current.id);
    }
    assert.ok(h.events.some((e) => e.type === 'prepare'));
    assert.ok(
      engine.getSnapshot().history.every((line) => !line.sponsorship),
      'no cancelled paid line reached the player',
    );
    assert.ok(engine.getSnapshot().aired > 5, 'the editorial show continues');
  } finally {
    engine.dispose();
    await tick();
  }
});

void test('a committed start with a lost response is compensated and its old lease stays quarantined', async () => {
  const h = harness();
  const original = h.service.event;
  let committed = false;
  h.service.event = async (event) => {
    if (event.type === 'start') {
      committed = true;
      throw new TypeError('Lost start response');
    }
    return original(event);
  };
  await h.program.sync();
  const [line] = h.program.written(h.program.nextCue(0), lines());
  await assert.rejects(h.program.before(line), /Lost start/);
  assert.equal(committed, true);
  assert.ok(h.events.some((e) => e.type === 'paused'));
  await h.program.sync();
  assert.equal(
    h.program.nextCue(200),
    undefined,
    'an unchanged lease can never be revived by pull',
  );
  await assert.rejects(h.program.before(line), /cancelled|rescheduled/);
});
void test('ambiguous compensating pauses stop heartbeat renewal until the old lease is confirmed ended', async () => {
  const h = harness();
  let renewals = 0;
  let ended = false;
  h.service.sync = async () => {
    renewals++;
    return [h.order];
  };
  h.service.event = async (event) => {
    if (event.type === 'prepare') return { status: 'prepared' };
    const error = new TypeError('Lost response');
    if (event.type === 'paused' && ended)
      Object.assign(error, { code: 'LEASE' });
    throw error;
  };
  await h.program.sync();
  const [line] = h.program.written(h.program.nextCue(0), lines());
  await assert.rejects(h.program.before(line));
  await assert.rejects(h.program.sync(), /not being renewed/);
  await assert.rejects(h.program.sync(), /not being renewed/);
  assert.equal(renewals, 1);
  ended = true;
  await h.program.sync();
  assert.equal(renewals, 2);
  assert.equal(h.program.nextCue(200), undefined);
});
void test('a failed multi-order gate compensates the cap started before the later spotlight failure', async () => {
  const cap = lease('cap');
  cap.id = 'cap';
  cap.leaseToken = 'cap-lease';
  const ad = lease();
  const events = [];
  const p = new SponsorProgram({
    sync: async () => [cap, ad],
    event: async (e) => {
      events.push(e);
      if (e.orderId === ad.id && e.type === 'start')
        throw new TypeError('Lost second start');
      return { status: e.type === 'paused' ? 'paused' : 'playing' };
    },
  });
  await p.sync();
  const capLine = p.decorate(p.written(p.nextCue(0), lines())[0]);
  await p.before(capLine);
  const adLine = p.decorate(p.written(p.nextCue(120), lines(10))[0]);
  await assert.rejects(p.before(adLine), /Lost second start/);
  assert.deepEqual(
    events
      .filter((e) => e.type === 'paused')
      .map((e) => e.orderId)
      .sort((a, b) => a.localeCompare(b)),
    ['cap', 'order1'],
  );
});
void test('rapid pause and resume cannot commit an authorization gate from before the pause', async () => {
  const h = harness();
  const original = h.service.event;
  let release;
  let intercepted = false;
  h.service.event = async (event) => {
    if (event.type === 'start' && !intercepted) {
      intercepted = true;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return original(event);
  };
  const { engine } = engineHarness(h);
  try {
    engine.start();
    for (let step = 0; step < 30 && !release; step++) {
      await tick();
      const s = engine.getSnapshot();
      if (s.phase === 'playing' && s.current) engine.clipEnded(s.current.id);
    }
    assert.ok(release);
    engine.pause();
    engine.pause();
    release();
    for (let step = 0; step < 12; step++) {
      await tick();
      const s = engine.getSnapshot();
      if (s.phase === 'playing' && s.current) engine.clipEnded(s.current.id);
    }
    assert.ok(h.events.some((e) => e.type === 'paused'));
    assert.ok(
      engine.getSnapshot().history.every((l) => !l.sponsorship),
      'the old gate never admits media from a lost lease',
    );
  } finally {
    engine.dispose();
    await tick();
  }
});
void test('blocked sponsored playback relinquishes delivery and cannot resume the same media', async () => {
  const h = harness();
  const { engine } = engineHarness(h);
  try {
    engine.start();
    for (
      let step = 0;
      step < 30 && !engine.getSnapshot().current?.sponsorship;
      step++
    ) {
      await tick();
      const s = engine.getSnapshot();
      if (s.phase === 'playing' && s.current) engine.clipEnded(s.current.id);
    }
    const current = engine.getSnapshot().current;
    assert.ok(current?.sponsorship);
    assert.equal(
      engine.playbackFailed(current.id, current.url, 'Autoplay was blocked.'),
      true,
    );
    engine.clipEnded(current.id);
    await tick();
    assert.ok(h.events.some((e) => e.type === 'paused'));
    assert.ok(!h.events.some((e) => e.type === 'complete'));
    assert.notEqual(engine.getSnapshot().current?.url, current.url);
    assert.equal(
      engine.playbackFailed(
        current.id,
        current.url,
        'A stale play promise resolved.',
      ),
      false,
    );
  } finally {
    engine.dispose();
    await tick();
  }
});
