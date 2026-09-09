import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['requests', 'interact']);
const I = await import('../work/tests/interact.js');

const WALLET = '7xK9abcdefghijkmnopqrstuvwxyzABCDEFGH123456';
const TREASURY = 'TREAsury11111111111111111111111111111111111';
const ATA = 'ATAaccount1111111111111111111111111111111111';
const MINT = 'MINTaddress111111111111111111111111111111111';
const REF = 'REFerence1111111111111111111111111111111111';
const row = (over = {}) => ({
  id: 'id-1',
  reference: REF,
  wallet: WALLET,
  name: 'Deb',
  message: 'ask chad about leg day',
  amount_ui: 166.666667,
  amount_base: '166666667',
  mint: MINT,
  recipient: TREASURY,
  price_usd: 0.03,
  status: 'paid',
  signature: null,
  created_at: 1000,
  expires_at: 61000,
  paid_at: 2000,
  claimed_at: null,
  aired_at: null,
  ...over,
});
const tx = (over = {}) => ({
  meta: {
    err: null,
    preTokenBalances: [
      { accountIndex: 3, mint: MINT, owner: TREASURY, uiTokenAmount: { amount: '1000', decimals: 6 } },
    ],
    postTokenBalances: [
      { accountIndex: 3, mint: MINT, owner: TREASURY, uiTokenAmount: { amount: '166667667', decimals: 6 } },
    ],
    loadedAddresses: { writable: [], readonly: [] },
  },
  transaction: { message: { accountKeys: [WALLET, 'SenderATA', 'ComputeBudget', ATA, MINT, REF] } },
  ...over,
});

test('the public view hides the wallet and amounts and numbers the unaired queue', () => {
  const positions = I.queuePositions([row({ reference: 'first' }), row()]);
  const view = I.publicView(row(), positions);
  assert.deepEqual(view, {
    reference: REF,
    from: 'Deb',
    wallet: '7xK9…3456',
    text: 'ask chad about leg day',
    status: 'paid',
    at: 2000,
    position: 2,
  });
  assert.equal(I.publicView(row({ name: '' })).from, 'an anonymous viewer');
  assert.equal('position' in I.publicView(row({ status: 'aired' }), positions), false, 'aired rows have no place in line');
  assert.equal(I.publicView(row({ paid_at: null })).at, 1000, 'falls back to the quote time');
  const pulled = I.pullView(row());
  assert.equal(pulled.wallet, WALLET, 'the studio gets the full wallet');
  assert.equal(pulled.amount, 166.666667);
  assert.equal(pulled.from, 'Deb');
});

test('the studio token compares in constant time and only localhost may skip it', () => {
  assert.equal(I.sameToken('secret', 'secret'), true);
  assert.equal(I.sameToken('secret', 'secreT'), false);
  assert.equal(I.sameToken('secre', 'secret'), false);
  assert.equal(I.sameToken('', ''), false, 'an empty secret never matches');
  assert.equal(I.isLocalHost('localhost'), true);
  assert.equal(I.isLocalHost('127.0.0.1'), true);
  assert.equal(I.isLocalHost('pepe-chad.example.workers.dev'), false);
});

test('prices come from Jupiter, then pump.fun, and PRICE_FIXED means tokens per dollar', () => {
  assert.equal(I.readJupiterPrice({ [MINT]: { usdPrice: 0.0312, decimals: 6 } }, MINT), 0.0312);
  assert.equal(I.readJupiterPrice({ other: { usdPrice: 1 } }, MINT), null);
  assert.equal(I.readJupiterPrice({ [MINT]: { usdPrice: 0 } }, MINT), null);
  assert.equal(I.readJupiterPrice(null, MINT), null);
  const pump = { usd_market_cap: 50000, total_supply: 1e15 };
  assert.ok(Math.abs(I.readPumpPrice(pump, 6) - 0.00005) < 1e-12);
  assert.equal(I.readPumpPrice({ usd_market_cap: 'nope' }, 6), null);
  assert.equal(I.fixedPrice('1000'), 0.001);
  assert.equal(I.fixedPrice(''), null);
  assert.equal(I.fixedPrice(undefined), null);
  assert.equal(I.usdPerRequest('0.10'), 0.1);
  assert.equal(I.usdPerRequest(undefined), 5);
  assert.equal(I.usdPerRequest('-3'), 5);
  assert.equal(I.buyUrlFor(MINT), `https://pump.fun/coin/${MINT}`);
  assert.equal(I.buyUrlFor(null), null);
});

