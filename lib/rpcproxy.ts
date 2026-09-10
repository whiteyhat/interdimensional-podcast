// What the browser's RPC proxy will and will not forward, and what each call costs. Pure, so
// the policy is testable without a network or a Worker.
export const rpcProxyLimits = {
  /** A signed transfer plus its blockhash is a few kilobytes; nothing legitimate is larger. */
  maxBodyBytes: 16_000,
  timeoutMs: 15_000,
  maxBatch: 10,
  /**
   * Cost units one HTTP request may carry. A batch of ten cheap calls fits; a batch of five
   * getTransaction does not. Before this existed the limiter charged one tick per HTTP request
   * however many calls the body held, so a batch was a free 10x.
   */
  maxUnitsPerRequest: 20,
  /**
   * Per caller, per ten seconds, enforced by a Cloudflare rate-limit binding. The binding
   * counts per connection in practice -- 150 requests over one HTTP/2 connection drew 89
   * refusals, 300 over ten connections drew none -- so this is a free first gate against a
   * single-connection flood and nothing more. A real payment's busiest second is a handful
   * of calls; 60 is ample headroom.
   */
  burstPer10s: 60,
  /**
   * Per caller, per minute, counted durably in D1 (lib/rpc-budget.ts), which is the limit
   * that holds however many connections or colos a caller uses. Sized from a real payment: a
   * wallet makes roughly 40-60 calls over a minute while it prices, sends and then polls
   * getSignatureStatuses every couple of seconds, so this is about five payments a minute
   * from one address -- a Discord crowd behind one NAT, not one person. It matches the edge
   * rule on the production zone (50 requests per 10s), which is the third, coarsest gate.
   */
  perMinute: 300,
  /** Broadcasts per caller per minute. A wallet retries a handful; a relay sends thousands. */
  sendsPerMinute: 6,
  /**
   * Broadcasts per quote, across every caller, for as long as the quote is open. A wallet
   * that cannot get its payment heard re-sends the same bytes a few times; nothing legitimate
   * needs more, and this is what stops one quote being a season ticket.
   */
  sendsPerReference: 10,
  /**
   * The whole deployment, counted durably in D1 so a botnet spread across colos still hits a
   * ceiling. The burst row is a brake for a flood; the day row is the bill.
   */
  globalPer10s: 3_000,
  globalPerDay: 250_000,
  /** How stale a quote may be and still have its broadcast forwarded; matches the submit action. */
  sendGraceMs: 5 * 60_000,
} as const;
/**
 * Exactly what a wallet needs to price, send and confirm one transfer, and nothing else.
 * Notably absent: getProgramAccounts, getSignaturesForAddress and the block-range calls, which
 * are the expensive ones someone would borrow the key for.
 *
 * This list will need to grow as wallet libraries reach for methods nobody guessed, which is
 * why a refusal is reported in JSON-RPC's own shape and logged: the gap shows up as a named
 * method in the logs rather than as "payments fail for some people".
 *
 * The number is the cost in budget units. Helius bills every one of these at a single credit,
 * so the surcharges are not billing: they are abuse pricing. getTransaction is what someone
 * grinds old signatures through, getTokenAccountsByOwner is the heaviest read a wallet makes,
 * and a batch of either should run out of budget faster than a batch of getHealth.
 */
const allowed = new Map<string, number>([
  ['getGenesisHash', 1],
  ['isBlockhashValid', 1],
  ['getLatestBlockhash', 1],
  ['getFeeForMessage', 1],
  ['sendTransaction', 1],
  ['simulateTransaction', 2],
  ['getSignatureStatuses', 1],
  ['getTransaction', 4],
  ['getAccountInfo', 1],
  ['getMultipleAccounts', 2],
  ['getBalance', 1],
  ['getTokenAccountBalance', 1],
  ['getTokenAccountsByOwner', 3],
  ['getMinimumBalanceForRentExemption', 1],
  ['getRecentPrioritizationFees', 1],
  ['getEpochInfo', 1],
  ['getSlot', 1],
  ['getHealth', 1],
  ['getVersion', 1],
]);
export type RpcCall = { method: string; params?: unknown };
export type Screened =
  | {
      ok: true;
      /** The calls in body order, so the route can charge and inspect without re-parsing. */
      calls: RpcCall[];
      /** Summed cost of the body; what the caller is charged. */
      units: number;
      /** The one broadcast in the body, when there is one. It travels alone. */
      send: RpcCall | null;
    }
  /** `method` is the one that was refused, when a method is what went wrong. */
  | { ok: false; why: string; method?: string };
const isCall = (v: unknown): v is { method?: unknown; params?: unknown } =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** The cost of one call. A status poll that searches history is the archival lookup in disguise. */
export function unitsFor(call: RpcCall): number {
  const base = allowed.get(call.method) ?? 1;
  if (call.method === 'getSignatureStatuses' && Array.isArray(call.params)) {
    const opts = call.params[1];
    if (opts && typeof opts === 'object' && (opts as { searchTransactionHistory?: unknown }).searchTransactionHistory === true)
      return 3;
  }
  return base;
}
/** Accept a single JSON-RPC call or a small batch, so long as every method is allowed. */
export function screenRpcCall(payload: unknown): Screened {
  const raw = Array.isArray(payload) ? payload : [payload];
  if (!raw.length) return { ok: false, why: 'Empty request.' };
  if (raw.length > rpcProxyLimits.maxBatch)
    return { ok: false, why: `At most ${rpcProxyLimits.maxBatch} calls per request.` };
  const calls: RpcCall[] = [];
  let units = 0;
  let send: RpcCall | null = null;
  for (const call of raw) {
    if (!isCall(call)) return { ok: false, why: 'Expected JSON-RPC objects.' };
    const method = call.method;
    if (typeof method !== 'string') return { ok: false, why: 'Every call needs a method.' };
    if (!allowed.has(method))
      return { ok: false, why: `${method} is not available through this endpoint.`, method };
    const entry: RpcCall = { method, params: call.params };
    if (method === 'sendTransaction') {
      // No wallet batches a broadcast with anything, and a relay would love to hide ten of
      // them behind one budget tick.
      if (raw.length > 1) return { ok: false, why: 'A broadcast travels alone.', method };
      send = entry;
    }
    calls.push(entry);
    units += unitsFor(entry);
  }
  if (units > rpcProxyLimits.maxUnitsPerRequest)
    return { ok: false, why: 'That batch is too expensive for this endpoint.' };
  return { ok: true, calls, units, send };
}
