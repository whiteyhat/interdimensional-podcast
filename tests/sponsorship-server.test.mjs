import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Keypair, Transaction } from '@solana/web3.js';
import { build } from './build.mjs';
import * as orders from './fixtures/sponsor-orders.mjs';
await build([
  'requests',
  'interact',
  'producer-lease',
  'db',
  'sponsorship',
  'sponsor-db',
  'sponsor-pay',
  'sponsor-server',
]);
const server = await import('../work/tests/sponsor-server.js');
const db = await import('../work/tests/sponsor-db.js');
const legacy = await import('../work/tests/db.js');
const pay = await import('../work/tests/sponsor-pay.js');
function database() {
  const sql = new DatabaseSync(':memory:');
  return {
    sql,
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
  };
}
/** A placement on sale, for the tests that only need some order to pay for. */
const DRAFT = {
  product: 'spotlight',
  projectName: 'Game',
  style: 'intro',
  name: 'Joe',
  message: 'Hello everyone',
};
const post = (v, body, headers = {}) =>
  server.handleSponsorship(
    new Request('https://show.test/api/sponsorship', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    v,
  );
async function fixture() {
  const DB = database(),
    treasury = Keypair.generate(),
    wallet = Keypair.generate();
  const v = {
    DB,
    TREASURY_WALLET: treasury.publicKey.toBase58(),
    SPONSOR_ENABLED: 'true',
    SOLANA_RPC_URL: 'http://127.0.0.1:65534/' + crypto.randomUUID(),
    JUPITER_API_KEY: 'test',
    STUDIO_TOKEN: 'studio-token-0123456789',
  };
  await db.ensureSponsorSchema(DB);
  await db.heartbeat(
    DB,
    'studio',
    { message: true, spotlight: true, cap: false },
    Date.now(),
  );
  const c = pay.sponsorConnection(v.SOLANA_RPC_URL);
  c.getBalance = async () => 10_000_000_000;
  c.getBlockTime = async () => Math.floor(Date.now() / 1000);
  c.getLatestBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 200,
  });
  c.getBlockHeight = async () => 100;
  c.getFeeForMessage = async () => ({ value: 11000 });
  c.getSignaturesForAddress = async () => [];
  c.getParsedTransaction = async () => null;
  c.getSignatureStatuses = async () => ({ value: [null] });
  c.getTransaction = async () => null;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ [pay.SOL_MINT]: { usdPrice: 100, blockId: 100 } });
  return { DB, v, c, wallet, restore: () => (globalThis.fetch = oldFetch) };
}
void test('private receipt capability is separate from the Solana Pay capability', async () => {
  const f = await fixture();
  try {
    const draft = await (
      await post(f.v, {
        action: 'draft',
        draft: DRAFT,
      })
    ).json();
    const quote = await (
      await post(f.v, {
        action: 'quote',
        token: draft.receipt.token,
        asset: 'SOL',
      })
    ).json();
    assert.ok(quote.attempt);
    const cap = new URL(
      decodeURIComponent(quote.solanaPayUrl.slice(7)),
    ).pathname
      .split('/')
      .pop();
    const wrong = await server.handleSponsorship(
      new Request(
        'https://show.test/api/sponsorship?action=receipt&token=' + cap,
      ),
      f.v,
    );
    assert.equal(wrong.status, 404);
    const metadata = await server.handleSolanaPay(
      new Request('https://show.test/api/solana-pay/' + cap),
      f.v,
      cap,
    );
    assert.equal(metadata.status, 200);
    assert.equal(metadata.headers.get('access-control-allow-origin'), '*');
    assert.equal(
      JSON.stringify(await metadata.json()).includes(draft.receipt.token),
      false,
    );
  } finally {
    f.restore();
  }
});
void test('ambiguous broadcasts persist deterministic signature and cannot issue a new charge', async () => {
  const f = await fixture();
  try {
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: DRAFT,
      })
    ).json();
    const quote = await (
      await post(f.v, {
        action: 'quote',
        token: receipt.token,
        asset: 'SOL',
        wallet: f.wallet.publicKey.toBase58(),
      })
    ).json();
    const tx = Transaction.from(Buffer.from(quote.transaction, 'base64'));
    tx.partialSign(f.wallet);
    f.c.sendRawTransaction = async () => {
      throw Error('timeout after acceptance');
    };
    const submitted = await (
      await post(f.v, {
        action: 'submit',
        token: receipt.token,
        attemptId: quote.attempt.id,
        signedTx: tx.serialize().toString('base64'),
      })
    ).json();
    assert.equal(submitted.receipt.attempts[0].status, 'submitted');
    assert.ok(submitted.receipt.attempts[0].broadcastSignature);
    assert.equal(submitted.receipt.attempts[0].verifiedSignature, null);
    const retry = await post(f.v, {
      action: 'quote',
      token: receipt.token,
      asset: 'USDC',
    });
    assert.equal(retry.status, 409);
    assert.equal(
      f.DB.sql.prepare('SELECT count(*) n FROM sponsor_payment_attempts').get()
        .n,
      1,
    );
  } finally {
    f.restore();
  }
});
void test('producer must heartbeat before pulling even with the shared token', async () => {
  const f = await fixture();
  try {
    const r = await post(
      f.v,
      { action: 'pull' },
      { 'x-studio-token': f.v.STUDIO_TOKEN, 'x-studio-id': 'other' },
    );
    assert.equal(r.status, 409);
  } finally {
    f.restore();
  }
});
void test('both queues identify direct producers consistently with absent and noncanonical headers', async (t) => {
  for (const [name, id, expected] of [
    ['absent', undefined, 'studio'],
    ['trimmed', '  studio-a  ', 'studio-a'],
    ['invalid', 'studio/a', 'studio'],
    ['long', 'a'.repeat(40), 'a'.repeat(32)],
  ]) {
    await t.test(name, async () => {
      const DB = database();
      await legacy.ensureSchema(DB);
      const v = {
        DB,
        STUDIO_TOKEN: 'shared-studio-token',
        STUDIO_ID: 'configured-bridge-id',
      };
      assert.equal(await legacy.heartbeat(DB, Date.now(), expected), true);
      const headers = {
        'x-studio-token': v.STUDIO_TOKEN,
        ...(id === undefined ? {} : { 'x-studio-id': id }),
      };
      const heartbeat = await post(
        v,
        {
          action: 'heartbeat',
          capabilities: { message: true, spotlight: false, cap: false },
        },
        headers,
      );
      assert.equal(
        heartbeat.status,
        200,
        'the same producer must not conflict with its legacy lease',
      );
      assert.equal((await post(v, { action: 'pull' }, headers)).status, 200);
      assert.equal(
        DB.sql.prepare('SELECT studio_id FROM sponsor_producer').get()
          .studio_id,
        expected,
      );
    });
  }
});

