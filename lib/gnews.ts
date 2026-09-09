// The free news lane: Google News RSS, parsed without dependencies so it runs inside the Worker.
// Pure — no network, no clock reads. The route fetches; this module decides what is usable.
//
// Two things learned from real feeds and encoded here:
//  - Every <link> points at news.google.com, so provenance comes from <source url="...">.
//  - A lone headline is not safe to broadcast. The same story ran as both "Bitcoin Network Says
//    $320 Million Stolen" and "Whitehats return 3,400 BTC". Only a story several outlets carry
//    goes on air, and the brief says who is reporting it.
import { sanitizeDraft, similar, type TopicCategory, type TopicDraft } from './topics';
export type ClusterEntry = { title: string; publisher: string };
export type RssItem = {
  title: string;
  publisher: string;
  publisherUrl: string;
  at: number;
  cluster: ClusterEntry[];
};
export const gnewsConfig = {
  maxAgeHours: 18,
  minCluster: 3, // distinct outlets required before a story may air
  scoreCap: 55, // stays under the crypto lane so influencer takes win a tie
  perFeed: 12,
} as const;
export type Feed = {
  id: string;
  category: TopicCategory;
  topic?: string;
  query?: string;
};
export const feeds: Feed[] = [
  { id: 'solana', query: 'solana when:1d', category: 'crypto' },
  { id: 'memecoin', query: '(solana OR "pump.fun" OR bonk OR dogwifhat) (memecoin OR "meme coin" OR launch OR community) when:1d', category: 'crypto' },
  { id: 'crypto', query: '(bitcoin OR ethereum OR crypto) (exchange OR network OR regulation) when:1d', category: 'crypto' },
];
const BASE = 'hl=en-US&gl=US&ceid=US:en';
export const feedUrl = (feed: Feed) =>
  feed.query
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(feed.query)}&${BASE}`
    : `https://news.google.com/rss/headlines/section/topic/${feed.topic}?${BASE}`;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = Number(
        body[1] === 'x' || body[1] === 'X' ? `0x${body.slice(2)}` : body.slice(1),
      );
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}
const text = (value: string) =>
  decodeEntities(
    decodeEntities(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
const tag = (block: string, name: string) => {
  const found = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(
    block,
  );
  return found ? found[1] : '';
};

export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const [, block] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const source = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(block);
    const publisher = source ? text(source[1]) : '';
    const url = /<source[^>]*\burl="([^"]+)"/i.exec(block);
    const at = Date.parse(text(tag(block, 'pubDate')));
    let title = text(tag(block, 'title'));
    // Google appends " - Publisher"; match the publisher itself, since some contain " - ".
    if (publisher && title.endsWith(` - ${publisher}`))
      title = title.slice(0, -(publisher.length + 3)).trim();
    if (!title || !publisher || !Number.isFinite(at)) continue;
    items.push({
      title,
      publisher,
      publisherUrl: url ? url[1] : '',
      at,
      cluster: parseCluster(tag(block, 'description')),
    });
  }
  return items;
}
/** The <ol><li> block of related coverage: an anchor per headline, a <font> per outlet. */
function parseCluster(description: string): ClusterEntry[] {
  const raw = decodeEntities(description);
  const titles = [...raw.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => text(m[1]));
  const publishers = [...raw.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/gi)].map((m) =>
    text(m[1]),
  );
  const entries: ClusterEntry[] = [];
  for (let i = 0; i < Math.min(titles.length, publishers.length); i++)
    if (titles[i] && publishers[i])
      entries.push({ title: titles[i], publisher: publishers[i] });
  return entries;
}

/**
 * Search feeds carry no related-coverage block, so corroboration has to be rebuilt by
 * matching headlines across publishers. Without this every search item looks like a
 * single-source story and is rejected, which silently emptied the crypto lane.
 */
export function clusterItems(items: RssItem[]): RssItem[] {
  const used = new Set<number>();
  const grouped: RssItem[] = [];
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const group = [items[i]];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      if (!similar(items[i].title, items[j].title)) continue;
      used.add(j);
      group.push(items[j]);
    }
    grouped.push({
      ...items[i],
      cluster: group.map((g) => ({ title: g.title, publisher: g.publisher })),
    });
  }
  return grouped;
}

