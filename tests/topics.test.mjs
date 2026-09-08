import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('work/tests', { recursive: true });
for (const name of ['topics', 'show', 'chat']) {
  const source = await readFile(`lib/${name}.ts`, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText.replace(/from '\.\/(\w+)'/g, "from './$1.js'");
  await writeFile(`work/tests/${name}.js`, js);
}
const T = await import('../work/tests/topics.js');
const { lintVoices, parseLines } = await import('../work/tests/show.js');
const { parseChatLines } = await import('../work/tests/chat.js');

let counter = 0;
const id = () => `id-${++counter}`;
const draft = (title, over = {}) => ({
  title,
  brief: `Something verifiable happened regarding ${title}.`,
  angle: 'Play it straight.',
  source: 'x',
  score: 50,
  ...over,
});
const live = () => T.setFeedEnabled(T.createQueue(), true);

test('enqueue drops near-duplicates and evicts the coldest over the cap', () => {
  let q = T.enqueue(T.createQueue(), [draft('Bitcoin ETF inflows hit a record')], 0, T.topicConfig, id);
  q = T.enqueue(q, [draft('bitcoin etf inflows hit a RECORD!')], 1, T.topicConfig, id);
  assert.equal(q.topics.filter((t) => t.status === 'queued').length, 1);
  const subjects = ['Solana outage', 'Fed rate decision', 'A hacked bridge', 'Memecoin lawsuit',
    'Chip export rules', 'Stablecoin depeg', 'Mining ban vote', 'Wallet phishing wave',
    'Custody bank merger', 'Layer two shutdown', 'Airline strike vote', 'Chip fab delayed',
    'Bond auction wobbles', 'Retail sales slump', 'Oil pipeline restart', 'Housing starts fall',
    'Port workers deal', 'Cloud outage report', 'Patent ruling lands', 'Grid upgrade funded',
    'Rare earth quota', 'Steel tariff review', 'Wheat harvest short', 'Rail merger blocked',
    'Copper mine reopens', 'Freight rates ease'];
  q = T.enqueue(q, subjects.map((s, i) => draft(s, { score: i * 10 })), 2, T.topicConfig, id);
  const queued = q.topics.filter((t) => t.status === 'queued');
  assert.equal(queued.length, T.topicConfig.maxQueued);
  assert.ok(
    queued.length === T.topicConfig.maxQueued,
    'the queue is trimmed to the cap',
  );
});

test('a used title is not re-queued later', () => {
  let q = T.enqueue(T.createQueue(), [draft('An exchange lost the keys')], 0, T.topicConfig, id);
  const topic = q.topics[0];
  q = T.markTopic(q, topic.id, 'buffered', 4);
  q = T.markOnAir(q, 4);
  q = T.markTopic(q, topic.id, 'used');
  q = T.enqueue(q, [draft('An exchange lost the keys')], 1, T.topicConfig, id);
  assert.equal(q.topics.filter((t) => t.status === 'queued').length, 0);
});

test('selection prefers pinned, then chat, and respects both cadences', () => {
  const base = T.enqueue(
    T.createQueue(),
    [draft('A feed story', { score: 90 }), draft('A chat question', { source: 'chat', score: 10 })],
    0,
    T.topicConfig,
    id,
  );
  // Cold start: both cadences are open, so the chat comment outranks the hotter feed item.
  assert.equal(T.pickTopic(base).source, 'chat');
  const chat = base.topics.find((t) => t.source === 'chat');
  const feed = base.topics.find((t) => t.source === 'x');

  // After a chat topic airs, chat must wait its cadence while the feed lane stays open.
  const afterChat = T.batchWritten(T.markTopic(base, chat.id, 'buffered', 0), chat);
  assert.equal(afterChat.batches, 1);
  assert.equal(T.pickTopic(afterChat).source, 'x', 'the feed lane is not blocked by chat');

  // Mid-rotation the feed lane holds off until enough dialogue has been written.
  const midRotation = {
    ...base,
    feedSeconds: 0,
    topics: base.topics.filter((t) => t.source !== 'chat'),
  };
  assert.equal(T.pickTopic(midRotation), undefined, 'the feed waits out its rotation');
  const pinned = base.topics.find((t) => t.source === 'x');
  assert.equal(
    T.pickTopic(T.promote(midRotation, pinned.id)).id,
    pinned.id,
    'a pinned topic ignores the rotation',
  );
});

test('research gates on queue depth, staleness, gap and the hourly cap', () => {
  const q = live();
  assert.equal(T.shouldResearch(q, 0), true, 'empty wire researches immediately');
  assert.equal(T.shouldResearch({ ...q, feed: { ...q.feed, inflight: true } }, 0), false);
  assert.equal(T.shouldResearch({ ...q, feed: { ...q.feed, status: 'off' } }, 0), false);
  let full = T.enqueue(
    q,
    [draft('One story'), draft('Two story'), draft('Third unrelated matter')],
    0,
    T.topicConfig,
    id,
  );
  full = { ...full, feed: { ...full.feed, lastResearchAt: 1 } };
  assert.equal(T.shouldResearch(full, 1000), false, 'enough topics and not stale');
  assert.equal(T.shouldResearch(full, 1 + T.topicConfig.staleMs + 1), true);
  const busy = {
    ...q,
    feed: { ...q.feed, callTimes: Array.from({ length: T.topicConfig.maxCallsPerHour }, () => 0) },
  };
  assert.equal(T.shouldResearch(busy, 1000), false, 'hourly cap');
});

test('research backs off on failures and on calls that add nothing', () => {
  let q = T.researchStarted(live(), 0);
  assert.equal(q.feed.inflight, true);
  assert.equal(T.shouldResearch(q, 0), false);
  q = T.researchSettled(q, { ok: false, now: 0, error: 'boom' });
  assert.equal(q.feed.status, 'error');
  assert.equal(q.feed.nextAllowedAt, T.topicConfig.backoffBaseMs);
  const second = T.researchSettled(T.researchStarted(q, 1), { ok: false, now: 1, error: 'boom' });
  assert.ok(second.feed.nextAllowedAt - 1 > q.feed.nextAllowedAt, 'backoff grows');
  const empty = T.researchSettled(T.researchStarted(live(), 0), { ok: true, now: 0, added: 0 });
  assert.equal(empty.feed.status, 'live');
  assert.equal(empty.feed.failures, 1, 'a call that adds nothing is a soft failure');
  const good = T.researchSettled(T.researchStarted(live(), 0), {
    ok: true,
    now: 0,
    added: 3,
    cost: { usd: 0.05 },
  });
  assert.equal(good.feed.failures, 0);
  assert.equal(good.feed.nextAllowedAt, T.topicConfig.minGapMs);
  assert.equal(good.feed.costUsd, 0.05);
});

test('airing a shot retires the previous topic and remembers its title', () => {
  let q = T.enqueue(T.createQueue(), [draft('First story'), draft('Second story')], 0, T.topicConfig, id);
  const [first, second] = q.topics;
  q = T.markOnAir(T.markTopic(q, first.id, 'buffered', 8), 8);
  assert.equal(q.topics.find((t) => t.id === first.id).status, 'on-air');
  q = T.markOnAir(T.markTopic(q, second.id, 'buffered', 12), 12);
  assert.equal(q.topics.find((t) => t.id === first.id).status, 'used');
  assert.ok(q.recentTitles.includes('First story'));
  assert.ok(T.avoidTitles(q).includes('Second story'));
});

test('queued feed topics expire but pinned ones stay', () => {
  let q = T.enqueue(T.createQueue(), [draft('Aging story'), draft('Kept story')], 0, T.topicConfig, id);
  q = T.promote(q, q.topics[1].id);
  q = T.expire(q, T.topicConfig.maxAge.web + 1);
  assert.equal(q.topics[0].status, 'dropped');
  assert.equal(q.topics[1].status, 'queued');
});

test('comment prefilter removes spam, stubs and duplicates', () => {
  const kept = T.prefilterComments([
    { id: '1', author: 'deb', text: 'why is the timeline mad at the SEC today' },
    { id: '2', author: 'bot', text: 'BUY 0x1234567890abcdef1234567890abcdef12345678' },
    { id: '3', author: 'x', text: 'gm' },
    { id: '4', author: 'y', text: 'https://example.com/spam' },
    { id: '5', author: 'z', text: 'Why is the timeline MAD at the SEC today?' },
  ]);
  assert.deepEqual(kept.map((c) => c.id), ['1']);
});

test('drafts are clamped and unusable ones rejected', () => {
  assert.equal(T.sanitizeDraft({ title: '', brief: 'x' }), null);
  assert.equal(T.sanitizeDraft('nope'), null);
  const clean = T.sanitizeDraft({
    title: 'x'.repeat(200),
    brief: 'y'.repeat(900),
    angle: 'z',
    source: 'nonsense',
    heat: 900,
    url: 'javascript:alert(1)',
  });
  assert.equal(clean.title.length, T.topicConfig.limits.title);
  assert.equal(clean.brief.length, T.topicConfig.limits.brief);
  assert.equal(clean.source, 'web', 'unknown sources fall back to web');
  assert.equal(clean.score, 100);
  assert.equal(clean.url, undefined, 'only https urls survive');
  assert.equal(T.sanitizeDraft({ title: 'a', brief: 'b' }, 'chat').source, 'chat');
});

test('model output is read through code fences and stray prose', () => {
  assert.deepEqual(T.parseTopicJson('```json\n{"topics":[]}\n```'), { topics: [] });
  assert.deepEqual(T.parseTopicJson('Here you go: [1,2]'), [1, 2]);
  assert.throws(() => T.parseTopicJson('not json at all'));
});

test('source labels name the provenance shown on stage', () => {
  assert.equal(
    T.sourceLabel({ title: 't', source: 'x', who: 'Ansem', handle: '@blknoiz06' }),
    'via Ansem (@blknoiz06) on X',
  );
  assert.equal(T.sourceLabel({ title: 't', source: 'x', handle: '@vitalik' }), 'via @vitalik on X');
  assert.equal(
    T.sourceLabel({ title: 't', source: 'web', handle: 'The Verge', url: 'https://news.google.com/x' }),
    'from The Verge',
    'the publisher is credited, never the aggregator',
  );
  assert.equal(T.sourceLabel({ title: 't', source: 'x' }), 'trending on X');
  assert.equal(
    T.sourceLabel({ title: 't', source: 'web', url: 'https://www.reuters.com/a' }),
    'from reuters.com',
  );
  assert.equal(T.sourceLabel({ title: 't', source: 'chat', handle: 'deb' }), 'from live chat: deb');
});

test('cost adds tool invocations to token spend', () => {
  const cost = T.estimateCost({ input_tokens: 1e6, output_tokens: 1e6 }, 'grok-4.6', 4);
  assert.equal(Number(cost.usd.toFixed(2)), 8.02);
  assert.equal(T.estimateCost({}, 'unknown-model', 0).usd, 0);
});

test('a live topic is stamped on the first line only', () => {
  const lines = parseLines(
    ['One perfectly ordinary spoken line here.', 'Two ordinary spoken lines here now.', 'Three ordinary spoken lines here.', 'Four ordinary spoken lines here now.'].join('\n'),
    0,
    undefined,
    { title: 'An exchange lost the keys', source: 'x', handle: '@someone' },
  );
  assert.equal(lines[0].topic.title, 'An exchange lost the keys');
  assert.ok(lines.slice(1).every((l) => l.topic === undefined));
});

test('voice lint catches lines written for the wrong host', () => {
  assert.deepEqual(lintVoices([{ id: 0, speaker: 'host', text: 'Markets are fine.' }]), []);
  assert.equal(
    lintVoices([{ id: 1, speaker: 'guest', text: 'I think people are saying it is over.' }]).length,
    1,
  );
  assert.equal(
    lintVoices([{ id: 0, speaker: 'host', text: 'This is a test of character.' }]).length,
    1,
  );
});

test('chat lines parse an author prefix when there is one', () => {
  const batch = parseChatLines('deb: why is gas so high\njust vibes', 'studio', 5);
  assert.deepEqual(
    batch.map((c) => [c.author, c.text]),
    [
      ['deb', 'why is gas so high'],
      ['studio', 'just vibes'],
    ],
  );
});

test('a speaker label from the writer never reaches the microphone', () => {
  const lines = parseLines(
    [
      'PEPE: One perfectly ordinary spoken line here.',
      'GigaChad - Two ordinary spoken lines here now.',
      'Three ordinary spoken lines here for us.',
      'Four ordinary spoken lines here right now.',
    ].join('\n'),
    0,
  );
  assert.equal(lines[0].text, 'One perfectly ordinary spoken line here.');
  assert.equal(lines[1].text, 'Two ordinary spoken lines here now.');
});

test('topic JSON survives the CLI habit of emitting placeholders before the real answer', () => {
  // Measured shape: prose, then throwaway objects, then the payload, all concatenated.
  const messy =
    'I\'ll pull the latest posts and return one object.' +
    '{"topics":[{"title":"placeholder"}]}' +
    '{"topics":[{"title":"checking again"}]}' +
    '{"topics":[{"title":"Memory charts look bottomed","who":"Ansem"}]}';
  assert.equal(T.parseTopicJson(messy).topics[0].title, 'Memory charts look bottomed');
});

test('topic JSON ignores a trailing note and braces inside strings', () => {
  const trailing =
    '{"topics":[{"title":"The SEC said something {again}","brief":"He wrote \\"gm\\" and left."}]}' +
    '\n\nNote: {"status":"done"}';
  const parsed = T.parseTopicJson(trailing);
  assert.equal(parsed.topics.length, 1);
  assert.match(parsed.topics[0].title, /\{again\}/);
  const truncated = '{"topics":[{"title":"good"}]} and then {"topics":[{"tit';
  assert.equal(T.parseTopicJson(truncated).topics[0].title, 'good');
});

test('topic JSON still reads fenced payloads, arrays and rejects junk', () => {
  assert.deepEqual(T.parseTopicJson('```json\n{"topics":[]}\n```'), { topics: [] });
  assert.deepEqual(T.parseTopicJson('Here you go: [1,2]'), [1, 2]);
  assert.deepEqual(T.parseTopicJson('{"error":"nope"}'), { error: 'nope' });
  assert.throws(() => T.parseTopicJson('not json at all'));
});

test('handle rotation covers the roster without repeating inside a window', () => {
  const pool = Array.from({ length: 12 }, (_, i) => `@acct${i}`);
  const first = T.rotate(pool, 5, 0);
  const second = T.rotate(pool, 5, 1);
  assert.equal(first.length, 5);
  assert.equal(new Set(first).size, 5, 'no duplicates within a call');
  assert.notDeepEqual(first, second, 'consecutive calls watch different accounts');
  assert.deepEqual(T.rotate(pool, 5, 0), first, 'the same cursor is stable');
  assert.equal(T.rotate([], 5, 0).length > 0, true, 'falls back to the built-in roster');
});

test('chat comments are ranked locally, with spam and repeats dropped', () => {
  const comments = [
    { id: '1', author: 'deb', text: 'why is the whole timeline mad at the SEC again today' },
    { id: '2', author: 'bot', text: 'buy $PUMP now, ape in before it sends' },
    { id: '3', author: 'max', text: 'ask chad if he has ever taken profit in his life' },
    { id: '4', author: 'rep', text: 'why is the whole timeline mad at the SEC again today' },
  ];
  const topics = T.rankComments(
    comments,
    ['ask chad if he has ever taken profit in his life'],
    3,
  );
  assert.ok(topics.length >= 1 && topics.length <= 3);
  assert.ok(topics.every((t) => t.source === 'chat'));
  assert.ok(!topics.some((t) => /\$PUMP/i.test(t.title)), 'shilling never becomes a topic');
  assert.ok(
    !topics.some((t) => /taken profit/i.test(t.title)),
    'a repeat of a recent topic is dropped',
  );
  assert.equal(new Set(topics.map((t) => t.title)).size, topics.length);
});

test('topics rotate on airtime, not on batch count', () => {
  const rotate = T.topicConfig.rotateSeconds;
  let q = T.enqueue(
    T.createQueue(),
    [
      'Ansem calls the memory top',
      'Chad refuses to sell his bags',
      'Solana outage explained badly',
      'Regulators subpoena a mining pool',
      'Stablecoin depegs on a Tuesday',
      'Wallet phishing wave hits users',
      'Memecoin lawsuit gets weirder',
      'Exchange loses its own keys',
    ].map((t) => draft(t, { source: 'x' })),
    0,
    T.topicConfig,
    id,
  );
  // A batch is four spoken turns; the wire should turn over roughly every 35 seconds.
  const BATCH = 24;
  let aired = 0;
  const changes = [];
  for (let batch = 0; batch < 12; batch++) {
    const topic = T.pickTopic(q);
    if (topic) {
      changes.push(aired);
      q = T.markTopic(q, topic.id, 'buffered', batch);
    }
    q = T.batchWritten(q, topic, BATCH);
    aired += BATCH;
  }
  assert.ok(changes.length >= 6, `expected frequent rotation, got ${changes.length} in 12 batches`);
  const gaps = changes.slice(1).map((t, i) => t - changes[i]);
  const average = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(
    Math.abs(average - rotate) <= BATCH / 2 + 1,
    `average gap ${average}s should sit near ${rotate}s`,
  );
  assert.equal(changes[0], 0, 'the first batch already carries a topic');
});