void test('the local sponsorship bridge publishes the same normalized id as the legacy bridge', async (t) => {
  for (const [name, id, expected] of [
    ['absent', undefined, 'studio'],
    ['trimmed', '  studio-a  ', 'studio-a'],
    ['invalid', 'studio/a', 'studio'],
    ['long', 'a'.repeat(40), 'a'.repeat(32)],
  ]) {
    await t.test(name, async (t) => {
      const DB = database();
      await legacy.ensureSchema(DB);
      const remote = { DB, STUDIO_TOKEN: 'shared-studio-token' };
      assert.equal(await legacy.heartbeat(DB, Date.now(), expected), true);
      t.mock.method(globalThis, 'fetch', (url, options) => {
        assert.equal(url, 'https://show.test/api/sponsorship');
        assert.equal(options.headers['x-studio-id'], expected);
        return post(remote, JSON.parse(options.body), options.headers);
      });
      const response = await server.handleSponsorship(
        new Request('http://127.0.0.1:3212/api/sponsorship', {
          method: 'POST',
          body: JSON.stringify({
            action: 'heartbeat',
            capabilities: { message: true },
          }),
        }),
        { ...remote, STUDIO_ID: id, INTERACT_ORIGIN: 'https://show.test' },
      );
      assert.equal(
        response.status,
        200,
        'the bridged producer must retain its shared lease',
      );
      assert.equal(
        DB.sql.prepare('SELECT studio_id FROM sponsor_producer').get()
          .studio_id,
        expected,
      );
    });
  }
});
void test('the sponsorship bridge reports a site without the release as a JSON error, never as relabelled HTML', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        '<!DOCTYPE html><title>404: This page could not be found.</title>',
        {
          status: 404,
          headers: { 'content-type': 'text/html' },
        },
      ),
  );
  const response = await server.handleSponsorship(
    new Request('http://127.0.0.1:3212/api/sponsorship', {
      method: 'POST',
      body: JSON.stringify({
        action: 'heartbeat',
        capabilities: { message: true },
      }),
    }),
    {
      STUDIO_TOKEN: 'shared-studio-token',
      INTERACT_ORIGIN: 'https://show.test',
    },
  );
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('content-type'), 'application/json');
  const body = await response.json();
  assert.equal(body.code, 'SITE');
  assert.match(body.error, /answered 404 without JSON/);
});
void test('expiry requires a reference sweep begun after blockhash finality, not an old pagination cursor', async () => {
  const f = await fixture();
  try {
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: DRAFT,
      })
    ).json();
    await (
      await post(f.v, {
        action: 'quote',
        token: receipt.token,
        asset: 'SOL',
        wallet: f.wallet.publicKey.toBase58(),
      })
    ).json();
    f.DB.sql
      .prepare(
        "UPDATE sponsor_payment_attempts SET expires_at=0,scan_before='old-page'",
      )
      .run();
    f.c.getBlockHeight = async () => 300;
    const first = await (
      await post(f.v, { action: 'confirm', token: receipt.token })
    ).json();
    assert.equal(first.receipt.attempts[0].status, 'issued');
    const second = await (
      await post(f.v, { action: 'confirm', token: receipt.token })
    ).json();
    assert.equal(second.receipt.attempts[0].status, 'expired');
  } finally {
    f.restore();
  }
});
void test('wallet requests carry a server cosignature that fixes their blockhash without funding gas', async () => {
  const f = await fixture();
  try {
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: DRAFT,
      })
    ).json();
    const q = await (
      await post(f.v, {
        action: 'quote',
        token: receipt.token,
        asset: 'SOL',
        wallet: f.wallet.publicKey.toBase58(),
      })
    ).json();
    const tx = Transaction.from(Buffer.from(q.transaction, 'base64'));
    assert.equal(tx.feePayer.toBase58(), f.wallet.publicKey.toBase58());
    assert.equal(tx.signatures.length, 2);
    assert.ok(tx.signatures[1].signature);
    tx.partialSign(f.wallet);
    assert.equal(tx.verifySignatures(), true);
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.partialSign(f.wallet);
    assert.equal(tx.verifySignatures(), false);
  } finally {
    f.restore();
  }
});
void test('Solana Pay preflight permits the official helper cache-control header', async () => {
  const f = await fixture();
  try {
    const r = await server.handleSolanaPay(
      new Request('https://show.test/api/solana-pay/test', {
        method: 'OPTIONS',
      }),
      f.v,
      'test',
    );
    assert.match(
      r.headers.get('access-control-allow-headers'),
      /cache-control/i,
    );
  } finally {
    f.restore();
  }
});
void test('USDC stays one token per dollar without a Jupiter service', async () => {
  const f = await fixture();
  try {
    f.v.JUPITER_API_KEY = undefined;
    globalThis.fetch = async () => {
      throw Error('oracle offline');
    };
    const owners = [f.v.TREASURY_WALLET];
    f.c.getAccountInfo = async (key) => {
      if (key.toBase58() === pay.USDC_MINT) {
        const data = Buffer.alloc(82);
        data[44] = 6;
        data[45] = 1;
        return { owner: pay.TOKEN_PROGRAM, data };
      }
      const owner = owners.find((o) => pay.ata(o, pay.USDC_MINT).equals(key));
      if (!owner) return null;
      const data = Buffer.alloc(165);
      new (await import('@solana/web3.js')).PublicKey(pay.USDC_MINT)
        .toBuffer()
        .copy(data, 0);
      new (await import('@solana/web3.js')).PublicKey(owner)
        .toBuffer()
        .copy(data, 32);
      data.writeBigUInt64LE(BigInt(1000000000), 64);
      data[108] = 1;
      return { owner: pay.TOKEN_PROGRAM, data };
    };
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: DRAFT,
      })
    ).json();
    const r = await post(f.v, {
      action: 'quote',
      token: receipt.token,
      asset: 'USDC',
    });
    const q = await r.json();
    assert.equal(r.status, 200, JSON.stringify(q));
    assert.equal(q.attempt.amountBase, '25000000');
    assert.equal(q.attempt.priceUsd, '1');
  } finally {
    f.restore();
  }
});
void test('studio context resolves immutable draft and rejects relinquished leases', async () => {
  const f = await fixture();
  try {
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: DRAFT,
      })
    ).json();
    const q = await (
      await post(f.v, { action: 'quote', token: receipt.token, asset: 'SOL' })
    ).json();
    await db.settlePayment(
      f.DB,
      q.attempt.id,
      {
        signature: 'paid',
        payer: f.wallet.publicKey.toBase58(),
        blockTime: 100,
      },
      Date.now(),
    );
    const [o] = await db.leaseOrders(f.DB, 'studio', Date.now());
    const headers = {
      'x-studio-id': 'studio',
      'x-studio-token': f.v.STUDIO_TOKEN,
    };
    const context = await post(
      f.v,
      { action: 'context', orderId: o.id, leaseToken: o.lease_token },
      headers,
    );
    assert.equal(context.status, 200);
    assert.equal((await context.json()).order.draft.message, 'Hello everyone');
    await db.applyEvent(
      f.DB,
      {
        orderId: o.id,
        studioId: 'studio',
        leaseToken: o.lease_token,
        eventId: 'pause',
        type: 'paused',
      },
      Date.now(),
    );
    assert.equal(
      (
        await post(
          f.v,
          { action: 'context', orderId: o.id, leaseToken: o.lease_token },
          headers,
        )
      ).status,
      409,
    );
  } finally {
    f.restore();
  }
});
async function terminalDelivery(f, type) {
  const now = Date.now(),
    id = `terminal-${type}`;
  await db.createOrder(f.DB, {
    id,
    tokenHash: id,
    draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
    now,
  });
  await db.insertAttempt(f.DB, {
    id,
    order_id: id,
    pay_token: id,
    asset: 'SOL',
    mint: null,
    decimals: 9,
    amount_base: '50000000',
    price_usd: '100',
    price_cents: 500,
    recipient: f.v.TREASURY_WALLET,
    reference: id,
    issued_at: now,
    expires_at: now + 60000,
  });
  await db.settlePayment(
    f.DB,
    id,
    {
      signature: id,
      payer: f.wallet.publicKey.toBase58(),
      blockTime: now / 1000,
    },
    now,
  );
  const [order] = await db.leaseOrders(f.DB, 'studio', now, 1);
  const base = {
    orderId: order.id,
    studioId: 'studio',
    leaseToken: order.lease_token,
  };
  for (const event of [
    { type: 'prepare', eventId: `${id}:prepare` },
    { type: 'start', eventId: `${id}:start` },
    { type: 'progress', eventId: `${id}:progress`, stage: 'intro' },
    { type, eventId: `${id}:${type}` },
  ])
    await db.applyEvent(f.DB, { ...base, ...event }, now);
  return {
    action: 'event',
    orderId: order.id,
    leaseToken: order.lease_token,
    type,
    eventId: `${id}:${type}`,
  };
}
void test('terminal API replays survive lease expiry and disabled capabilities without authorizing stale playback', async () => {
  const f = await fixture();
  try {
    const events = [
      await terminalDelivery(f, 'complete'),
      await terminalDelivery(f, 'paused'),
    ];
    await db.heartbeat(
      f.DB,
      'studio',
      { message: false, spotlight: false, cap: false },
      Date.now(),
    );
    f.DB.sql
      .prepare('UPDATE sponsor_orders SET lease_until=?')
      .run(Date.now() - 1);
    const headers = {
      'x-studio-id': 'studio',
      'x-studio-token': f.v.STUDIO_TOKEN,
    };
    for (const event of events) {
      const replay = await post(f.v, event, headers);
      assert.equal(
        replay.status,
        200,
        JSON.stringify(await replay.clone().json()),
      );
      assert.equal(
        (await replay.json()).status,
        event.type === 'complete' ? 'fulfilled' : 'paused',
      );
      assert.equal(
        (await post(f.v, { ...event, leaseToken: 'foreign' }, headers)).status,
        409,
      );
      assert.equal(
        (
          await post(
            f.v,
            { ...event, type: 'start', eventId: `${event.orderId}:start` },
            headers,
          )
        ).status,
        409,
      );
    }
  } finally {
    f.restore();
  }
});
void test('an ambiguous pause acknowledgment remains recoverable after heartbeat expiry and producer replacement', async () => {
  const f = await fixture();
  try {
    const event = await terminalDelivery(f, 'paused');
    const headers = {
      'x-studio-id': 'studio',
      'x-studio-token': f.v.STUDIO_TOKEN,
    };
    f.DB.sql
      .prepare('UPDATE sponsor_producer SET seen_at=?')
      .run(Date.now() - 60000);
    f.DB.sql
      .prepare("UPDATE meta SET updated_at=? WHERE key='studio_id'")
      .run(Date.now() - 60000);
    f.DB.sql
      .prepare('UPDATE sponsor_orders SET lease_until=?')
      .run(Date.now() - 1);
    assert.equal(
      (await post(f.v, event, headers)).status,
      200,
      'lost pause acknowledgments must not require a renewing heartbeat',
    );
    assert.equal(
      (await post(f.v, event)).status,
      401,
      'pause recovery still requires the studio token',
    );
    const expired = await post(
      f.v,
      { ...event, eventId: 'previously-unsubmitted-pause' },
      headers,
    );
    assert.equal(expired.status, 409);
    assert.equal(
      (await expired.json()).code,
      'LEASE',
      'an expired unacknowledged intent must resolve without renewing its lease',
    );
    assert.equal(
      (await post(f.v, { ...event, leaseToken: 'foreign' }, headers)).status,
      409,
    );
    await db.heartbeat(
      f.DB,
      'replacement',
      { message: true, spotlight: true, cap: false },
      Date.now(),
    );
    assert.equal(
      (await post(f.v, event, headers)).status,
      200,
      'the old studio can acknowledge its own already-paused lease',
    );
    const start = await post(
      f.v,
      { ...event, type: 'start', eventId: `${event.orderId}:start` },
      headers,
    );
    assert.equal(start.status, 409);
    assert.equal((await start.json()).code, 'STUDIO_BUSY');
    f.DB.sql
      .prepare(
        "UPDATE sponsor_orders SET status='leased',lease_owner='replacement',lease_token='replacement-lease',lease_until=? WHERE id=?",
      )
      .run(Date.now() + 45000, event.orderId);
    assert.equal(
      (await post(f.v, event, headers)).status,
      409,
      'an old pause must not cancel a replacement lease',
    );
    const current = await db.getOrder(f.DB, event.orderId);
    assert.equal(current.status, 'leased');
    assert.equal(current.lease_owner, 'replacement');
    assert.equal(current.lease_token, 'replacement-lease');
    assert.equal(
      f.DB.sql.prepare('SELECT studio_id FROM sponsor_producer').get()
        .studio_id,
      'replacement',
    );
  } finally {
    f.restore();
  }
});
void test('finalized cosigned payment credits its actual payer exactly once', async () => {
  const f = await fixture();
  try {
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: DRAFT,
      })
    ).json();
    const q = await (
      await post(f.v, {
        action: 'quote',
        token: receipt.token,
        asset: 'SOL',
        wallet: f.wallet.publicKey.toBase58(),
      })
    ).json();
    const tx = Transaction.from(Buffer.from(q.transaction, 'base64'));
    tx.partialSign(f.wallet);
    const { getBase58Decoder } = await import('@solana/kit');
    const sig = getBase58Decoder().decode(tx.signature),
      msg = tx.compileMessage();
    const keys = msg.accountKeys.map((pubkey, i) => ({
        pubkey: pubkey.toBase58(),
        signer: i < msg.header.numRequiredSignatures,
      })),
      index = keys.findIndex((k) => k.pubkey === f.v.TREASURY_WALLET),
      pre = keys.map(() => 0),
      after = keys.map(() => 0);
    pre[0] = 300000000;
    after[0] = 49000000;
    after[index] = 250000000;
    f.c.getParsedTransaction = async () => ({
      blockTime: Math.floor(Date.now() / 1000),
      meta: { err: null, preBalances: pre, postBalances: after },
      transaction: {
        signatures: tx.signatures.map((s) =>
          getBase58Decoder().decode(s.signature),
        ),
        message: {
          accountKeys: keys,
          instructions: [
            {
              programId: '11111111111111111111111111111111',
              parsed: {
                type: 'transfer',
                info: {
                  source: f.wallet.publicKey.toBase58(),
                  destination: f.v.TREASURY_WALLET,
                  lamports: 250000000,
                },
              },
            },
          ],
        },
      },
    });
    const result = await (
      await post(f.v, {
        action: 'confirm',
        token: receipt.token,
        attemptId: q.attempt.id,
        signature: sig,
      })
    ).json();
    assert.equal(result.receipt.status, 'paid');
    assert.equal(result.receipt.payer, f.wallet.publicKey.toBase58());
    // The fixture settles on a local validator: the receipt links to the devnet explorer.
    assert.equal(
      result.receipt.attempts[0].explorerUrl,
      `https://solscan.io/tx/${sig}?cluster=devnet`,
    );
    await post(f.v, {
      action: 'confirm',
      token: receipt.token,
      attemptId: q.attempt.id,
      signature: sig,
    });
    assert.equal(
      f.DB.sql.prepare('SELECT count(*) n FROM sponsor_payments').get().n,
      1,
    );
  } finally {
    f.restore();
  }
});
void test('a held builder lock prevents recovery from expiring its in-flight attempt', async () => {
  const f = await fixture();
  try {
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: DRAFT,
      })
    ).json();
    const q = await (
      await post(f.v, { action: 'quote', token: receipt.token, asset: 'SOL' })
    ).json();
    f.DB.sql.prepare('UPDATE sponsor_payment_attempts SET expires_at=0').run();
    const lock = await db.acquireLock(
      f.DB,
      'attempt:' + q.attempt.id,
      Date.now(),
    );
    const pending = await (
      await post(f.v, { action: 'confirm', token: receipt.token })
    ).json();
    assert.equal(pending.receipt.attempts[0].status, 'issued');
    await db.releaseLock(f.DB, 'attempt:' + q.attempt.id, lock);
    const closed = await (
      await post(f.v, { action: 'confirm', token: receipt.token })
    ).json();
    assert.equal(closed.receipt.attempts[0].status, 'expired');
  } finally {
    f.restore();
  }
});

