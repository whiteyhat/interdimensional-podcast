// How the Worker talks to the RPC provider: with a deadline, and again when the network fails.
//
// One transient failure used to fail a payment outright. Every method the proxy forwards is
// safe to repeat -- the reads are idempotent and a signed Solana transaction is idempotent by
// its signature, so re-sending the same bytes cannot double-spend -- which is what makes a
// retry correct here and not merely convenient.
//
// What is retried: a thrown fetch (network, DNS, timeout), 429, and 5xx. What is not: any
// 2xx, because a JSON-RPC error inside a 200 is a real answer (a bad blockhash, an
// insufficient balance) and asking again would only delay telling the wallet.
export const upstreamPolicy = {
  attempts: 3,
  /** Per attempt. Helius answers in well under a second; a slow node should not eat the budget. */
  attemptTimeoutMs: 6_000,
  /** Across all attempts, so the Worker's own deadline is never the thing that fires. */
  totalTimeoutMs: 15_000,
  backoffMs: [250, 750],
} as const;
const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.5);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly attempts: number,
  ) {
    super(message);
  }
}
/**
 * Repeat `fn` while `retryIf` says the failure is transient, with a short backoff. Exposed for
 * the server-side money path, which calls the provider through @solana/kit rather than fetch.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retryIf: (e: unknown) => boolean,
  attempts = upstreamPolicy.attempts,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts - 1 || !retryIf(e)) throw e;
      await sleep(jitter(upstreamPolicy.backoffMs[Math.min(i, upstreamPolicy.backoffMs.length - 1)]));
    }
  }
  throw last;
}
/** A network-level failure from @solana/kit's transport, as opposed to an answer from the node. */
export function isTransportError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const text = `${e.name} ${e.message}`;
  // kit wraps HTTP failures as "HTTP error (503)"; a fetch that never connected is a TypeError.
  return /HTTP error \((?:429|5\d\d)\)/.test(text) || /fetch failed|network|ECONNRESET|socket/i.test(text);
}
export type Forwarded = { status: number; body: string; attempts: number };
/**
 * POST a JSON-RPC body to the provider and return its answer untouched. Throws UpstreamError
 * only when every attempt failed at the transport level.
 */
export async function forwardJsonRpc(
  url: string,
  body: string,
  fetcher: typeof fetch = fetch,
): Promise<Forwarded> {
  const deadline = Date.now() + upstreamPolicy.totalTimeoutMs;
  let last: { status: number | null; message: string } = { status: null, message: 'no attempt' };
  for (let attempt = 1; attempt <= upstreamPolicy.attempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(Math.min(upstreamPolicy.attemptTimeoutMs, remaining)),
      });
      if (response.status === 429 || response.status >= 500) {
        last = { status: response.status, message: `provider returned ${response.status}` };
      } else {
        return { status: response.status, body: await response.text(), attempts: attempt };
      }
    } catch (e) {
      last = { status: null, message: e instanceof Error ? e.message : String(e) };
    }
    if (attempt < upstreamPolicy.attempts) {
      const wait = jitter(upstreamPolicy.backoffMs[Math.min(attempt - 1, upstreamPolicy.backoffMs.length - 1)]);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
  }
  throw new UpstreamError(last.message, last.status, upstreamPolicy.attempts);
}
