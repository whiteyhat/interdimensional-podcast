// One way to read JSON from the public data APIs (pump.fun, Jupiter, Google News).
// The user agent and the timeout are policy: pump.fun rate-limits on both, so they
// live here rather than in each route.
export const userAgent = 'Mozilla/5.0 (compatible; PepeAndChadLive/1.0)';
export type JsonOptions = {
  timeoutMs?: number;
  /** Seconds the Workers subrequest cache may reuse this answer across isolates. */
  cacheTtl?: number;
};
export async function fetchJson(url: string, options: JsonOptions = {}): Promise<unknown> {
  const { timeoutMs = 8000, cacheTtl } = options;
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    ...(cacheTtl ? { cf: { cacheTtl, cacheEverything: true } } : { cache: 'no-store' as const }),
  });
  if (!response.ok) throw Error(`${new URL(url).hostname} returned ${response.status}`);
  return response.json();
}
