import type { Services, Clip } from './engine';
import { shotDuration, type Line } from './show';
type Result = {
  token?: string;
  status?: string;
  url?: string;
  lines?: Line[];
  error?: string;
  code?: string;
};
class DialogueError extends Error {}
async function api(body: unknown) {
  const response = await fetch('/api/podcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
    async write(recent, start, cue) {
      const key = JSON.stringify(['naughty-nice-write-clean-v2', recent, start, cue]);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await job(key, { action: 'write', recent, start, cue });
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
      const key = JSON.stringify(['naughty-nice-shot-v1', line.speaker, line.text, shotDuration(line.text)]);
      const result = await job(key, { action: 'shot', line });
      if (!result.url) throw Error('No video returned');
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
    release(url) {
      URL.revokeObjectURL(url);
    },
  };
}
