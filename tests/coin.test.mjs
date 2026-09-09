import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from './build.mjs';
await build(['topics', 'coin']);
const C = await import('../work/tests/coin.js');
const T = await import('../work/tests/topics.js');
const raw = JSON.parse(await readFile('tests/fixtures/pump-coin.json', 'utf8'));
const SOL = 104.67;
const NOW = 1788886400000;
const MINT = raw.mint;
const candles = (closes, step) =>
  closes.map((c, i) => ({
    timestamp: NOW - (closes.length - i) * step,
    open: String(c * 0.99),
    high: String(c * 1.01),
    low: String(c * 0.98),
    close: String(c),
    volume: '100',
  }));
const flat = (n, price) => Array.from({ length: n }, () => price);
const snap = (over = {}, five = flat(60, 6.5e-6), hours = flat(25, 6.5e-6)) => ({
  ...C.normalizeCoin(raw, SOL, candles(five, 300000), candles(hours, 3600000), NOW, MINT),
  ...over,
});

test('a bonding-curve coin is priced from its reserves and its progress from the curve', () => {
  const coin = snap();
  assert.ok(Math.abs(coin.priceUsd - 6.587e-6) < 2e-8, `price ${coin.priceUsd}`);
  assert.equal(coin.mcapUsd, 6587.4);
  assert.equal(coin.progress, 35.9);
  assert.equal(coin.graduated, false);
  assert.equal(coin.symbol, 'FROGCLENCH');
  assert.equal(coin.live, true);
  assert.equal(coin.candles.length, 60);
  assert.equal(coin.volume24h, 2400);
  assert.equal(coin.change5m, 0);
});

test('a graduated coin reports 100 percent and prices from market cap', () => {
  const coin = C.normalizeCoin({ ...raw, complete: true, real_token_reserves: 0, usd_market_cap: 250000 }, SOL, [], [], NOW, MINT);
  assert.equal(coin.progress, 100);
  assert.equal(coin.graduated, true);
  assert.ok(Math.abs(coin.priceUsd - 0.00025) < 1e-9);
  assert.equal(coin.change5m, null, 'no candles, no claim');
});

test('moves are measured against the candles', () => {
  const five = [...flat(59, 5e-6), 5.6e-6];
  const coin = snap({}, five, [...flat(24, 5e-6), 5.6e-6]);
  assert.ok(Math.abs(coin.change5m - 12) < 0.01);
  assert.ok(Math.abs(coin.change1h - 12) < 0.01);
  assert.ok(Math.abs(coin.change24h - 12) < 0.01);
});

test('the first look learns the baseline and celebrates nothing', () => {
  const { events, memory } = C.pumpEvents({ next: snap(), memory: C.createCoinMemory(), now: NOW });
  assert.equal(events.length, 0);
  assert.equal(memory.seen, true);
  assert.equal(memory.athUsd, 9000);
  assert.equal(memory.lastMilestone, 25);
});

test('a big five minute move is a celebration or a funeral, then goes quiet for a while', () => {
  const base = snap();
  const seen = C.pumpEvents({ next: base, memory: C.createCoinMemory(), now: NOW }).memory;
  const up = C.pumpEvents({ prev: base, next: snap({ change5m: 12 }), memory: seen, now: NOW + 60000 });
  assert.equal(up.events[0].kind, 'move5m');
  assert.equal(up.events[0].mood, 'celebrate');
  assert.match(up.events[0].title, /frogclench is up 12 percent in five minutes/);
  assert.match(up.events[0].brief, /6\.6 thousand dollars/);
  assert.ok(!/\$/.test(up.events[0].brief + up.events[0].title), 'nothing to read as a symbol');
  assert.ok(!/[1-9A-HJ-NP-Za-km-z]{32,}/.test(up.events[0].brief), 'no addresses');
  const repeat = C.pumpEvents({ prev: base, next: snap({ change5m: 13 }), memory: up.memory, now: NOW + 120000 });
  assert.equal(repeat.events.length, 0, 'the same move is not celebrated twice');
  const down = C.pumpEvents({ prev: base, next: snap({ change5m: -15 }), memory: seen, now: NOW + 60000 });
  assert.equal(down.events[0].mood, 'mourn');
  assert.match(down.events[0].title, /down 15 percent/);
  const small = C.pumpEvents({ prev: base, next: snap({ change5m: 3 }), memory: seen, now: NOW + 60000 });
  assert.equal(small.events.length, 0, 'noise stays silent');
});