// SQLite counts every row an INSERT, UPDATE or DELETE touched on this connection: the exact
// thing D1 bills against a daily allowance, and what an idle reconciler must not spend.
const rowsWritten = (f) =>
  f.DB.sql.prepare('SELECT total_changes() AS n').get().n;
async function quoted(f) {
  const { receipt } = await (
    await post(f.v, { action: 'draft', draft: DRAFT })
  ).json();
  const q = await (
    await post(f.v, {
      action: 'quote',
      token: receipt.token,
      asset: 'SOL',
      wallet: f.wallet.publicKey.toBase58(),
    })
  ).json();
  return { receipt, attempt: q.attempt };
}

void test('a reconcile pass with nothing to do reads, and writes nothing', async (t) => {
  const f = await fixture();
  try {
    const { receipt, attempt } = await quoted(f);
    await db.settlePayment(
      f.DB,
      attempt.id,
      { signature: 'sig', payer: 'payer', blockTime: 150 },
      Date.now(),
    );
    const scans = t.mock.method(f.c, 'getSignaturesForAddress');
    const before = rowsWritten(f);
    const result = await server.reconcileSponsorships(f.v);
    assert.deepEqual(result, { ok: true, idle: true, checked: 0, errors: 0 });
    assert.equal(rowsWritten(f), before, 'not one row written');
    assert.equal(
      scans.mock.callCount(),
      0,
      'a verified payment is never re-read from the chain',
    );
    // Confirming a paid order again costs nothing either.
    const again = await (
      await post(f.v, {
        action: 'confirm',
        token: receipt.token,
        attemptId: attempt.id,
      })
    ).json();
    assert.equal(again.receipt.status, 'paid');
    assert.equal(scans.mock.callCount(), 0);
  } finally {
    f.restore();
  }
});

