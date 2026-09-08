// Topic queue and feed policy. Pure: no DOM, no network, no timers, no clock reads.
// The engine and the server both use these helpers so the browser and the API agree.
export type TopicSource = 'audience' | 'chat' | 'x' | 'web';
export type TopicStatus =
  | 'queued'
  | 'writing'
  | 'buffered'
  | 'on-air'
  | 'used'
  | 'dropped';
export type TopicCategory = 'crypto' | 'tech' | 'macro' | 'chat';
export type TopicDraft = {
  title: string;
  brief: string;
  angle: string;
  source: TopicSource;
  score: number;
  url?: string;
  handle?: string;
  who?: string;
  /** A short verbatim line from the post, so the hosts can react to real words. */
  quote?: string;
  category?: TopicCategory;
  commentId?: string;
};
export type Topic = TopicDraft & {
  id: string;
  at: number;
  status: TopicStatus;
  pinned: boolean;
  shot?: number;
};
/** What the dialogue writer receives. */
export type TopicBrief = Pick<
  TopicDraft,
  'title' | 'brief' | 'angle' | 'source' | 'handle' | 'url' | 'who' | 'quote'
>;
/** Provenance stamped on the first line of a batch; small enough for the signed job token. */
export type TopicTag = Pick<TopicDraft, 'title' | 'source' | 'handle' | 'url' | 'who'>;
export type Comment = {
  id: string;
  author: string;
  text: string;
  likes?: number;
  platform?: string;
  at?: number;
};
export type FeedStatus = 'off' | 'idle' | 'searching' | 'live' | 'error';
export type FeedState = {
  status: FeedStatus;
  inflight: boolean;
  lastResearchAt: number;
  nextAllowedAt: number;
  failures: number;
  calls: number;
  callTimes: number[];
  costUsd: number;
  lastAdded: number;
  error: string;
};
export type CostEstimate = {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  model: string;
};
export type TopicQueueState = {
  topics: Topic[];
  batches: number;
  feedTurns: number;
  /** Seconds of dialogue written since the last topic change, carried across batches. */
  feedSeconds: number;
  lastTopicBatch: number;
  lastChatBatch: number;
  feed: FeedState;
  recentTitles: string[];
};
export type ResearchInput = { avoid: string[]; onAir?: string; focus?: string };
export type ResearchResult = { topics: TopicDraft[]; cost?: CostEstimate };
export type RankInput = {
  comments: Comment[];
  recentTitles: string[];
  onAir?: string;
  k?: number;
};
export type RankResult = { topics: TopicDraft[]; cost?: CostEstimate };

export const topicConfig = {
  // Write batches between chat topics. Four spoken turns per batch, roughly 24 seconds.
  cadence: { chat: 2 },
  // The wire turns over on airtime, not batch count: a fresh subject every ~35 seconds.
  // A batch cannot be split, so this alternates one and two batches to average out.
  rotateSeconds: 35,
  // Two influencer takes for every news topic: crypto is the show, news is filler.
  lane: { newsEvery: 3 },
  minQueued: 3,
  staleMs: 4 * 60000,
  minGapMs: 60000,
  maxCallsPerHour: 20,
  backoffBaseMs: 30000,
  backoffMaxMs: 10 * 60000,
  // Fast rotation burns roughly a hundred topics an hour, so the wire is kept deep.
  maxQueued: 24,
  // A crypto take goes stale fast, and a short window self-heals a deleted post.
  maxAge: { x: 15 * 60000, web: 45 * 60000 },
  keepUsed: 12,
  recentTitles: 20,
  limits: {
    title: 80,
    brief: 500,
    angle: 200,
    handle: 32,
    who: 40,
    quote: 180,
    url: 300,
    comment: 280,
    comments: 50,
    avoid: 30,
    author: 40,
  },
} as const;
export type TopicConfig = typeof topicConfig;

const SOURCES: TopicSource[] = ['audience', 'chat', 'x', 'web'];
const CATEGORIES: TopicCategory[] = ['crypto', 'tech', 'macro', 'chat'];
const FEED_SOURCES: TopicSource[] = ['x', 'web'];
const PENDING: TopicStatus[] = ['queued', 'writing', 'buffered'];

