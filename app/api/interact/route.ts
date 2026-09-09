import { env, waitUntil } from 'cloudflare:workers';
import { isAddress, isSignature } from '@solana/kit';
import * as db from '@/lib/db';
import {
  buyUrlFor,
  fail,
  HttpError,
  interactLimits,
  isLocalHost,
  publicRpc,
  publicView,
  pullView,
  queuePositions,
  sameToken,
  usdPerRequest,
  type PublicConfig,
  type PublicRequest,
} from '@/lib/interact';
import { checkMessage, checkName, quoteAmount, toBaseUnits } from '@/lib/requests';
import { clientAddress, perMinuteCounter } from '@/lib/throttle';
import { defaultBrand } from '@/lib/show';
import {
  buildQuoteTx,
  findPayment,
  inspectSigned,
  mintInfo,
  priceUsd as fetchPrice,
  randomReference,
  rpcFor,
  sendSigned,
  tokenBalance,
  treasuryReady,
  verifyPayment,
} from '@/lib/solana';

type Vars = {
  DB?: D1Database;
  COIN_MINT?: string;
  COIN_NAME?: string;
  COIN_TICKER?: string;
  TREASURY_WALLET?: string;
  SOLANA_RPC_URL?: string;
  CLIENT_RPC_URL?: string;
  STUDIO_TOKEN?: string;
  INTERACT_ORIGIN?: string;
  INTERACT_USD?: string;
  STREAM_EMBED_URL?: string;
  X_LIVE_URL?: string;
  PRICE_FIXED?: string;
};
type Body = {
  action?: unknown;
  wallet?: unknown;
  message?: unknown;
  name?: unknown;
  reference?: unknown;
  signedTx?: unknown;
  signature?: unknown;
};
const vars = () => env as unknown as Vars;
const BASE64 = /^[A-Za-z0-9+/]+=*$/;
const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
// Quote attempts per minute per client address, counted before any chain work.
const tooMany = perMinuteCounter();

/** The deployment's launch state, read fresh on every request so a redeploy flips it. */
function settings() {
  const v = vars();
  const mint = v.COIN_MINT?.trim() ?? '';
  const treasury = v.TREASURY_WALLET?.trim() ?? '';
  const hasMint = isAddress(mint);
  const hasTreasury = isAddress(treasury);
  let interactOrigin: string | null = null;
  try {
    interactOrigin = v.INTERACT_ORIGIN?.trim() ? new URL(v.INTERACT_ORIGIN.trim()).origin : null;
  } catch {
    interactOrigin = null;
  }
  return {
    launched: hasMint && hasTreasury,
    mint: hasMint ? mint : null,
    treasury: hasTreasury ? treasury : null,
    buyUrl: buyUrlFor(hasMint ? mint : null),
    ticker: v.COIN_TICKER?.trim().replace(/^\$/, '') || defaultBrand.ticker,
    name: v.COIN_NAME?.trim() || defaultBrand.name,
    usd: usdPerRequest(v.INTERACT_USD, defaultBrand.usd),
    rpcUrl: v.SOLANA_RPC_URL?.trim() || publicRpc,
    // Whatever ends up here is served to every anonymous visitor, so it must never carry a
    // credential. Left empty by default and filled in by config() with this deployment's own
    // /api/rpc, which reaches the provider with the key held server-side.
    clientRpcUrl: publishableRpc(v.CLIENT_RPC_URL),
    streamEmbedUrl: v.STREAM_EMBED_URL?.trim() || null,
    xLiveUrl: v.X_LIVE_URL?.trim() || null,
    interactOrigin,
    priceFixed: v.PRICE_FIXED?.trim() || undefined,
  };
}
type Settings = ReturnType<typeof settings>;
/** A deployment that is actually launched: the mint and treasury are known good addresses. */
type LiveSettings = Settings & { mint: string; treasury: string };
async function database() {
  const d = vars().DB;
  if (!d) throw fail(503, 'The request queue is not configured on this deployment.', 'DB');
  await db.ensureSchema(d);
  return d;
}
function readReference(raw: unknown) {
  const reference = typeof raw === 'string' ? raw.trim() : '';
  if (!isAddress(reference)) throw fail(400, 'Unknown request.');
  return reference;
}
/**
 * The one chain read both handlers need: the mint's decimals and program, the dollar price
 * and whether the treasury can receive the coin. A price or treasury lookup that fails is
 * reported as "no price" / "not ready" so one flaky feed cannot blank the whole answer.
 */
