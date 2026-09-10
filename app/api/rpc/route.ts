import { env, waitUntil } from 'cloudflare:workers';
import { ensureSchema } from '@/lib/db';
import { braked, charge as chargeGlobal, flush } from '@/lib/rpc-budget';
import { decodeWire, openQuoteFor, paysQuote, treasuryAccountsFor } from '@/lib/rpc-gate';
import { chargeReference } from '@/lib/rpc-budget';
import { sameToken } from '@/lib/interact';
import { forwardJsonRpc, UpstreamError } from '@/lib/rpc-upstream';
import { rpcProxyLimits, screenRpcCall } from '@/lib/rpcproxy';
import { charge, clientAddress } from '@/lib/throttle';
/**
 * A same-origin Solana RPC for the browser.
 *
 * The viewer's wallet has to broadcast its own payment, so the page needs an RPC it can reach.
 * Handing it the provider URL directly would publish the API key to everyone who loads the
 * site -- PublicConfig says "never secrets" for exactly this reason -- and a paid key served to
 * anonymous visitors is a key someone else spends. So the key stays in a Worker secret and the
 * browser talks to this route instead.
 *
 * It is deliberately not a general-purpose relay, and the gates below are ordered so that the
 * cheapest one refuses first:
 *
 *  1. the allowlist and the cost of the body (pure, no I/O);
 *  2. the caller's ten-second budget, in Cloudflare's rate-limit bindings (no network hop;
 *     they count per connection, so this is a first gate, not the limit);
 *  3. the caller's minute and the deployment's budgets, braked from a durable D1 ledger that is
 *     flushed after the response and holds across every connection, isolate and colo;
 *  4. for a broadcast, proof that the transaction pays a quote this show issued: the quoted
 *     asset into the quoted treasury, signed by the quoted wallet (one D1 read, one write);
 *  5. the provider, with a deadline and a retry, because one flaky call used to fail a payment.
 *
 * The in-isolate counter this replaces never fired: 200 anonymous POSTs from one address in
 * 14 seconds, 200 forwarded, 0 refused, because a colo runs many isolates and each counted
 * alone. Only what is enforced at the edge or in the database holds.
 */
type Vars = {
  SOLANA_RPC_URL?: string;
  STUDIO_TOKEN?: string;
  DB?: D1Database;
  RPC_BURST?: RateLimit;
  RPC_MINUTE?: RateLimit;
  RPC_SEND?: RateLimit;
};
const vars = () => env as unknown as Vars;
const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
/**
 * Refuse in JSON-RPC's own shape. The wallet library is looking for an `error` member, not our
 * envelope, so anything else reaches the viewer as a bare network failure with the reason
 * stripped out. 200 is deliberate: a JSON-RPC error is a valid response.
 */
