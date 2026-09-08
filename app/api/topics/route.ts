import { env } from 'cloudflare:workers';
import {
  rankSchema,
  rankSystem,
  rankUser,
  researchSchema,
  researchSystem,
  researchUser,
} from '@/lib/newsdesk';
import {
  estimateCost,
  parseTopicJson,
  prefilterComments,
  sanitizeDraft,
  topicConfig,
  type Comment,
  type TopicDraft,
} from '@/lib/topics';
type Vars = {
  XAI_API_KEY?: string;
  XAI_MODEL?: string;
  XAI_RANK_MODEL?: string;
  XAI_X_HANDLES?: string;
  XAI_STRUCTURED?: string;
  FAL_KEY?: string;
};
type Content = {
  type?: string;
  text?: string;
  annotations?: { url?: string }[];
};
type GrokResponse = {
  output?: {
    type?: string;
    role?: string;
    content?: Content[];
  }[];
  citations?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    num_server_side_tools_used?: number;
  };
  error?: unknown;
  detail?: unknown;
};
const vars = () => env as unknown as Vars;
const reply = (body: unknown, status = 200) => Response.json(body, { status });
const model = () => vars().XAI_MODEL || 'grok-4.6';
const rankModel = () => vars().XAI_RANK_MODEL || 'grok-4.3';
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
let loggedShape = false;

async function grok(secret: string, body: unknown, timeoutMs = 90000) {
  const response = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await response.json()) as GrokResponse;
  if (!response.ok)
    throw Object.assign(
      Error(
        `Research provider returned ${response.status}: ${JSON.stringify(data.detail || data.error || 'request failed').slice(0, 350)}`,
      ),
      { status: response.status },
    );
  return data;
}
function extractText(data: GrokResponse) {
  const output = data.output ?? [];
  if (!loggedShape) {
    loggedShape = true;
    console.log(
      '[topics] grok shape',
      JSON.stringify({
        keys: Object.keys(data),
        output: output.map((o) => o.type),
        usage: Object.keys(data.usage ?? {}),
      }),
    );
  }
  const messages = output.filter((o) => o.type === 'message');
  const content = messages.at(-1)?.content ?? [];
  const text = content
    .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
  const citations = new Set<string>();
  for (const part of content)
    for (const note of part.annotations ?? [])
      if (typeof note.url === 'string') citations.add(note.url);
  if (Array.isArray(data.citations))
    for (const url of data.citations)
      if (typeof url === 'string') citations.add(url);
  const toolCalls = Math.max(
    output.filter((o) => (o.type ?? '').endsWith('_search_call')).length,
    data.usage?.num_server_side_tools_used ?? 0,
  );
  return { text, citations: [...citations], toolCalls };
}
function readTopics(raw: string): unknown[] {
  const parsed = parseTopicJson(raw);
  if (Array.isArray(parsed)) return parsed;
  const list = (parsed as { topics?: unknown })?.topics;
  return Array.isArray(list) ? list : [];
}
const strings = (value: unknown, count: number, length: number) =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string')
        .slice(0, count)
        .map((v) => v.slice(0, length))
    : [];

