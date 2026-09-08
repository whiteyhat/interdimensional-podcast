import { env } from 'cloudflare:workers';
import {
  cast,
  lintVoices,
  parseLines,
  shotPrompt,
  shotDuration,
  writerSystem,
  type Line,
  type Speaker,
} from '@/lib/show';
import {
  sanitizeBrief,
  sourceLabel,
  tagOf,
  type TopicBrief,
} from '@/lib/topics';
const encoder = new TextEncoder();
function key() {
  return (env as unknown as { FAL_KEY?: string }).FAL_KEY;
}
const reply = (body: unknown, status = 200) => Response.json(body, { status });
async function signature(value: string, secret: string) {
  const k = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(value))),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
async function sign(data: unknown, secret: string) {
  const value = btoa(
    String.fromCharCode(...encoder.encode(JSON.stringify(data))),
  );
  return value + '.' + (await signature(value, secret));
}
async function unpack(token: unknown, secret: string) {
  if (typeof token !== 'string' || token.length > 8000)
    throw Error('Invalid job token');
  const [value, sig] = token.split('.');
  if ((await signature(value, secret)) !== sig)
    throw Error('Invalid job token');
  const job = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
    ),
  );
  if (Date.now() - job.time > 86400000) throw Error('Job expired');
  for (const name of ['status_url', 'response_url']) {
    const u = new URL(job[name]);
    if (u.protocol !== 'https:' || u.hostname !== 'queue.fal.run')
      throw Error('Invalid job URL');
  }
  return job;
}
async function provider(url: string, secret: string, body?: unknown) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Key ${secret}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await response.json()) as {
    detail?: unknown;
    error?: unknown;
    status?: string;
    output?: string;
    video?: { url: string };
    status_url?: string;
    response_url?: string;
    request_id?: string;
  };
  if (!response.ok)
    throw Error(
      `Generation provider returned ${response.status}: ${JSON.stringify(data.detail || data.error || 'request failed').slice(0, 350)}`,
    );
  return data;
}
function writerRequest(cue?: string, topic?: TopicBrief) {
  if (cue) return `Audience request: ${cue}`;
  if (topic)
    return topic.source === 'x'
      ? `LIVE TAKE: ${topic.who || topic.handle || 'someone on the timeline'} posted this on X.\nTHE TAKE: ${topic.title}\nWHAT'S HAPPENING: ${topic.brief}\nANGLE: ${topic.angle}\nPepe brings it up and names them; GigaChad answers the take without citing anyone.`
      : `LIVE TOPIC: ${topic.title}\nWHAT'S HAPPENING: ${topic.brief}\nANGLE: ${topic.angle}\nSOURCE: ${sourceLabel(topic)}`;
  return 'Audience request: None. Keep riffing on the current subject with a fresh concrete angle.';
}
export async function GET() {
  return reply({ configured: !!key() });
}
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return reply({ error: 'Origin not allowed' }, 403);
  const secret = key();
  if (!secret)
    return reply({ error: 'FAL_KEY is missing from .dev.vars.' }, 503);
  try {
    const body = (await request.json()) as {
      action: string;
      token?: string;
      line?: Line;
      recent?: Line[];
      start?: number;
      cue?: string;
      topic?: unknown;
    };
    if (body.action === 'poll') {
      const job = await unpack(body.token, secret);
      const state = await provider(job.status_url, secret);
      if (state.status !== 'COMPLETED') return reply({ status: state.status });
      const result = await provider(job.response_url, secret);
      if (job.action === 'write') {
        try {
          if (typeof result.output !== 'string') throw Error('Missing dialogue');
          const lines = parseLines(result.output, job.start, job.cue, job.topic);
          const slips = lintVoices(lines);
          if (slips.length) {
            console.warn('[writer] voice lint', slips);
            if ((env as unknown as { WRITER_STRICT_VOICE?: string }).WRITER_STRICT_VOICE === '1')
              throw Error('Out-of-character dialogue');
          }
          return reply({ status: 'COMPLETED', lines });
        } catch (e) {
          console.warn(
            '[writer] rejected exchange:',
            e instanceof Error ? e.message : e,
            JSON.stringify(String(result.output ?? '').slice(0, 400)),
          );
          return reply({ code: 'INVALID_DIALOGUE', error: 'The writer returned an unusable exchange. Please retry the dialogue.' }, 422);
        }
      }
      const url = result.video?.url;
      if (
        typeof url !== 'string' ||
        !/^https:\/\/(?:[a-z0-9-]+\.)*fal\.media\//i.test(url)
      )
        throw Error('Provider returned no video');
      return reply({ status: 'COMPLETED', url });
    }
    let endpoint: string, input: Record<string, unknown>;
    let topic: TopicBrief | undefined;
    if (body.action === 'shot') {
      if (!body.line || !['host', 'guest'].includes(body.line.speaker))
        return reply({ error: 'Invalid speaker' }, 400);
      const speaker = body.line.speaker as Speaker;
      input = {
        image_url: cast[speaker].source,
        prompt: shotPrompt(speaker, body.line.text),
        duration: shotDuration(body.line.text),
        resolution: '480P',
        prompt_expansion_mode: 'disabled',
        seed: cast[speaker].seed,
      };
      endpoint = 'minimax/h3-max-turbo/image-to-video';
    } else if (body.action === 'write') {
      if (
        !Number.isInteger(body.start) ||
        body.start! < 0 ||
        !Array.isArray(body.recent) ||
        body.recent.length > 12 ||
        (body.cue && body.cue.length > 240)
      )
        return reply({ error: 'Invalid writer context' }, 400);
      if (body.topic !== undefined && !sanitizeBrief(body.topic))
        return reply({ error: 'Invalid topic' }, 400);
      topic = body.topic === undefined ? undefined : sanitizeBrief(body.topic)!;
      const recent = body.recent
        .map((l) => {
          if (
            !['host', 'guest'].includes(l.speaker) ||
            typeof l.text !== 'string' ||
            l.text.length > 180
          )
            throw Error('Invalid transcript');
          return `${l.speaker}: ${l.text}`;
        })
        .join('\n');
      input = {
        model: 'google/gemini-2.5-flash',
        system_prompt: writerSystem,
        prompt: `COMMITTED TRANSCRIPT (including buffered footage):\n${recent || 'The conversation is just beginning.'}\nFirst speaker: ${cast[body.start! % 2 === 0 ? 'host' : 'guest'].name.toUpperCase()}.\n${writerRequest(body.cue, topic)}\nWrite the next four turns. If there is an audience request or live topic, the first turn must connect the prior detail to its subject, and the second must already be about that subject. For a live topic, one of the first two turns states plainly what happened using only WHAT'S HAPPENING, then the hosts react in their own kinds of lines; use ANGLE as the comedic direction, not as a line to read. Keep the delivery casual and the connection understandable.`,
        max_tokens: 700,
        temperature: 0.9,
      };
      endpoint = 'openrouter/router';
    } else return reply({ error: 'Unknown action' }, 400);
    const job = await provider(
      `https://queue.fal.run/${endpoint}`,
      secret,
      input,
    );
    return reply({
      token: await sign(
        {
          action: body.action,
          start: body.start,
          cue: body.cue,
          topic: topic && tagOf(topic),
          status_url: job.status_url,
          response_url: job.response_url,
          time: Date.now(),
        },
        secret,
      ),
      requestId: job.request_id,
    });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : 'Generation failed' },
      400,
    );
  }
}