test('all-time highs, milestones and graduation are each celebrated once', () => {
  const base = snap();
  const seen = C.pumpEvents({ next: base, memory: C.createCoinMemory(), now: NOW }).memory;
  const ath = C.pumpEvents({ prev: base, next: snap({ mcapUsd: 12000 }), memory: seen, now: NOW + 1000 });
  assert.equal(ath.events[0].kind, 'ath');
  assert.equal(ath.memory.athUsd, 12000);
  const again = C.pumpEvents({ prev: base, next: snap({ mcapUsd: 12100 }), memory: ath.memory, now: NOW + 2000 });
  assert.ok(!again.events.some((e) => e.kind === 'ath'), 'a hair above the last high is not news');
  const half = C.pumpEvents({ prev: base, next: snap({ progress: 52 }), memory: seen, now: NOW + 1000 });
  assert.equal(half.events[0].kind, 'milestone');
  assert.match(half.events[0].title, /50 percent of the way/);
  assert.equal(half.memory.lastMilestone, 50);
  const grad = C.pumpEvents({ prev: base, next: snap({ graduated: true, progress: 100 }), memory: seen, now: NOW + 1000 });
  assert.equal(grad.events[0].kind, 'graduated');
  assert.equal(grad.events[0].score, 95);
  const crowd = C.pumpEvents({ prev: base, next: snap({ viewers: 120 }), memory: seen, now: NOW + 1000 });
  assert.equal(crowd.events[0].kind, 'viewers');
  assert.match(crowd.events[0].title, /120 people are watching/);
});

test('a flat chart becomes a deadpan check-in every ten minutes at most', () => {
  const base = snap();
  const seen = C.pumpEvents({ next: base, memory: C.createCoinMemory(), now: NOW }).memory;
  const soon = C.pumpEvents({ prev: base, next: base, memory: seen, now: NOW + 5 * 60000 });
  assert.equal(soon.events.length, 0);
  const quiet = C.pumpEvents({ prev: base, next: base, memory: seen, now: NOW + 10 * 60000 });
  assert.equal(quiet.events[0].kind, 'quiet');
  assert.equal(quiet.events[0].mood, 'deadpan');
  const later = C.pumpEvents({ prev: base, next: base, memory: quiet.memory, now: NOW + 15 * 60000 });
  assert.equal(later.events.length, 0);
});

test('chart events become wire topics that survive the sanitizer', () => {
  const base = snap();
  const seen = C.pumpEvents({ next: base, memory: C.createCoinMemory(), now: NOW }).memory;
  const { events } = C.pumpEvents({ prev: base, next: snap({ change5m: 20, mcapUsd: 20000 }), memory: seen, now: NOW + 1000 });
  const drafts = C.coinDrafts(events);
  assert.ok(drafts.length >= 2);
  assert.ok(drafts.every((d) => d.source === 'coin'));
  assert.ok(drafts[0].score >= drafts[1].score, 'strongest first');
  for (const d of drafts) {
    const clean = T.sanitizeDraft(d);
    assert.ok(clean, 'kept');
    assert.equal(clean.source, 'coin');
    assert.equal(clean.title, d.title, 'nothing was clamped');
  }
  assert.equal(C.spokenUsd(1234567), '1.2 million dollars');
  assert.equal(C.spokenUsd(830), '830 dollars');
  assert.equal(C.spokenUsd(120000), '120 thousand dollars');
});
