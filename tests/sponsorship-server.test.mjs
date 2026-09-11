import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Keypair, Transaction } from '@solana/web3.js';
import { build } from './build.mjs';
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
        for (const s of statements) out.push(await s.all());
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
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
    signer = Keypair.generate(),
    wallet = Keypair.generate();
  const v = {
    DB,
    TREASURY_WALLET: treasury.publicKey.toBase58(),
    SPONSOR_ENABLED: 'true',
    SOLANA_RPC_URL: 'http://127.0.0.1:65534/' + crypto.randomUUID(),
    JUPITER_API_KEY: 'test',
    SPONSOR_REFUND_SECRET_KEY: JSON.stringify([...signer.secretKey]),
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
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
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
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
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
void test('refund wire is durable before broadcast and retries the same signature', async () => {
  const f = await fixture();
  try {
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
      })
    ).json();
    const q = await (
      await post(f.v, { action: 'quote', token: receipt.token, asset: 'SOL' })
    ).json();
    await db.settlePayment(
      f.DB,
      q.attempt.id,
      {
        signature: 'original',
        payer: f.wallet.publicKey.toBase58(),
        blockTime: Math.floor(Date.now() / 1000),
      },
      Date.now(),
    );
    assert.equal(
      (await post(f.v, { action: 'refund', token: receipt.token })).status,
      200,
    );
    const wires = [];
    f.c.sendRawTransaction = async (wire) => {
      const row = f.DB.sql.prepare('SELECT * FROM sponsor_refunds').get();
      assert.ok(row.signed_tx);
      wires.push(Buffer.from(wire).toString('base64'));
      throw Error('network timeout');
    };
    await server.reconcileSponsorships(f.v);
    await server.reconcileSponsorships(f.v);
    assert.equal(wires.length, 2);
    assert.equal(wires[0], wires[1]);
    f.c.getSignatureStatuses = async () => ({
      value: [{ confirmationStatus: 'finalized', err: null }],
    });
    await server.reconcileSponsorships(f.v);
    assert.equal((await db.getOrder(f.DB, receipt.id)).status, 'refunded');
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
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
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
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
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
void test('USDC remains exactly five tokens without a Jupiter service', async () => {
  const f = await fixture();
  try {
    f.v.JUPITER_API_KEY = undefined;
    globalThis.fetch = async () => {
      throw Error('oracle offline');
    };
    const owners = [
      f.v.TREASURY_WALLET,
      Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(f.v.SPONSOR_REFUND_SECRET_KEY)),
      ).publicKey.toBase58(),
    ];
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
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
      })
    ).json();
    const r = await post(f.v, {
      action: 'quote',
      token: receipt.token,
      asset: 'USDC',
    });
    const q = await r.json();
    assert.equal(r.status, 200, JSON.stringify(q));
    assert.equal(q.attempt.amountBase, '5000000');
    assert.equal(q.attempt.priceUsd, '1');
  } finally {
    f.restore();
  }
});
void test('studio context resolves immutable draft and rejects canceled leases', async () => {
  const f = await fixture();
  try {
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
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
    await db.requestRefund(f.DB, o.id, Date.now());
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
void test('refund history loss never creates a second transfer after blockhash expiry', async () => {
  const f = await fixture();
  try {
    const { receipt } = await (
      await post(f.v, {
        action: 'draft',
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
      })
    ).json();
    const q = await (
      await post(f.v, { action: 'quote', token: receipt.token, asset: 'SOL' })
    ).json();
    await db.settlePayment(
      f.DB,
      q.attempt.id,
      {
        signature: 'original',
        payer: f.wallet.publicKey.toBase58(),
        blockTime: 100,
      },
      Date.now(),
    );
    await db.requestRefund(f.DB, receipt.id, Date.now());
    const wires = [];
    f.c.sendRawTransaction = async (wire) => {
      wires.push(Buffer.from(wire).toString('base64'));
      throw Error('accepted but timed out');
    };
    await server.reconcileSponsorships(f.v);
    const first = f.DB.sql
      .prepare('SELECT signature FROM sponsor_refunds')
      .get().signature;
    f.c.getBlockHeight = async () => 1000;
    await server.reconcileSponsorships(f.v);
    const row = f.DB.sql.prepare('SELECT * FROM sponsor_refunds').get();
    assert.equal(row.signature, first);
    assert.equal(row.status, 'blocked');
    assert.equal(wires.length, 1);
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
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
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
    pre[0] = 100000000;
    after[0] = 49000000;
    after[index] = 50000000;
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
                  lamports: 50000000,
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
        draft: { product: 'message', name: 'Joe', message: 'Hello everyone' },
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