async function chainState(s: LiveSettings, now: number) {
  const rpc = rpcFor(s.rpcUrl);
  const info = await mintInfo(rpc, s.mint);
  const [priceUsd, ready] = await Promise.all([
    fetchPrice(s.mint, info.decimals, now, s.priceFixed).catch(() => null),
    treasuryReady(rpc, s.treasury, s.mint, info.program, now).catch(() => false),
  ]);
  return { decimals: info.decimals, priceUsd, treasuryReady: ready, program: info.program };
}
/**
 * A browser RPC URL is only safe to publish if it carries no credential. Providers put keys in
 * the query string or the path, so anything beyond a bare origin is refused rather than served
 * — the proxy is already the safe default, so refusing costs the operator nothing but a log
 * line, where honouring it would publish a paid key to everyone who loads the page.
 */
function publishableRpc(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!url.search && !url.username && !url.password && (url.pathname === '/' || url.pathname === ''))
      return url.toString();
    console.warn('[interact] ignoring CLIENT_RPC_URL: it carries credentials and would be public');
  } catch {
    console.warn('[interact] ignoring CLIENT_RPC_URL: not a URL');
  }
  return '';
}
function failure(e: unknown, where: string) {
  if (e instanceof HttpError)
    return reply({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
  const message = e instanceof Error ? e.message : 'Request failed';
  console.warn(`[interact] ${where} failed`, message);
  if (/UNIQUE constraint failed: requests\.signature/.test(message))
    return reply({ error: 'That payment already belongs to another request.' }, 409);
  return reply({ error: 'Something went wrong on our side; try again in a moment.' }, 502);
}

// ---- GET ------------------------------------------------------------------------------

async function config(origin: string): Promise<PublicConfig> {
  const s = settings();
  const now = Date.now();
  let studioOnline = false;
  let queued = 0;
  const d = vars().DB;
  if (d) {
    try {
      await db.ensureSchema(d);
      const [seen, count] = await Promise.all([db.getHeartbeat(d), db.countQueued(d)]);
      studioOnline = now - seen < interactLimits.heartbeatMs;
      queued = count;
    } catch (e) {
      console.warn('[interact] config db', e instanceof Error ? e.message : e);
    }
  }
  // The card shows what a seat costs, so the server prices it with the very same maths the
  // quote path uses rather than shipping a price and letting the browser do the arithmetic.
  let previewAmountUi: number | null = null;
  let ready = false;
  if (s.launched && s.mint && s.treasury) {
    try {
      const chain = await chainState({ ...s, mint: s.mint, treasury: s.treasury }, now);
      ready = chain.treasuryReady;
      if (chain.priceUsd !== null)
        previewAmountUi = quoteAmount(chain.priceUsd, s.usd, chain.decimals);
    } catch (e) {
      console.warn('[interact] config chain', e instanceof Error ? e.message : e);
    }
  }
  return {
    launched: s.launched,
    mint: s.mint,
    ticker: s.ticker,
    name: s.name,
    treasury: s.treasury,
    buyUrl: s.buyUrl,
    previewAmountUi,
    interactUsd: s.usd,
    streamEmbedUrl: s.streamEmbedUrl,
    links: { pumpfun: s.buyUrl, x: s.xLiveUrl },
    studioOnline,
    treasuryReady: ready,
    clientRpcUrl: s.clientRpcUrl || `${origin}/api/rpc`,
    queued,
  };
}
/** Read-only: every visitor polls this every few seconds, so it never writes to the database. */
async function status(raw: string | null) {
  const d = await database();
  const reference = raw === null ? null : raw.trim();
  const { queue, recent: rows, row } = await db.statusReads(
    d,
    interactLimits.recent,
    reference && isAddress(reference) ? reference : null,
  );
  const positions = queuePositions(queue);
  const recent: PublicRequest[] = rows.map((r) => publicView(r, positions));
  if (raw === null) return { recent };
  return { request: row ? publicView(row, positions) : null, recent };
}
export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') ?? 'config';
  try {
    if (action === 'config') return reply(await config(url.origin));
    if (action === 'status') return reply(await status(url.searchParams.get('reference')));
    return reply({ error: 'Unknown action' }, 400);
  } catch (e) {
    return failure(e, action);
  }
}

// ---- POST: viewer ----------------------------------------------------------------------

async function quote(request: Request, body: Body) {
  const s = settings();
  if (!s.launched || !s.mint || !s.treasury)
    throw fail(409, 'Launching soon: the coin is not live yet.', 'NOT_LAUNCHED');
  const live: LiveSettings = { ...s, mint: s.mint, treasury: s.treasury };
  const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : '';
  if (!isAddress(wallet)) throw fail(400, 'Connect a Solana wallet first.');
  const name = checkName(body.name);
  if (!name.ok) throw fail(400, name.error);
  const message = checkMessage(body.message);
  if (!message.ok) throw fail(400, message.error);
  // Cheap check first; the throttle counts every attempt that would reach the chain.
  if (tooMany(`ip:${clientAddress(request)}`, interactLimits.quotesPerMinuteIp, Date.now()))
    throw fail(429, 'Slow down: a few quotes a minute is plenty.');
  const d = await database();
  const now = Date.now();
  const gates = await db.quoteGates(d, wallet, now);
  if (now - gates.studioSeenAt >= interactLimits.heartbeatMs)
    throw fail(409, 'The studio is off air right now; requests reopen when the show is live.', 'OFFAIR');
  const rpc = rpcFor(s.rpcUrl);
  // Nothing here depends on anything else, and a wallet popup is waiting on all of it.
  const [chain, balance] = await Promise.all([
    chainState(live, now),
    tokenBalance(rpc, wallet, s.mint),
  ]);
  if (!chain.treasuryReady)
    throw fail(409, `The show's treasury cannot receive ${s.ticker} yet. Try again shortly.`, 'TREASURY');
  if (gates.quotesInLastMinute >= interactLimits.quotesPerMinute)
    throw fail(429, 'Slow down: three quotes a minute per wallet.');
  if (chain.priceUsd === null)
    throw fail(503, 'The coin has no price right now; try again in a moment.', 'PRICE');
  const price = chain.priceUsd;
  let amountUi: number;
  try {
    amountUi = quoteAmount(price, s.usd, chain.decimals);
  } catch {
    throw fail(503, 'Could not price the request; try again in a moment.', 'PRICE');
  }
  const amountBase = toBaseUnits(amountUi, chain.decimals);
  if (balance < amountUi) return { ok: true, hasEnough: false, amountUi, balance, buyUrl: s.buyUrl };
  const reference = randomReference();
  const tx = await buildQuoteTx(
    rpc,
    { wallet, recipient: s.treasury, mint: s.mint, amountUi, reference },
    s.ticker,
  );
  const expiresAt = now + interactLimits.quoteTtlMs;
  await db.insertQuote(d, {
    id: crypto.randomUUID(),
    reference,
    wallet,
    name: name.text,
    message: message.text,
    amount_ui: amountUi,
    amount_base: amountBase,
    mint: s.mint,
    recipient: s.treasury,
    price_usd: price,
    created_at: now,
    expires_at: expiresAt,
  });
  return {
    ok: true,
    hasEnough: true,
    reference,
    tx,
    amountUi,
    amountBase,
    priceUsd: price,
    expiresAt,
    ttlMs: interactLimits.quoteTtlMs,
    now,
  };
}
async function submit(body: Body) {
  const reference = readReference(body.reference);
  const signed = typeof body.signedTx === 'string' ? body.signedTx.trim() : '';
  if (!signed || signed.length > 4000 || !BASE64.test(signed))
    throw fail(400, 'Send the signed transaction as base64.');
  const d = await database();
  const now = Date.now();
  const row = await db.getByReference(d, reference);
  if (!row) throw fail(404, 'Unknown request.');
  if (row.signature && row.status !== 'quoted' && row.status !== 'expired' && row.status !== 'failed')
    return { ok: true, signature: row.signature };
  if (row.status !== 'quoted' && row.status !== 'submitted')
    throw fail(409, 'This quote is no longer valid. Ask for a new one.', 'REQUOTE');
  if (now > row.expires_at + 5 * 60_000) {
    await db.setStatus(d, reference, 'expired', ['quoted', 'submitted'], now);
    throw fail(409, 'This quote expired. Ask for a new one.', 'REQUOTE');
  }
  inspectSigned(signed, { wallet: row.wallet, reference });
  const rpc = rpcFor(settings().rpcUrl);
  let signature: string;
  try {
    signature = await sendSigned(rpc, signed);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'REQUOTE')
      await db.setStatus(d, reference, 'expired', ['quoted', 'submitted'], now);
    throw e;
  }
  await db.setStatus(d, reference, 'submitted', ['quoted', 'submitted'], now, signature);
  return { ok: true, signature };
}
type Settled = { status: string; position?: number; error?: string };
/**
 * What the chain says about one row. A signature is only ever written down once it verified,
 * so a wrong or hostile signature can never block the real payment for a request.
 */
