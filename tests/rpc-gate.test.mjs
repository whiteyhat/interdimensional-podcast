import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
import { d1 } from './fixtures/d1.mjs';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getTransferInstruction, getTransferCheckedInstruction, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { getTransferSolInstruction } from '@solana-program/system';
await build(['rpc-gate', 'rpc-upstream', 'rpc-budget', 'throttle', 'db', 'sponsor-db']);
const G = await import('../work/tests/rpc-gate.js');
const U = await import('../work/tests/rpc-upstream.js');
const B = await import('../work/tests/rpc-budget.js');
const T = await import('../work/tests/throttle.js');
const DB = await import('../work/tests/db.js');
const SDB = await import('../work/tests/sponsor-db.js');

// ---- the broadcast gate ----------------------------------------------------------------

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
  assert.ok(d.messageBytes.length > 0 && PAYER in d.signatures, 'what was signed and by whom, for the signature check');
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

void test('the treasury account is derived for both token programs, once, without the network', async () => {
  const accounts = await G.treasuryAccountsFor(TREASURY, MINT);
  assert.deepEqual(accounts, [TREASURY_ATA, TREASURY_ATA_2022]);
  assert.equal(await G.treasuryAccountsFor(TREASURY, MINT), accounts, 'the same derivation is handed back');
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
  assert.equal(G.paysQuote(G.decodeWire(b64(payment(PAYER, TREASURY_ATA_2022))), seatQuote, treasury), true);
});

void test('our reference stapled onto a transaction that does not pay us is refused', async () => {
  // The attack: take a quote, keep the reference, attach it to anything, relay for free.
  const treasury = await G.treasuryAccountsFor(TREASURY, MINT);
  assert.equal(G.paysQuote(G.decodeWire(b64(wire([referenceMemo()]))), seatQuote, treasury), false, 'memo only');
  assert.equal(G.paysQuote(G.decodeWire(b64(payment(PAYER, PAYER_ATA))), seatQuote, treasury), false, 'a transfer to somewhere else');
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
  const paid = wire([referenceMemo(), getTransferSolInstruction({ source: createNoopSigner(address(PAYER)), destination: address(TREASURY), amount: 1n })]);
  assert.equal(G.paysQuote(G.decodeWire(b64(paid)), sol, []), true);
  const toOther = wire([referenceMemo(), getTransferSolInstruction({ source: createNoopSigner(address(PAYER)), destination: address(OTHER), amount: 1n })]);
  assert.equal(G.paysQuote(G.decodeWire(b64(toOther)), sol, []), false);
});

/** A real database with both schemas, the way a route opens one. */
async function database({ sponsorship = true } = {}) {
  const d = d1();
  await DB.ensureSchema(d);
  if (sponsorship) await SDB.ensureSponsorSchema(d);
  return d;
}
const NOW = 1_700_000_000_000;
const seatRow = (over = {}) => ({
  id: 'q1', reference: REFERENCE, wallet: PAYER, name: 'Carlos', message: 'hi', amount_ui: 5000, amount_base: '5000000000',
  mint: MINT, recipient: TREASURY, price_usd: 0.001, created_at: NOW - 30_000, expires_at: NOW + 30_000, ...over,
});
const sponsorRow = (d, over = {}) =>
  d.sql
    .prepare(
      `INSERT INTO sponsor_orders(id,token_hash,draft,product,status,created_at,updated_at) VALUES('o1','h','{}','spotlight','payment-pending',?,?)`,
    )
    .run(NOW, NOW) &&
  d.sql
    .prepare(
      `INSERT INTO sponsor_payment_attempts(id,order_id,pay_token,asset,mint,decimals,amount_base,price_usd,price_cents,recipient,reference,issued_at,expires_at,status,wallet_hint) VALUES('a1','o1','t','coin',?,6,'1','1',100,?,?,?,?,?,?)`,
    )
    .run(over.mint ?? MINT, TREASURY, REFERENCE, NOW - 30_000, over.expires_at ?? NOW + 30_000, over.status ?? 'issued', over.wallet_hint ?? null);

