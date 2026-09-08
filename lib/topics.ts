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
  'title' | 'brief' | 'angle' | 'source' | 'handle' | 'url'
>;
/** Provenance stamped on the first line of a batch; small enough for the signed job token. */
export type TopicTag = Pick<TopicDraft, 'title' | 'source' | 'handle' | 'url'>;
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
  // Write batches between automatic topics. Four spoken turns per batch, roughly 22 seconds.
  cadence: { chat: 2, feed: 7 },
  minQueued: 2,
  staleMs: 10 * 60000,
  minGapMs: 60000,
  maxCallsPerHour: 20,
  backoffBaseMs: 30000,
  backoffMaxMs: 10 * 60000,
  maxQueued: 8,
  maxAgeMs: 20 * 60000,
  keepUsed: 12,
  recentTitles: 20,
  limits: {
    title: 80,
    brief: 500,
    angle: 200,
    handle: 32,
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
  return {
    title,
    brief,
    angle: angle || 'Play the situation straight and let the hosts react.',
    source,
    score,
    ...(httpsUrl(item.url, cfg.limits.url) ? { url: item.url as string } : {}),
    ...(handle ? { handle } : {}),
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
    ...(topic.url ? { url: topic.url } : {}),
  };
}
export function tagOf(topic: TopicBrief): TopicTag {
  return {
    title: topic.title,
    source: topic.source,
    ...(topic.handle ? { handle: topic.handle } : {}),
    ...(topic.url ? { url: topic.url } : {}),
  };
}
export function sourceLabel(topic: TopicTag) {
  if (topic.source === 'x')
    return topic.handle ? `via ${topic.handle} on X` : 'trending on X';
  if (topic.source === 'web') {
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
      now - t.at > cfg.maxAgeMs,
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
    const evict = [...queued]
      .sort((a, b) => a.score - b.score || a.at - b.at)
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
  const rank = (t: Topic) => (t.pinned ? 0 : t.source === 'chat' ? 1 : 2);
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
  const feed = ordered.find((t) => FEED_SOURCES.includes(t.source));
  if (feed && state.batches - state.lastTopicBatch >= cfg.cadence.feed)
    return feed;
  return undefined;
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
): TopicQueueState {
  return {
    ...state,
    batches: state.batches + 1,
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
    unusedFeedCount(state) < cfg.minQueued ||
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
export function parseTopicJson(raw: string): unknown {
  let clean = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  const start = clean.search(/[[{]/);
  if (start > 0) clean = clean.slice(start);
  return JSON.parse(clean);
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