void test('an open quote is still recovered, and an expired one only inside its day of grace', async (t) => {
  const f = await fixture();
  try {
    const { attempt } = await quoted(f);
    const scans = t.mock.method(f.c, 'getSignaturesForAddress');
    const open = await server.reconcileSponsorships(f.v);
    assert.equal(open.checked, 1, 'an issued quote is checked');
    assert.equal(scans.mock.callCount(), 1);
    // Expired an hour ago and checked five minutes ago: left alone.
    const set = (fields) =>
      f.DB.sql
        .prepare(
          `UPDATE sponsor_payment_attempts SET status='expired', issued_at=?, last_checked_at=? WHERE id=?`,
        )
        .run(fields.issued_at, fields.last_checked_at, attempt.id);
    set({
      issued_at: Date.now() - 3600000,
      last_checked_at: Date.now() - 300000,
    });
    assert.equal((await server.reconcileSponsorships(f.v)).idle, true);
    // Checked eleven minutes ago: looked at once more, in case a late payment landed.
    set({
      issued_at: Date.now() - 3600000,
      last_checked_at: Date.now() - 660000,
    });
    assert.equal((await server.reconcileSponsorships(f.v)).checked, 1);
    assert.equal(scans.mock.callCount(), 2);
    // A day later: never again.
    set({ issued_at: Date.now() - 90000000, last_checked_at: 0 });
    assert.equal((await server.reconcileSponsorships(f.v)).idle, true);
    assert.equal(scans.mock.callCount(), 2);
  } finally {
    f.restore();
  }
});

void test('devnet pricing is refused on a deployment that is not on devnet', async () => {
  const f = await fixture();
  try {
    const mainnet = {
      ...f.v,
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      SPONSOR_FLAT_PRICE_CENTS: '100',
      SPONSOR_SOL_USD: '150',
    };
    const catalog = await (
      await server.handleSponsorship(
        new Request('https://show.test/api/sponsorship?action=catalog'),
        mainnet,
      )
    ).json();
    // Loud, not quiet: the catalog refuses outright rather than selling anything at
    // the test price.
    assert.equal(catalog.code, 'CONFIG');
    assert.match(catalog.error, /not on devnet/);
  } finally {
    f.restore();
  }
});
void test('a devnet deployment prices every placement flat and pins SOL', async () => {
  const f = await fixture();
  try {
    const devnet = {
      ...f.v,
      // The fixture already talks to a local validator, which is what the guard allows.
      SPONSOR_FLAT_PRICE_CENTS: '100',
      SPONSOR_SOL_USD: '150',
      // No price service at all: the pin is what makes the quote possible.
      JUPITER_API_KEY: undefined,
    };
    const drafted = await (
      await post(devnet, {
        action: 'draft',
        draft: {
          product: 'spotlight',
          projectName: 'Game',
          style: 'intro',
          name: 'Joe',
          message: 'Hello everyone',
        },
      })
    ).json();
    assert.ok(drafted.receipt, JSON.stringify(drafted));
    const receipt = drafted.receipt;
    const q = await (
      await post(devnet, {
        action: 'quote',
        token: receipt.token,
        asset: 'SOL',
        wallet: f.wallet.publicKey.toBase58(),
      })
    ).json();
    assert.ok(q.attempt, JSON.stringify(q));
    assert.equal(
      q.attempt.priceCents,
      100,
      'a $25 spotlight costs a dollar on devnet',
    );
    assert.equal(q.attempt.amountBase, '6666667', 'a dollar of SOL at $150');
  } finally {
    f.restore();
  }
});
void test('the catalog keeps caps on sale while caps are queued and counts what a buyer waits behind', async () => {
  const f = await fixture();
  try {
    await db.heartbeat(
      f.DB,
      'studio',
      { message: true, spotlight: true, cap: true },
      Date.now(),
    );
    const cap = (id, target) => orders.capOrder(db, f.DB, id, target);
    const paid = (id, target, at) => orders.paidCap(db, f.DB, id, target, at);
    await paid('cap1', 'host', 300);
    await paid('cap2', 'host', 310);
    // A guest quote nobody has paid: the buyer never sees it, so it is not in the line.
    await cap('cap3', 'guest');
    const catalog = await (
      await server.handleSponsorship(
        new Request('https://show.test/api/sponsorship?action=catalog'),
        f.v,
      )
    ).json();
    assert.deepEqual(catalog.capQueue, { host: 2, guest: 0 });
    assert.equal(
      catalog.capInventory,
      undefined,
      'nothing is reserved any more',
    );
    const product = catalog.products.find((p) => p.id === 'cap');
    assert.equal(product.available, true, JSON.stringify(product));
    assert.equal(product.reason, null);
    const site = { origin: 'https://show.test', cluster: 'devnet' };
    const first = await server.sponsorReceipt(
      f.DB,
      await db.getOrder(f.DB, 'cap1'),
      't1',
      site,
    );
    const second = await server.sponsorReceipt(
      f.DB,
      await db.getOrder(f.DB, 'cap2'),
      't2',
      site,
    );
    assert.equal(first.capAhead, 0);
    assert.equal(
      second.capAhead,
      1,
      'the second cap on a host is told it waits for the first',
    );
    assert.equal(
      second.queuePosition,
      2,
      'the overall queue position is unchanged',
    );
  } finally {
    f.restore();
  }
});
void test('the five-dollar message is off sale: no new pass, no new charge, and paid ones still air', async () => {
  const f = await fixture();
  try {
    const catalog = await (
      await server.handleSponsorship(
        new Request('https://show.test/api/sponsorship?action=catalog'),
        f.v,
      )
    ).json();
    assert.deepEqual(
      catalog.products.map((p) => p.id),
      ['spotlight', 'cap'],
    );
    const message = { product: 'message', name: 'Joe', message: 'Hello' };
    const refused = await post(f.v, { action: 'draft', draft: message });
    assert.equal(refused.status, 400);
    // A pass saved before the message came off sale is never charged again.
    const token = 'a'.repeat(64);
    await db.createOrder(f.DB, {
      id: 'saved',
      tokenHash: await server.hashSponsorToken(token),
      draft: message,
      now: 100,
    });
    const quote = await post(f.v, { action: 'quote', token, asset: 'SOL' });
    assert.equal(quote.status, 409);
    assert.match((await quote.json()).error, /no longer offered/);
    // One already paid for still goes to the studio: every placement is final once paid.
    await db.createOrder(f.DB, {
      id: 'paid',
      tokenHash: 'paid',
      draft: message,
      now: 100,
    });
    await db.insertAttempt(f.DB, {
      id: 'paid-a',
      order_id: 'paid',
      pay_token: 'paid',
      asset: 'SOL',
      mint: null,
      decimals: 9,
      amount_base: '50000000',
      price_usd: '100',
      price_cents: 500,
      recipient: f.v.TREASURY_WALLET,
      reference: 'paid',
      issued_at: 100,
      expires_at: 200,
    });
    await db.settlePayment(
      f.DB,
      'paid-a',
      { signature: 'sig-paid', payer: 'payer', blockTime: 150 },
      300,
    );
    const [leased] = await db.leaseOrders(f.DB, 'studio', Date.now());
    assert.equal(leased?.id, 'paid');
  } finally {
    f.restore();
  }
});

