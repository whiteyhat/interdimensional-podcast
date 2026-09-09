import type { Services, Clip } from './engine';
import { readCoinBody } from '@/hooks/use-coin';
import { show, shotInput, scaleInput, type Line } from './show';
import { readRequest, type PaidRequest } from './requests';
import {
  sanitizeDraft,
  type CostEstimate,
  type TopicDraft,
  type TopicSource,
} from './topics';
type Result = {
  token?: string;
  status?: string;
  url?: string;
  lines?: Line[];
  topics?: unknown[];
  requests?: unknown[];
  cost?: CostEstimate;
  error?: string;
  code?: string;
};
class DialogueError extends Error {}
async function api(body: unknown, path = '/api/podcast', signal?: AbortSignal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const data = (await response.json()) as Result;
  if (!response.ok) {
    if (data.code === 'INVALID_DIALOGUE') throw new DialogueError(data.error);
    throw Error(data.error || 'Provider request failed');
  }
  return data;
}
async function poll(token: string) {
  let failures = 0;
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    try {
      const result = await api({ action: 'poll', token });
      failures = 0;
      if (result.status === 'COMPLETED') return result;
    } catch (e) {
      if (e instanceof DialogueError || ++failures >= 3) throw e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error(
    'The job is taking too long. Retry will poll the existing request.',
  );
}
async function topics(body: unknown, forceSource?: TopicSource) {
  const data = await api(body, '/api/topics', AbortSignal.timeout(100000));
  const drafts = (data.topics ?? [])
    .map((raw) => sanitizeDraft(raw, forceSource))
    .filter((draft): draft is TopicDraft => !!draft);
  return { topics: drafts, cost: data.cost };
}
export function createServices(): Services {
  const jobs = new Map<string, string>();
  async function job(key: string, body: unknown) {
    let token = jobs.get(key);
    if (!token) {
      const request = await api(body);
      if (!request.token) throw Error('No job token');
      token = request.token;
      jobs.set(key, token);
    }
    return poll(token);
  }
  return {
    async write(recent, start, cue, topic, from) {
      const key = JSON.stringify([
        `${show.slug}-write-v3`,
        recent,
        start,
        cue,
        topic,
        from,
      ]);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await job(key, {
            action: 'write',
            recent,
            start,
            cue,
            topic,
            from,
          });
          if (!result.lines) throw new DialogueError('No dialogue returned');
          return result.lines;
        } catch (e) {
          if (!(e instanceof DialogueError)) throw e;
          // A completed malformed response cannot improve by polling it again.
          jobs.delete(key);
          if (attempt === 1) throw e;
        }
      }
      throw Error('The dialogue writer could not finish this exchange.');
    },
    async render(line) {
      const start = Date.now();
      const key = JSON.stringify([`${show.slug}-shot-v7`, shotInput(line)]);
      const native = await job(key, { action: 'shot', line });
      if (!native.url) throw Error('No video returned');
      // Cache stages separately: a scaler/download retry must not regenerate speech.
      const scaleKey = JSON.stringify([`${show.slug}-scale-v1`, scaleInput(native.url)]);
      const result = await job(scaleKey, { action: 'scale', url: native.url });
      if (!result.url) throw Error('No scaled video returned');
      const response = await fetch(
        `/api/media?url=${encodeURIComponent(result.url)}`,
      );
      if (!response.ok)
        throw Error('Video download failed. Retry will reuse this shot.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const duration = await new Promise<number>((resolve, reject) => {
          const video = document.createElement('video');
          const timeout = setTimeout(
            () => finish(Error('Video could not be decoded')),
            30000,
          );
          const finish = (error?: Error) => {
            clearTimeout(timeout);
            video.onloadeddata = null;
            video.onerror = null;
            const duration = video.duration;
            video.removeAttribute('src');
            video.load();
            if (error) reject(error);
            else resolve(duration);
          };
          video.muted = true;
          video.preload = 'auto';
          video.onloadeddata = () => finish();
          video.onerror = () =>
            finish(Error('Generated video is not playable'));
          video.src = url;
          video.load();
        });
        return {
          ...line,
          url,
          rawUrl: result.url,
          duration,
          renderMs: Date.now() - start,
        } satisfies Clip;
      } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
      }
    },
    async news(input) {
      return topics({ action: 'news', ...input }, 'web');
    },
    async research(input) {
      return topics({ action: 'research', ...input });
    },
    requests: {
      // The studio claims paid requests from the site; the local worker adds the studio token.
      async pull() {
        const data = await api(
          { action: 'pull' },
          '/api/interact',
          AbortSignal.timeout(15000),
        );
        return (data.requests ?? [])
          .map(readRequest)
          .filter((r): r is PaidRequest => !!r);
      },
      async aired(reference) {
        await api({ action: 'aired', reference }, '/api/interact', AbortSignal.timeout(15000));
      },
    },
    async coin() {
      const response = await fetch('/api/coin', {
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      const data: unknown = await response.json();
      const reading = readCoinBody(data);
      if (!response.ok || !reading)
        throw Error((data as { error?: string })?.error || 'Chart unavailable');
      return reading;
    },
    release(url) {
      URL.revokeObjectURL(url);
    },
  };
}