async function settle(
  d: D1Database,
  rpc: ReturnType<typeof rpcFor>,
  row: db.RequestRow,
  now: number,
  offered?: string,
): Promise<Settled> {
  if (row.status === 'paid' || row.status === 'claimed')
    return { status: row.status, position: await db.positionOf(d, row.reference) };
  if (row.status === 'aired') return { status: 'aired' };
  // The wallet's own signature first, then what the studio broadcast, then the chain itself.
  const signature = offered || row.signature || (await findPayment(rpc, row.reference));
  if (!signature) {
    // A quote's blockhash lives about a minute; past that the card asks for a fresh one. A payment
    // that still lands late is found by the studio's recovery sweep or the next confirm.
    if (row.status === 'quoted' && now > row.expires_at) {
      await db.setStatus(d, row.reference, 'expired', ['quoted'], now);
      return { status: 'expired' };
    }
    return { status: row.status === 'expired' ? 'expired' : 'pending' };
  }
  const info = await mintInfo(rpc, row.mint);
  const verdict = await verifyPayment(rpc, signature, {
    recipient: row.recipient,
    amountBase: row.amount_base,
    mint: row.mint,
    reference: row.reference,
    program: info.program,
  });
  if (verdict.status === 'paid') {
    try {
      await db.setStatus(d, row.reference, 'paid', ['quoted', 'submitted', 'expired', 'failed'], now, signature);
    } catch (e) {
      // One transaction carrying two references pays for one request, never two.
      if (/UNIQUE constraint failed/.test(e instanceof Error ? e.message : ''))
        return { status: 'failed', error: 'That payment was already used for another request.' };
      throw e;
    }
    return { status: 'paid', position: await db.positionOf(d, row.reference) };
  }
  if (verdict.status === 'failed') return { status: 'failed', error: verdict.error };
  return { status: row.status === 'expired' ? 'expired' : 'pending' };
}
async function confirm(body: Body) {
  const reference = readReference(body.reference);
  const rawSignature = typeof body.signature === 'string' ? body.signature.trim() : '';
  if (rawSignature && !isSignature(rawSignature)) throw fail(400, 'That signature is not valid.');
  const d = await database();
  const now = Date.now();
  const row = await db.getByReference(d, reference);
  if (!row) throw fail(404, 'Unknown request.');
  if (row.status === 'failed') return { status: 'failed', error: 'The payment did not go through.' };
  try {
    return await settle(d, rpcFor(settings().rpcUrl), row, now, rawSignature || undefined);
  } catch (e) {
    console.warn('[interact] confirm', e instanceof Error ? e.message : e);
    return { status: 'pending', error: 'Could not reach the network; still checking.' };
  }
}
/**
 * Once a minute, look for payments that landed after the viewer's page stopped asking. This
 * runs after the studio already has its answer, so it never fails a pull or slows one down.
 */