const refuse = (id: unknown, code: number, message: string, data?: unknown) =>
  reply({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const idOf = (payload: unknown) =>
  Array.isArray(payload) ? null : (payload as { id?: unknown })?.id ?? null;
export async function POST(request: Request) {
  const v = vars();
  // No public fallback. api.mainnet-beta.solana.com answers 403 to a Cloudflare Worker, so a
  // missing key would not degrade to a slower RPC; it would fail every call while looking
  // configured. Say so instead.
  const upstream = v.SOLANA_RPC_URL?.trim();
  if (!upstream) {
    console.error('[rpc] SOLANA_RPC_URL is not set');
    return reply({ error: 'This deployment has no Solana RPC configured.' }, 503);
  }
  // Check the declared size before buffering, so an oversized body is refused rather than read.
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > rpcProxyLimits.maxBodyBytes) return reply({ error: 'Request too large.' }, 413);
  const raw = await request.text();
  if (raw.length > rpcProxyLimits.maxBodyBytes)
    return reply({ error: 'Request too large.' }, 413);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return reply({ error: 'Expected JSON-RPC.' }, 400);
  }
  const id = idOf(payload);
  const screened = screenRpcCall(payload);
  if (!screened.ok) {
    // A method we have not allowed is the list falling behind the wallets, not an attack.
    // Log it by name so the gap is visible here instead of in somebody's failed payment.
    if (screened.method) console.warn('[rpc] refused', screened.method);
    return refuse(id, -32601, screened.why);
  }
  const caller = clientAddress(request);
  const now = Date.now();
  // A caller the ledger has already shown over its minute is refused before anything is spent
  // on it. Nothing here touches the network; the brake was set by an earlier flush.
  if (braked(caller, now) === 'caller')
    return refuse(id, -32005, 'Too many requests. Wait a minute.', { retryAfterMs: 60_000 });
  // The per-connection gates, charged by cost rather than by request: a body of ten calls
  // costs ten calls' worth, which is the fix for the batch being a free 10x.
  const [burstOk, minuteOk] = await Promise.all([
    charge(v.RPC_BURST, 'RPC_BURST', caller, screened.units),
    charge(v.RPC_MINUTE, 'RPC_MINUTE', caller, screened.units),
  ]);
  if (!burstOk || !minuteOk)
    return refuse(id, -32005, 'Too many requests. Wait a moment.', { retryAfterMs: burstOk ? 60_000 : 10_000 });
  let bound: string | null = null;
  if (screened.send) {
    // Broadcasts get their own, much smaller allowance first, so a send flood is refused
    // before it costs a database read.
    if (!(await charge(v.RPC_SEND, 'RPC_SEND', caller, 1)))
      return refuse(id, -32005, 'Too many broadcasts. Wait a moment.', { retryAfterMs: 60_000 });
    const decoded = decodeWire(screened.send.params);
    if (!decoded) return refuse(id, -32000, 'That is not a Solana transaction.');
    // The studio operator is not a stranger. A send that carries the studio's own secret is
    // forwarded without a quote, which is what an operator-signed transaction with no reference
    // needs; it is still counted and still logged.
    const operator = sameToken(request.headers.get('x-studio-token')?.trim() ?? '', v.STUDIO_TOKEN?.trim() ?? '');
    if (operator) {
      console.log('[rpc] operator broadcast; fee payer', decoded.keys[0]);
      bound = 'operator';
    } else {
      if (!v.DB) {
        console.error('[rpc] no database binding; refusing to relay a broadcast');
        return refuse(id, -32000, 'Broadcasts are unavailable right now.');
      }
      let quote;
      let treasury: string[] = [];
      let allowed = false;
      try {
        await ensureSchema(v.DB);
        quote = await openQuoteFor(v.DB, decoded.keys, now);
        if (quote) {
          treasury = quote.mint ? await treasuryAccountsFor(quote.recipient, quote.mint) : [];
          if (paysQuote(decoded, quote, treasury)) allowed = await chargeReference(v.DB, quote.reference, now);
        }
      } catch (e) {
        // Fail closed. The relay must never open because the ledger blinked.
        console.error('[rpc] send gate failed', e instanceof Error ? e.message : e);
        return refuse(id, -32000, 'Broadcasts are unavailable right now. Try again shortly.');
      }
      if (!quote) {
        console.warn('[rpc] refused a broadcast that names no quote of ours; fee payer', decoded.keys[0]);
        return refuse(id, -32003, 'This endpoint only broadcasts payments quoted by this show. Ask for a quote first.');
      }
      if (!allowed) {
        // Either the transaction wears our reference without paying it -- the stapling attack
        // the content check exists for -- or one quote has been broadcast too many times.
        console.warn('[rpc] refused a broadcast that does not pay its quote', quote.kind, quote.reference, 'fee payer', decoded.keys[0]);
        return refuse(id, -32003, 'That transaction does not pay the quote it names.');
      }
      bound = quote.reference;
    }
  }
  // The deployment-wide brake. A broadcast that pays a live quote is exempt: a viewer mid-payment
  // is not the traffic the brake exists for, and losing their send costs real money.
  if (!bound && braked(caller, now) === 'deployment')
    return refuse(id, -32005, "This show's RPC budget is spent for now. Try again shortly.", { retryAfterMs: 30_000 });
  if (v.DB && chargeGlobal(caller, screened.units, now)) {
    const db = v.DB;
    waitUntil(ensureSchema(db).then(() => flush(db, Date.now())));
  }
  try {
    const answer = await forwardJsonRpc(upstream, raw);
    if (answer.attempts > 1) console.warn('[rpc] upstream answered after', answer.attempts, 'attempts');
    // Pass the provider's answer through untouched so the wallet sees real JSON-RPC errors,
    // but never the provider's headers: those can carry the account's plan and usage.
    return new Response(answer.body, {
      status: answer.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    const detail = e instanceof UpstreamError ? `${e.message} after ${e.attempts} attempts` : e instanceof Error ? e.message : String(e);
    console.warn('[rpc] upstream failed:', detail);
    return refuse(id, -32005, 'The network is busy. Try again.', { retryAfterMs: 2_000 });
  }
}