export async function GET() {
  const config = vars();
  return reply({
    configured: { xai: !!config.XAI_API_KEY, fal: !!config.FAL_KEY },
    model: model(),
    rankModel: rankModel(),
  });
}
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return reply({ error: 'Origin not allowed' }, 403);
  const secret = vars().XAI_API_KEY;
  if (!secret)
    return reply({ error: 'XAI_API_KEY is missing from .dev.vars.' }, 503);
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
    let payload: Record<string, unknown>;
    let used: string;
    let comments: Comment[] = [];

    if (body.action === 'research') {
      used = model();
      const now = Date.now();
      const handles = strings(
        vars().XAI_X_HANDLES?.split(',').map((h) => h.trim()),
        20,
        limits.handle,
      );
      payload = {
        model: used,
        input: [
          { role: 'system', content: researchSystem },
          {
            role: 'user',
            content: researchUser({
              now: new Date(now).toISOString(),
              avoid: strings(body.avoid, limits.avoid, limits.title),
              onAir:
                typeof body.onAir === 'string'
                  ? body.onAir.slice(0, limits.title)
                  : undefined,
              focus:
                typeof body.focus === 'string'
                  ? body.focus.slice(0, 120)
                  : undefined,
            }),
          },
        ],
        tools: [
          {
            type: 'x_search',
            from_date: utcDate(now - 86400000),
            to_date: utcDate(now),
            ...(handles.length ? { allowed_x_handles: handles } : {}),
          },
          { type: 'web_search' },
        ],
        max_output_tokens: 2500,
        temperature: 0.7,
        store: false,
      };
    } else if (body.action === 'rank') {
      used = rankModel();
      if (!Array.isArray(body.comments))
        return reply({ error: 'Invalid comments' }, 400);
      comments = prefilterComments(body.comments as Comment[]);
      if (!comments.length) return reply({ topics: [], model: used, ms: 0 });
      const k = Number(body.k);
      payload = {
        model: used,
        input: [
          { role: 'system', content: rankSystem },
          {
            role: 'user',
            content: rankUser({
              comments,
              recentTitles: strings(
                body.recentTitles,
                limits.avoid,
                limits.title,
              ),
              onAir:
                typeof body.onAir === 'string'
                  ? body.onAir.slice(0, limits.title)
                  : undefined,
              k: Number.isFinite(k) ? Math.max(1, Math.min(5, k)) : 3,
            }),
          },
        ],
        max_output_tokens: 1200,
        temperature: 0.3,
        store: false,
      };
    } else return reply({ error: 'Unknown action' }, 400);

    const schema = body.action === 'research' ? researchSchema : rankSchema;
    const structured = vars().XAI_STRUCTURED !== '0';
    let data: GrokResponse;
    try {
      data = await grok(
        secret,
        structured
          ? {
              ...payload,
              text: {
                format: {
                  type: 'json_schema',
                  name: 'topics',
                  schema,
                  strict: true,
                },
              },
            }
          : payload,
      );
    } catch (e) {
      // Some model or tool combinations reject the schema; the parser tolerates plain JSON.
      const status = (e as { status?: number }).status;
      if (!structured || !status || status >= 500) throw e;
      console.warn('[topics] retrying without structured output');
      data = await grok(secret, payload);
    }

    const { text, citations, toolCalls } = extractText(data);
    let raw: unknown[] = [];
    let warning: string | undefined;
    try {
      raw = readTopics(text);
    } catch {
      warning = 'The news desk returned unreadable JSON.';
    }
    const byId = new Map(comments.map((c) => [c.id, c]));
    const topics = raw
      .map((entry) => {
        const draft = sanitizeDraft(
          entry,
          body.action === 'rank' ? 'chat' : undefined,
        );
        if (!draft) return null;
        if (body.action === 'rank') {
          const comment = draft.commentId ? byId.get(draft.commentId) : undefined;
          return {
            ...draft,
            category: 'chat' as const,
            ...(comment ? { handle: comment.author } : {}),
          };
        }
        return draft.url || !citations.length
          ? draft
          : { ...draft, url: citations[0] };
      })
      .filter((draft): draft is TopicDraft => !!draft);
    const cost = estimateCost(data.usage ?? {}, used, toolCalls);
    const ms = Date.now() - started;
    console.log(
      `[topics] ${body.action} model=${used} in=${cost.inputTokens} out=${cost.outputTokens} tools=${toolCalls} usd=${cost.usd.toFixed(4)} ms=${ms} topics=${topics.length}`,
    );
    return reply({
      topics,
      cost,
      model: used,
      ms,
      sources: citations.length,
      ...(warning ? { warning } : {}),
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : 'The news desk request failed';
    console.warn('[topics] failed', message);
    return reply({ error: message }, 502);
  }
}
