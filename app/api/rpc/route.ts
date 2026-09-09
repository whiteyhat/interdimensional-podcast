import { env } from 'cloudflare:workers';
import { publicRpc } from '@/lib/interact';
import { rpcProxyLimits, screenRpcCall } from '@/lib/rpcproxy';
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
// Best-effort per-IP gate. One isolate among many, so it thins abuse rather than stopping it;
// the real ceiling is the provider's own rate limit.
const hits = new Map<string, number[]>();
function tooMany(key: string, now: number) {
  const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > rpcProxyLimits.perMinute;
}
function clientAddress(request: Request) {
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'local'
  );
}
export async function POST(request: Request) {
  const upstream = vars().SOLANA_RPC_URL?.trim() || publicRpc;
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
  if (!screened.ok) return reply({ error: screened.why }, 400);
  if (tooMany(clientAddress(request), Date.now()))
    return reply({ error: 'Too many requests. Wait a moment.' }, 429);
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