void test('an open seat quote is found by any key the transaction names, with the submit grace', async () => {
  const d = await database();
  await DB.insertQuote(d, seatRow());
  assert.deepEqual(await G.openQuoteFor(d, [PAYER, REFERENCE], NOW), seatQuote);
  assert.equal(await G.openQuoteFor(d, [PAYER, OTHER], NOW), null, 'a key we never issued');
  assert.equal(await G.openQuoteFor(d, [], NOW), null, 'nothing to look up');
  // Expired four minutes ago: still inside the five-minute grace the submit action gives.
  assert.ok(await G.openQuoteFor(d, [REFERENCE], NOW + 30_000 + 4 * 60_000));
  assert.equal(await G.openQuoteFor(d, [REFERENCE], NOW + 30_000 + 6 * 60_000), null, 'past the grace');
  await DB.setStatus(d, REFERENCE, 'paid', ['quoted'], NOW);
  assert.equal(await G.openQuoteFor(d, [REFERENCE], NOW), null, 'a settled quote is no longer open');
});

void test('a sponsorship attempt is found too, carries its wallet hint, and gets no grace', async () => {
  const d = await database();
  sponsorRow(d, { wallet_hint: OTHER });
  const q = await G.openQuoteFor(d, [REFERENCE], NOW);
  assert.equal(q.kind, 'sponsor');
  assert.equal(q.payer, OTHER);
  assert.equal(q.mint, MINT);
  assert.equal(await G.openQuoteFor(d, [REFERENCE], NOW + 31_000), null, 'the sponsor server refuses past expiry, so does the gate');
});

void test('a missing sponsorship table is an outage, not "no sponsorship"', async () => {
  const d = await database({ sponsorship: false });
  await DB.insertQuote(d, seatRow());
  await assert.rejects(G.openQuoteFor(d, [REFERENCE], NOW), /no such table/);
});

// ---- the upstream transport --------------------------------------------------------------

const text = async (r) => new Response(r.body).text();
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
  assert.match(await text(r), /"result":"ok"/);
  assert.equal((await U.forwardJsonRpc('https://rpc.test', '{}', fetchScript(answer(200)))).attempts, 1);
});

void test('a JSON-RPC error inside a 200 is an answer, not a failure to retry', async () => {
  const f = fetchScript(answer(200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"Blockhash not found"}}'));
  const r = await U.forwardJsonRpc('https://rpc.test', '{}', f);
  assert.equal(r.attempts, 1);
  assert.match(await text(r), /Blockhash not found/);
});