async function recover(d: D1Database, now: number) {
  try {
    if (!(await db.recoverDue(d, now))) return;
    const rows = await db.recoverable(d, now, interactLimits.recoverBatch);
    if (!rows.length) return;
    const rpc = rpcFor(settings().rpcUrl);
    await Promise.all(
      rows.map(async (row) => {
        try {
          const result = await settle(d, rpc, row, now);
          if (result.status === 'paid') console.log('[interact] recovered a late payment', row.reference);
        } catch (e) {
          console.warn('[interact] recover', e instanceof Error ? e.message : e);
        }
      }),
    );
  } catch (e) {
    console.warn('[interact] recover', e instanceof Error ? e.message : e);
  }
}

// ---- POST: studio ----------------------------------------------------------------------

/**
 * The studio's local worker: forward to the deployed site with the shared token, the same
 * way the topics route forwards to the news desk. Only this machine's own pages may use it;
 * a rebinding page from elsewhere gets nothing.
 */
async function proxyToSite(
  request: Request,
  origin: string,
  action: 'pull' | 'aired',
  reference?: string,
): Promise<unknown> {
  const site = request.headers.get('sec-fetch-site');
  if (!isLocalHost(new URL(request.url).hostname) || (site && site !== 'same-origin' && site !== 'none'))
    throw fail(403, 'The studio proxy only serves its own machine.');
  const token = vars().STUDIO_TOKEN?.trim();
  if (!token) throw fail(503, 'STUDIO_TOKEN is not set for the studio worker.');
  const upstream = await fetch(`${origin}/api/interact`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-studio-token': token },
    body: JSON.stringify({ action, reference }),
    signal: AbortSignal.timeout(15000),
  });
  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    throw fail(502, `The site answered ${upstream.status} without JSON.`);
  }
  if (upstream.ok) return data;
  const answer = (data ?? {}) as { error?: unknown; code?: unknown };
  throw fail(
    upstream.status,
    typeof answer.error === 'string' ? answer.error : `The site answered ${upstream.status}.`,
    typeof answer.code === 'string' ? answer.code : undefined,
  );
}
/** Who may drive the queue here: the shared token, or the developer's own machine. */
function assertStudio(request: Request) {
  const given = request.headers.get('x-studio-token')?.trim() ?? '';
  const expected = vars().STUDIO_TOKEN?.trim() ?? '';
  if (!expected) {
    // No secret configured: only the developer's own machine may drive the queue.
    if (given || !isLocalHost(new URL(request.url).hostname))
      throw fail(503, 'STUDIO_TOKEN is not configured on this deployment.');
  } else if (!given || !sameToken(given, expected)) throw fail(401, 'Studio token rejected.');
}
/** The studio claims paid requests; this is also the only heartbeat and the only tidy-up. */
async function pull(request: Request): Promise<unknown> {
  const origin = settings().interactOrigin;
  if (origin) return proxyToSite(request, origin, 'pull');
  assertStudio(request);
  const d = await database();
  const now = Date.now();
  const [rows] = await Promise.all([
    db.claimPaid(d, interactLimits.claimBatch, now),
    db.heartbeat(d, now),
    // One client on an 8s cadence, rather than every viewer poll, retires stale quotes.
    db.expireStale(d, now),
  ]);
  waitUntil(recover(d, now));
  return { requests: rows.map(pullView) };
}
async function aired(request: Request, reference: string): Promise<unknown> {
  const origin = settings().interactOrigin;
  if (origin) return proxyToSite(request, origin, 'aired', reference);
  assertStudio(request);
  const d = await database();
  if (!(await db.markAired(d, reference, Date.now()))) throw fail(404, 'Unknown request.');
  return { ok: true };
}

function run(action: string, request: Request, body: Body): Promise<unknown> {
  switch (action) {
    case 'quote':
      return quote(request, body);
    case 'submit':
      return submit(body);
    case 'confirm':
      return confirm(body);
    case 'pull':
      return pull(request);
    case 'aired':
      return aired(request, readReference(body.reference));
    default:
      throw fail(400, 'Unknown action');
  }
}
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return reply({ error: 'Origin not allowed' }, 403);
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return reply({ error: 'Send a JSON body.' }, 400);
  }
  const action = typeof body?.action === 'string' ? body.action : '';
  try {
    return reply(await run(action, request, body));
  } catch (e) {
    return failure(e, action || 'post');
  }
}