// ---- looks. One sponsor_assets row per (logo, character); the order gate and the air gate.
const ASSET = 'a'.repeat(64);
const LOOK_SHA = 'b'.repeat(64);
const logoUrl = `https://show.test/api/sponsorship/assets/${ASSET}?part=logo`;
const lookUrl = `https://show.test/api/sponsorship/assets/${ASSET}?part=look&v=${LOOK_SHA}`;
const PALETTE = {
  clusters: [{ hex: '#112233', share: 1 }],
  primary: '#112233',
  secondary: '#112233',
  accent: '#112233',
  monochrome: false,
};
const capMeta = (extra = {}) => ({
  kind: 'cap',
  target: 'host',
  templateVersion: 'looks-v1',
  logoSha256: 'c'.repeat(64),
  logoUrl,
  palette: PALETTE,
  ...extra,
});
const qualifiedMeta = () =>
  capMeta({
    sourceUrl: lookUrl,
    sha256: LOOK_SHA,
    look: { sha256: LOOK_SHA, model: 'm', fit: 1, round: 1, verdict: {} },
    tailor: { round: 1, requestedAt: 100, outcome: 'look', at: 200 },
  });
function insertAsset(f, status, meta, id = ASSET) {
  f.DB.sql
    .prepare(
      'INSERT OR REPLACE INTO sponsor_assets(id,status,url,mime,created_at,metadata) VALUES(?,?,?,?,?,?)',
    )
    .run(
      id,
      status,
      status === 'qualified' ? lookUrl : logoUrl,
      'image/png',
      100,
      JSON.stringify(meta),
    );
}
const CAP_DRAFT = {
  product: 'cap',
  target: 'host',
  name: 'Joe',
  projectName: 'Canvas',
  message: 'Builders ship',
  assetId: ASSET,
};
const CAPS = {
  message: true,
  spotlight: true,
  cap: true,
  capTemplateVersion: 'looks-v1',
};

void test('the order gate takes a logo that is tailoring or done, and refuses one the tailor gave up on', async () => {
  const f = await fixture();
  try {
    await db.heartbeat(f.DB, 'studio', CAPS, Date.now());
    insertAsset(f, 'logo', capMeta());
    const tailoring = await post(f.v, { action: 'draft', draft: CAP_DRAFT });
    assert.equal(tailoring.status, 200, JSON.stringify(await tailoring.clone().json()));
    insertAsset(f, 'qualified', qualifiedMeta());
    assert.equal((await post(f.v, { action: 'draft', draft: CAP_DRAFT })).status, 200);
    insertAsset(f, 'refused', capMeta({ reason: 'Too thin to print.' }));
    const refused = await post(f.v, { action: 'draft', draft: CAP_DRAFT });
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.code, 'ASSET');
    assert.match(body.error, /Too thin to print/);
    assert.match(body.error, /Use a different logo/);
    // The wrong host, or a logo from an older wardrobe, is not this order's.
    insertAsset(f, 'logo', capMeta({ target: 'guest' }));
    assert.equal((await post(f.v, { action: 'draft', draft: CAP_DRAFT })).status, 409);
    insertAsset(f, 'logo', capMeta({ templateVersion: 'caps-v1' }));
    assert.equal((await post(f.v, { action: 'draft', draft: CAP_DRAFT })).status, 409);
    // A studio still heartbeating the old wardrobe cannot be quoted a cap; the new one can.
    insertAsset(f, 'logo', capMeta());
    const { receipt } = await (
      await post(f.v, { action: 'draft', draft: CAP_DRAFT })
    ).json();
    await db.heartbeat(f.DB, 'studio', { ...CAPS, capTemplateVersion: 'caps-v1' }, Date.now());
    const old = await post(f.v, { action: 'quote', token: receipt.token, asset: 'SOL' });
    assert.equal(old.status, 409);
    assert.equal((await old.json()).code, 'ASSET');
    await db.heartbeat(f.DB, 'studio', CAPS, Date.now());
    const quoted = await post(f.v, { action: 'quote', token: receipt.token, asset: 'SOL' });
    assert.equal(quoted.status, 200, JSON.stringify(await quoted.clone().json()));
  } finally {
    f.restore();
  }
});