void test('a network that never answers fails naming the attempt, and 429 counts as stumbling', async () => {
  const dead = fetchScript(Object.assign(Error('fetch failed'), { name: 'TypeError' }));
  await assert.rejects(U.forwardJsonRpc('https://rpc.test', '{}', dead), (e) => {
    assert.ok(e instanceof U.UpstreamError);
    assert.equal(e.attempts, U.upstreamPolicy.attempts);
    return true;
  });
  assert.equal(dead.calls.length, U.upstreamPolicy.attempts);
  assert.equal((await U.forwardJsonRpc('https://rpc.test', '{}', fetchScript(answer(429), answer(200)))).attempts, 2);
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

const T0 = 1_000_000;
const rows = (d) =>
  d.sql.prepare('SELECT id, units, window_at FROM rpc_budget ORDER BY id').all().map((r) => ({ ...r }));

void test('units accumulate in the isolate and flush in one batch, not per call', async () => {
  B.resetMeter();
  for (let i = 0; i < 24; i++) assert.equal(B.charge('a', 1, T0 + i), false, `call ${i} does not flush`);
  assert.equal(B.charge('a', 1, T0 + 24), true, 'the 25th does');
  const d = await database();
  await B.flush(d, T0 + 24);
  assert.deepEqual(rows(d), [
    { id: 'burst', units: 25, window_at: T0 + 24 },
    { id: 'day', units: 25, window_at: T0 + 24 },
    { id: 'ip:a', units: 25, window_at: T0 + 24 },
  ]);
  assert.equal(B.meterState().pending, 0);
  assert.equal(B.braked('a', T0 + 25), null);
});

void test('a window that has closed starts over; one still open adds up', async () => {
  B.resetMeter();
  const d = await database();
  B.charge('a', 10, T0);
  await B.flush(d, T0);
  B.charge('a', 5, T0 + 11_000);
  await B.flush(d, T0 + 11_000);
  const byId = Object.fromEntries(rows(d).map((r) => [r.id, r]));
  assert.equal(byId.burst.units, 5, 'the ten-second row rolled');
  assert.equal(byId.day.units, 15, 'the day row kept counting');
  assert.equal(byId['ip:a'].units, 15, 'the caller minute kept counting');
});

void test('a crossed deployment ceiling brakes the isolate, backs off further each strike, and clears', async () => {
  B.resetMeter();
  const d = await database();
  d.sql.prepare(`INSERT INTO rpc_budget VALUES('burst', 4990, ?)`).run(T0);
  B.charge('a', 30, T0 + 1);
  await B.flush(d, T0 + 1);
  assert.equal(B.braked('a', T0 + 59_000), 'deployment');
  assert.equal(B.braked('a', T0 + 61_000), null, 'first strike: a minute');
  d.sql.prepare(`UPDATE rpc_budget SET units=4990, window_at=? WHERE id='burst'`).run(T0 + 61_000);
  B.charge('a', 30, T0 + 61_000);
  await B.flush(d, T0 + 61_000);
  assert.equal(B.braked('anyone', T0 + 61_000 + 119_000), 'deployment', 'second strike: two minutes, and it is everyone');
  B.charge('a', 1, T0 + 200_000);
  await B.flush(d, T0 + 200_000);
  assert.equal(B.meterState().strikes, 0, 'under the ceiling again, the count resets');
});

void test('a caller the ledger shows over its minute is refused until that minute rolls, and only that caller', async () => {
  B.resetMeter();
  const d = await database();
  // Other isolates already put this caller at 298 in a window that opened 40s ago.
  d.sql.prepare(`INSERT INTO rpc_budget VALUES('ip:spread', 298, ?)`).run(T0 - 40_000);
  B.charge('spread', 3, T0);
  B.charge('honest', 2, T0);
  assert.deepEqual(await B.flush(d, T0), ['spread']);
  assert.equal(B.braked('spread', T0 + 1), 'caller');
  assert.equal(B.braked('honest', T0 + 1), null, 'the other caller in the same batch is untouched');
  assert.equal(B.braked('spread', T0 + 19_000), 'caller', 'still inside the window that opened 40s ago');
  assert.equal(B.braked('spread', T0 + 21_000), null, 'the window rolled; the brake lifts on its own');
});

void test('a quote may be broadcast ten times, then not', async () => {
  const d = await database();
  for (let i = 0; i < 10; i++) assert.equal(await B.chargeReference(d, REFERENCE, T0 + i), true, `send ${i + 1}`);
  assert.equal(await B.chargeReference(d, REFERENCE, T0 + 10), false, 'the eleventh');
  assert.equal(await B.chargeReference(d, OTHER, T0 + 10), true, 'another quote is its own count');
});

void test('the sweep drops stale caller and quote rows, keeps live ones and the deployment rows, and runs every five minutes', async () => {
  B.resetMeter();
  const d = await database();
  d.sql.prepare(`INSERT INTO rpc_budget VALUES('ip:old', 1, ?), ('send:old', 1, ?), ('ip:live', 1, ?)`).run(T0 - 10 * 60_000, T0 - 60 * 60_000, T0 - 30_000);
  B.charge('a', 1, T0);
  await B.flush(d, T0);
  assert.deepEqual(rows(d).map((r) => r.id), ['burst', 'day', 'ip:a', 'ip:live']);
  d.sql.prepare(`INSERT INTO rpc_budget VALUES('ip:old2', 1, ?)`).run(T0 - 10 * 60_000);
  B.charge('a', 1, T0 + 60_000);
  await B.flush(d, T0 + 60_000);
  assert.ok(rows(d).some((r) => r.id === 'ip:old2'), 'a minute later the sweep is not due');
  B.charge('a', 1, T0 + 6 * 60_000);
  await B.flush(d, T0 + 6 * 60_000);
  assert.ok(!rows(d).some((r) => r.id === 'ip:old2'), 'five minutes on, it is');
});

void test('a failed flush keeps the units, for the deployment and each caller, and never brakes', async () => {
  B.resetMeter();
  B.charge('a', 30, T0);
  B.charge('b', 10, T0);
  const broken = { ...(await database()), batch: async () => { throw Error('D1_ERROR: too many requests'); } };
  await B.flush(broken, T0);
  const st = B.meterState();
  assert.equal(st.pending, 40, 'nothing lost');
  assert.deepEqual([...st.callers], [['a', 30], ['b', 10]]);
  assert.equal(B.braked('a', T0 + 1), null, 'a ledger blip is not a self-inflicted outage');
});
