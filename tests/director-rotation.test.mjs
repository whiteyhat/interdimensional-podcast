import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['director-rotation']);
const { DirectorRotation } = await import('../work/tests/director-rotation.js');
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function rig(overrides = {}) {
  let clock = 0;
  const feeds = [],
    cuts = [];
  const rotation = new DirectorRotation({
    now: () => clock,
    create: async (id, signal, events) => {
      const feed = {
        id,
        signal,
        events,
        decoded: false,
        silent: true,
        stuck: false,
        closed: false,
        ready: () => feed.decoded,
        quiet: () => feed.silent,
        stalled: () => feed.stuck,
        buffered: () => 12,
        close: () => {
          feed.closed = true;
        },
      };
      feeds.push(feed);
      return feed;
    },
    take: async (next, old, valid) => {
      if (valid()) cuts.push([old?.id, next.id]);
    },
    ...overrides,
  });
  return {
    rotation,
    feeds,
    cuts,
    async at(ms) {
      clock = ms;
      rotation.tick();
      await settle();
    },
    async start() {
      rotation.start();
      await settle();
      feeds[0].decoded = true;
      await this.at(0);
    },
  };
}
test('default target is one hour; warms 90 seconds early and cuts on a quiet boundary', async () => {
  const r = rig();
  await r.start();
  assert.equal(r.rotation.getSnapshot().remainingSeconds, 3600);
  await r.at(900000);
  assert.equal(r.feeds.length, 1, 'no fifteen-minute rotation');
  await r.at(3509999);
  assert.equal(r.feeds.length, 1);
  await r.at(3510000);
  assert.equal(r.feeds.length, 2);
  r.feeds[1].decoded = true;
  await r.at(3569000);
  assert.equal(r.cuts.length, 1);
  r.feeds[0].silent = false;
  await r.at(3570000);
  assert.equal(r.cuts.length, 1, 'keep the current utterance');
  r.feeds[0].silent = true;
  await r.at(3571000);
  assert.equal(r.cuts.length, 2);
  assert.ok(r.feeds[0].closed);
  assert.equal(r.rotation.getSnapshot().rotations, 1);
  void r.rotation.stop();
  assert.ok(r.feeds.every((f) => f.closed));
});
test('a shorter reported entitlement drives warmup, even when announced late', async () => {
  const r = rig();
  await r.start();
  r.feeds[0].events.limit(900);
  await r.at(810000);
  assert.equal(r.feeds.length, 2);
  assert.equal(r.rotation.getSnapshot().remainingSeconds, 90);
  r.feeds[0].events.limit(null);
  r.feeds[0].events.limit(7200);
  assert.equal(
    r.rotation.getSnapshot().remainingSeconds,
    90,
    'never extend an already known deadline',
  );
});
test('waits for decoded replacement footage; forces a ready handover before expiry', async () => {
  const r = rig();
  await r.start();
  await r.at(3510000);
  r.feeds[0].silent = false;
  await r.at(3595000);
  assert.equal(r.cuts.length, 1);
  assert.equal(r.feeds[0].closed, false);
  r.feeds[1].decoded = true;
  await r.at(3596000);
  assert.equal(r.cuts.length, 2);
});
test('failed standby retries with backoff without stopping the on-air feed', async () => {
  const r = rig();
  await r.start();
  await r.at(3510000);
  r.feeds[1].events.ended('Capacity unavailable');
  await settle();
  assert.ok(r.feeds[1].closed);
  assert.equal(r.feeds[0].closed, false);
  await r.at(3514999);
  assert.equal(r.feeds.length, 2);
  await r.at(3515000);
  assert.equal(r.feeds.length, 3);
  assert.equal(r.feeds.filter((f) => !f.closed).length, 2);
});
test('transport failure or a frozen on-air player begins recovery immediately', async () => {
  for (const fault of ['transport', 'freeze']) {
    const r = rig();
    await r.start();
    if (fault === 'transport') r.feeds[0].events.ended('Peer lost');
    else r.feeds[0].stuck = true;
    await r.at(30000);
    assert.equal(r.feeds.length, 2);
    r.feeds[1].decoded = true;
    await r.at(31000);
    assert.equal(r.cuts.length, 2);
    void r.rotation.stop();
  }
});
test('late creation and pending handovers cannot revive a stopped run', async () => {
  let resolve;
  const feed = {
    id: 1,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  const r = rig({
    create: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  r.rotation.start();
  void r.rotation.stop();
  resolve(feed);
  await settle();
  assert.ok(feed.closed);
  assert.equal(r.rotation.getSnapshot().phase, 'stopped');
  let finish;
  const q = rig({
    take: () =>
      new Promise((r) => {
        finish = r;
      }),
  });
  q.rotation.start();
  await settle();
  q.feeds[0].decoded = true;
  await q.at(0);
  void q.rotation.stop();
  finish();
  await settle();
  assert.equal(q.rotation.getSnapshot().activeId, null);
  assert.ok(q.feeds[0].closed);
});
test('warmup timeout closes a stuck attempt and retries; fatal balance errors stop', async () => {
  const r = rig();
  r.rotation.start();
  await settle();
  await r.at(120001);
  assert.ok(r.feeds[0].closed);
  await r.at(125001);
  assert.equal(r.feeds.length, 2);
  r.feeds[1].events.ended('Insufficient balance', true);
  await settle();
  assert.equal(r.rotation.getSnapshot().phase, 'error');
  await r.at(999999);
  assert.equal(r.feeds.length, 2);
});
test('24 hours of rotations retain at most two feeds, with bounded state', async () => {
  const r = rig();
  await r.start();
  for (let time = 1000; time <= 86400000; time += 1000) {
    for (const f of r.feeds) f.decoded = true;
    await r.at(time);
    assert.ok(r.feeds.filter((f) => !f.closed).length <= 2);
  }
  assert.ok(r.rotation.getSnapshot().rotations >= 24);
  void r.rotation.stop();
  assert.ok(r.feeds.every((f) => f.closed));
});
test('synchronous handover errors recover and a cancelled unresolved take cannot lock the next one', async () => {
  let attempts = 0;
  const r = rig({
    take: () => {
      if (++attempts === 1) throw Error('play failed');
      return Promise.resolve();
    },
  });
  r.rotation.start();
  await settle();
  r.feeds[0].decoded = true;
  await r.at(0);
  assert.ok(r.feeds[0].closed);
  await r.at(5000);
  r.feeds[1].decoded = true;
  await r.at(6000);
  assert.equal(r.rotation.getSnapshot().activeId, 2);
  let calls = 0;
  const q = rig({
    take: () => (++calls === 2 ? new Promise(() => {}) : Promise.resolve()),
  });
  await q.start();
  await q.at(3510000);
  q.feeds[1].decoded = true;
  await q.at(3570000);
  q.feeds[1].events.ended('decode failed');
  await settle();
  await q.at(3575000);
  q.feeds[2].decoded = true;
  await q.at(3576000);
  assert.equal(q.rotation.getSnapshot().activeId, 3);
});
test('stop cleans every resource despite a throwing close; restart waits for async cleanup', async () => {
  const r = rig();
  await r.start();
  await r.at(3510000);
  r.feeds[0].close = () => {
    throw Error('already closed');
  };
  assert.doesNotThrow(() => r.rotation.stop());
  assert.ok(r.feeds[1].closed);
  const q = rig();
  await q.start();
  await q.at(3510000);
  let release;
  q.feeds[0].close = () =>
    new Promise((r) => {
      release = r;
    });
  void q.rotation.stop();
  q.rotation.start();
  await settle();
  assert.equal(q.feeds.length, 2, 'wait for old resource disposal');
  release();
  await settle();
  await q.at(3511000);
  assert.equal(q.feeds.length, 3);
});
test('a shorter limit during pending handover invalidates the target and preserves the current feed', async () => {
  let finish, validity;
  let transfers = 0;
  const r = rig({
    take: (_next, _old, valid) =>
      ++transfers === 1
        ? Promise.resolve()
        : new Promise((resolve) => {
            finish = resolve;
            validity = valid;
          }),
  });
  await r.start();
  await r.at(3510000);
  r.feeds[1].decoded = true;
  await r.at(3570000);
  assert.equal(validity(), true);
  r.feeds[1].events.limit(10);
  assert.equal(validity(), false);
  finish();
  await settle();
  assert.equal(r.rotation.getSnapshot().activeId, 1);
  assert.equal(r.feeds[0].closed, false);
  await r.at(3571000);
  assert.ok(r.feeds[1].closed);
});
test('the shutdown promise covers pending creation and late provider cleanup', async () => {
  let resolveCreation, resolveClose;
  const r = rig({
    create: () =>
      new Promise((resolve) => {
        resolveCreation = resolve;
      }),
  });
  r.rotation.start();
  let drained = false;
  const closed = r.rotation.stop().then(() => (drained = true));
  resolveCreation({
    close: () =>
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
  });
  await settle();
  assert.equal(drained, false);
  resolveClose();
  await closed;
  assert.equal(drained, true);
});