test('Solana Pay errors become viewer-facing messages with the right status', () => {
  const treasury = I.friendlyPayError('CreateTransferError: recipient not initialized', 'FROGCLENCH');
  assert.equal(treasury.status, 409);
  assert.equal(treasury.code, 'TREASURY');
  assert.match(treasury.error, /FROGCLENCH/);
  assert.equal(I.friendlyPayError('insufficient funds', 'X').status, 400);
  assert.equal(I.friendlyPayError('sender not initialized', 'X').status, 400);
  assert.equal(I.friendlyPayError('Amount 1 with 6 decimals exceeds safe floating-point precision', 'X').code, 'PRICE');
  assert.equal(I.friendlyPayError('something else entirely', 'X'), null);
  assert.equal(I.isRequoteError('Transaction simulation failed: Blockhash not found'), true);
  assert.equal(I.isRequoteError('block height exceeded'), true);
  assert.equal(I.isRequoteError('insufficient lamports'), false);
  const err = I.fail(429, 'slow down', 'RATE');
  assert.ok(err instanceof I.HttpError);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'RATE');
});

test('the loose check accepts a transfer anywhere in the transaction and rejects the rest', () => {
  const fields = { recipient: TREASURY, recipientAta: ATA, mint: MINT, reference: REF, amountBase: '166666667' };
  assert.deepEqual(I.checkTransfer(tx(), fields), { ok: true });
  // A wallet that put our reference in a lookup table still passes.
  const viaTable = tx({ transaction: { message: { accountKeys: [WALLET, ATA] } } });
  viaTable.meta.loadedAddresses.readonly = [REF];
  assert.deepEqual(I.checkTransfer(viaTable, fields), { ok: true });
  // Older RPC nodes omit `owner`: fall back to the treasury's token account index.
  const noOwner = tx();
  noOwner.meta.preTokenBalances = noOwner.meta.preTokenBalances.map(({ owner, ...b }) => b);
  noOwner.meta.postTokenBalances = noOwner.meta.postTokenBalances.map(({ owner, ...b }) => b);
  assert.deepEqual(I.checkTransfer(noOwner, fields), { ok: true });
  // The treasury had no balance entry before: the whole post balance counts.
  const fresh = tx();
  fresh.meta.preTokenBalances = [];
  assert.deepEqual(I.checkTransfer(fresh, fields), { ok: true });

  const short = I.checkTransfer(tx(), { ...fields, amountBase: '166666668' });
  assert.equal(short.ok, false);
  assert.equal(short.final, true, 'underpayment is final');
  const failed = I.checkTransfer(tx({ meta: { ...tx().meta, err: { InstructionError: [2, 'Custom'] } } }), fields);
  assert.equal(failed.ok, false);
  assert.equal(failed.final, true);
  const other = I.checkTransfer(tx(), { ...fields, reference: 'SomeOtherReference1111111111111111111111111' });
  assert.equal(other.ok, false, 'a transaction without our reference never pays for this request');
  assert.equal(other.final, true);
  const wrongMint = I.checkTransfer(tx(), { ...fields, mint: 'OtherMint1111111111111111111111111111111111' });
  assert.equal(wrongMint.ok, false);
  const early = I.checkTransfer(tx({ meta: null }), fields);
  assert.equal(early.ok, false);
  assert.equal(early.final, false, 'no metadata yet means keep polling');
  const unreadable = I.checkTransfer(tx(), { ...fields, amountBase: 'abc' });
  assert.equal(unreadable.ok, false);
});
