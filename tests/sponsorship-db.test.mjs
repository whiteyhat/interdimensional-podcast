import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from './build.mjs';
import * as orders from './fixtures/sponsor-orders.mjs';
await build([
  'requests',
  'interact',
  'producer-lease',
  'sponsorship',
  'sponsor-db',
  'db',
]);
const db = await import('../work/tests/sponsor-db.js');
const interactDb = await import('../work/tests/db.js');
function database() {
  const sql = new DatabaseSync(':memory:');
  return {
    prepare(text) {
      let params = [];
      return {
        bind(...v) {
          params = v;
          return this;
        },
        async run() {
          const r = sql.prepare(text).run(...params);
          return { meta: { changes: Number(r.changes) } };
        },
        async all() {
          return { results: sql.prepare(text).all(...params) };
        },
        async first() {
          return sql.prepare(text).get(...params) ?? null;
        },
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) {
          const result = await s.all();
          // D1 reports the rows each statement changed; settlePayment reads it.
          out.push({
            ...result,
            meta: { changes: sql.prepare('SELECT changes() AS n').get().n },
          });
        }
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
    sql,
  };
}
async function fixture() {
  const d = database();
  await db.ensureSponsorSchema(d);
  await db.createOrder(d, {
    id: 'order',
    tokenHash: 'secret',
    draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
    now: 100,
  });
  await db.insertAttempt(d, {
    id: 'a1',
    order_id: 'order',
    pay_token: 'pay',
    asset: 'SOL',
    mint: null,
    decimals: 9,
    amount_base: '50000000',
    price_usd: '100',
    price_cents: 500,
    recipient: 'treasury',
    reference: 'ref',
    issued_at: 100,
    expires_at: 200,
  });
  return d;
}
const capAttempt = (d, id, order) => orders.capAttempt(db, d, id, order);
const paidCap = (d, id, target, at) => orders.paidCap(db, d, id, target, at);
void test('a cap is always for sale: a second cap for the same host is quoted and queued, never refused', async () => {
  const d = await fixture();
  for (const [id, target] of [
    ['cap1', 'host'],
    ['cap2', 'host'],
    ['cap3', 'guest'],
  ])
    await db.createOrder(d, {
      id,
      tokenHash: id,
      draft: orders.capDraft(target),
      now: 100,
    });
  await capAttempt(d, 'cap-a1', 'cap1');
  await capAttempt(d, 'cap-a3', 'cap3');
  // Pepe already has a cap being paid for. That is no reason to turn the next buyer away.
  await capAttempt(d, 'cap-a2', 'cap2');
  assert.equal((await db.getOrder(d, 'cap2')).status, 'payment-pending');
  assert.deepEqual(
    await db.capQueue(d),
    { host: 0, guest: 0 },
    'unpaid quotes are invisible to the buyer, so they are not in the line',
  );
  await db.settlePayment(
    d,
    'cap-a1',
    { signature: 'sig-cap1', payer: 'payer', blockTime: 150 },
    300,
  );
  await db.settlePayment(
    d,
    'cap-a2',
    { signature: 'sig-cap2', payer: 'payer', blockTime: 160 },
    310,
  );
  assert.deepEqual(await db.capQueue(d), { host: 2, guest: 0 });
  assert.equal(
    (await db.queueStanding(d, await db.getOrder(d, 'cap1'))).capAhead,
    0,
    'the first paid cap goes on first',
  );
  assert.equal(
    (await db.queueStanding(d, await db.getOrder(d, 'cap2'))).capAhead,
    1,
    'the second waits behind it',
  );
  // An expired guest quote never counts, and its late payment still joins the line.
  d.sql
    .prepare(
      "UPDATE sponsor_payment_attempts SET status='expired' WHERE id='cap-a3'",
    )
    .run();
  assert.equal((await db.capQueue(d)).guest, 0);
  await db.settlePayment(
    d,
    'cap-a3',
    { signature: 'late-cap-payment', payer: 'payer', blockTime: 170 },
    1000,
  );
  assert.equal(
    (await db.getOrder(d, 'cap3')).status,
    'paid',
    'late evidence is preserved for queued delivery',
  );
  assert.equal((await db.capQueue(d)).guest, 1);
  // A paused cap is still in the line: it resumes ahead of anything paid after it.
  d.sql
    .prepare("UPDATE sponsor_orders SET status='paused' WHERE id='cap1'")
    .run();
  assert.equal((await db.capQueue(d)).host, 2);
  assert.equal((await db.queueStanding(d, await db.getOrder(d, 'cap2'))).capAhead, 1);
  d.sql
    .prepare("UPDATE sponsor_orders SET status='fulfilled' WHERE id='cap1'")
    .run();
  assert.equal((await db.capQueue(d)).host, 1, 'delivery shortens the line');
  assert.equal(
    (await db.queueStanding(d, await db.getOrder(d, 'cap2'))).capAhead,
    0,
    'nothing goes on before the second cap now',
  );
  // The other guards on a quote are untouched: a paid order takes no new quote.
  await assert.rejects(capAttempt(d, 'cap-a2b', 'cap2'), /no longer accept/);
});
void test('caps for one host go on one at a time, and a paused cap never holds the next one back', async () => {
  const d = await fixture();
  await paidCap(d, 'cap1', 'host', 300);
  await paidCap(d, 'cap2', 'host', 310);
  await paidCap(d, 'cap3', 'guest', 320);
  const caps = { message: false, spotlight: false, cap: true };
  const first = await db.leaseOrders(d, 'studio', 400, 3, caps);
  assert.deepEqual(
    first.map((o) => o.id),
    ['cap1', 'cap3'],
    'the earliest paid cap per host is leased; the second Pepe cap waits',
  );
  const base = (o) => ({
    orderId: o.id,
    studioId: 'studio',
    leaseToken: o.lease_token,
  });
  await db.applyEvent(
    d,
    { ...base(first[0]), eventId: 'p1', type: 'prepare' },
    410,
  );
  await db.applyEvent(
    d,
    { ...base(first[0]), eventId: 's1', type: 'start' },
    420,
  );
  assert.deepEqual(
    (await db.leaseOrders(d, 'studio', 430, 3, caps)).map((o) => o.id),
    ['cap1', 'cap3'],
    'while the first cap is playing the second is not leased',
  );
  assert.equal((await db.getOrder(d, 'cap2')).status, 'paid');
  await db.applyEvent(
    d,
    { ...base(first[0]), eventId: 'x1', type: 'paused' },
    500,
  );
  assert.equal((await db.getOrder(d, 'cap1')).status, 'paused');
  const next = await db.leaseOrders(d, 'studio', 510, 3, caps);
  assert.ok(
    next.some((o) => o.id === 'cap2'),
    'a paused cap is in a retry cooldown, not on air: the next cap for that host goes on',
  );
  assert.equal((await db.getOrder(d, 'cap2')).status, 'leased');
});
void test('settlement is exactly once and a late second payment is recorded separately', async () => {
  const d = await fixture();
  assert.equal(
    (await db.getAttempt(d, 'a1')).product_version,
    'sponsorship-v1',
  );
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig2', payer: 'payer', blockTime: 151 },
    301,
  );
  assert.equal(
    d.sql.prepare('SELECT count(*) n FROM sponsor_payments').get().n,
    2,
  );
  assert.equal((await db.getOrder(d, 'order')).paid_attempt_id, 'a1');
  assert.equal(
    d.sql
      .prepare('SELECT count(*) n FROM sponsor_payments WHERE is_late=1')
      .get().n,
    1,
  );
});
void test('two studios cannot claim the same order', async () => {
  const d = await fixture();
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  assert.equal((await db.leaseOrders(d, 'one', 400, 1)).length, 1);
  assert.equal((await db.leaseOrders(d, 'two', 400, 1)).length, 0);
});
void test('replayed start acknowledgement cannot authorize playback after the lease is relinquished', async () => {
  const d = await fixture();
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  const [o] = await db.leaseOrders(d, 'studio', 400, 1);
  const base = { orderId: o.id, studioId: 'studio', leaseToken: o.lease_token };
  await db.applyEvent(d, { ...base, eventId: 'prep', type: 'prepare' }, 410);
  await db.applyEvent(d, { ...base, eventId: 'start', type: 'start' }, 420);
  await db.applyEvent(d, { ...base, eventId: 'pause', type: 'paused' }, 430);
  await assert.rejects(
    db.applyEvent(d, { ...base, eventId: 'start', type: 'start' }, 450),
    /lease|delivery/i,
  );
});
void test('progress is idempotent and cannot complete an undelivered cap', async () => {
  const d = await fixture();
  d.sql.prepare("UPDATE sponsor_orders SET product='cap',target='host'").run();
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  const [o] = await db.leaseOrders(d, 'studio', 400, 1);
  const base = { orderId: o.id, studioId: 'studio', leaseToken: o.lease_token };
  await db.applyEvent(d, { ...base, eventId: 'p', type: 'prepare' }, 410);
  await db.applyEvent(d, { ...base, eventId: 's', type: 'start' }, 420);
  await db.applyEvent(
    d,
    {
      ...base,
      eventId: 'g',
      type: 'progress',
      appearanceId: 'clip1',
      stage: 'intro',
      visibleMs: 1000,
    },
    1420,
  );
  await db.applyEvent(
    d,
    {
      ...base,
      eventId: 'g',
      type: 'progress',
      appearanceId: 'clip1',
      stage: 'intro',
      visibleMs: 1000,
    },
    1430,
  );
  const row = await db.getOrder(d, o.id);
  assert.equal(row.appearances, 1);
  assert.equal(row.visible_ms, 1000);
  await assert.rejects(
    db.applyEvent(d, { ...base, eventId: 'c', type: 'complete' }, 1500),
    /incomplete/i,
  );
});
void test('durable quote throttle is bounded across server isolates', async () => {
  const d = await fixture();
  assert.equal(await db.allowSponsorRequest(d, 'quote:ip', 2, 100), true);
  assert.equal(await db.allowSponsorRequest(d, 'quote:ip', 2, 100), true);
  assert.equal(await db.allowSponsorRequest(d, 'quote:ip', 2, 100), false);
  assert.equal(await db.allowSponsorRequest(d, 'quote:ip', 2, 60100), true);
});
void test('pull rehydrates a live lease and excludes unsupported products from new claims', async () => {
  const d = await fixture();
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  assert.equal(
    (
      await db.leaseOrders(d, 'studio', 400, 3, {
        message: false,
        spotlight: false,
        cap: false,
      })
    ).length,
    0,
  );
  const first = await db.leaseOrders(d, 'studio', 400, 3, {
    message: true,
    spotlight: false,
    cap: false,
  });
  const again = await db.leaseOrders(d, 'studio', 450, 3, {
    message: true,
    spotlight: false,
    cap: false,
  });
  assert.equal(first[0].lease_token, again[0].lease_token);
});
void test('expired or mismatched old event acknowledgements cannot authorize playback', async () => {
  const d = await fixture();
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  const [o] = await db.leaseOrders(d, 'studio', 400);
  const base = { orderId: o.id, studioId: 'studio', leaseToken: o.lease_token };
  await db.applyEvent(d, { ...base, type: 'prepare', eventId: 'prepare' }, 410);
  await assert.rejects(
    db.applyEvent(d, { ...base, type: 'start', eventId: 'prepare' }, 420),
    /another delivery/i,
  );
  await db.applyEvent(d, { ...base, type: 'start', eventId: 'start' }, 420);
  await assert.rejects(
    db.applyEvent(d, { ...base, type: 'start', eventId: 'start' }, 100000),
    /lease/i,
  );
});
void test('paused fulfillment resumes after a durable cooldown and keeps progress', async () => {
  const d = await fixture();
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  await db.heartbeat(
    d,
    'studio',
    { message: true, spotlight: false, cap: false },
    400,
  );
  const [o] = await db.leaseOrders(d, 'studio', 400);
  const base = { orderId: o.id, studioId: 'studio', leaseToken: o.lease_token };
  await db.applyEvent(d, { ...base, type: 'prepare', eventId: 'prepare' }, 410);
  await db.applyEvent(d, { ...base, type: 'start', eventId: 'start' }, 420);
  await db.applyEvent(d, { ...base, type: 'paused', eventId: 'pause' }, 500);
  await db.resumeDue(d, 600);
  assert.equal((await db.getOrder(d, o.id)).status, 'paused');
  await db.heartbeat(
    d,
    'studio',
    { message: true, spotlight: false, cap: false },
    31000,
  );
  await db.resumeDue(d, 31000);
  const resumed = await db.getOrder(d, o.id);
  assert.equal(resumed.status, 'paid');
  assert.equal(resumed.started_at, 420);
});

