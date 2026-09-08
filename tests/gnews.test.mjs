import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('work/tests', { recursive: true });
for (const name of ['topics', 'gnews']) {
  const source = await readFile(`lib/${name}.ts`, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText.replace(/from '\.\/(\w+)'/g, "from './$1.js'");
  await writeFile(`work/tests/${name}.js`, js);
}
const G = await import('../work/tests/gnews.js');
const tech = await readFile('tests/fixtures/gnews-technology.xml', 'utf8');
const business = await readFile('tests/fixtures/gnews-business.xml', 'utf8');
// The fixtures were captured on this date; freshness filters are relative to it.
const CAPTURED = Date.parse('2026-09-08T12:00:00Z');

test('every item in a real feed parses', () => {
  const items = G.parseRss(tech);
  assert.ok(items.length > 40, `expected a full feed, got ${items.length}`);
  assert.ok(
    items.every((i) => i.title && i.publisher && Number.isFinite(i.at)),
    'every item has a title, a publisher and a date',
  );
});

test('the publisher comes from the source element, never the link', () => {
  const items = G.parseRss(business);
  const first = items[0];
  assert.ok(first.publisher.length > 1);
  assert.ok(
    !first.publisher.includes('news.google'),
    'the publisher is the real outlet',
  );
  assert.ok(
    items.every((i) => !i.title.endsWith(` - ${i.publisher}`)),
    'the publisher suffix is stripped from the headline',
  );
});

test('a publisher containing a dash is not mangled', () => {
  const item = G.parseRss(
    `<rss><channel><item><title>Something happened - ABC News - Breaking News, Latest News and Videos</title>` +
      `<source url="https://abcnews.go.com">ABC News - Breaking News, Latest News and Videos</source>` +
      `<pubDate>Tue, 08 Sep 2026 05:00:00 GMT</pubDate></item></channel></rss>`,
  )[0];
  assert.equal(item.title, 'Something happened');
  assert.equal(item.publisher, 'ABC News - Breaking News, Latest News and Videos');
});

test('entities and CDATA survive parsing', () => {
  const item = G.parseRss(
    `<rss><channel><item><title><![CDATA[Fed &amp; Treasury &#39;spar&#39; over &quot;rates&quot;]]></title>` +
      `<source url="https://x.test">Reuters</source>` +
      `<pubDate>Tue, 08 Sep 2026 05:00:00 GMT</pubDate></item></channel></rss>`,
  )[0];
  assert.equal(item.title, `Fed & Treasury 'spar' over "rates"`);
});

test('the related-coverage cluster is extracted with its publishers', () => {
  const items = G.parseRss(business);
  const clustered = items.filter((i) => i.cluster.length >= 3);
  assert.ok(clustered.length > 10, 'real feeds carry clustered stories');
  const sample = clustered[0];
  assert.ok(sample.cluster.every((c) => c.title && c.publisher));
  assert.ok(
    new Set(sample.cluster.map((c) => c.publisher)).size >= 3,
    'a cluster names at least three distinct outlets',
  );
});

test('a story only one outlet carries is rejected', () => {
  const lonely = {
    title: 'A local paper reports a thing',
    publisher: 'Somewhere Herald',
    publisherUrl: 'https://somewhere.test',
    at: CAPTURED - 3600000,
    cluster: [{ title: 'A local paper reports a thing', publisher: 'Somewhere Herald' }],
  };
  assert.equal(G.acceptable(lonely, CAPTURED), false);
});

test('stale stories and search-engine filler are rejected', () => {
  const base = G.parseRss(business).find((i) => i.cluster.length >= 3);
  assert.equal(G.acceptable({ ...base, at: CAPTURED - 40 * 3600000 }, CAPTURED), false);
  for (const title of [
    'Bitcoin Price Prediction: Could BTC Hit $200,000?',
    '7 Best Meme Coins To Buy Now',
    'Ethereum presale is live',
    'Is it a buy at these levels?',
  ])
    assert.equal(
      G.acceptable({ ...base, title }, CAPTURED),
      false,
      `${title} should be rejected`,
    );
});

test('the brief attributes the story and names who else is covering it', () => {
  const item = G.parseRss(business).find((i) => i.cluster.length >= 3);
  const brief = G.synthBrief(item, CAPTURED);
  assert.ok(brief.includes(item.publisher), 'the brief attributes the reporting');
  assert.ok(/also covered by/i.test(brief), 'corroboration is stated');
  assert.ok(brief.length <= 500, 'fits the writer brief limit');
});

test('drafts land in the shape the queue expects', () => {
  const drafts = G.toDrafts(G.parseRss(business), CAPTURED, 'macro');
  assert.ok(drafts.length > 5);
  for (const d of drafts) {
    assert.equal(d.source, 'web');
    assert.equal(d.category, 'macro');
    assert.ok(d.score <= G.gnewsConfig.scoreCap, 'news never outranks the crypto lane');
    assert.ok(d.handle && !d.handle.includes('news.google'));
    assert.ok(d.title.length <= 80 && d.brief.length <= 500);
  }
  const titles = drafts.map((d) => d.title);
  assert.equal(new Set(titles).size, titles.length, 'no duplicate stories');
});

test('tragedy never becomes comedy material', () => {
  const base = G.parseRss(business).find((i) => i.cluster.length >= 3);
  const forbidden = [
    'Five killed in Miami plane crash landing were in two vehicles, investigators say',
    'Gunman opens fire at a shopping centre, several dead',
    'Death toll rises to 40 after the earthquake in the region',
    'Boy, 12, dies after being pulled from the river near the bridge',
    'Air strike kills civilians in the besieged northern city',
    'Woman sentenced for the murder of her neighbour last spring',
    'Hospital reports outbreak as the virus claims more victims',
    'Missing hiker found dead in the national park after four days',
  ];
  for (const title of forbidden)
    assert.equal(
      G.acceptable({ ...base, title }, CAPTURED),
      false,
      `must reject: ${title}`,
    );
});

test('ordinary business and tech stories still get through', () => {
  const base = G.parseRss(business).find((i) => i.cluster.length >= 3);
  const allowed = [
    'Canada countertariffs take effect as Trump threatens to ban Bombardier sales',
    'Apple says the new headset sold out in under an hour this morning',
    'The Federal Reserve left interest rates unchanged again this month',
    'Regulators open an inquiry into the exchange listing practices',
  ];
  for (const title of allowed)
    assert.equal(
      G.acceptable({ ...base, title }, CAPTURED),
      true,
      `must accept: ${title}`,
    );
});

test('a company quoting itself is not corroboration', () => {
  const item = {
    title: 'Bombardier faces a proposed sales ban in a widening trade fight',
    publisher: 'The Washington Post',
    publisherUrl: 'https://washingtonpost.com',
    at: CAPTURED - 3600000,
    cluster: [
      { title: 'Bombardier faces a proposed sales ban', publisher: 'The Washington Post' },
      { title: 'Bombardier Statement', publisher: 'Bombardier' },
      { title: 'A note from the company', publisher: 'dars.gov.et' },
    ],
  };
  assert.equal(G.acceptable(item, CAPTURED), false, 'press releases and bare domains do not count');
});

test('search feeds get their corroboration rebuilt from matching headlines', async () => {
  const search = await readFile('tests/fixtures/gnews-crypto-search.xml', 'utf8');
  const raw = G.parseRss(search);
  assert.ok(raw.length > 20, 'the fixture is a full search feed');
  assert.ok(
    raw.every((i) => i.cluster.length <= 1),
    'search feeds ship no related-coverage block',
  );
  const clustered = G.clusterItems(raw);
  const corroborated = clustered.filter((i) => G.publishers(i).size >= 2);
  assert.ok(
    corroborated.length > 0,
    'stories carried by several outlets are found by headline matching',
  );
  const drafts = G.toDrafts(clustered, Date.parse('2026-09-08T16:00:00Z'), 'crypto', 2);
  assert.ok(drafts.length > 0, 'the crypto lane produces topics');
  assert.ok(drafts.every((d) => d.category === 'crypto'));
});