export const createFeed = (): FeedState => ({
  status: 'off',
  inflight: false,
  lastResearchAt: 0,
  nextAllowedAt: 0,
  failures: 0,
  calls: 0,
  callTimes: [],
  costUsd: 0,
  lastAdded: 0,
  error: '',
});
export const createQueue = (): TopicQueueState => ({
  topics: [],
  batches: 0,
  feedTurns: 0,
  // Seeded so the very first batch already carries a topic.
  feedSeconds: topicConfig.rotateSeconds,
  lastTopicBatch: -Infinity,
  lastChatBatch: -Infinity,
  feed: createFeed(),
  recentTitles: [],
});

export function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function similar(a: string, b: string) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left))
    return true;
  const one = new Set(left.split(' ').filter((w) => w.length > 2));
  const two = new Set(right.split(' ').filter((w) => w.length > 2));
  if (!one.size || !two.size) return false;
  let shared = 0;
  for (const word of one) if (two.has(word)) shared++;
  return shared / (one.size + two.size - shared) >= 0.6;
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
function httpsUrl(value: unknown, max: number) {
  if (typeof value !== 'string' || value.length > max) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}
const HANDLE = /^@[A-Za-z0-9_]{1,15}$/;
// Repeating an allegation about a real person is unrecoverable; dropping a topic costs nothing.
const ACCUSATION =
  /\b(scam(mer|ming)?|rug(ged|pull|s)?|fraud(ulent)?|ponzi|insider|stole|stealing|launder(ing|ed)?|arrested|indicted|charged with|convicted|sued|suing|lawsuit against|exit liquidity|paid to (shill|post)|shilling for|pedo|groom(er|ing))\b/i;
// Compromised accounts posting token pumps are routine; never read one on air.
const PROMOTION =
  /(\$[A-Za-z]{2,10}\b[^.]{0,60}\b(buy|ape|send|long|entry|presale|mint)\b)|0x[a-f0-9]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/i;
export function sanitizeDraft(
  raw: unknown,
  forceSource?: TopicSource,
  cfg: TopicConfig = topicConfig,
): TopicDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const title = text(item.title, cfg.limits.title);
  const brief = text(item.brief, cfg.limits.brief);
  const angle = text(item.angle, cfg.limits.angle);
  if (!title || !brief) return null;
  const source =
    forceSource ??
    (SOURCES.includes(item.source as TopicSource)
      ? (item.source as TopicSource)
      : 'web');
  const raw_score = Number(item.score ?? item.heat);
  const score = Number.isFinite(raw_score)
    ? Math.max(0, Math.min(100, Math.round(raw_score)))
    : 50;
  const handle = text(item.handle, cfg.limits.handle) || undefined;
  const category = CATEGORIES.includes(item.category as TopicCategory)
    ? (item.category as TopicCategory)
    : undefined;
  const commentId = text(item.commentId, 64) || undefined;
  const who = text(item.who, cfg.limits.who).replace(/^@/, '') || undefined;
  const quote = text(item.quote, cfg.limits.quote) || undefined;
  if (source === 'x') {
    // A take from a named person is the one place the show can do real damage.
    const all = `${title} ${brief} ${angle} ${quote ?? ''}`;
    if (ACCUSATION.test(all) || PROMOTION.test(all)) return null;
    if (handle && !HANDLE.test(handle)) return null;
  }
  return {
    title,
    brief,
    angle: angle || 'Play the situation straight and let the hosts react.',
    source,
    score,
    ...(httpsUrl(item.url, cfg.limits.url) ? { url: item.url as string } : {}),
    ...(handle ? { handle } : {}),
    ...(who && who.toLowerCase() !== handle?.slice(1).toLowerCase() ? { who } : {}),
    ...(quote ? { quote } : {}),
    ...(category ? { category } : {}),
    ...(commentId ? { commentId } : {}),
  };
}
export function sanitizeBrief(
  raw: unknown,
  cfg: TopicConfig = topicConfig,
): TopicBrief | null {
  const draft = sanitizeDraft(raw, undefined, cfg);
  return draft && briefOf(draft);
}
export function briefOf(topic: TopicDraft): TopicBrief {
  return {
    title: topic.title,
    brief: topic.brief,
    angle: topic.angle,
    source: topic.source,
    ...(topic.handle ? { handle: topic.handle } : {}),
    ...(topic.who ? { who: topic.who } : {}),
    ...(topic.quote ? { quote: topic.quote } : {}),
    ...(topic.url ? { url: topic.url } : {}),
  };
}
export function tagOf(topic: TopicBrief): TopicTag {
  return {
    title: topic.title,
    source: topic.source,
    ...(topic.handle ? { handle: topic.handle } : {}),
    ...(topic.who ? { who: topic.who } : {}),
    ...(topic.url ? { url: topic.url } : {}),
  };
}
export function sourceLabel(topic: TopicTag) {
  if (topic.source === 'x') {
    if (topic.who && topic.handle) return `via ${topic.who} (${topic.handle}) on X`;
    return topic.handle ? `via ${topic.handle} on X` : 'trending on X';
  }
  if (topic.source === 'web') {
    if (topic.handle) return `from ${topic.handle}`;
    if (!topic.url) return 'from the news';
    try {
      return `from ${new URL(topic.url).hostname.replace(/^www\./, '')}`;
    } catch {
      return 'from the news';
    }
  }
  if (topic.source === 'chat')
    return topic.handle ? `from live chat: ${topic.handle}` : 'from live chat';
  return 'audience request';
}