void test('an order that keeps pausing is never given up on, only spaced out', async () => {
  // Paid and non-refundable: the fifth pause must wait longer, not wait forever.
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 40].map(db.pauseCooldownMs),
    [
      30000, 60000, 120000, 240000, 480000, 960000, 1800000, 1800000, 21600000,
      21600000,
    ],
  );
  const d = await fixture();
  await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  const caps = { message: true, spotlight: false, cap: false };
  let now = 400;
  await db.heartbeat(d, 'studio', caps, now);
  for (let pause = 0; pause < 6; pause++) {
    const [o] = await db.leaseOrders(d, 'studio', now);
    assert.ok(o, `the order is leased again after pause ${pause}`);
    const base = {
      orderId: o.id,
      studioId: 'studio',
      leaseToken: o.lease_token,
    };
    await db.applyEvent(
      d,
      { ...base, type: 'prepare', eventId: `prepare${pause}` },
      now + 10,
    );
    await db.applyEvent(
      d,
      { ...base, type: 'start', eventId: `start${pause}` },
      now + 20,
    );
    await db.applyEvent(
      d,
      { ...base, type: 'paused', eventId: `pause${pause}` },
      now + 30,
    );
    const waited = now + 30 + db.pauseCooldownMs(pause);
    await db.heartbeat(d, 'studio', caps, waited - 1);
    await db.resumeDue(d, waited - 1);
    assert.equal(
      (await db.getOrder(d, o.id)).status,
      'paused',
      'not before its cooldown',
    );
    now = waited;
    await db.heartbeat(d, 'studio', caps, now);
    await db.resumeDue(d, now);
    const resumed = await db.getOrder(d, o.id);
    assert.equal(
      resumed.status,
      'paid',
      `pause ${pause + 1} still resumes by itself`,
    );
    assert.equal(resumed.pause_count, pause + 1);
  }
});

