import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from './build.mjs';
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
        for (const s of statements) out.push(await s.all());
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
void test('cap inventory reserves one host through ambiguous payments and preserves late obligations', async () => {
  const d = await fixture();
  const create = async (id, target) => {
    await db.createOrder(d, {
      id,
      tokenHash: id,
      draft: {
        product: 'cap',
        target,
        name: 'Joe',
        projectName: 'GM',
        message: 'Builders ship',
        assetId: 'art',
      },
      now: 100,
    });
  };
  const attempt = async (id, order) =>
    db.insertAttempt(d, {
      id,
      order_id: order,
      pay_token: id,
      asset: 'SOL',
      mint: null,
      decimals: 9,
      amount_base: '1000000000',
      price_usd: '100',
      price_cents: 10000,
      recipient: 'treasury',
      reference: id,
      issued_at: 100,
      expires_at: 200,
    });
  await create('cap1', 'host');
  await create('cap2', 'host');
  await create('cap3', 'guest');
  await attempt('cap-a1', 'cap1');
  await attempt('cap-a3', 'cap3');
  await assert.rejects(attempt('cap-a2', 'cap2'), /reserved/i);
  assert.deepEqual(await db.capInventory(d), { host: false, guest: false });
  assert.equal(
    (await db.getOrder(d, 'cap2')).status,
    'draft',
    'a rejected reservation does not change the order',
  );
  d.sql
    .prepare(
      "UPDATE sponsor_payment_attempts SET status='submitted' WHERE id='cap-a1'",
    )
    .run();
  await assert.rejects(attempt('cap-a2', 'cap2'), /reserved/i);
  d.sql
    .prepare(
      "UPDATE sponsor_payment_attempts SET status='expired' WHERE id='cap-a1'",
    )
    .run();
  assert.equal(
    (await db.capInventory(d)).host,
    true,
    'only reconciled expiry releases the hold',
  );
  await attempt('cap-a2', 'cap2');
  await db.settlePayment(
    d,
    'cap-a1',
    { signature: 'late-cap-payment', payer: 'payer', blockTime: 150 },
    1000,
  );
  assert.equal(
    (await db.getOrder(d, 'cap1')).status,
    'paid',
    'late evidence is preserved for queued delivery',
  );
  assert.equal((await db.capInventory(d)).host, false);
  d.sql
    .prepare(
      "UPDATE sponsor_payment_attempts SET status='expired' WHERE id='cap-a2'",
    )
    .run();
  assert.equal(
    (await db.capInventory(d)).host,
    false,
    'a paid cap keeps its host until it is delivered; nothing refunds it away',
  );
  d.sql
    .prepare("UPDATE sponsor_orders SET status='fulfilled' WHERE id='cap1'")
    .run();
  assert.equal(
    (await db.capInventory(d)).host,
    true,
    'delivery releases the host for the next buyer',
  );
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

test('the producer lease reports a live studio while the request queue sits idle', async () => {
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
