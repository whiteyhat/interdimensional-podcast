import { env } from 'cloudflare:workers';
import { clusterItems, feedUrl, feeds, parseRss, toDrafts } from '@/lib/gnews';
import { deskUser, researchUser } from '@/lib/newsdesk';
import {
  estimateCost,
  prefilterComments,
  rankComments,
  readTopicList,
  rotate,
  sanitizeDraft,
  topicConfig,
  type Comment,
  type TopicDraft,
} from '@/lib/topics';
type Vars = {
  FAL_KEY?: string;
  NEWSDESK_URL?: string;
  NEWSDESK_TOKEN?: string;
  NEWSDESK_X_HANDLES?: string;
};
type DeskEnvelope = {
  ok?: boolean;
  text?: string;
  detail?: string;
  structuredOutput?: unknown;
  stopReason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  totalCostUsd?: number;
  ms?: number;
  error?: string;
  reason?: string;
};
const vars = () => env as unknown as Vars;
const reply = (body: unknown, status = 200) => Response.json(body, { status });
const deskUrl = () => vars().NEWSDESK_URL || 'http://127.0.0.1:8791';
const strings = (value: unknown, count: number, length: number) =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string')
        .slice(0, count)
        .map((v) => v.slice(0, length))
    : [];

/**
 * The one seam to the Grok CLI. Everything else in this file is transport-agnostic,
 * so swapping in an API key later means rewriting this function and nothing else.
 */
async function desk(prompt: string, timeoutMs = 185000): Promise<DeskEnvelope> {
  const response = await fetch(`${deskUrl()}/run`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      'x-newsdesk-token': vars().NEWSDESK_TOKEN || 'local',
    },
    body: JSON.stringify({ kind: 'research', prompt }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await response.json()) as DeskEnvelope;
  if (!response.ok)
    throw Object.assign(Error(data.error || `News desk returned ${response.status}`), {
      status: response.status,
      reason: data.reason,
    });
  return data;
}

/** The free lane: Google News RSS, fetched and filtered inside the Worker. */
async function newsTopics(): Promise<TopicDraft[]> {
  const now = Date.now();
  const results = await Promise.all(
    feeds.map(async (feed) => {
      try {
        const response = await fetch(feedUrl(feed), {
          cache: 'no-store',
          redirect: 'follow',
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; PepeAndChadLive/1.0)' },
        });
        if (!response.ok) return [];
        // Search feeds cluster less than topic sections, so they need a lower bar
        // to produce anything at all; two outlets still means it is not one blog.
        const parsed = parseRss(await response.text());
        // Search feeds ship no cluster block, so rebuild it from matching headlines.
        return feed.query
          ? toDrafts(clusterItems(parsed), now, feed.category, 2)
          : toDrafts(parsed, now, feed.category);
      } catch {
        return []; // one dead feed must never take the lane down
      }
    }),
  );
  return results.flat();
}

export async function GET() {
  const config = vars();
  let health: unknown = { ok: false, reason: 'offline' };
  try {
    const response = await fetch(`${deskUrl()}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) health = await response.json();
  } catch {
    // The desk being down is normal; the free lane carries the show.
  }
  return reply({
    configured: { feed: true, fal: !!config.FAL_KEY },
    newsdesk: health,
  });
}
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return reply({ error: 'Origin not allowed' }, 403);
  const started = Date.now();
  try {
    const body = (await request.json()) as {
      action?: string;
      avoid?: unknown;
      onAir?: unknown;
      focus?: unknown;
      comments?: unknown;
      recentTitles?: unknown;
      k?: unknown;
    };
    const limits = topicConfig.limits;
    const avoid = strings(body.avoid, limits.avoid, limits.title);
    const onAir =
      typeof body.onAir === 'string' ? body.onAir.slice(0, limits.title) : undefined;

    if (body.action === 'news') {
      const topics = await newsTopics();
      const fresh = topics.filter(
        (t) => !avoid.some((a) => a.toLowerCase() === t.title.toLowerCase()),
      );
      console.log(`[topics] news items=${fresh.length} ms=${Date.now() - started}`);
      return reply({ topics: fresh, model: 'google-news-rss', ms: Date.now() - started });
    }

    if (body.action === 'rank') {
      // Ranking is a local heuristic now: no model call, no cost, no latency.
      if (!Array.isArray(body.comments))
        return reply({ error: 'Invalid comments' }, 400);
      const comments = prefilterComments(body.comments as Comment[]);
      const k = Number(body.k);
      const topics = rankComments(
        comments,
        strings(body.recentTitles, limits.avoid, limits.title),
        Number.isFinite(k) ? Math.max(1, Math.min(5, k)) : 3,
      );
      return reply({ topics, model: 'local', ms: Date.now() - started });
    }

    if (body.action !== 'research') return reply({ error: 'Unknown action' }, 400);

    const handles = strings(
      vars().NEWSDESK_X_HANDLES?.split(',').map((h) => h.trim()),
      40,
      limits.handle,
    );
    const prompt = researchUser({
      handles: rotate(handles.length ? handles : undefined, 4, Math.floor(Date.now() / 600000)),
      avoid,
      onAir,
      focus: typeof body.focus === 'string' ? body.focus.slice(0, 120) : undefined,
    });
    const envelope = await desk(`${deskUser}\n\n${prompt}`);
    const topics = readTopicList(envelope.text ?? '')
      .map((entry) => sanitizeDraft(entry, 'x'))
      .filter((draft): draft is TopicDraft => !!draft);
    const cost = {
      ...estimateCost(envelope.usage ?? {}, 'grok-cli', 0),
      usd: envelope.totalCostUsd ?? 0,
    };
    const ms = Date.now() - started;
    console.log(
      `[topics] research topics=${topics.length} usd=${cost.usd.toFixed(4)} ms=${ms}`,
    );
    return reply({
      topics,
      cost,
      model: 'grok-cli',
      ms,
      ...(topics.length ? {} : { warning: 'The desk returned nothing usable.' }),
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    const reason = (e as { reason?: string }).reason;
    const message =
      e instanceof Error ? e.message : 'The news desk request failed';
    console.warn('[topics] failed', message);
    // 503 means the desk is missing or logged out: park the lane instead of retrying.
    return reply(
      { error: message, ...(status === 503 ? { fatal: true, reason } : {}) },
      status === 503 ? 503 : 502,
    );
  }
}
