import { env } from 'cloudflare:workers';
import { publicRpc } from '@/lib/interact';
import { rpcProxyLimits, screenRpcCall } from '@/lib/rpcproxy';
import { clientAddress, perMinuteCounter } from '@/lib/throttle';
/**
 * A same-origin Solana RPC for the browser.
 *
 * The viewer's wallet has to broadcast its own payment, so the page needs an RPC it can reach.
 * Handing it the provider URL directly would publish the API key to everyone who loads the
 * site — PublicConfig says "never secrets" for exactly this reason — and a paid key served to
 * anonymous visitors is a key someone else spends. So the key stays in a Worker secret and the
 * browser talks to this route instead.
 *
 * It is deliberately not a general-purpose relay. Only the handful of methods a wallet needs
 * to send and confirm one transfer are allowed, so the worst an abuser gets is the same thing
 * they could already do by running their own node.
 */
type Vars = { SOLANA_RPC_URL?: string };
const vars = () => env as unknown as Vars;
const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
/**
 * Refuse in JSON-RPC's own shape. The wallet library is looking for an `error` member, not our
 * envelope, so anything else reaches the viewer as a bare network failure with the reason
 * stripped out. 200 is deliberate: a JSON-RPC error is a valid response.
 */
const refuse = (id: unknown, code: number, message: string) =>
  reply({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const idOf = (payload: unknown) =>
  Array.isArray(payload) ? null : (payload as { id?: unknown })?.id ?? null;
// Its own bucket, so an RPC burst cannot eat anybody's quote allowance.
const tooMany = perMinuteCounter();
export async function POST(request: Request) {
  const upstream = vars().SOLANA_RPC_URL?.trim() || publicRpc;
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
  const screened = screenRpcCall(payload);
  if (!screened.ok) {
    // A method we have not allowed is the list falling behind the wallets, not an attack.
    // Log it by name so the gap is visible here instead of in somebody's failed payment.
    if (screened.method) console.warn('[rpc] refused', screened.method);
    return refuse(idOf(payload), -32601, screened.why);
  }
  if (tooMany(clientAddress(request), rpcProxyLimits.perMinute, Date.now()))
    return refuse(idOf(payload), -32005, 'Too many requests. Wait a moment.');
  try {
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
      signal: AbortSignal.timeout(rpcProxyLimits.timeoutMs),
    });
    // Pass the provider's answer through untouched so the wallet sees real JSON-RPC errors,
    // but never the provider's headers: those can carry the account's plan and usage.
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    console.warn('[rpc] upstream failed', e instanceof Error ? e.message : e);
    return reply({ error: 'The network is busy. Try again.' }, 502);
  }
}