/** A paid cap order leased to the heartbeating studio by hand, whatever its asset says; then the studio asks for its context. */
async function leasedCapContext(f, status, meta) {
  const now = Date.now();
  await db.heartbeat(f.DB, 'studio', CAPS, now);
  insertAsset(f, status, meta);
  await db.createOrder(f.DB, { id: 'cap-order', tokenHash: 'cap-order', draft: CAP_DRAFT, now });
  f.DB.sql
    .prepare(
      "UPDATE sponsor_orders SET status='leased',paid_attempt_id='paid',paid_at=?,lease_owner='studio',lease_token='lease',lease_until=? WHERE id='cap-order'",
    )
    .run(now, now + 45000);
  return post(
    f.v,
    { action: 'context', orderId: 'cap-order', leaseToken: 'lease' },
    { 'x-studio-id': 'studio', 'x-studio-token': f.v.STUDIO_TOKEN },
  );
}
// Moved from tests/sponsor-render.test.mjs, where a take was refused 409 ASSET when the design
// was not what the lease promised. The air gate makes the same refusal before any clip is made.
void test('the air gate refuses a cap whose look is not in place, even when the order is leased by hand', async (t) => {
  const without = (key) => {
    const m = qualifiedMeta();
    delete m[key];
    return m;
  };
  for (const [name, status, meta] of [
    ['still tailoring', 'logo', capMeta({ tailor: { round: 1, requestedAt: 100 } })],
    ['refused by the tailor', 'refused', capMeta({ reason: 'Too thin.' })],
    ['qualified without a wardrobe version', 'qualified', without('templateVersion')],
    ['qualified but the look and the source disagree', 'qualified', { ...qualifiedMeta(), sha256: 'f'.repeat(64) }],
    ['qualified without a source image', 'qualified', without('sourceUrl')],
  ]) {
    await t.test(name, async () => {
      const f = await fixture();
      try {
        const r = await leasedCapContext(f, status, meta);
        assert.equal(r.status, 409);
        assert.equal((await r.json()).code, 'ASSET');
      } finally {
        f.restore();
      }
    });
  }
  await t.test('a finished look is handed to the studio with what the route pins', async () => {
    const f = await fixture();
    try {
      const r = await leasedCapContext(f, 'qualified', qualifiedMeta());
      assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
      const { order } = await r.json();
      assert.equal(order.assetUrl, lookUrl);
      assert.equal(order.assetMetadata.sourceUrl, lookUrl);
      assert.equal(order.assetMetadata.sha256, LOOK_SHA);
      assert.equal(order.assetMetadata.templateVersion, 'looks-v1');
    } finally {
      f.restore();
    }
  });
});

void test('a cap receipt says where its look stands', async () => {
  const f = await fixture();
  try {
    const site = { origin: 'https://show.test', cluster: 'devnet' };
    await db.createOrder(f.DB, { id: 'cap-look', tokenHash: 'cap-look', draft: CAP_DRAFT, now: 100 });
    const receipt = async () =>
      server.sponsorReceipt(f.DB, await db.getOrder(f.DB, 'cap-look'), 't', site);
    insertAsset(f, 'logo', capMeta({ tailor: { round: 2, requestedAt: 100 } }));
    let r = await receipt();
    assert.deepEqual(r.look, { status: 'tailoring', round: 2 });
    assert.equal(r.assetUrl, logoUrl, 'the swatch until the look lands');
    insertAsset(f, 'logo', capMeta());
    assert.deepEqual((await receipt()).look, { status: 'tailoring' }, 'paid, not yet requested');
    const fallback = qualifiedMeta();
    fallback.look.fallback = 'cap-v1';
    insertAsset(f, 'qualified', fallback);
    r = await receipt();
    assert.deepEqual(r.look, { status: 'ready', url: lookUrl, round: 1, fallback: 'cap-v1' });
    assert.equal(r.assetUrl, lookUrl);
    insertAsset(f, 'qualified', qualifiedMeta());
    assert.deepEqual((await receipt()).look, { status: 'ready', url: lookUrl, round: 1 });
    insertAsset(
      f,
      'refused',
      capMeta({
        reason: 'Too thin.',
        tailor: { round: 3, requestedAt: 100, outcome: 'refused', at: 200, reasons: ['Too thin.'] },
      }),
    );
    assert.deepEqual((await receipt()).look, { status: 'refused', reason: 'Too thin.', round: 3 });
    // A paid cap carries the clock the panel's waiting copy reads: the payment, or the later
    // swap for a different logo (replaceLogo moves updated_at), whichever is later.
    await f.DB.prepare("UPDATE sponsor_orders SET status='paid',paid_at=?,updated_at=? WHERE id=?")
      .bind(500, 700, 'cap-look')
      .run();
    insertAsset(f, 'logo', capMeta());
    assert.deepEqual((await receipt()).look, { status: 'tailoring', since: 700 });
    // A spotlight has no look.
    const { receipt: spotlight } = await (
      await post(f.v, {
        action: 'draft',
        draft: { product: 'spotlight', projectName: 'Game', style: 'intro', name: 'Joe', message: 'Hello everyone' },
      })
    ).json();
    assert.equal(spotlight.look, undefined);
  } finally {
    f.restore();
  }
});

// ---- paying starts the tailor.
/** Pay a quote on the fixture's fake chain the way a wallet does, then confirm it: the real settle path. */
async function payOnChain(f, v, receipt, q) {
  const tx = Transaction.from(Buffer.from(q.transaction, 'base64'));
  tx.partialSign(f.wallet);
  const { getBase58Decoder } = await import('@solana/kit');
  const sig = getBase58Decoder().decode(tx.signature),
    msg = tx.compileMessage();
  const keys = msg.accountKeys.map((pubkey, i) => ({
      pubkey: pubkey.toBase58(),
      signer: i < msg.header.numRequiredSignatures,
    })),
    index = keys.findIndex((k) => k.pubkey === f.v.TREASURY_WALLET),
    lamports = Number(q.attempt.amountBase),
    pre = keys.map(() => 0),
    after = keys.map(() => 0);
  pre[0] = 3000000000;
  after[0] = pre[0] - lamports - 5000;
  after[index] = lamports;
  f.c.getParsedTransaction = async () => ({
    blockTime: Math.floor(Date.now() / 1000),
    meta: { err: null, preBalances: pre, postBalances: after },
    transaction: {
      signatures: tx.signatures.map((s) => getBase58Decoder().decode(s.signature)),
      message: {
        accountKeys: keys,
        instructions: [
          {
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: {
                source: f.wallet.publicKey.toBase58(),
                destination: f.v.TREASURY_WALLET,
                lamports,
              },
            },
          },
        ],
      },
    },
  });
  return (
    await post(v, { action: 'confirm', token: receipt.token, attemptId: q.attempt.id, signature: sig })
  ).json();
}
/** The fixture with a wardrobe desk: /tailor answers are scripted, everything else is the price oracle. */
function withDesk(f, answer = () => Response.json({ key: 'k', queued: true }, { status: 202 })) {
  const tailors = [];
  const oracle = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
    if (target.endsWith('/tailor')) {
      tailors.push({ url: target, init, body: JSON.parse(init.body) });
      return answer();
    }
    return oracle(url, init);
  };
  return {
    tailors,
    v: {
      ...f.v,
      SPONSOR_MEDIA_URL: 'https://media.test',
      SPONSOR_MEDIA_TOKEN: 'm'.repeat(32),
      SITE_URL: 'https://show.test',
    },
  };
}
/** Draft a cap on the asset, quote it for the fixture wallet, pay it: the paid receipt. */
async function buyCap(f, v) {
  await db.heartbeat(f.DB, 'studio', CAPS, Date.now());
  const { receipt } = await (await post(v, { action: 'draft', draft: CAP_DRAFT })).json();
  const q = await (
    await post(v, { action: 'quote', token: receipt.token, asset: 'SOL', wallet: f.wallet.publicKey.toBase58() })
  ).json();
  assert.ok(q.attempt, JSON.stringify(q));
  const paid = await payOnChain(f, v, receipt, q);
  assert.equal(paid.receipt.status, 'paid', JSON.stringify(paid));
  return { receipt, q, paid };
}
const assetMeta = (f) =>
  JSON.parse(f.DB.sql.prepare('SELECT metadata FROM sponsor_assets WHERE id=?').get(ASSET).metadata);