const remember = (
  titles: string[],
  title: string,
  cfg: TopicConfig = topicConfig,
) => [...titles.filter((t) => t !== title), title].slice(-cfg.recentTitles);

export function expire(
  state: TopicQueueState,
  now: number,
  cfg: TopicConfig = topicConfig,
): TopicQueueState {
  const stale = state.topics.filter(
    (t) =>
      t.status === 'queued' &&
      !t.pinned &&
      FEED_SOURCES.includes(t.source) &&
      now - t.at > (t.source === 'x' ? cfg.maxAge.x : cfg.maxAge.web),
  );
  if (!stale.length) return state;
  return {
    ...state,
    topics: state.topics.map((t) =>
      stale.includes(t) ? { ...t, status: 'dropped' } : t,
    ),
  };
}
export function enqueue(
  state: TopicQueueState,
  drafts: TopicDraft[],
  now: number,
  cfg: TopicConfig = topicConfig,
  id: () => string = () => crypto.randomUUID(),
): TopicQueueState {
  let next = expire(state, now, cfg);
  const added: Topic[] = [];
  for (const draft of drafts) {
    const seen = [
      ...next.topics.filter((t) => PENDING.includes(t.status)).map((t) => t.title),
      ...next.recentTitles,
      ...added.map((t) => t.title),
    ];
    if (seen.some((title) => similar(title, draft.title))) continue;
    added.push({ ...draft, id: id(), at: now, status: 'queued', pinned: false });
  }
  if (!added.length) return next;
  let topics = [...next.topics, ...added];
  // Keep the queue small: drop the coldest unused topics, never a pinned one.
  const queued = topics.filter((t) => t.status === 'queued' && !t.pinned);
  if (queued.length > cfg.maxQueued) {
    // Cheap news goes first, then the coldest: an influencer take is never evicted by filler.
    const evict = [...queued]
      .sort(
        (a, b) =>
          Number(b.source === 'web') - Number(a.source === 'web') ||
          a.score - b.score ||
          a.at - b.at,
      )
      .slice(0, queued.length - cfg.maxQueued);
    topics = topics.map((t) =>
      evict.includes(t) ? { ...t, status: 'dropped' as TopicStatus } : t,
    );
  }
  next = { ...next, topics: trim(topics, cfg) };
  return next;
}
function trim(topics: Topic[], cfg: TopicConfig) {
  const done = topics.filter((t) => t.status === 'used' || t.status === 'dropped');
  if (done.length <= cfg.keepUsed) return topics;
  const drop = done.slice(0, done.length - cfg.keepUsed);
  return topics.filter((t) => !drop.includes(t));
}
export function orderTopics(state: TopicQueueState): Topic[] {
  const rank = (t: Topic) =>
    t.pinned ? 0 : t.source === 'chat' ? 1 : t.source === 'x' ? 2 : 3;
  return state.topics
    .filter((t) => t.status === 'queued')
    .sort(
      (a, b) => rank(a) - rank(b) || b.score - a.score || b.at - a.at,
    );
}
export function pickTopic(
  state: TopicQueueState,
  cfg: TopicConfig = topicConfig,
): Topic | undefined {
  const ordered = orderTopics(state);
  const pinned = ordered.find((t) => t.pinned);
  if (pinned) return pinned;
  const chat = ordered.find((t) => t.source === 'chat');
  if (chat && state.batches - state.lastChatBatch >= cfg.cadence.chat)
    return chat;
  if (state.feedSeconds < cfg.rotateSeconds) return undefined;
  const take = ordered.find((t) => t.source === 'x');
  const news = ordered.find((t) => t.source === 'web');
  // Every third feed slot goes to news; the rest belong to the influencer lane.
  const wantNews =
    state.feedTurns % cfg.lane.newsEvery === cfg.lane.newsEvery - 1;
  return wantNews ? (news ?? take) : (take ?? news);
}
export function markTopic(
  state: TopicQueueState,
  id: string,
  status: TopicStatus,
  shot?: number,
  cfg: TopicConfig = topicConfig,
): TopicQueueState {
  const target = state.topics.find((t) => t.id === id);
  if (!target) return state;
  const done = status === 'used' || status === 'dropped';
  return {
    ...state,
    topics: state.topics.map((t) =>
      t.id === id
        ? {
            ...t,
            status,
            ...(shot === undefined ? {} : { shot }),
            ...(done ? { pinned: false } : {}),
          }
        : t,
    ),
    recentTitles: done
      ? remember(state.recentTitles, target.title, cfg)
      : state.recentTitles,
  };
}
export function batchWritten(
  state: TopicQueueState,
  topic?: Topic,
  seconds = 24,
  cfg: TopicConfig = topicConfig,
): TopicQueueState {
  const isFeed = !!topic && FEED_SOURCES.includes(topic.source);
  // Carry the overflow rather than resetting, so the average lands on rotateSeconds
  // even though dialogue can only change subject on a batch boundary.
  const feedSeconds =
    (isFeed ? Math.max(0, state.feedSeconds - cfg.rotateSeconds) : state.feedSeconds) +
    seconds;
  return {
    ...state,
    batches: state.batches + 1,
    feedSeconds,
    feedTurns: state.feedTurns + (isFeed ? 1 : 0),
    lastTopicBatch:
      topic && FEED_SOURCES.includes(topic.source)
        ? state.batches
        : state.lastTopicBatch,
    lastChatBatch:
      topic && topic.source === 'chat' ? state.batches : state.lastChatBatch,
  };
}
export function markOnAir(
  state: TopicQueueState,
  shotId: number,
  cfg: TopicConfig = topicConfig,
): TopicQueueState {
  const arriving = state.topics.find(
    (t) => t.shot === shotId && t.status === 'buffered',
  );
  if (!arriving) return state;
  let titles = state.recentTitles;
  const topics = state.topics.map((t) => {
    if (t.id === arriving.id) return { ...t, status: 'on-air' as TopicStatus };
    if (t.status === 'on-air') {
      titles = remember(titles, t.title, cfg);
      return { ...t, status: 'used' as TopicStatus };
    }
    return t;
  });
  return { ...state, topics: trim(topics, cfg), recentTitles: titles };
}
export function promote(state: TopicQueueState, id: string): TopicQueueState {
  if (!state.topics.some((t) => t.id === id && t.status === 'queued'))
    return state;
  return {
    ...state,
    topics: state.topics.map((t) => ({ ...t, pinned: t.id === id })),
  };
}
export function dismiss(state: TopicQueueState, id: string): TopicQueueState {
  return markTopic(state, id, 'dropped');
}
/** Queued, unused topics in one lane. The lanes refill independently. */
export function laneDepth(state: TopicQueueState, source: TopicSource) {
  return state.topics.filter(
    (t) => t.status === 'queued' && t.source === source,
  ).length;
}
export function unusedFeedCount(state: TopicQueueState) {
  return state.topics.filter(
    (t) => t.status === 'queued' && FEED_SOURCES.includes(t.source),
  ).length;
}
export function avoidTitles(
  state: TopicQueueState,
  cfg: TopicConfig = topicConfig,
) {
  const pending = state.topics
    .filter((t) => PENDING.includes(t.status) || t.status === 'on-air')
    .map((t) => t.title);
  return [...new Set([...state.recentTitles, ...pending])].slice(
    -cfg.limits.avoid,
  );
}
export function setFeedEnabled(
  state: TopicQueueState,
  enabled: boolean,
): TopicQueueState {
  if (enabled === (state.feed.status !== 'off')) return state;
  return {
    ...state,
    feed: enabled
      ? { ...state.feed, status: 'idle', error: '' }
      : { ...state.feed, status: 'off' },
  };
}
export function shouldResearch(
  state: TopicQueueState,
  now: number,
  cfg: TopicConfig = topicConfig,
) {
  const feed = state.feed;
  if (feed.status === 'off' || feed.inflight) return false;
  if (now < feed.nextAllowedAt) return false;
  if (feed.callTimes.filter((t) => now - t < 3600000).length >= cfg.maxCallsPerHour)
    return false;
  return (
    laneDepth(state, 'x') < cfg.minQueued ||
    now - feed.lastResearchAt > cfg.staleMs
  );
}
export function researchStarted(
  state: TopicQueueState,
  now: number,
): TopicQueueState {
  return {
    ...state,
    feed: {
      ...state.feed,
      status: 'searching',
      inflight: true,
      lastResearchAt: now,
      calls: state.feed.calls + 1,
      callTimes: [...state.feed.callTimes, now].filter(
        (t) => now - t < 3600000,
      ),
      error: '',
    },
  };
}
export function researchSettled(
  state: TopicQueueState,
  result: {
    ok: boolean;
    now: number;
    added?: number;
    cost?: CostEstimate;
    error?: string;
  },
  cfg: TopicConfig = topicConfig,
): TopicQueueState {
  const feed = state.feed;
  const costUsd = feed.costUsd + (result.cost?.usd ?? 0);
  // A call that returns nothing usable is a soft failure: keep the feed live, wait longer.
  const failures = result.ok && result.added ? 0 : feed.failures + 1;
  const backoff = Math.min(
    cfg.backoffBaseMs * 2 ** Math.max(0, failures - 1),
    cfg.backoffMaxMs,
  );
  return {
    ...state,
    feed: {
      ...feed,
      inflight: false,
      costUsd,
      failures,
      lastAdded: result.added ?? 0,
      status: result.ok ? 'live' : 'error',
      error: result.ok ? '' : (result.error ?? 'Research failed.'),
      nextAllowedAt:
        result.now + (result.ok && result.added ? cfg.minGapMs : backoff),
    },
  };
}
export function resetRuntime(state: TopicQueueState): TopicQueueState {
  return {
    ...state,
    batches: 0,
    feedTurns: 0,
    feedSeconds: topicConfig.rotateSeconds,
    lastTopicBatch: -Infinity,
    lastChatBatch: -Infinity,
    topics: state.topics.map((t) =>
      t.status === 'writing' ? { ...t, status: 'queued' } : t,
    ),
    feed: {
      ...state.feed,
      inflight: false,
      status: state.feed.status === 'searching' ? 'idle' : state.feed.status,
    },
  };
}

