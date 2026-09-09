import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['requests']);
const R = await import('../work/tests/requests.js');

const req = (text, over = {}) => ({
  id: `id-${text}`,
  reference: `ref-${text}`,
  from: 'deb',
  wallet: '7xK9abcdefghijkmnopqrstuvwxyzABCDEFGH123456',
  text,
  amount: 1,
  status: 'queued',
  at: 0,
  ...over,
});

test('a five dollar quote rounds up to the mint decimals and never exceeds 15 digits', () => {
  assert.equal(R.quoteAmount(0.03, 5, 6), 166.666667);
  assert.equal(R.quoteAmount(2, 5, 6), 2.5);
  const tiny = R.quoteAmount(1e-9, 5, 6);
  assert.ok(tiny >= 5e9, 'never underpays');
  assert.ok(String(tiny).replace('.', '').replace(/^0+/, '').length <= 15, 'fits Solana Pay');
  assert.throws(() => R.quoteAmount(0, 5, 6));
  assert.throws(() => R.quoteAmount(1, 0, 6));
  assert.equal(R.toBaseUnits(166.666667, 6), '166666667');
  assert.equal(R.toBaseUnits(2.5, 6), '2500000');
});

test('messages are checked once, the same way, on the card and on the server', () => {
  assert.deepEqual(R.checkMessage('  why is   chad never selling  '), { ok: true, text: 'why is chad never selling' });
  assert.equal(R.checkMessage('gm').ok, false);
  assert.equal(R.checkMessage('x'.repeat(241)).ok, false);
  assert.equal(R.checkMessage('go to https://example.com now').ok, false);
  assert.equal(R.checkMessage('send it to 7xK9abcdefghijkmnopqrstuvwxyzABCDEFGH123456 please').ok, false);
  assert.equal(R.checkMessage('buy 0x1234567890abcdef1234567890abcdef12345678').ok, false);
  assert.equal(R.checkMessage('line one\nline two').ok, true, 'newlines collapse to spaces');
  assert.equal(R.checkMessage(42).ok, false);
});

test('names are short, plain and optional', () => {
  assert.deepEqual(R.checkName(''), { ok: true, text: '' });
  assert.deepEqual(R.checkName(undefined), { ok: true, text: '' });
  assert.deepEqual(R.checkName('  Deb from the chat  '), { ok: true, text: 'Deb from the chat' });
  assert.equal(R.checkName('<script>').ok, false);
  assert.equal(R.checkName('a'.repeat(40)).text.length, 20);
  assert.equal(R.spokenName(''), R.requestConfig.anonymous);
  assert.equal(R.spokenName('Deb'), 'Deb');
  assert.equal(R.shortWallet('7xK9abcdefghijkmnopqrstuvwxyzABCDEFGH123456'), '7xK9…3456');
});

test('incoming requests append in order and never repeat a reference', () => {
  let list = R.mergeIncoming([], [req('first'), req('second')]);
  assert.deepEqual(list.map((r) => r.text), ['first', 'second']);
  const again = R.mergeIncoming(list, [req('first', { text: 'first again' })]);
  assert.equal(again, list, 'a known reference is ignored');
  list = R.markRequest(list, 'id-first', 'buffered', 8);
  assert.equal(R.nextQueued(list).text, 'second');
  assert.equal(list[0].shot, 8);
  const many = Array.from({ length: 40 }, (_, i) => req(`m${i}`, { status: i < 35 ? 'aired' : 'queued' }));
  const trimmed = R.trimRequests(many);
  assert.equal(trimmed.length, R.requestConfig.limits.keep);
  assert.ok(trimmed.filter((r) => r.status === 'queued').length === 5, 'pending requests are never trimmed');
});

test('rows from the site are read defensively', () => {
  assert.equal(R.readRequest(null), null);
  assert.equal(R.readRequest({ reference: 'r', text: 'hi' }), null, 'too short');
  const row = R.readRequest({ reference: 'r1', text: 'ask chad about his gym', from: '', amount: '12.5', at: '7' });
  assert.equal(row.from, R.requestConfig.anonymous);
  assert.equal(row.amount, 12.5);
  assert.equal(row.at, 7);
  assert.equal(row.status, 'queued');
  assert.equal(row.id, 'r1');
});