void test('the first proof that pays a cap asks the desk for its look exactly once', async () => {
  const f = await fixture();
  try {
    const desk = withDesk(f);
    insertAsset(f, 'logo', capMeta());
    const { receipt, q, paid } = await buyCap(f, desk.v);
    assert.equal(desk.tailors.length, 1);
    assert.equal(desk.tailors[0].url, 'https://media.test/tailor');
    assert.equal(desk.tailors[0].init.headers.authorization, `Bearer ${'m'.repeat(32)}`);
    assert.deepEqual(desk.tailors[0].body, {
      assetId: ASSET,
      round: 1,
      target: 'host',
      logoUrl,
      logoSha256: 'c'.repeat(64),
      palette: PALETTE,
      projectName: 'Canvas',
    });
    const meta = assetMeta(f);
    assert.equal(meta.tailor.round, 1);
    assert.equal(typeof meta.tailor.requestedAt, 'number');
    // The look carries the clock the panel reads (the payment, moved by a logo swap).
    assert.ok(typeof paid.receipt.look.since === 'number' && paid.receipt.look.since > 0, 'since');
    assert.deepEqual(paid.receipt.look, { status: 'tailoring', round: 1, since: paid.receipt.look.since });
    // Confirming again, and a late second transfer, ask for nothing.
    await post(desk.v, { action: 'confirm', token: receipt.token, attemptId: q.attempt.id });
    await db.settlePayment(f.DB, q.attempt.id, { signature: 'late', payer: 'payer', blockTime: 150 }, Date.now());
    await post(desk.v, { action: 'confirm', token: receipt.token });
    assert.equal(desk.tailors.length, 1);
  } finally {
    f.restore();
  }
});

void test('a site without a desk still takes the payment, and warns', async (t) => {
  const f = await fixture();
  try {
    const warned = t.mock.method(console, 'warn', () => {});
    insertAsset(f, 'logo', capMeta());
    await buyCap(f, f.v);
    assert.ok(
      warned.mock.calls.some((c) => c.arguments[0] === '[sponsorship] tailor deferred'),
      'the deferral is logged',
    );
    assert.equal(assetMeta(f).tailor.round, 0, 'no round was spent: no desk took the job');
  } finally {
    f.restore();
  }
});

void test('a second order for a logo whose look exists asks the desk for nothing and reads ready', async () => {
  const f = await fixture();
  try {
    const desk = withDesk(f);
    insertAsset(f, 'qualified', qualifiedMeta());
    const { paid } = await buyCap(f, desk.v);
    assert.equal(desk.tailors.length, 0);
    assert.equal(paid.receipt.look.status, 'ready');
    assert.equal(paid.receipt.look.url, lookUrl);
  } finally {
    f.restore();
  }
});

// Only the desk's callback refuses a logo. An answer to the request refuses the request: a
// malformed body, a stale token, a desk that is full, unconfigured or down. None of them looked
// at the logo, so none of them may spend the buyer's round or end their order.
void test('an answer that refuses the request never refuses the logo, and spends no round', async (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  const cried = t.mock.method(console, 'error', () => {});
  for (const [name, answer, loud] of [
    [
      'the site sent a malformed request',
      () => Response.json({ code: 'LOGO_HASH', error: 'The logo does not match its hash.' }, { status: 400 }),
      true,
    ],
    ['a stale token', () => Response.json({ code: 'AUTH' }, { status: 401 }), true],
    ['a desk with no fal key', () => Response.json({ code: 'TAILOR_UNAVAILABLE' }, { status: 503 }), false],
    ['busy', () => Response.json({ code: 'BUSY', retryAfterMs: 5000 }, { status: 409 }), false],
    ['down', () => Promise.reject(new TypeError('fetch failed')), false],
  ]) {
    await t.test(name, async () => {
      const f = await fixture();
      try {
        warned.mock.resetCalls();
        cried.mock.resetCalls();
        const desk = withDesk(f, answer);
        insertAsset(f, 'logo', capMeta());
        await buyCap(f, desk.v);
        const row = f.DB.sql.prepare('SELECT status,metadata FROM sponsor_assets WHERE id=?').get(ASSET);
        assert.equal(row.status, 'logo', 'the buyer keeps their logo and their place');
        const meta = JSON.parse(row.metadata);
        assert.equal(meta.reason, undefined, 'nothing was said about the logo');
        assert.equal(meta.tailor.round, 0, 'the round is handed back');
        assert.ok(meta.tailor.requestedAt > 0, 'and the reconciler waits its four minutes');
        assert.equal(meta.tailor.outcome, undefined);
        // A 4xx is this site's own bug: it is reported as an error, not as a passing condition.
        assert.equal(
          cried.mock.calls.some((c) => c.arguments[0] === '[sponsorship] the tailor refused this request'),
          loud,
          'a 4xx must be reported as this site\'s own fault',
        );
      } finally {
        f.restore();
      }
    });
  }
});

