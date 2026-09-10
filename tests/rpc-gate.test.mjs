import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
await build(['rpc-gate', 'rpc-upstream', 'rpc-budget', 'throttle']);
const G = await import('../work/tests/rpc-gate.js');
const U = await import('../work/tests/rpc-upstream.js');
const B = await import('../work/tests/rpc-budget.js');
const T = await import('../work/tests/throttle.js');

// ---- the broadcast gate ----------------------------------------------------------------

import { getTransferInstruction, getTransferCheckedInstruction, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner } from '@solana/kit';

const PAYER = '7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv';
const OTHER = '3yum94n8ViPw81jAbpcshHBmT7RNEwz9zayKRUbMe8ka';
const TREASURY = '2XpVWYFSvxXwixHZBsEeKuLM9zEmKRBivpQzYEtGnvfc';
const MINT = '4Sj91fesMPC4cmt4JQgiE7ogNpYVKDz8gnJJMvKwaq6j';
const REFERENCE = address(getBase58Decoder().decode(new Uint8Array(32).fill(7)));
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const [PAYER_ATA] = await findAssociatedTokenPda({ owner: address(PAYER), mint: address(MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
const [TREASURY_ATA] = await findAssociatedTokenPda({ owner: address(TREASURY), mint: address(MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
const [TREASURY_ATA_2022] = await findAssociatedTokenPda({ owner: address(TREASURY), mint: address(MINT), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
const referenceMemo = () => ({
  programAddress: address(MEMO),
  accounts: [{ address: REFERENCE, role: 0 }],
  data: new Uint8Array([1, 2, 3]),
});
/** A v0 transaction shaped like the site's own: fee payer first, the given instructions. */
function wire(instructions, payer = PAYER) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(payer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '9zcvkR4rSSK4XEqQjxvFwbJRKMdEcCHHLwmNwx5jhgpd', lastValidBlockHeight: 1n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
/** The transaction the seat actually issues: reference memo plus an SPL transfer into the treasury. */
const payment = (payer = PAYER, destination = TREASURY_ATA) =>
  wire(
    [
      referenceMemo(),
      getTransferInstruction({ source: PAYER_ATA, destination, authority: createNoopSigner(address(payer)), amount: 1n }),
    ],
    payer,
  );
const seatQuote = { kind: 'seat', reference: REFERENCE, payer: PAYER, recipient: TREASURY, mint: MINT };
const b64 = (w) => [w, { encoding: 'base64' }];

void test('the reference a quote minted is read back out of the wire transaction', () => {
  const d = G.decodeWire(b64(payment()));
  assert.ok(d, 'decodes');
  assert.equal(d.keys[0], PAYER, 'fee payer first, as the submit path already relies on');
  assert.ok(d.keys.includes(REFERENCE), 'the reference is among the static keys');
  assert.equal(d.instructions.length, 2);
  assert.equal(d.instructions[1].program, TOKEN_PROGRAM_ADDRESS);
  assert.deepEqual(G.staticKeysOf(b64(payment())), d.keys);
});

void test('base58 is the JSON-RPC default and decodes the same transaction', async () => {
  const { getBase64Encoder, getBase58Decoder: b58 } = await import('@solana/kit');
  const bytes = getBase64Encoder().encode(payment());
  const d = G.decodeWire([b58().decode(bytes)]);
  assert.ok(d && d.keys.includes(REFERENCE));
});

void test('what is not a transaction is refused before the database is asked', () => {
  assert.equal(G.decodeWire(['not base64 at all', { encoding: 'base64' }]), null);
  assert.equal(G.decodeWire([]), null);
  assert.equal(G.decodeWire([42]), null);
  assert.equal(G.decodeWire(undefined), null);
  assert.equal(G.decodeWire(['A'.repeat(4001), { encoding: 'base64' }]), null, 'a relay-sized payload');
});

void test('the treasury account is derived for both token programs without asking the network', async () => {
  const accounts = await G.treasuryAccountsFor(TREASURY, MINT);
  assert.deepEqual(accounts, [TREASURY_ATA, TREASURY_ATA_2022]);
});

void test('a real payment passes: our reference, the quoted wallet, the coin into the treasury', async () => {
  const treasury = await G.treasuryAccountsFor(TREASURY, MINT);
  assert.equal(G.paysQuote(G.decodeWire(b64(payment())), seatQuote, treasury), true);
  // TransferChecked is what a wallet that rewrites the instruction tends to emit.
  const checked = wire([
    referenceMemo(),
    getTransferCheckedInstruction({ source: PAYER_ATA, mint: address(MINT), destination: TREASURY_ATA, authority: createNoopSigner(address(PAYER)), amount: 1n, decimals: 6 }),
  ]);
  assert.equal(G.paysQuote(G.decodeWire(b64(checked)), seatQuote, treasury), true);
  // A Token-2022 mint lands in the other derived account and is just as much a payment.
  const to2022 = payment(PAYER, TREASURY_ATA_2022);
  assert.equal(G.paysQuote(G.decodeWire(b64(to2022)), seatQuote, treasury), true);
});

void test('our reference stapled onto a transaction that does not pay us is refused', async () => {
  // The attack: take a quote, keep the reference, attach it to anything, relay for free.
  const treasury = await G.treasuryAccountsFor(TREASURY, MINT);
  const stapled = wire([referenceMemo()]);
  assert.equal(G.paysQuote(G.decodeWire(b64(stapled)), seatQuote, treasury), false, 'memo only');
  const elsewhere = payment(PAYER, PAYER_ATA);
  assert.equal(G.paysQuote(G.decodeWire(b64(elsewhere)), seatQuote, treasury), false, 'a transfer to somewhere else');
  const noReference = wire([
    getTransferInstruction({ source: PAYER_ATA, destination: TREASURY_ATA, authority: createNoopSigner(address(PAYER)), amount: 1n }),
  ]);
  assert.equal(G.paysQuote(G.decodeWire(b64(noReference)), seatQuote, treasury), false, 'pays us but names no quote');
});

void test('a seat quote is bound to the wallet it was issued to; a sponsorship with no hint is not', async () => {
  const treasury = await G.treasuryAccountsFor(TREASURY, MINT);
  assert.equal(G.paysQuote(G.decodeWire(b64(payment(OTHER))), seatQuote, treasury), false, 'someone else signing');
  const sponsor = { kind: 'sponsor', reference: REFERENCE, payer: null, recipient: TREASURY, mint: MINT };
  assert.equal(G.paysQuote(G.decodeWire(b64(payment(OTHER))), sponsor, treasury), true);
  assert.equal(G.paysQuote(G.decodeWire(b64(payment(OTHER))), { ...sponsor, payer: PAYER }, treasury), false, 'once hinted, bound');
});

void test('a sponsorship paid in SOL is a system transfer to the recipient itself', () => {
  const sol = { kind: 'sponsor', reference: REFERENCE, payer: null, recipient: TREASURY, mint: null };
  const paid = wire([
    referenceMemo(),
    getTransferSolInstruction({ source: createNoopSigner(address(PAYER)), destination: address(TREASURY), amount: 1n }),
  ]);
  assert.equal(G.paysQuote(G.decodeWire(b64(paid)), sol, []), true);
  const toOther = wire([
    referenceMemo(),
    getTransferSolInstruction({ source: createNoopSigner(address(PAYER)), destination: address(OTHER), amount: 1n }),
  ]);
  assert.equal(G.paysQuote(G.decodeWire(b64(toOther)), sol, []), false);
});

/** A D1 stand-in that answers the two lookups from a table of open quotes. */
function fakeDb({ seat = [], sponsor = [], sponsorTableMissing = false } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const keys = args.slice(0, -1);
          return {
            async first() {
              if (sql.includes('sponsor_payment_attempts')) {
                if (sponsorTableMissing) throw Error('no such table: sponsor_payment_attempts');
                const hit = sponsor.find((r) => keys.includes(r.reference));
                return hit ? { reference: hit.reference, wallet_hint: hit.payer ?? null, recipient: hit.recipient, mint: hit.mint ?? null } : null;
              }
              const hit = seat.find((r) => keys.includes(r.reference));
              return hit ? { reference: hit.reference, wallet: hit.payer, recipient: hit.recipient, mint: hit.mint } : null;
            },
          };
        },
      };
    },
  };
}
const seatRow = { reference: REFERENCE, payer: PAYER, recipient: TREASURY, mint: MINT };

void test('an open quote is found by any key the transaction names, in either table', async () => {
  assert.deepEqual(await G.openQuoteFor(fakeDb({ seat: [seatRow] }), [PAYER, REFERENCE], 0), seatQuote);
  const sp = await G.openQuoteFor(fakeDb({ sponsor: [{ ...seatRow, payer: null }] }), [PAYER, REFERENCE], 0);
  assert.equal(sp.kind, 'sponsor');
  assert.equal(sp.payer, null);
  assert.equal(await G.openQuoteFor(fakeDb(), [PAYER, REFERENCE], 0), null, "a stranger's transaction");
  assert.equal(await G.openQuoteFor(fakeDb({ seat: [seatRow] }), [], 0), null, 'nothing to look up');
});

void test('a missing sponsorship table is "no sponsorship", not an outage', async () => {
  assert.equal((await G.openQuoteFor(fakeDb({ seat: [seatRow], sponsorTableMissing: true }), [REFERENCE], 0)).kind, 'seat');
  assert.equal(await G.openQuoteFor(fakeDb({ sponsorTableMissing: true }), [REFERENCE], 0), null);
});

// ---- the upstream transport --------------------------------------------------------------

const answer = (status, body = '{"jsonrpc":"2.0","id":1,"result":"ok"}') =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });
function fetchScript(...steps) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(init.body);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  f.calls = calls;
  return f;
}

void test('a provider that stumbles is asked again; one that answers is not', async () => {
  const f = fetchScript(answer(502), answer(503), answer(200));
  const r = await U.forwardJsonRpc('https://rpc.test', '{}', f);
  assert.equal(r.status, 200);
  assert.equal(r.attempts, 3);
  const once = fetchScript(answer(200));
  assert.equal((await U.forwardJsonRpc('https://rpc.test', '{}', once)).attempts, 1);
});

void test('a JSON-RPC error inside a 200 is an answer, not a failure to retry', async () => {
  const f = fetchScript(answer(200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"Blockhash not found"}}'));
  const r = await U.forwardJsonRpc('https://rpc.test', '{}', f);
  assert.equal(r.attempts, 1);
  assert.match(r.body, /Blockhash not found/);
});

void test('a network that never answers fails with the attempt count, and 429 counts as stumbling', async () => {
  const dead = fetchScript(Object.assign(Error('fetch failed'), { name: 'TypeError' }));
  await assert.rejects(U.forwardJsonRpc('https://rpc.test', '{}', dead), (e) => {
    assert.ok(e instanceof U.UpstreamError);
    assert.equal(e.attempts, U.upstreamPolicy.attempts);
    return true;
  });
  assert.equal(dead.calls.length, U.upstreamPolicy.attempts);
  const throttled = fetchScript(answer(429), answer(200));
  assert.equal((await U.forwardJsonRpc('https://rpc.test', '{}', throttled)).attempts, 2);
});

void test('withRetry repeats only what its predicate calls transient', async () => {
  let n = 0;
  const flaky = async () => {
    n++;
    if (n < 3) throw Object.assign(Error('HTTP error (503)'), { name: 'SolanaError' });
    return 'ok';
  };
  assert.equal(await U.withRetry(flaky, U.isTransportError), 'ok');
  assert.equal(n, 3);
  n = 0;
  const stale = async () => {
    n++;
    throw Error('Blockhash not found');
  };
  await assert.rejects(U.withRetry(stale, U.isTransportError), /Blockhash/);
  assert.equal(n, 1, 'a real answer from the node is not retried');
});

// ---- who the caller is -------------------------------------------------------------------

const req = (url, headers) => new Request(url, { headers });

void test('only the header Cloudflare sets names a caller in production', () => {
  assert.equal(T.clientAddress(req('https://frogclench.fun/api/rpc', { 'cf-connecting-ip': '203.0.113.9' })), '203.0.113.9');
  assert.equal(
    T.clientAddress(req('https://frogclench.fun/api/rpc', { 'x-forwarded-for': '203.0.113.9' })),
    'unknown',
    'a header the client wrote does not mint a bucket',
  );
  assert.equal(T.clientAddress(req('http://localhost:3212/api/rpc', { 'x-forwarded-for': '10.0.0.5, 1.1.1.1' })), '10.0.0.5');
  assert.equal(T.clientAddress(req('http://127.0.0.1:3212/api/rpc', {})), 'local');
});

void test('an IPv6 caller is keyed on its /64, so rotating inside it buys nothing', () => {
  const a = T.clientAddress(req('https://x/', { 'cf-connecting-ip': '2001:db8:85a3:1234:aaaa:bbbb:cccc:dddd' }));
  const b = T.clientAddress(req('https://x/', { 'cf-connecting-ip': '2001:db8:85a3:1234::1' }));
  assert.equal(a, b);
  assert.equal(a, '2001:db8:85a3:1234::/64');
  assert.notEqual(a, T.clientAddress(req('https://x/', { 'cf-connecting-ip': '2001:db8:85a3:9999::1' })));
});

void test('a binding is charged once per unit and refuses if any unit is', async () => {
  const seen = [];
  const limiter = { limit: async ({ key }) => (seen.push(key), { success: seen.length <= 3 }) };
  assert.equal(await T.charge(limiter, 'X', 'ip', 3), true);
  assert.equal(seen.length, 3);
  assert.equal(await T.charge(limiter, 'X', 'ip', 2), false, 'the fourth unit is over');
  assert.equal(await T.charge(undefined, 'X', 'ip', 5), true, 'no binding: allow, and say so once');
});

// ---- the deployment-wide and per-caller budgets ---------------------------------------

/**
 * A D1 stand-in for the ledger. `totals` maps a row id to the units the upsert reports back;
 * a row not listed reports exactly what was written. Records every batch.
 */
function ledger(totals = {}, { windowAt = 0 } = {}) {
  const writes = [];
  return {
    writes,
    prepare: (sql) => ({ bind: (...args) => ({ sql, args }) }),
    async batch(statements) {
      writes.push(statements.map((s) => (s.sql.startsWith('DELETE') ? 'sweep' : [s.args[0], s.args[1]])));
      if (totals instanceof Error) throw totals;
      return statements.map((s) =>
        s.sql.startsWith('DELETE')
          ? { results: [] }
          : { results: [{ units: totals[s.args[0]] ?? s.args[1], window_at: windowAt }] },
      );
    },
  };
}
const T0 = 1_000_000;

void test('units accumulate in the isolate and flush in batches, not per call', async () => {
  B.resetMeter();
  for (let i = 0; i < 24; i++) assert.equal(B.charge('a', 1, T0 + i), false, `call ${i} does not flush`);
  assert.equal(B.charge('a', 1, T0 + 24), true, 'the 25th does');
  const db = ledger();
  await B.flush(db, T0 + 24);
  assert.deepEqual(db.writes, [[['burst', 25], ['day', 25], ['ip:a', 25], 'sweep']], 'one batch: both deployment rows, the caller, and the first sweep');
  assert.equal(B.meterState().pending, 0);
  assert.equal(B.braked('a', T0 + 25), null);
});

void test('a crossed deployment ceiling brakes the isolate, backs off further each strike, and clears', async () => {
  B.resetMeter();
  B.charge('a', 30, T0);
  await B.flush(ledger({ burst: 5_000, day: 5_000 }), T0);
  assert.equal(B.braked('a', T0 + 59_000), 'deployment');
  assert.equal(B.braked('a', T0 + 61_000), null, 'first strike: a minute');
  B.charge('a', 30, T0 + 61_000);
  await B.flush(ledger({ burst: 5_000, day: 5_000 }), T0 + 61_000);
  assert.equal(B.braked('anyone', T0 + 61_000 + 119_000), 'deployment', 'second strike: two minutes, and it is everyone');
  B.charge('a', 1, T0 + 200_000);
  await B.flush(ledger({ burst: 1, day: 31 }), T0 + 200_000);
  assert.equal(B.meterState().strikes, 0, 'under the ceiling again, the count resets');
});

void test('a caller the ledger shows over its minute is refused until that minute rolls, and only that caller', async () => {
  B.resetMeter();
  // This isolate saw only a few calls from "spread"; the ledger, fed by every isolate, says 301.
  B.charge('spread', 3, T0);
  B.charge('honest', 2, T0);
  const db = ledger({ 'ip:spread': 301 }, { windowAt: T0 - 40_000 });
  const r = await B.flush(db, T0);
  assert.deepEqual(r.callersOver, ['spread']);
  assert.equal(B.braked('spread', T0 + 1), 'caller');
  assert.equal(B.braked('honest', T0 + 1), null, 'the other caller in the same batch is untouched');
  assert.equal(B.braked('spread', T0 + 19_000), 'caller', 'still inside the window that opened 40s ago');
  assert.equal(B.braked('spread', T0 + 21_000), null, 'the window rolled; the brake lifts on its own');
});

void test('the sweep runs with the first flush and then only every five minutes', async () => {
  B.resetMeter();
  B.charge('a', 1, T0);
  const db = ledger();
  await B.flush(db, T0);
  B.charge('a', 1, T0 + 60_000);
  await B.flush(db, T0 + 60_000);
  B.charge('a', 1, T0 + 6 * 60_000);
  await B.flush(db, T0 + 6 * 60_000);
  assert.deepEqual(db.writes.map((w) => w.includes('sweep')), [true, false, true]);
});

void test('a failed flush keeps the units, for the deployment and each caller, and never brakes', async () => {
  B.resetMeter();
  B.charge('a', 30, T0);
  B.charge('b', 10, T0);
  await B.flush(ledger(Error('D1_ERROR: too many requests')), T0);
  const st = B.meterState();
  assert.equal(st.pending, 40, 'nothing lost');
  assert.deepEqual([...st.callers], [['a', 30], ['b', 10]]);
  assert.equal(B.braked('a', T0 + 1), null, 'a ledger blip is not a self-inflicted outage');
});
