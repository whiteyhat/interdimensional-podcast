import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['house', 'show']);
const H = await import('../work/tests/house.js');
const brand = { name: 'FROGCLENCH', ticker: 'FROGCLENCH', usd: 0 };
const line = (speaker, text) => ({ id: 0, speaker, text });

// The show plugs itself on a clock, and never offers what the site is not selling.
void test('the sale comes from the catalog and fails closed', () => {
  assert.deepEqual(H.saleFromCatalog({ products: [{ id: 'spotlight', available: false }, { id: 'cap', available: false }] }), H.noSale);
  assert.deepEqual(H.saleFromCatalog({ products: [{ id: 'spotlight', available: true }, { id: 'cap', available: false }] }), { message: false, spotlight: true, cap: false });
  for (const raw of [null, {}, { products: 'x' }, { products: [{ id: 'cap', available: 'yes' }] }]) assert.deepEqual(H.saleFromCatalog(raw), H.noSale);
});
void test('the house paragraph says the two place names once and nothing for sale when nothing is', () => {
  const closed = H.houseRequest(brand, 'frogclench.fun', H.noSale, true);
  assert.match(closed, /HOUSE MESSAGE/);
  assert.match(closed, /pump dot fun/);
  assert.match(closed, /frogclench dot fun/);
  assert.match(closed, /nothing is on sale right now/);
  assert.doesNotMatch(closed, /sponsor the podcast/);
  const open = H.houseRequest(brand, 'frogclench.fun', { message: false, spotlight: true, cap: true }, true);
  assert.match(open, /put their own project on the show/);
  assert.match(open, /sponsor the podcast/);
  assert.doesNotMatch(open, /message read on air/);
  const noCoin = H.houseRequest(brand, 'frogclench.fun', H.noSale, false);
  assert.doesNotMatch(noCoin, /pump dot fun/);
  assert.match(noCoin, /frogclench dot fun/);
  assert.equal(H.spokenHost('www.frogclench.fun'), 'frogclench dot fun');
});
void test('the deterministic check accepts a proper plug and names what is missing or forbidden', () => {
  const good = [
    line('host', 'Anyway, my bags: frogclench is live on pump dot fun, not financial advice, financial advice needs finances.'),
    line('guest', 'The show lives at frogclench dot fun. That is where discipline is broadcast.'),
    line('host', 'Discipline is a word for people with a plan.'),
    line('guest', 'And a plan is a word for people with assets.'),
  ];
  assert.deepEqual(H.houseSaid(good, brand, 'frogclench.fun', H.noSale, true), []);
  assert.deepEqual(H.houseSaid([good[0], line('guest', 'The show lives at frogclench.fun.'), good[2], good[3]], brand, 'frogclench.fun', H.noSale, true), [], 'a transcript spelling of the site passes');
  const missingSite = H.houseSaid([good[0], good[2], good[3], line('guest', 'Assets.')], brand, 'frogclench.fun', H.noSale, true);
  assert.ok(missingSite.some((p) => /site/.test(p)), missingSite.join('; '));
  const twice = H.houseSaid([good[0], good[1], line('host', 'pump dot fun again'), good[3]], brand, 'frogclench.fun', H.noSale, true);
  assert.ok(twice.some((p) => /pump dot fun 2 times/.test(p)), twice.join('; '));
  const selling = H.houseSaid([good[0], line('guest', 'The show lives at frogclench dot fun, sponsor the podcast today.'), good[2], good[3]], brand, 'frogclench.fun', H.noSale, true);
  assert.ok(selling.some((p) => /not on sale/.test(p)), selling.join('; '));
  const noCoin = H.houseSaid(good, brand, 'frogclench.fun', H.noSale, false);
  assert.ok(noCoin.some((p) => /no coin live/.test(p)), noCoin.join('; '));
});
void test('the lower-third house slot is up twelve seconds in every ninety', () => {
  assert.equal(H.houseTickerUp(0), true);
  assert.equal(H.houseTickerUp(11_999), true);
  assert.equal(H.houseTickerUp(12_000), false);
  assert.equal(H.houseTickerUp(89_999), false);
  assert.equal(H.houseTickerUp(90_000), true);
});