// Three rounds the desk actually took, and no look: the logo is refused and a new one offered.
void test('only rounds the desk took are spent, so a desk that was down never refuses a logo', async (t) => {
  const f = await fixture();
  try {
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    const MIN = 60000;
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    let up = false;
    const desk = withDesk(f, () =>
      up ? Response.json({ queued: true }, { status: 202 }) : Promise.reject(new TypeError('fetch failed')),
    );
    await db.createOrder(f.DB, { id: 'down', tokenHash: 'down', draft: CAP_DRAFT, now: clock });
    f.DB.sql
      .prepare("UPDATE sponsor_orders SET status='paid',paid_attempt_id='paid',paid_at=? WHERE id='down'")
      .run(clock);
    insertAsset(f, 'logo', capMeta());
    // Twelve minutes with the desk down: three passes, no round spent, nothing refused.
    for (let i = 0; i < 3; i++) {
      clock += 4 * MIN + 1;
      await server.reconcileSponsorships(desk.v);
    }
    assert.equal(desk.tailors.length, 3, 'it kept asking');
    assert.deepEqual(desk.tailors.map((t) => t.body.round), [1, 1, 1], 'always the first round');
    let row = f.DB.sql.prepare('SELECT status,metadata FROM sponsor_assets WHERE id=?').get(ASSET);
    assert.equal(row.status, 'logo', 'a logo nobody looked at is never refused');
    // The desk comes back and takes three rounds that land nothing: now the logo is refused.
    up = true;
    for (const round of [1, 2, 3]) {
      clock += 4 * MIN + 1;
      await server.reconcileSponsorships(desk.v);
      assert.equal(desk.tailors.at(-1).body.round, round);
    }
    clock += 4 * MIN + 1;
    await server.reconcileSponsorships(desk.v);
    row = f.DB.sql.prepare('SELECT status,metadata FROM sponsor_assets WHERE id=?').get(ASSET);
    assert.equal(row.status, 'refused');
    assert.match(JSON.parse(row.metadata).reason, /couldn’t finish tailoring|couldn't finish tailoring/);
  } finally {
    f.restore();
  }
});

void test('the reconciler re-requests a stuck look with the next round, gives up after the third, and upgrades a fallback', async (t) => {
  const f = await fixture();
  try {
    t.mock.method(console, 'warn', () => {});
    const desk = withDesk(f);
    const MIN = 60000;
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    await db.createOrder(f.DB, { id: 'stuck', tokenHash: 'stuck', draft: CAP_DRAFT, now: clock });
    f.DB.sql
      .prepare("UPDATE sponsor_orders SET status='paid',paid_attempt_id='paid',paid_at=? WHERE id='stuck'")
      .run(clock);
    insertAsset(f, 'logo', capMeta({ tailor: { round: 1, requestedAt: clock } }));
    // Inside the round's four minutes: idle, and not one row written.
    const before = rowsWritten(f);
    assert.deepEqual(await server.reconcileSponsorships(desk.v), { ok: true, idle: true, checked: 0, errors: 0 });
    assert.equal(rowsWritten(f), before);
    assert.equal(desk.tailors.length, 0);
    clock += 4 * MIN + 1;
    const result = await server.reconcileSponsorships(desk.v);
    assert.equal(result.tailored, 1, JSON.stringify(result));
    assert.equal(desk.tailors.length, 1);
    assert.equal(desk.tailors[0].body.round, 2);
    assert.equal(assetMeta(f).tailor.round, 2);
    assert.equal((await server.reconcileSponsorships(desk.v)).idle, true, 'round 2 is in flight');
    clock += 4 * MIN + 1;
    await server.reconcileSponsorships(desk.v);
    assert.equal(desk.tailors.length, 2);
    assert.equal(desk.tailors[1].body.round, 3);
    clock += 4 * MIN + 1;
    await server.reconcileSponsorships(desk.v);
    assert.equal(desk.tailors.length, 2, 'no fourth round');
    const row = f.DB.sql.prepare('SELECT status,metadata FROM sponsor_assets WHERE id=?').get(ASSET);
    assert.equal(row.status, 'refused');
    assert.match(JSON.parse(row.metadata).reason, /couldn't finish tailoring/);
    clock += 60 * MIN;
    assert.equal((await server.reconcileSponsorships(desk.v)).idle, true, 'a refused logo is left alone');
    // A first-round fallback gets one upgrade after ten minutes.
    const fallback = qualifiedMeta();
    fallback.look.fallback = 'cap-v1';
    fallback.tailor = { round: 1, requestedAt: clock, outcome: 'look', at: clock };
    insertAsset(f, 'qualified', fallback);
    clock += 10 * MIN + 1;
    await server.reconcileSponsorships(desk.v);
    assert.equal(desk.tailors.length, 3);
    assert.equal(desk.tailors[2].body.round, 2);
    clock += 60 * MIN;
    assert.equal((await server.reconcileSponsorships(desk.v)).idle, true, 'one upgrade only');
  } finally {
    f.restore();
  }
});

void test('a paid buyer may swap the logo when the tailor gave up, stalled, or fell back', async (t) => {
  const f = await fixture();
  try {
    t.mock.method(console, 'warn', () => {});
    const desk = withDesk(f);
    const MIN = 60000;
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const OTHER = 'e'.repeat(64),
      THIRD = 'a'.repeat(63) + 'b';
    const metaFor = (id, extra = {}) =>
      capMeta({
        logoSha256: id.slice(0, 1).repeat(64),
        logoUrl: `https://show.test/api/sponsorship/assets/${id}?part=logo`,
        ...extra,
      });
    const token = 'f'.repeat(64);
    await db.createOrder(f.DB, {
      id: 'swap',
      tokenHash: await server.hashSponsorToken(token),
      draft: CAP_DRAFT,
      now: clock,
    });
    const swap = (assetId) => post(desk.v, { action: 'replaceLogo', token, assetId });
    const current = () =>
      JSON.parse(f.DB.sql.prepare('SELECT draft FROM sponsor_orders WHERE id=?').get('swap').draft).assetId;
    insertAsset(f, 'refused', capMeta({ reason: 'Too thin.' }));
    insertAsset(f, 'logo', metaFor(OTHER), OTHER);
    insertAsset(f, 'logo', metaFor(THIRD), THIRD);
    // 1. Not before it is paid.
    assert.equal((await swap(OTHER)).status, 409);
    f.DB.sql
      .prepare("UPDATE sponsor_orders SET status='paid',paid_attempt_id='paid',paid_at=?,updated_at=? WHERE id='swap'")
      .run(clock, clock);
    // 2. A refused logo is swapped at once; the new one starts its rounds fresh.
    const swapped = await swap(OTHER);
    assert.equal(swapped.status, 200, JSON.stringify(await swapped.clone().json()));
    const { receipt } = await swapped.json();
    assert.equal(receipt.draft.assetId, OTHER);
    // The look carries the clock the panel reads (the payment, moved by a logo swap).
    assert.ok(typeof receipt.look.since === 'number' && receipt.look.since > 0, 'since');
    assert.deepEqual(receipt.look, { status: 'tailoring', round: 1, since: receipt.look.since });
    assert.deepEqual(desk.tailors.map((c) => [c.body.assetId, c.body.round]), [[OTHER, 1]]);
    // 3. A logo that is tailoring stays put for ten minutes, then may go.
    const early = await swap(THIRD);
    assert.equal(early.status, 409);
    assert.match((await early.json()).error, /still being tailored/);
    clock += 10 * MIN + 1;
    assert.equal((await swap(THIRD)).status, 200);
    assert.equal(current(), THIRD);
    assert.equal(desk.tailors.length, 2);
    // 4. The new logo must itself be dressable for this host: the tailor's reason comes back.
    clock += 10 * MIN + 1;
    const bad = await swap(ASSET);
    assert.equal(bad.status, 409);
    assert.match((await bad.json()).error, /Too thin/);
    assert.equal(current(), THIRD);
    // 5. A fallback look may be improved on; a real look may not be swapped away.
    const fallback = { ...qualifiedMeta(), ...metaFor(THIRD) };
    fallback.look = { ...qualifiedMeta().look, fallback: 'cap-v1' };
    insertAsset(f, 'qualified', fallback, THIRD);
    assert.equal((await swap(OTHER)).status, 200, 'a fallback can be improved on');
    assert.equal(current(), OTHER);
    assert.equal(desk.tailors.length, 3);
    clock += 10 * MIN + 1;
    insertAsset(f, 'qualified', { ...qualifiedMeta(), ...metaFor(THIRD) }, THIRD);
    const ready = await swap(THIRD);
    assert.equal(ready.status, 200, 'a finished look is taken as it is');
    assert.equal((await ready.json()).receipt.look.status, 'ready');
    assert.equal(desk.tailors.length, 3, 'nothing to tailor for a finished look');
    assert.equal((await swap(OTHER)).status, 409, 'a real look is not swapped away');
    // 6. The same logo again resets its rounds instead of changing the order.
    insertAsset(
      f,
      'logo',
      metaFor(THIRD, { tailor: { round: 3, requestedAt: clock - 30 * MIN, outcome: 'deadline', at: clock - 20 * MIN } }),
      THIRD,
    );
    clock += 10 * MIN + 1;
    assert.equal((await swap(THIRD)).status, 200);
    assert.equal(current(), THIRD);
    assert.equal(desk.tailors.length, 4);
    assert.equal(desk.tailors[3].body.assetId, THIRD);
    assert.equal(desk.tailors[3].body.round, 1);
  } finally {
    f.restore();
  }
});