void test('the producer lease reports a live studio while the request queue sits idle', async () => {
  const d = database();
  await db.ensureSponsorSchema(d);
  await interactDb.ensureSchema(d);
  // The studio serves sponsorships only: nothing pulls the paid request queue.
  await db.heartbeat(
    d,
    'studio',
    { message: true, spotlight: true, cap: true },
    10_000,
  );
  assert.equal(
    await interactDb.getHeartbeat(d),
    0,
    'the request queue never reports readiness on its own',
  );
  const lease = await interactDb.getStudio(d);
  assert.equal(lease.id, 'studio');
  assert.equal(
    lease.seenAt,
    10_000,
    'the lease carries the liveness the public page asks about',
  );
});
void test('settlement says whether this is the payment that paid the order', async () => {
  const d = await fixture();
  const first = await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  assert.deepEqual(first, { orderId: 'order', orderPaidNow: true });
  // The same proof again, and a late second transfer: recorded, but they paid nothing new.
  const again = await db.settlePayment(
    d,
    'a1',
    { signature: 'sig1', payer: 'payer', blockTime: 150 },
    300,
  );
  assert.deepEqual(again, { orderId: 'order', orderPaidNow: false });
  const late = await db.settlePayment(
    d,
    'a1',
    { signature: 'sig2', payer: 'payer', blockTime: 151 },
    301,
  );
  assert.deepEqual(late, { orderId: 'order', orderPaidNow: false });
  assert.equal(
    d.sql.prepare('SELECT count(*) n FROM sponsor_payments').get().n,
    2,
    'both transfers are still on record',
  );
});
