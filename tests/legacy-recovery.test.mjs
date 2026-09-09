import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './fixtures/d1.mjs';
import { build } from './build.mjs';
await build([
  'requests',
  'interact',
  'producer-lease',
  'show',
  'gestures',
  'video-frames',
  'http',
  'solana',
  'db',
  'legacy-recovery',
  'legacy-receipt',
]);
const db = await import('../work/tests/db.js'),
  { settleLegacy, legacyRpcWithDeadline } =
    await import('../work/tests/legacy-recovery.js'),
  { readLegacyReceipt } = await import('../work/tests/legacy-receipt.js');
const ref = '11111111111111111111111111111111',
  sig = (n) => '1'.repeat(63) + n;
async function fixture() {
  const d = d1();
  await db.ensureSchema(d);
  await db.insertQuote(d, {
    id: 'legacy',
    reference: ref,
    wallet: ref,
    name: 'Joe',
    message: 'Remember this payment',
    amount_ui: 5,
    amount_base: '5000000',
    mint: ref,
    recipient: ref,
    price_usd: 1,
    created_at: 100,
    expires_at: 200,
  });
  return d;
}
void test('migration moves only unverified signatures and preserves paid signatures', async () => {
  const d = d1();
  for (const s of db.schema) d.sql.exec(s);
  d.sql.exec(
    "INSERT INTO requests(id,reference,wallet,message,amount_ui,amount_base,mint,recipient,price_usd,status,signature,created_at,expires_at) VALUES('a','a','w','m',1,'1','m','r',1,'submitted','broadcast',1,2),('b','b','w','m',1,'1','m','r',1,'paid','verified',1,2)",
  );
  await db.ensureSchema(d);
  const rows = d.sql
    .prepare('SELECT signature,broadcast_signature FROM requests ORDER BY id')
    .all();
  assert.equal(rows[0].signature, null);
  assert.equal(rows[0].broadcast_signature, 'broadcast');
  assert.equal(rows[1].signature, 'verified');
});
void test('a failed broadcast and failed first page cannot hide a later valid payment', async () => {
  const d = await fixture();
  await db.setStatus(d, ref, 'submitted', ['quoted'], 300, sig('2'));
  const seen = [];
  const rpc = {
    getSignaturesForAddress(_ref, options) {
      seen.push(options.before);
      return {
        send: async () =>
          options.before
            ? [{ signature: sig('Z'), err: null }]
            : Array.from({ length: 10 }, (_, i) => ({
                signature: sig('23456789AB'[i]),
                err: null,
              })),
      };
    },
  };
  const services = {
    mintInfo: async () => ({ program: ref }),
    verifyPayment: async (_r, s) => ({
      status: s === sig('Z') ? 'paid' : 'failed',
    }),
  };
  const result = await settleLegacy(
    d,
    rpc,
    await db.getByReference(d, ref),
    500,
    undefined,
    services,
  );
  assert.equal(result.status, 'paid');
  assert.equal(seen.length, 2);
  const row = await db.getByReference(d, ref);
  assert.equal(row.signature, sig('Z'));
  assert.equal(row.broadcast_signature, sig('2'));
  assert.equal(
    (await settleLegacy(d, rpc, row, 600, undefined, services)).status,
    'paid',
  );
  assert.equal(seen.length, 2, 'settled rows never scan or fulfill again');
});
void test('missing indexed transaction bodies preserve the recovery cursor and expired rows stay recoverable', async () => {
  const d = await fixture();
  await db.setStatus(d, ref, 'expired', ['quoted'], 300);
  let arrived = false;
  const rpc = {
    getSignaturesForAddress() {
      return {
        send: async () =>
          Array.from({ length: 10 }, () => ({
            signature: sig('2'),
            err: null,
          })),
      };
    },
  };
  const services = {
    mintInfo: async () => ({ program: ref }),
    verifyPayment: async () => ({ status: arrived ? 'paid' : 'pending' }),
  };
  assert.equal(
    (
      await settleLegacy(
        d,
        rpc,
        await db.getByReference(d, ref),
        400,
        sig('2'),
        services,
      )
    ).status,
    'pending',
  );
  assert.equal(
    d.sql.prepare('SELECT cursor FROM legacy_payment_recovery').get().cursor,
    null,
  );
  arrived = true;
  assert.equal(
    (
      await settleLegacy(
        d,
        rpc,
        await db.getByReference(d, ref),
        500,
        undefined,
        services,
      )
    ).status,
    'paid',
  );
});
void test('receipt recovery has no frontend timeout and survives a changed or disconnected wallet', () => {
  const r = readLegacyReceipt(
    JSON.stringify({ reference: ref, wallet: ref, at: 1, paid: false }),
  );
  assert.equal(r.reference, ref);
  assert.equal(r.signature, null);
});
void test('a stalled archival RPC is canceled without clearing the recoverable receipt', async () => {
  const d = await fixture(),
    controller = new AbortController();
  const rpc = legacyRpcWithDeadline(
    {
      getSignaturesForAddress() {
        return {
          send: ({ abortSignal }) =>
            new Promise((resolve, reject) => {
              abortSignal.addEventListener(
                'abort',
                () => reject(abortSignal.reason),
                { once: true },
              );
              controller.abort(Error('Archival node timed out'));
            }),
        };
      },
    },
    controller.signal,
  );
  const services = {
    mintInfo: async () => ({ program: ref }),
    verifyPayment: async () => ({ status: 'pending' }),
  };
  await assert.rejects(
    settleLegacy(
      d,
      rpc,
      await db.getByReference(d, ref),
      400,
      undefined,
      services,
    ),
    /timed out/,
  );
  assert.equal((await db.getByReference(d, ref)).status, 'quoted');
  assert.equal(
    d.sql.prepare('SELECT count(*) n FROM legacy_payment_recovery').get().n,
    0,
    'no incomplete scan is committed',
  );
});