const JUNK = [
  /\bprice (prediction|today|analysis)\b/i,
  /\b(could|will) (hit|reach|soar|explode)\b/i,
  /^\d+\s+(best|top|hot)\b/i,
  /\b(presale|airdrop|giveaway)\b/i,
  /\bis it a buy\b/i,
  /\bbuy(ing)? now\b/i,
  /\bhere's (why|how)\b/i,
  /\bpage \d+\b/i,
];
const DENY = [
  'Robinhood',
  'Moomoo',
  'TradingView',
  'Stock Titan',
  'StreetInsider',
  'Quiver Quantitative',
  'Business Wire',
  'PR Newswire',
  'GlobeNewswire',
];
// Real people get hurt in the news. None of it is material for a comedy show, and no
// prompt rule is a substitute for never handing the story to the writer in the first place.
const SENSITIVE =
  /\b(kill(s|ed|ing)?|dead|deaths?|death toll|dies|died|dying|fatal(ly|ities)?|murder(s|ed)?|homicide|manslaughter|shooting|gunman|shot dead|stabb(ed|ing)|massacre|terror(ism|ist)?|bomb(ing|ed)?|air ?strike|war crimes?|genocide|hostages?|kidnapp?(ed|ing)|abuse|assault(ed)?|rape|trafficking|suicide|overdose|casualt(y|ies)|victims?|funeral|obituary|earthquake|wildfire|hurricane|flood(s|ing)?|famine|outbreak|epidemic|pandemic|crash(ed)?|derail(ed|ment)|missing (child|boy|girl|woman|man|hiker)|found dead|sentenced|convicted|arrested|indicted|charged with|lawsuit|sues?|suing)\b/i;
/** A bare domain, e.g. "dars.gov.et" — not a recognisable outlet. */
const bareDomain = (name: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name.trim());
/** Outlets whose coverage counts as independent corroboration. */
export function publishers(item: RssItem): Set<string> {
  const names = [item.publisher, ...item.cluster.map((c) => c.publisher)];
  const subject = item.title.toLowerCase();
  return new Set(
    names.filter(
      (name) =>
        name &&
        !bareDomain(name) &&
        // A company issuing a statement about itself is not a second source.
        !subject.includes(name.toLowerCase()),
    ),
  );
}
export function acceptable(
  item: RssItem,
  nowMs: number,
  minCluster: number = gnewsConfig.minCluster,
): boolean {
  const ageHours = (nowMs - item.at) / 3600000;
  if (!(ageHours >= -1 && ageHours <= gnewsConfig.maxAgeHours)) return false;
  if (item.title.length < 25 || item.title.length > 160) return false;
  if (item.title.endsWith('?')) return false;
  if (SENSITIVE.test(item.title)) return false;
  if (item.cluster.some((c) => SENSITIVE.test(c.title))) return false;
  if (JUNK.some((r) => r.test(item.title))) return false;
  if (DENY.some((d) => item.publisher.startsWith(d))) return false;
  // Non-Latin headlines read badly on air and the writer cannot use them.
  if ((item.title.match(/[\u2001-\uffff]/g) || []).length > 4) return false;
  return publishers(item).size >= minCluster;
}
/**
 * A brief the hosts can use without inventing anything: who reported it, what they said,
 * and who else is carrying it. Deliberately headline-level — the writer prompt says so.
 */
export function synthBrief(item: RssItem, nowMs: number): string {
  const others = [...publishers(item)].filter((p) => p !== item.publisher).slice(0, 3);
  const hours = Math.max(0, Math.round((nowMs - item.at) / 3600000));
  const when = hours < 1 ? 'in the last hour' : hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  // A second framing from the cluster shows the story is bigger than one outlet's angle.
  const angle = item.cluster.find(
    (c) => c.publisher !== item.publisher && c.title !== item.title,
  );
  const parts = [
    `${item.publisher} reported ${when}: ${item.title}.`,
    others.length ? `Also covered by ${others.join(', ')}.` : '',
    angle ? `${angle.publisher} headlines it "${angle.title}".` : '',
    'Headline-level reporting only; no further detail is known.',
  ];
  return parts.filter(Boolean).join(' ').slice(0, 500);
}
export function toDrafts(
  items: RssItem[],
  nowMs: number,
  category: TopicCategory,
  minCluster: number = gnewsConfig.minCluster,
): TopicDraft[] {
  const seen = new Set<string>();
  const drafts: TopicDraft[] = [];
  for (const item of items) {
    if (!acceptable(item, nowMs, minCluster)) continue;
    const key = item.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ageHours = (nowMs - item.at) / 3600000;
    // Corroboration and freshness are the only signals RSS gives us.
    const score = Math.min(
      gnewsConfig.scoreCap,
      Math.round(
        20 +
          (category === 'crypto' ? 12 : 0) +
          Math.min(publishers(item).size, 6) * 5 +
          Math.max(0, gnewsConfig.maxAgeHours - ageHours),
      ),
    );
    const draft = sanitizeDraft({
      title: item.title,
      brief: synthBrief(item, nowMs),
      angle: `React to the reported event and its consequences for Solana memecoin traders. Keep the event central; invent no details beyond these headlines.`,
      source: 'web',
      score,
      handle: item.publisher,
      category,
      ...(item.publisherUrl ? { url: item.publisherUrl } : {}),
    });
    if (draft) drafts.push(draft);
    if (drafts.length >= gnewsConfig.perFeed) break;
  }
  return drafts;
}
