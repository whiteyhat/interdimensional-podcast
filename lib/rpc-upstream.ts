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
    readonly attempts: number,
  ) {
    super(message);
  }
}
/**
 * Repeat `fn` while `retryIf` says the failure is transient, with a short backoff and, when
 * `totalMs` is given, a deadline the attempts share. Each attempt is handed a signal sized to
 * whichever is shorter, the per-attempt timeout or what is left of the deadline.
 */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  retryIf: (e: unknown) => boolean,
  { attempts = upstreamPolicy.attempts, totalMs = Infinity } = {},
): Promise<T> {
  const deadline = Date.now() + totalMs;
  for (let i = 1; ; i++) {
    try {
      return await fn(AbortSignal.timeout(Math.min(upstreamPolicy.attemptTimeoutMs, deadline - Date.now())));
    } catch (e) {
      const wait = jitter(upstreamPolicy.backoffMs[Math.min(i - 1, upstreamPolicy.backoffMs.length - 1)]);
      if (i >= attempts || !retryIf(e) || Date.now() + wait >= deadline) throw e;
      await sleep(wait);
    }
  }
}
/** A network-level failure from @solana/kit's transport, as opposed to an answer from the node. */
export function isTransportError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const text = `${e.name} ${e.message}`;
  // kit wraps HTTP failures as "HTTP error (503)"; a fetch that never connected is a TypeError.
  return /HTTP error \((?:429|5\d\d)\)/.test(text) || /fetch failed|network|ECONNRESET|socket/i.test(text);
}
export type Forwarded = { status: number; body: ReadableStream<Uint8Array> | null; attempts: number };
/**
 * POST a JSON-RPC body to the provider and hand back its answer as it arrives, unbuffered.
 * Throws UpstreamError, carrying the attempt it failed on, only when every attempt failed at
 * the transport level.
 */
export function forwardJsonRpc(url: string, body: string, fetcher: typeof fetch = fetch): Promise<Forwarded> {
  let attempt = 0;
  return withRetry(
    async (signal) => {
      attempt++;
      let response: Response;
      try {
        response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });
      } catch (e) {
        throw new UpstreamError(e instanceof Error ? e.message : String(e), attempt);
      }
      if (response.status === 429 || response.status >= 500)
        throw new UpstreamError(`provider returned ${response.status}`, attempt);
      return { status: response.status, body: response.body, attempts: attempt };
    },
    () => true,
    { totalMs: upstreamPolicy.totalTimeoutMs },
  );
}
