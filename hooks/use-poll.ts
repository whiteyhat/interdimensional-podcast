'use client';
import { useEffect, useRef, useState } from 'react';
/**
 * The one polling loop the site uses: fetch, parse, keep the last good value, and wait.
 * Nothing is fetched while the tab is hidden, and a failed poll never blanks the screen.
 */
export type Poll<T> = { data: T | null; error: string };
export type PollOptions<T> = {
  /** Fixed milliseconds, or a function of the last value so a hook can speed up while busy. */
  intervalMs: number | ((data: T | null) => number);
  /** Shown when the request fails or the body does not parse. */
  errorText: string;
};
/** What we hold is stamped with the url it came from, so a new subject never shows a stale answer. */
type Held<T> = { url: string; data: T | null; error: string };
export function usePoll<T>(
  url: string,
  parse: (raw: unknown, ok: boolean) => T | null,
  { intervalMs, errorText }: PollOptions<T>,
): Poll<T> {
  const [held, setHeld] = useState<Held<T>>({ url, data: null, error: '' });
  // Callers may pass an inline parser or cadence. Reading them through a ref keeps their
  // identity out of the effect, so a re-render never restarts the loop mid-flight.
  const latest = useRef({ parse, intervalMs, errorText });
  useEffect(() => {
    latest.current = { parse, intervalMs, errorText };
  });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: T | null = null;
    async function load() {
      if (!alive) return;
      const { parse: read, intervalMs: every, errorText: message } = latest.current;
      if (document.visibilityState === 'visible') {
        try {
          const response = await fetch(url);
          const raw: unknown = await response.json();
          if (!alive) return;
          const data = read(raw, response.ok);
          last = data ?? last;
          setHeld({ url, data: last, error: data ? '' : message });
        } catch {
          if (!alive) return;
          setHeld({ url, data: last, error: message });
        }
      }
      if (alive) timer = setTimeout(load, typeof every === 'function' ? every(last) : every);
    }
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url]);
  return held.url === url ? { data: held.data, error: held.error } : { data: null, error: '' };
}
