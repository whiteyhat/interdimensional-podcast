// What the browser's RPC proxy will and will not forward. Pure, so the policy is testable
// without a network or a Worker.
export const rpcProxyLimits = {
  /** A signed transfer plus its blockhash is a few kilobytes; nothing legitimate is larger. */
  maxBodyBytes: 16_000,
  /** Wallets send bursts while confirming, so this is generous enough not to break one payer. */
  perMinute: 120,
  timeoutMs: 15_000,
  maxBatch: 10,
} as const;
/**
 * Exactly what a wallet needs to price, send and confirm one transfer, and nothing else.
 * Notably absent: getProgramAccounts, getSignaturesForAddress and the block-range calls, which
 * are the expensive ones someone would borrow the key for.
 *
 * This list will need to grow as wallet libraries reach for methods nobody guessed, which is
 * why a refusal is reported in JSON-RPC's own shape and logged: the gap shows up as a named
 * method in the logs rather than as "payments fail for some people".
 */
const allowed = new Set([
  'getLatestBlockhash',
  'getFeeForMessage',
  'sendTransaction',
  'simulateTransaction',
  'getSignatureStatuses',
  'getTransaction',
  'getAccountInfo',
  'getMultipleAccounts',
  'getBalance',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getMinimumBalanceForRentExemption',
  'getRecentPrioritizationFees',
  'getEpochInfo',
  'getSlot',
  'getHealth',
  'getVersion',
]);
export type Screened =
  | { ok: true }
  /** `method` is the one that was refused, when a method is what went wrong. */
  | { ok: false; why: string; method?: string };
const isCall = (v: unknown): v is { method?: unknown } =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** Accept a single JSON-RPC call or a small batch, so long as every method is allowed. */
export function screenRpcCall(payload: unknown): Screened {
  const calls = Array.isArray(payload) ? payload : [payload];
  if (!calls.length) return { ok: false, why: 'Empty request.' };
  if (calls.length > rpcProxyLimits.maxBatch)
    return { ok: false, why: `At most ${rpcProxyLimits.maxBatch} calls per request.` };
  for (const call of calls) {
    if (!isCall(call)) return { ok: false, why: 'Expected JSON-RPC objects.' };
    const method = call.method;
    if (typeof method !== 'string') return { ok: false, why: 'Every call needs a method.' };
    if (!allowed.has(method))
      return { ok: false, why: `${method} is not available through this endpoint.`, method };
  }
  return { ok: true };
}
