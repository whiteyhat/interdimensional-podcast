import type { Services, Clip } from './engine';
import { SpeechError } from './speech';
import { createSponsorServices } from './sponsor-delivery-client';
import { readCoinBody } from '@/hooks/use-coin';
import { show, shotInput, scaleInput, type Line } from './show';
import { readRequest, StudioBusyError, type PaidRequest } from './requests';
import {
  sanitizeDraft,
  type CostEstimate,
  type TopicDraft,
  type TopicSource,
} from './topics';
type Result = {
  token?: string;
  speechEnd?: number;
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
class WearableError extends Error {}
async function api(body: unknown, path = '/api/podcast', signal?: AbortSignal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const data = (await response.json()) as Result;
  if (!response.ok) {
    if (data.code === 'INVALID_SPEECH') throw new SpeechError(data.error);
    if (data.code === 'INVALID_DIALOGUE') throw new DialogueError(data.error);
    if (data.code === 'STUDIO_BUSY') throw new StudioBusyError(data.error);
    if (data.code === 'INVALID_WEARABLE') throw new WearableError(data.error);
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
      if (
        e instanceof DialogueError ||
        e instanceof SpeechError ||
        ++failures >= 3
      )
        throw e;
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
  const speechRetries = new Map<string, number>();
  const wardrobeRetries = new Map<string, number>();
  const media = new Map<string, string>();
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
    sponsors: createSponsorServices(),
    async write(recent, start, cue, topic, from, sponsorship) {
      const key = JSON.stringify([
        `${show.slug}-write-v3`,
        recent,
        start,
        cue,
        topic,
        from,
        sponsorship,
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
            sponsorship,
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
    async render(line): Promise<Clip> {
      const start = Date.now();
      const input = shotInput(line);
      const identity = JSON.stringify([input, line.wardrobe]);
      const attempt =
        (speechRetries.get(identity) ?? 0) +
        (wardrobeRetries.get(identity) ?? 0);
      const key = JSON.stringify([
        `${show.slug}-shot-v9`,
        input,
        line.wardrobe,
        attempt,
      ]);
      const native = await job(key, { action: 'shot', line, attempt });
      if (!native.url) throw Error('No video returned');
      // Cache stages separately: a scaler/download retry must not regenerate speech.
      const scaleKey = JSON.stringify([
        `${show.slug}-scale-v1`,
        scaleInput(native.url),
      ]);
      const speechKey = JSON.stringify([
        `${show.slug}-speech-v1`,
        native.url,
        line.text,
      ]);
      const rejectSpeech = (error: unknown): never => {
        if (error instanceof SpeechError) {
          speechRetries.set(identity, Math.min(100, attempt + 1));
          jobs.delete(key);
          jobs.delete(speechKey);
        }
        throw error;
      };
      // A cap shot is composited on the take as the model made it, the only frame the cap's
      // qualification covers, and the media desk scales the verified composite to 1080 itself.
      // Fal's scaler would hand the tracker a frame it was never proven on: twice the pixels,
      // every tracking error grown by the scale, and real takes lost or out of time.
      const [result, speech] = await Promise.all([
        line.wardrobe
          ? ({ url: native.url } as Result)
          : job(scaleKey, { action: 'scale', url: native.url }),
        job(speechKey, { action: 'speech', url: native.url, line }),
      ]).catch(rejectSpeech);
      if (
        typeof speech.speechEnd !== 'number' ||
        !Number.isFinite(speech.speechEnd) ||
        speech.speechEnd <= 0 ||
        speech.speechEnd > 16
      )
        return rejectSpeech(
          new SpeechError('No verified speech boundary returned'),
        );
      if (!result.url) throw Error('No scaled video returned');
      let finalUrl = result.url;
      if (line.wardrobe) {
        const mediaKey = JSON.stringify([result.url, line.wardrobe]);
        finalUrl = media.get(mediaKey) || '';
        if (!finalUrl) {
          try {
            const composed = (await api(
              {
                orderId: line.wardrobe.orderId,
                leaseToken: line.wardrobe.leaseToken,
                videoUrl: result.url,
              },
              '/api/sponsorship/media',
              AbortSignal.timeout(120000),
            )) as Result & {
              quality?: { accepted?: boolean; audioVerified?: boolean };
            };
            if (
              !composed.url ||
              composed.quality?.accepted !== true ||
              composed.quality?.audioVerified !== true
            )
              throw new WearableError(
                'The cap placement did not pass its visual and audio checks.',
              );
            finalUrl = composed.url;
            media.set(mediaKey, finalUrl);
          } catch (error) {
            if (
              error instanceof WearableError &&
              (wardrobeRetries.get(identity) ?? 0) < 2
            ) {
              wardrobeRetries.set(
                identity,
                (wardrobeRetries.get(identity) ?? 0) + 1,
              );
              return this.render(line);
            }
            throw error;
          }
        }
      }
      const response = await fetch(
        line.wardrobe
          ? finalUrl
          : `/api/media?url=${encodeURIComponent(finalUrl)}`,
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
        if (speech.speechEnd > duration)
          throw new SpeechError('Speech boundary exceeds clip duration');
        return {
          ...line,
          url,
          rawUrl: finalUrl,
          duration,
          speechEnd: speech.speechEnd,
          renderMs: Date.now() - start,
        } satisfies Clip;
      } catch (e) {
        URL.revokeObjectURL(url);
        return rejectSpeech(e);
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
        await api(
          { action: 'aired', reference },
          '/api/interact',
          AbortSignal.timeout(15000),
        );
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