const ADDRESS = /0x[a-f0-9]{40}/i;
export function prefilterComments(
  batch: Comment[],
  cfg: TopicConfig = topicConfig,
): Comment[] {
  const seen = new Set<string>();
  const keep: Comment[] = [];
  for (const comment of batch) {
    const body = text(comment.text, cfg.limits.comment);
    if (!body || body.split(/\s+/).length < 3) continue;
    if (ADDRESS.test(body)) continue;
    if (/^https?:\/\/\S+$/i.test(body)) continue;
    const key = normalizeTitle(body);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keep.push({
      ...comment,
      text: body,
      author: text(comment.author, cfg.limits.author) || 'anon',
    });
    if (keep.length >= cfg.limits.comments) break;
  }
  return keep;
}
/** Every top-level {...} or [...] span, ignoring brackets inside string literals. */
function jsonSpans(raw: string): string[] {
  const spans: string[] = [];
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    // Only quotes inside a candidate open a string; stray quotes in prose are ignored.
    if (c === '"') {
      if (stack.length) inString = true;
      continue;
    }
    if (c === '{' || c === '[') {
      if (!stack.length) start = i;
      stack.push(c);
    } else if (c === '}' || c === ']') {
      if (!stack.length) continue;
      const open = stack.pop();
      if ((c === '}') !== (open === '{')) {
        stack.length = 0;
        start = -1;
        continue;
      }
      if (!stack.length && start >= 0) {
        spans.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}
const isTopicPayload = (value: unknown) =>
  Array.isArray(value) ||
  (!!value &&
    typeof value === 'object' &&
    Array.isArray((value as { topics?: unknown }).topics));
/**
 * The Grok CLI narrates before it answers and sometimes emits placeholder objects
 * first, so the payload is the LAST well-shaped span, not the first thing that parses.
 */
export function parseTopicJson(raw: string): unknown {
  const clean = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  let shaped: unknown;
  let lastParsed: unknown;
  let found = false;
  for (const span of jsonSpans(clean)) {
    let value: unknown;
    try {
      value = JSON.parse(span);
    } catch {
      continue; // prose braces, a truncated tail
    }
    found = true;
    lastParsed = value;
    if (isTopicPayload(value)) shaped = value;
  }
  if (shaped !== undefined) return shaped;
  if (found) return lastParsed; // an odd shape, e.g. {"error":"..."}
  return JSON.parse(clean); // nothing parsed: throw a real SyntaxError
}
export function readTopicList(raw: string): unknown[] {
  const parsed = parseTopicJson(raw);
  if (Array.isArray(parsed)) return parsed;
  const list = (parsed as { topics?: unknown })?.topics;
  return Array.isArray(list) ? list : [];
}
const PRICES: Record<string, [number, number]> = {
  'grok-4.6': [2, 6],
  'grok-4.5': [2, 6],
  'grok-4.3': [1.25, 2.5],
};
export function estimateCost(
  usage: { input_tokens?: number; output_tokens?: number },
  model: string,
  toolCalls: number,
): CostEstimate {
  const [input, output] = PRICES[model] ?? [2, 6];
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    usd:
      (inputTokens / 1e6) * input +
      (outputTokens / 1e6) * output +
      toolCalls * 0.005,
    inputTokens,
    outputTokens,
    toolCalls,
    model,
  };
}

/** The memecoin and Solana voices the show watches. Override with NEWSDESK_X_HANDLES. */
export const watchlist = [
  '@blknoiz06',
  '@notthreadguy',
  '@0xMert_',
  '@aeyakovenko',
  '@rajgokal',
  '@frankdegods',
  '@inversebrah',
  '@CryptoKaleo',
  '@0xngmi',
  '@weremeow',
  '@theunipcs',
  '@Cbb0fe',
  '@0xSharples',
  '@shawmakesmagic',
  '@zerobeta',
  '@SolanaLegend',
  '@0xdefiwarrior',
  '@iamkadense',
];
/**
 * A stable slice of the roster so calls stay cheap and no one account dominates.
 * `step` is a plain counter: consecutive steps watch different accounts.
 */
export function rotate(pool: string[] | undefined, take: number, step: number) {
  const list = pool?.length ? pool : watchlist;
  const size = Math.min(take, list.length);
  const start = (Math.abs(Math.trunc(step)) * size) % list.length;
  return Array.from({ length: size }, (_, i) => list[(start + i) % list.length]);
}

const CHATTY = /\b(gm|gn|lol|lmao|wen|ser|fren|based|nice|first|hi|hey)\b/gi;
/**
 * Pick the live-chat comments worth airing. A heuristic rather than a model call:
 * it is free, instant, and a comment only needs to be specific and clean to qualify.
 */
export function rankComments(
  comments: Comment[],
  recentTitles: string[],
  k = 3,
  cfg: TopicConfig = topicConfig,
): TopicDraft[] {
  const scored = comments
    .map((comment) => {
      const words = comment.text.trim().split(/\s+/);
      const filler = (comment.text.match(CHATTY) || []).length;
      const score = Math.max(
        0,
        Math.min(
          100,
          30 +
            Math.min(words.length, 25) * 2 +
            Math.min(comment.likes ?? 0, 20) -
            filler * 15 +
            (comment.text.trim().endsWith('?') ? 10 : 0),
        ),
      );
      return { comment, score };
    })
    .filter(({ comment, score }) => {
      if (score < 40) return false;
      const all = comment.text;
      if (ACCUSATION.test(all) || PROMOTION.test(all)) return false;
      return !recentTitles.some((title) => similar(title, all));
    })
    .sort((a, b) => b.score - a.score);
  const picked: TopicDraft[] = [];
  for (const { comment, score } of scored) {
    if (picked.length >= k) break;
    if (picked.some((t) => similar(t.title, comment.text))) continue;
    const draft = sanitizeDraft(
      {
        title: comment.text.replace(/\s+/g, ' ').trim(),
        brief: `${comment.author} asked in the live chat: "${comment.text.trim()}". Nothing else is known about it.`,
        angle: 'Answer the viewer directly, in character.',
        score,
        handle: comment.author,
        category: 'chat',
        commentId: comment.id,
      },
      'chat',
      cfg,
    );
    if (draft) picked.push(draft);
  }
  return picked;
}
