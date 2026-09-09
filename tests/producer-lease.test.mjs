import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
import { d1 } from './fixtures/d1.mjs';

await build([
  'requests',
  'interact',
  'producer-lease',
  'db',
  'sponsorship',
  'sponsor-db',
]);
const legacy = await import('../work/tests/db.js');
const sponsor = await import('../work/tests/sponsor-db.js');
const { interactLimits } = await import('../work/tests/interact.js');
const caps = { message: true, spotlight: true, cap: false };
const now = 1_000_000;

async function fixture() {
  const d = d1();
  // D1 serializes atomic batches; mirror that when two callers arrive together.
  const batch = d.batch.bind(d);
  let tail = Promise.resolve();
  d.batch = (statements) => {
    const next = tail.then(() => batch(statements));
    tail = next.catch(() => {});
    return next;
  };
  await legacy.ensureSchema(d);
  await sponsor.ensureSponsorSchema(d);
  return d;
}

void test('a sponsorship owner also owns the legacy queue', async () => {
  const d = await fixture();
  await sponsor.heartbeat(d, 'studio-a', caps, now);
  assert.deepEqual(await legacy.getStudio(d), { id: 'studio-a', seenAt: now });
  assert.equal(await legacy.heartbeat(d, now + 1, 'studio-b'), false);
  assert.equal(await legacy.heartbeat(d, now + 2, 'studio-a'), true);
  assert.deepEqual(await legacy.getStudio(d), {
    id: 'studio-a',
    seenAt: now + 2,
  });
});

void test('a legacy owner cannot be displaced by sponsorship polling', async () => {
  const d = await fixture();
  await legacy.heartbeat(d, now, 'studio-b');
  await assert.rejects(sponsor.heartbeat(d, 'studio-a', caps, now + 1), {
    code: 'STUDIO_BUSY',
  });
  assert.equal(
    d.sql.prepare('SELECT * FROM sponsor_producer').get(),
    undefined,
  );
  await sponsor.heartbeat(d, 'studio-b', caps, now + 2);
  assert.deepEqual(await legacy.getStudio(d), {
    id: 'studio-b',
    seenAt: now + 2,
  });
});

void test('simultaneous queue heartbeats elect exactly one producer', async () => {
  for (const sponsorFirst of [true, false]) {
    const d = await fixture();
    const claimSponsor = () =>
      sponsor.heartbeat(d, 'sponsor', caps, now).then(
        () => true,
        (error) => {
          assert.equal(error.code, 'STUDIO_BUSY');
          return false;
        },
      );
    const claimLegacy = () => legacy.heartbeat(d, now, 'legacy');
    const claims = sponsorFirst
      ? [claimSponsor, claimLegacy]
      : [claimLegacy, claimSponsor];
    const results = await Promise.all(claims.map((claim) => claim()));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(
      (await legacy.getStudio(d)).id,
      sponsorFirst ? 'sponsor' : 'legacy',
    );
  }
});

void test('only a stale shared lease allows takeover and the old producer cannot renew it', async () => {
  const d = await fixture();
  await sponsor.heartbeat(d, 'old', caps, now);
  assert.equal(
    await legacy.heartbeat(d, now + interactLimits.heartbeatMs - 1, 'new'),
    false,
  );
  assert.equal(
    await legacy.heartbeat(d, now + interactLimits.heartbeatMs, 'new'),
    true,
  );
  await assert.rejects(
    sponsor.heartbeat(d, 'old', caps, now + interactLimits.heartbeatMs + 1),
    {
      code: 'STUDIO_BUSY',
    },
  );
  assert.equal((await legacy.getStudio(d)).id, 'new');
  assert.equal(
    d.sql.prepare('SELECT seen_at FROM sponsor_producer').get().seen_at,
    now,
  );
});

void test('queue heartbeats keep their separate delivery readiness timestamps', async () => {
  const d = await fixture();
  await sponsor.heartbeat(d, 'studio', caps, now);
  assert.equal(
    await legacy.getHeartbeat(d),
    0,
    'sponsorship alone cannot advertise a legacy consumer',
  );
  await legacy.heartbeat(d, now + 1, 'studio');
  assert.equal(await legacy.getHeartbeat(d), now + 1);
  assert.equal(
    d.sql.prepare('SELECT seen_at FROM sponsor_producer').get().seen_at,
    now,
  );
  await sponsor.heartbeat(
    d,
    'studio',
    { message: false, spotlight: false, cap: false },
    now + 2,
  );
  assert.equal(await legacy.getHeartbeat(d), now + 1);
  assert.deepEqual(
    JSON.parse(
      d.sql.prepare('SELECT capabilities FROM sponsor_producer').get()
        .capabilities,
    ),
    {
      message: false,
      spotlight: false,
      cap: false,
    },
  );
});

void test('schema initialization preserves existing legacy and sponsorship owners', async () => {
  for (const source of ['legacy', 'sponsor']) {
    const d = d1();
    if (source === 'legacy') {
      d.sql.exec(
        'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)',
      );
      d.sql
        .prepare('INSERT INTO meta VALUES(?,?,?)')
        .run('studio_id', 'existing', now);
      d.sql
        .prepare('INSERT INTO meta VALUES(?,?,?)')
        .run('studio_seen_at', String(now), now);
    } else {
      d.sql.exec(
        'CREATE TABLE sponsor_producer(id INTEGER PRIMARY KEY,studio_id TEXT NOT NULL,seen_at INTEGER NOT NULL,capabilities TEXT NOT NULL)',
      );
      d.sql
        .prepare('INSERT INTO sponsor_producer VALUES(1,?,?,?)')
        .run('existing', now, JSON.stringify(caps));
    }
    await legacy.ensureSchema(d);
    await sponsor.ensureSponsorSchema(d);
    assert.deepEqual(await legacy.getStudio(d), {
      id: 'existing',
      seenAt: now,
    });
    assert.equal(await legacy.heartbeat(d, now + 1, 'new'), false);
    await assert.rejects(sponsor.heartbeat(d, 'new', caps, now + 1), {
      code: 'STUDIO_BUSY',
    });
  }
});
