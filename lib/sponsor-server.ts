import { clusterOf, explorerTx, type Cluster } from './cluster';
import { interactLimits, readStudioId } from './interact';
import {
  SponsorError,
  LOOK_VERSION,
  sponsorOffers,
  sponsorProducts,
  sponsorLimits,
  sponsorPriceCents,
  flatPriceCents,
  amountBaseForCents,
  amountUi,
  validateSponsorDraft,
  type LookAssetMetadata,
  type SponsorAsset,
  type SponsorDraft,
  type SponsorCatalog,
  type SponsorCapabilities,
  type SponsorLook,
  type SponsorReceipt,
  type SponsorAttempt,
  type SponsorLease,
} from './sponsorship';
import * as db from './sponsor-db';
import {
  sponsorConnection,
  validWallet,
  randomPayReference,
  fetchSponsorPrice,
  tokenInfo,
  spendable,
  buildSponsorTransaction,
  inspectSponsorSigned,
  verifySponsorSignature,
  scanSponsorReference,
  SOL_MINT,
  USDC_MINT,
} from './sponsor-pay';
export type SponsorVars = {
  DB?: D1Database;
  COIN_MINT?: string;
  TREASURY_WALLET?: string;
  SOLANA_RPC_URL?: string;
  JUPITER_API_KEY?: string;
  JUP_API_KEY?: string;
  STUDIO_TOKEN?: string;
  STUDIO_ID?: string;
  INTERACT_ORIGIN?: string;
  SPONSOR_RECONCILE_TOKEN?: string;
  SPONSOR_USDC_MINT?: string;
  SPONSOR_ENABLED?: string;
  SPONSOR_FLAT_PRICE_CENTS?: string;
  SPONSOR_SOL_USD?: string;
};
/** Checkout stays closed until SPONSOR_ENABLED is 'true'; every entry point refuses with these words. */
export const CHECKOUT_CLOSED = 'Sponsorship checkout is not enabled.';
export const checkoutOpen = (v: SponsorVars) => v.SPONSOR_ENABLED === 'true';
export function assertCheckoutOpen(v: SponsorVars) {
  if (!checkoutOpen(v)) throw new SponsorError(503, CHECKOUT_CLOSED);
}
/** The site's media-side bindings: the asset bucket, and where the wardrobe desk is and its secret. */
export type SponsorMediaVars = SponsorVars & {
  SPONSOR_ASSETS?: R2Bucket;
  SPONSOR_MEDIA_URL?: string;
  SPONSOR_MEDIA_TOKEN?: string;
  SITE_URL?: string;
};
/**
 * Where the media desk lives and the secret its /logo and /tailor calls carry, and that its
 * look callbacks must present. Those are all this side needs.
 */
export function sponsorMediaConfig(v: SponsorMediaVars) {
  let url: URL | undefined;
  try {
    url = v.SPONSOR_MEDIA_URL ? new URL(v.SPONSOR_MEDIA_URL) : undefined;
  } catch {
    throw new SponsorError(
      503,
      'The wardrobe service URL is invalid.',
      'MEDIA',
    );
  }
  if (!url || !v.SPONSOR_MEDIA_TOKEN || v.SPONSOR_MEDIA_TOKEN.length < 24)
    throw new SponsorError(
      503,
      'The wardrobe desk is not connected yet.',
      'MEDIA',
    );
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  )
    throw new SponsorError(
      503,
      'The wardrobe service URL is invalid.',
      'MEDIA',
    );
  return { url, token: v.SPONSOR_MEDIA_TOKEN };
}
const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  });
export function sponsorFailure(e: unknown) {
  if (e instanceof SponsorError)
    return response({ error: e.message, code: e.code }, e.status);
  console.warn(
    '[sponsorship]',
    e instanceof Error ? e.message : 'Operation failed',
  );
  return response(
    {
      error:
        'Sponsorship service is temporarily unavailable. Your receipt is safe.',
      code: 'SERVICE',
    },
    503,
  );
}
export async function sponsorDatabase(v: SponsorVars) {
  if (!v.DB)
    throw new SponsorError(503, 'Sponsorship storage is not configured.', 'DB');
  await db.ensureSponsorSchema(v.DB);
  return v.DB;
}
const connection = (v: SponsorVars) =>
  sponsorConnection(
    v.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com',
  );
/**
 * Test pricing that reached mainnet would sell a $100 placement for a dollar and settle
 * SOL against a number somebody typed last month. Both overrides are therefore refused
 * outright unless this deployment talks to devnet or a local validator, the same refusal
 * scripts/testmint.mjs makes before it mints anything.
 */
function devnetPricing(v: SponsorVars) {
  const flatCents = flatPriceCents(v.SPONSOR_FLAT_PRICE_CENTS);
  const solUsd = v.SPONSOR_SOL_USD?.trim() || undefined;
  if (flatCents === undefined && solUsd === undefined) return {};
  if (clusterOf(v.SOLANA_RPC_URL) !== 'devnet')
    throw new SponsorError(
      503,
      'Devnet pricing is configured on a deployment that is not on devnet.',
      'CONFIG',
    );
  return { flatCents, solUsd };
}
export async function hashSponsorToken(token: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
function secretToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
export function sameSponsorToken(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0 && b.length >= 16;
}
function string(raw: unknown, max = 200) {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}
const local = (host: string) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(host);
function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new SponsorError(403, 'Origin not allowed.');
}
export function assertSponsorStudio(request: Request, v: SponsorVars) {
  const token = v.STUDIO_TOKEN?.trim();
  if (
    !token ||
    !sameSponsorToken(request.headers.get('x-studio-token') ?? '', token)
  )
    throw new SponsorError(401, 'Studio token rejected.');
  return readStudioId(request.headers.get('x-studio-id'));
}
function capabilities(raw: unknown): SponsorCapabilities {
  const c = raw as Record<string, unknown> | null;
  return {
    message: c?.message === true,
    spotlight: c?.spotlight === true,
    cap: c?.cap === true,
    ...(typeof c?.capTemplateVersion === 'string'
      ? { capTemplateVersion: c.capTemplateVersion.slice(0, 100) }
      : {}),
  };
}
async function producer(d: D1Database, now: number) {
  const row = await d
    .prepare(
      "SELECT p.* FROM sponsor_producer p JOIN meta m ON m.key='studio_id' AND m.value=p.studio_id WHERE p.id=1",
    )
    .first<{ studio_id: string; seen_at: number; capabilities: string }>();
  return {
    studioOnline: !!row && now - row.seen_at < sponsorLimits.heartbeatMs,
    capabilities: capabilities(row ? JSON.parse(row.capabilities) : null),
  };
}
/**
 * The asset an order names, checked for the stage it is at. `order` (draft, quote,
 * replaceLogo): the logo is this host's, on the current wardrobe, and the tailor has not
 * given up on it. `air` (context, pull, reschedule): the look is in place, so the studio
 * gets a `sourceUrl`, `sha256` and `templateVersion` the route can pin every dressed shot to.
 */
export async function qualifiedSponsorAsset(
  d: D1Database,
  draft: ReturnType<typeof validateSponsorDraft>,
  caps?: SponsorCapabilities,
  stage: 'order' | 'air' = 'order',
) {
  if (!draft.assetId) return null;
  const asset = await db.getAsset(d, draft.assetId);
  if (!asset) throw new SponsorError(409, 'Add your logo first.', 'ASSET');
  let meta: Omit<Partial<LookAssetMetadata>, 'kind'> & { kind?: string };
  try {
    meta = JSON.parse(asset.metadata);
  } catch {
    throw new SponsorError(
      409,
      'Artwork qualification is unavailable.',
      'ASSET',
    );
  }
  if (draft.product === 'spotlight') {
    if (meta.kind !== 'logo' || asset.status !== 'qualified')
      throw new SponsorError(
        409,
        'Choose a project logo for the spotlight.',
        'ASSET',
      );
    return asset;
  }
  if (draft.product !== 'cap') return asset;
  if (asset.status === 'refused')
    throw new SponsorError(
      409,
      `This logo could not be dressed${meta.reason ? ` (${meta.reason})` : ''}. Use a different logo.`,
      'ASSET',
    );
  if (
    meta.kind !== 'cap' ||
    meta.target !== draft.target ||
    meta.templateVersion !== LOOK_VERSION ||
    (caps && meta.templateVersion !== caps.capTemplateVersion) ||
    !['logo', 'qualified'].includes(asset.status)
  )
    throw new SponsorError(
      409,
      'This logo is not ready for this host on the current wardrobe.',
      'ASSET',
    );
  if (
    stage === 'air' &&
    (asset.status !== 'qualified' ||
      typeof meta.sourceUrl !== 'string' ||
      !meta.look?.sha256 ||
      meta.look.sha256 !== meta.sha256)
  )
    throw new SponsorError(409, 'This look is still being tailored.', 'ASSET');
  return asset;
}

function mintFor(v: SponsorVars, asset: SponsorAsset) {
  return asset === 'SOL'
    ? null
    : asset === 'USDC'
      ? v.SPONSOR_USDC_MINT?.trim() || USDC_MINT
      : v.COIN_MINT?.trim() || null;
}
async function assetState(
  d: D1Database,
  v: SponsorVars,
  asset: SponsorAsset,
  now: number,
) {
  const mint = mintFor(v, asset);
  if (asset !== 'SOL' && !mint)
    throw new SponsorError(
      503,
      'This payment asset is not configured.',
      'ASSET',
    );
  const treasury = v.TREASURY_WALLET?.trim();
  if (!validWallet(treasury))
    throw new SponsorError(
      503,
      'Sponsorship treasury is not configured.',
      'TREASURY',
    );
  const c = connection(v);
  // Jupiter prices mainnet only, and then dates its answer by a mainnet block a devnet
  // RPC has never heard of. A pinned SOL price is what makes a devnet quote possible at
  // all; every other asset still has to be priced for real.
  const { solUsd } = devnetPricing(v);
  const [info, price] = await Promise.all([
    mint ? tokenInfo(c, mint) : Promise.resolve({ decimals: 9 }),
    asset === 'USDC'
      ? Promise.resolve('1')
      : asset === 'SOL' && solUsd
        ? Promise.resolve(solUsd)
        : fetchSponsorPrice(
            c,
            mint ?? SOL_MINT,
            v.JUPITER_API_KEY || v.JUP_API_KEY,
            now,
          ),
  ]);
  const recipient = await spendable(c, treasury, mint);
  if (mint && !recipient.hasAta)
    throw new SponsorError(
      503,
      'The treasury token account is not ready.',
      'TREASURY',
    );
  return { mint, decimals: info.decimals, priceUsd: price, treasury };
}
export async function sponsorCatalog(
  request: Request,
  v: SponsorVars,
): Promise<SponsorCatalog> {
  const d = await sponsorDatabase(v),
    now = Date.now();
  const [live, capQueue] = await Promise.all([
    producer(d, now),
    db.capQueue(d),
  ]);
  const enabled = checkoutOpen(v);
  const { flatCents } = devnetPricing(v);
  const assets = await Promise.all(
    (['FROGCLENCH', 'USDC', 'SOL'] as const).map(async (id) => {
      try {
        if (!enabled) throw new SponsorError(503, CHECKOUT_CLOSED);
        const state = await assetState(d, v, id, now);
        return {
          id,
          mint: state.mint,
          decimals: state.decimals,
          priceUsd: state.priceUsd,
          available: true,
          reason: null,
        };
      } catch (e) {
        return {
          id,
          mint: mintFor(v, id),
          decimals: id === 'SOL' ? 9 : 6,
          priceUsd: null,
          available: false,
          reason:
            e instanceof SponsorError
              ? e.message
              : 'This payment asset is temporarily unavailable.',
        };
      }
    }),
  );
  return {
    products: sponsorOffers.map((p) => ({
      id: p.id,
      title: p.title,
      priceCents: sponsorPriceCents(p.id, 'USDC', flatCents),
      frogPriceCents: sponsorPriceCents(p.id, 'FROGCLENCH', flatCents),
      available:
        enabled &&
        live.studioOnline &&
        live.capabilities[p.id] &&
        assets.some((a) => a.available),
      reason: !enabled
        ? CHECKOUT_CLOSED
        : !live.studioOnline
          ? 'The studio is offline.'
          : !live.capabilities[p.id]
            ? 'The studio cannot deliver this placement right now.'
            : !assets.some((a) => a.available)
              ? 'Payment services are unavailable.'
              : null,
    })),
    assets,
    capQueue,
    ...live,
    treasury: validWallet(v.TREASURY_WALLET) ? v.TREASURY_WALLET! : null,
    clientRpcUrl: `${new URL(request.url).origin}/api/rpc`,
    now,
  };
}
/** Where a request is answered from: the public origin, and the cluster its payments settle on. */
type Site = { origin: string; cluster: Cluster };
function attemptView(a: db.AttemptRow, site: Site): SponsorAttempt {
  return {
    id: a.id,
    productVersion: a.product_version,
    asset: a.asset,
    amountBase: a.amount_base,
    amountUi: amountUi(a.amount_base, a.decimals),
    decimals: a.decimals,
    priceCents: a.price_cents,
    priceUsd: a.price_usd,
    reference: a.reference,
    recipient: a.recipient,
    mint: a.mint,
    issuedAt: a.issued_at,
    expiresAt: a.expires_at,
    lastValidBlockHeight: a.last_valid_block_height,
    status: a.status,
    broadcastSignature: a.broadcast_signature,
    verifiedSignature: a.verified_signature,
    explorerUrl: a.verified_signature
      ? explorerTx(a.verified_signature, site.cluster)
      : null,
    solanaPayUrl: `solana:${encodeURIComponent(`${site.origin}/api/solana-pay/${a.pay_token}`)}`,
  };
}
/** Where a cap order's look stands, for the receipt: tailoring, ready (fallback or not), or refused. */
function lookState(asset: db.AssetRow, o: db.OrderRow): SponsorLook {
  let meta: Partial<LookAssetMetadata> = {};
  try {
    meta = JSON.parse(asset.metadata);
  } catch {}
  // Round 0 is "no round spent yet": a request the desk never took hands its round back.
  const spentRound = meta.look?.round ?? meta.tailor?.round;
  const round = spentRound ? spentRound : undefined;
  // The clock the receipt's waiting copy reads, the same one replaceLogo keeps: the payment,
  // moved forward by a swap for a different logo. Read from the order, it survives a reload
  // and a receipt opened on another device.
  const withRound = {
    ...(round === undefined ? {} : { round }),
    ...(o.paid_at ? { since: Math.max(o.paid_at, o.updated_at) } : {}),
  };
  if (asset.status === 'qualified')
    return {
      status: 'ready',
      url: asset.url,
      ...withRound,
      ...(meta.look?.fallback ? { fallback: meta.look.fallback } : {}),
    };
  if (asset.status === 'refused')
    return {
      status: 'refused',
      ...(meta.reason ? { reason: meta.reason } : {}),
      ...withRound,
    };
  return { status: 'tailoring', ...withRound };
}
export async function sponsorReceipt(
  d: D1Database,
  o: db.OrderRow,
  token: string,
  site: Site,
): Promise<SponsorReceipt> {
  const [attempts, asset, standing] = await Promise.all([
    d
      .prepare(
        'SELECT * FROM sponsor_payment_attempts WHERE order_id=? ORDER BY issued_at DESC',
      )
      .bind(o.id)
      .all<db.AttemptRow>(),
    JSON.parse(o.draft).assetId
      ? db.getAsset(d, JSON.parse(o.draft).assetId)
      : Promise.resolve(null),
    db.queueStanding(d, o),
  ]);
  const queuePosition = ['paid', 'leased', 'prepared'].includes(o.status)
    ? standing.position
    : null;
  // The overall queue position cannot tell a cap buyer the one thing they want to know:
  // caps for one host go on one at a time (`leaseOrders`), so a paid cap may be waiting
  // for an earlier cap on the same host even when it is next in the queue otherwise.
  const capAhead =
    o.product === 'cap' && o.status === 'paid' ? standing.capAhead : null;
  return {
    id: o.id,
    token,
    status: o.status,
    draft: JSON.parse(o.draft),
    // What this order was actually quoted, in order of authority: the attempt that paid
    // it, then the most recent quote. A deployment may price differently from the listed
    // ladder, so the ladder answers only an order nobody has quoted yet.
    priceCents:
      attempts.results.find((a) => a.id === o.paid_attempt_id)?.price_cents ??
      attempts.results[0]?.price_cents ??
      sponsorProducts.find((p) => p.id === o.product)!.priceCents,
    attempts: attempts.results.map((a) => attemptView(a, site)),
    fulfillment: db.fulfillment(o),
    paidAt: o.paid_at,
    payer: o.payer,
    canReschedule: o.status === 'paused',
    assetUrl: asset?.url ?? null,
    queuePosition,
    capAhead,
    ...(o.product === 'cap' && asset ? { look: lookState(asset, o) } : {}),
  };
}
async function authenticateReceipt(d: D1Database, raw: unknown) {
  const token = string(raw, 64);
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new SponsorError(404, 'Receipt not found.');
  const order = await db.getOrderByToken(d, await hashSponsorToken(token));
  if (!order) throw new SponsorError(404, 'Receipt not found.');
  return { token, order };
}
/**
 * Ask the desk for the look of the asset an order names. Called the one time a payment
 * settles an order, by the reconciler for a round that went unanswered, and by replaceLogo.
 * The look is made once per asset: a `qualified` asset is reused as it is (a later order for
 * the same logo shows the existing look at once), except one wearing the fallback print,
 * which gets its single upgrade fit at round 2. Never throws: the confirm response and the
 * reconciler's counters are the same whatever the desk does. A request the desk refuses
 * outright (a non-409 4xx) is a verdict on the logo and refuses the asset at once.
 */
export async function requestTailor(
  d: D1Database,
  v: SponsorMediaVars,
  orderId: string,
  round: number,
): Promise<void> {
  try {
    const order = await db.getOrder(d, orderId);
    if (!order || order.product !== 'cap') return;
    const draft = JSON.parse(order.draft) as SponsorDraft;
    if (!draft.assetId || !draft.target) return;
    const asset = await db.getAsset(d, draft.assetId);
    if (!asset) return;
    const meta = JSON.parse(asset.metadata) as LookAssetMetadata;
    const upgrade =
      asset.status === 'qualified' && !!meta.look?.fallback && round === 2;
    if (asset.status !== 'logo' && !upgrade) return;
    const spent = meta.tailor?.round ?? 0;
    await db.markTailorRequested(d, asset.id, {
      round,
      requestedAt: Date.now(),
      ...(meta.tailor?.reasons ? { reasons: meta.tailor.reasons } : {}),
    });
    let refused: { status: number; code: string } | null = null;
    try {
      // A site with no desk configured is one more desk that did not take the job.
      const { url, token } = sponsorMediaConfig(v);
      const response = await fetch(new URL('/tailor', url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          assetId: asset.id,
          round,
          target: draft.target,
          logoUrl: meta.logoUrl,
          logoSha256: meta.logoSha256,
          palette: meta.palette,
          projectName: draft.projectName ?? '',
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
      };
      refused = { status: response.status, code: body.code ?? '' };
    } catch (e) {
      refused = {
        status: 0,
        code: e instanceof Error ? e.message : 'request failed',
      };
    }
    // Only the desk's callback refuses a logo. An answer to this request refuses the request:
    // 503 while the desk boots, 409 while it is full, 4xx because this site's body or its
    // configuration is wrong, 401 for a stale token, nothing at all when it is down. None of
    // them looked at the logo, so the round is handed back and the reconciler asks again in
    // four minutes; otherwise a desk that was down for twelve minutes would spend every round
    // and refuse a logo nobody ever saw. An upgrade keeps its round: the paid order already
    // wears a look and does not need another try.
    await db.markTailorRequested(d, asset.id, {
      round: upgrade ? round : spent,
      requestedAt: Date.now(),
      ...(meta.tailor?.reasons ? { reasons: meta.tailor.reasons } : {}),
    });
    // A 4xx is this site's own bug or configuration, not a passing condition: say so loudly.
    const ourFault =
      refused.status >= 400 && refused.status < 500 && refused.status !== 409;
    (ourFault ? console.error : console.warn)(
      ourFault
        ? '[sponsorship] the tailor refused this request'
        : '[sponsorship] tailor deferred',
      asset.id,
      refused.status,
      refused.code,
    );
  } catch (e) {
    console.warn(
      '[sponsorship] tailor deferred',
      orderId,
      e instanceof Error ? e.message : 'request failed',
    );
  }
}
async function recoverAttempt(
  d: D1Database,
  v: SponsorMediaVars,
  input: db.AttemptRow,
  offered?: string,
  deadlineAt = Date.now() + 15000,
) {
  // A verified attempt has nothing left to recover: no lock, no RPC calls, no write. Left in,
  // every pass re-read the chain and re-stamped the ten oldest attempts, day and night, which
  // is what spent the database's daily write allowance on a devnet holding eight orders.
  if (input.status === 'verified') return input;
  const lock = await db.acquireLock(
    d,
    `attempt:${input.id}`,
    Date.now(),
    60000,
  );
  if (!lock) return db.getAttempt(d, input.id);
  try {
    const a = (await db.getAttempt(d, input.id))!,
      c = connection(v),
      now = Date.now();
    const scanStartedHeight = a.scan_before
      ? a.scan_started_height
      : await c.getBlockHeight('finalized');
    let broadcastAmbiguous = false,
      paidNow = false;
    if (offered) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(offered))
        throw new SponsorError(400, 'Invalid transaction signature.');
      const proof = await verifySponsorSignature(c, offered, a);
      if (proof)
        paidNow =
          (await db.settlePayment(d, a.id, proof, now)).orderPaidNow || paidNow;
    }
    if (a.broadcast_signature) {
      const proof = await verifySponsorSignature(c, a.broadcast_signature, a);
      if (proof)
        paidNow =
          (await db.settlePayment(d, a.id, proof, now)).orderPaidNow || paidNow;
      else {
        const status = (
          await c.getSignatureStatuses([a.broadcast_signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
        broadcastAmbiguous = !!status && !status.err;
      }
    }
    const scan = await scanSponsorReference(c, a, { deadlineAt });
    for (const proof of scan.payments)
      paidNow =
        (await db.settlePayment(d, a.id, proof, now)).orderPaidNow || paidNow;
    let expired = false;
    if (now > a.expires_at && scan.complete && !broadcastAmbiguous) {
      if (a.last_valid_block_height !== null)
        expired =
          scanStartedHeight !== null &&
          scanStartedHeight > a.last_valid_block_height;
      else expired = !a.build_lock || !a.build_until || a.build_until < now;
    }
    await d
      .prepare(
        `UPDATE sponsor_payment_attempts SET scan_before=?,scan_started_height=?,scan_complete=?,last_checked_at=?,status=CASE WHEN ?=1 AND status IN ('issued','submitted') THEN 'expired' ELSE status END WHERE id=? AND EXISTS(SELECT 1 FROM sponsor_locks WHERE id=? AND token=? AND until_at>?)`,
      )
      .bind(
        scan.before,
        scan.complete ? null : scanStartedHeight,
        scan.complete ? 1 : 0,
        now,
        expired ? 1 : 0,
        a.id,
        `attempt:${a.id}`,
        lock,
        Date.now(),
      )
      .run();
    // The one moment this order became paid, still under the attempt lock: ask for its look.
    if (paidNow) await requestTailor(d, v, a.order_id, 1);
    return db.getAttempt(d, a.id);
  } finally {
    await db.releaseLock(d, `attempt:${input.id}`, lock);
  }
}

async function walletTransaction(
  d: D1Database,
  v: SponsorVars,
  a: db.AttemptRow,
  wallet: string,
): Promise<db.AttemptRow> {
  if (!validWallet(wallet))
    throw new SponsorError(400, 'Connect a Solana wallet first.', 'WALLET');
  if (a.status === 'expired' || a.status === 'verified')
    throw new SponsorError(
      409,
      'This payment attempt is closed. Check its receipt.',
      'EXPIRED',
    );
  if (a.unsigned_tx) {
    if (a.wallet_hint !== wallet)
      throw new SponsorError(
        409,
        'This attempt is already assigned to another wallet. Keep checking its receipt.',
        'PENDING',
      );
    return a;
  }
  if (a.status !== 'issued' || Date.now() > a.expires_at)
    throw new SponsorError(
      409,
      'This quote expired. Recover its receipt before requesting another.',
      'EXPIRED',
    );
  const order = await db.getOrder(d, a.order_id);
  if (!order || order.paid_attempt_id)
    throw new SponsorError(409, 'This order is already paid.', 'PAID');
  const lock = await db.acquireLock(d, `attempt:${a.id}`, Date.now(), 30000);
  if (!lock)
    throw new SponsorError(
      409,
      'This payment transaction is being prepared. Keep this receipt open.',
      'PENDING',
    );
  try {
    await d
      .prepare(
        'UPDATE sponsor_payment_attempts SET build_lock=?,build_until=? WHERE id=? AND unsigned_tx IS NULL',
      )
      .bind(lock, Date.now() + 30000, a.id)
      .run();
    const current = await db.getAttempt(d, a.id);
    if (current!.unsigned_tx) return walletTransaction(d, v, current!, wallet);
    if (
      !current ||
      current.status !== 'issued' ||
      Date.now() > current.expires_at
    )
      throw new SponsorError(
        409,
        'This quote expired before its transaction was issued. Recover the receipt first.',
        'EXPIRED',
      );
    const built = await buildSponsorTransaction(connection(v), {
      wallet,
      recipient: a.recipient,
      mint: a.mint,
      amountBase: a.amount_base,
      decimals: a.decimals,
      reference: a.reference,
    });
    await d
      .prepare(
        `UPDATE sponsor_payment_attempts SET wallet_hint=?,unsigned_tx=?,last_valid_block_height=?,build_lock=NULL,build_until=NULL WHERE id=? AND status='issued' AND unsigned_tx IS NULL AND build_lock=? AND build_until>? AND EXISTS(SELECT 1 FROM sponsor_orders WHERE id=? AND paid_attempt_id IS NULL)`,
      )
      .bind(
        wallet,
        built.transaction,
        built.lastValidBlockHeight,
        a.id,
        lock,
        Date.now(),
        a.order_id,
      )
      .run();
    const result = await db.getAttempt(d, a.id);
    if (!result?.unsigned_tx)
      throw new SponsorError(
        409,
        'The payment attempt changed. Recover your receipt.',
        'PENDING',
      );
    return result;
  } finally {
    await db.releaseLock(d, `attempt:${a.id}`, lock);
  }
}
async function quote(
  d: D1Database,
  v: SponsorMediaVars,
  o: db.OrderRow,
  asset: SponsorAsset,
  wallet: string | undefined,
  site: Site,
  token: string,
) {
  if (!['FROGCLENCH', 'USDC', 'SOL'].includes(asset))
    throw new SponsorError(400, 'Choose a payment asset.');
  if (o.paid_attempt_id)
    throw new SponsorError(409, 'This order is already paid.');
  const open = await d
    .prepare(
      "SELECT * FROM sponsor_payment_attempts WHERE order_id=? AND status IN ('issued','submitted') LIMIT 1",
    )
    .bind(o.id)
    .first<db.AttemptRow>();
  if (open) {
    const a = await recoverAttempt(d, v, open);
    if (a?.status !== 'expired') {
      if (a?.asset !== asset)
        throw new SponsorError(
          409,
          'A payment is still possible on the existing quote. Check it before changing assets.',
          'PENDING',
        );
      const updated =
        wallet && a?.status === 'issued'
          ? await walletTransaction(d, v, a, wallet)
          : a!;
      return {
        receipt: await sponsorReceipt(
          d,
          (await db.getOrder(d, o.id))!,
          token,
          site,
        ),
        attempt: attemptView(updated, site),
        transaction: updated.unsigned_tx ?? undefined,
        solanaPayUrl: attemptView(updated, site).solanaPayUrl,
      };
    }
  }
  // A pass saved before its placement came off sale keeps any quote it already holds, so a
  // payment in flight still lands; it never gets a new charge.
  if (!sponsorOffers.some((p) => p.id === o.product))
    throw new SponsorError(
      409,
      'This placement is no longer offered. Start a new pass.',
    );
  const lock = await db.acquireLock(d, 'quotes', Date.now(), 120000);
  if (!lock)
    throw new SponsorError(
      409,
      'Another quote is being checked. Try again shortly.',
      'BUSY',
    );
  try {
    const now = Date.now();
    assertCheckoutOpen(v);
    const live = await producer(d, now);
    if (!live.studioOnline || !live.capabilities[o.product])
      throw new SponsorError(
        409,
        'The studio cannot deliver this placement right now.',
        'OFFAIR',
      );
    await qualifiedSponsorAsset(d, JSON.parse(o.draft), live.capabilities, 'order');
    const state = await assetState(d, v, asset, now),
      cents = sponsorPriceCents(o.product, asset, devnetPricing(v).flatCents),
      amount = amountBaseForCents(cents, state.priceUsd, state.decimals);
    const id = crypto.randomUUID();
    await db.insertAttempt(
      d,
      {
        id,
        order_id: o.id,
        pay_token: secretToken(),
        asset,
        mint: state.mint,
        decimals: state.decimals,
        amount_base: amount,
        price_usd: state.priceUsd,
        price_cents: cents,
        recipient: state.treasury,
        reference: randomPayReference(),
        issued_at: Date.now(),
        expires_at: Date.now() + sponsorLimits.quoteMs,
      },
      lock,
    );
    let attempt = (await db.getAttempt(d, id))!;
    if (wallet) attempt = await walletTransaction(d, v, attempt, wallet);
    const view = attemptView(attempt, site);
    return {
      receipt: await sponsorReceipt(
        d,
        (await db.getOrder(d, o.id))!,
        token,
        site,
      ),
      attempt: view,
      transaction: attempt.unsigned_tx ?? undefined,
      solanaPayUrl: view.solanaPayUrl,
    };
  } finally {
    await db.releaseLock(d, 'quotes', lock);
  }
}
async function submit(
  d: D1Database,
  v: SponsorVars,
  a: db.AttemptRow,
  signed: string,
) {
  if (!a.unsigned_tx || signed.length > 6000)
    throw new SponsorError(400, 'This attempt has no valid transaction.');
  const wire = inspectSponsorSigned(signed, a.unsigned_tx);
  // Persist the deterministic signature BEFORE network IO. A timeout is ambiguous and keeps
  // this same wire recoverable; neither browser nor server creates a replacement charge.
  const r = await d
    .prepare(
      `UPDATE sponsor_payment_attempts SET broadcast_signature=COALESCE(broadcast_signature,?),signed_tx=COALESCE(signed_tx,?),status=CASE WHEN status='issued' THEN 'submitted' ELSE status END WHERE id=? AND status IN ('issued','submitted') AND (broadcast_signature IS NULL OR broadcast_signature=?) RETURNING id`,
    )
    .bind(wire.signature, signed, a.id, wire.signature)
    .all();
  if (!r.results.length) {
    if (a.verified_signature) return;
    throw new SponsorError(
      409,
      'This attempt is no longer open. Recover your receipt.',
      'PENDING',
    );
  }
  try {
    await connection(v).sendRawTransaction(wire.wire, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    });
  } catch {
    /* Always reconcile this immutable signature, including ambiguous RPC errors. */
  }
}
export async function reconcileSponsorships(v: SponsorMediaVars) {
  const d = await sponsorDatabase(v),
    now = Date.now();
  // The sweeps write only the rows that moved, so an idle pass costs reads. The lock is two
  // writes, and re-checking an attempt re-stamps it: both wait for an attempt worth checking.
  // An idle pass used to take the lock and re-stamp the ten oldest attempts every twenty
  // seconds, forever: sixty thousand writes a day for a database with nothing to do.
  await db.pauseExpired(d, now);
  // A lease that just lapsed may have paused an order whose cooldown is already over.
  await db.resumeDue(d, now);
  await d
    .prepare('DELETE FROM sponsor_rate_limits WHERE window_at<?')
    .bind(now - 3600000)
    .run();
  // Open quotes always; an expired one only while a late payment could still arrive, and
  // then no more than every few minutes; a verified one never. And the looks the tailor
  // still owes: a round that went unanswered, a spent logo, a fallback due its upgrade.
  const [attempts, tailoring] = await Promise.all([
    d
      .prepare(
        `SELECT * FROM sponsor_payment_attempts WHERE status IN ('issued','submitted') OR (status='expired' AND issued_at>? AND last_checked_at<?) ORDER BY CASE WHEN status IN ('issued','submitted') THEN 0 ELSE 1 END,last_checked_at ASC LIMIT 10`,
      )
      .bind(
        now - interactLimits.recoverWindowMs,
        now - interactLimits.recoverRecheckMs,
      )
      .all<db.AttemptRow>(),
    db.tailorProbe(d, now),
  ]);
  if (!attempts.results.length && !tailoring.length)
    return { ok: true, idle: true, checked: 0, errors: 0 };
  const lock = await db.acquireLock(d, 'reconcile', now, 90000);
  if (!lock) return { ok: true, busy: true };
  let checked = 0,
    errors = 0;
  try {
    for (const a of attempts.results) {
      if (Date.now() - now > 40000) break;
      try {
        await recoverAttempt(
          d,
          v,
          a,
          undefined,
          Math.min(now + 45000, Date.now() + 12000),
        );
        checked++;
      } catch {
        errors++;
        await d
          .prepare(
            'UPDATE sponsor_payment_attempts SET last_checked_at=? WHERE id=?',
          )
          .bind(Date.now(), a.id)
          .run();
      }
    }
    let tailored = 0;
    for (const job of tailoring) {
      if (Date.now() - now > 40000) break;
      if (job.nextRound > 3) {
        // Three rounds without a look: the logo is refused, and the receipt offers a new one.
        await db.applyLook(d, job.assetId, {
          kind: 'refused',
          reason: "We couldn't finish tailoring this logo.",
          round: 3,
        });
        continue;
      }
      await requestTailor(d, v, job.orderId, job.nextRound);
      tailored++;
    }
    return { ok: true, checked, errors, tailored };
  } finally {
    await db.releaseLock(d, 'reconcile', lock);
  }
}

export async function sponsorContext(
  d: D1Database,
  id: string,
  studioId: string,
  leaseToken: string,
  caps: SponsorCapabilities,
): Promise<SponsorLease> {
  const o = await db.getOrder(d, id);
  if (
    !o ||
    o.lease_owner !== studioId ||
    o.lease_token !== leaseToken ||
    !o.lease_until ||
    o.lease_until < Date.now() ||
    !['leased', 'prepared', 'playing', 'fulfilled'].includes(o.status)
  )
    throw new SponsorError(409, 'The delivery lease ended.', 'LEASE');
  if (!caps[o.product])
    throw new SponsorError(
      409,
      'The current producer cannot deliver this placement.',
      'CAPABILITY',
    );
  const draft = JSON.parse(o.draft);
  const asset = await qualifiedSponsorAsset(d, draft, caps, 'air');
  return {
    id: o.id,
    draft,
    leaseToken: o.lease_token,
    leaseUntil: o.lease_until,
    fulfillment: db.fulfillment(o),
    assetUrl: asset?.url ?? null,
    assetMetadata: asset ? JSON.parse(asset.metadata) : null,
  };
}

async function studioProxy(
  request: Request,
  v: SponsorVars,
  body: Record<string, unknown>,
) {
  const site = request.headers.get('sec-fetch-site');
  if (
    !local(new URL(request.url).hostname) ||
    (site && site !== 'same-origin' && site !== 'none')
  )
    throw new SponsorError(
      403,
      'The studio bridge only serves its own machine.',
    );
  if (!v.STUDIO_TOKEN)
    throw new SponsorError(503, 'Studio token is not configured.');
  const origin = new URL(v.INTERACT_ORIGIN!).origin;
  const upstream = await fetch(`${origin}/api/sponsorship`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-studio-token': v.STUDIO_TOKEN,
      'x-studio-id': readStudioId(v.STUDIO_ID),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    throw new SponsorError(
      502,
      `The site at ${origin} answered ${upstream.status} without JSON; it may not have the sponsorship release deployed.`,
      'SITE',
    );
  }
  return response(data, upstream.status);
}
/** How long a logo may keep tailoring before the buyer may swap it for another. */
const REPLACE_AFTER_MS = 600000;
/**
 * A paid buyer picks a different logo when the tailor gave up on theirs, has been at it for
 * more than ten minutes, or could only manage the fallback cap print. The new logo must pass
 * the order gate for the same host; the order's draft then names it and round 1 starts. The
 * same logo again resets its rounds instead.
 */
async function replaceLogo(
  d: D1Database,
  v: SponsorMediaVars,
  order: db.OrderRow,
  assetId: string,
) {
  const draft = JSON.parse(order.draft) as SponsorDraft;
  if (order.product !== 'cap' || order.status !== 'paid')
    throw new SponsorError(
      409,
      'A logo can be changed on a paid cap that is not on air yet.',
    );
  if (!/^[a-f0-9]{64}$/.test(assetId))
    throw new SponsorError(400, 'Choose a logo to use instead.');
  await qualifiedSponsorAsset(d, { ...draft, assetId }, undefined, 'order');
  const current = draft.assetId ? await db.getAsset(d, draft.assetId) : null;
  let meta: Partial<LookAssetMetadata> = {};
  try {
    meta = current ? JSON.parse(current.metadata) : {};
  } catch {}
  const now = Date.now();
  const since = Math.max(order.paid_at ?? 0, order.updated_at);
  const swappable =
    !current ||
    current.status === 'refused' ||
    (current.status === 'logo' && now - since > REPLACE_AFTER_MS) ||
    (current.status === 'qualified' && !!meta.look?.fallback);
  if (!swappable)
    throw new SponsorError(
      409,
      'This logo is still being tailored. Give it a few more minutes.',
    );
  const changed = await d
    .prepare(
      `UPDATE sponsor_orders SET draft=json_set(draft,'$.assetId',?),updated_at=? WHERE id=? AND status='paid'`,
    )
    .bind(assetId, now, order.id)
    .run();
  if (changed.meta.changes !== 1)
    throw new SponsorError(409, 'This cap just went on air.', 'LEASE');
  if (current && current.id === assetId)
    await d
      .prepare(
        `UPDATE sponsor_assets SET metadata=json_remove(metadata,'$.tailor') WHERE id=? AND status='logo'`,
      )
      .bind(assetId)
      .run();
  await requestTailor(d, v, order.id, 1);
}
export async function handleSponsorship(
  request: Request,
  v: SponsorMediaVars,
): Promise<Response> {
  try {
    const url = new URL(request.url),
      site: Site = {
        origin: url.origin,
        cluster: clusterOf(v.SOLANA_RPC_URL),
      };
    if (request.method === 'GET') {
      const action = url.searchParams.get('action') ?? 'catalog';
      if (action === 'catalog')
        return response(await sponsorCatalog(request, v));
      const d = await sponsorDatabase(v);
      if (action === 'receipt') {
        const auth = await authenticateReceipt(
          d,
          url.searchParams.get('token'),
        );
        return response({
          receipt: await sponsorReceipt(d, auth.order, auth.token, site),
        });
      }
      if (action === 'activity') {
        const rows = await d
          .prepare(
            `SELECT o.*,a.url AS asset_url FROM sponsor_orders o LEFT JOIN sponsor_assets a ON a.id=json_extract(o.draft,'$.assetId') WHERE o.paid_attempt_id IS NOT NULL ORDER BY o.paid_at DESC LIMIT 12`,
          )
          .all<db.OrderRow & { asset_url: string | null }>();
        return response({
          orders: rows.results.map((o) => {
            const draft = JSON.parse(o.draft);
            return {
              id: o.id,
              product: o.product,
              from: draft.name,
              projectName: draft.projectName,
              projectUrl: draft.projectUrl,
              message: draft.message,
              status: o.status,
              assetUrl: o.asset_url,
              fulfillment: {
                startedAt: o.started_at,
                completedAt: o.completed_at,
              },
            };
          }),
        });
      }
      throw new SponsorError(400, 'Unknown action.');
    }
    assertSameOrigin(request);
    const body = (await request.json().catch(() => {
      throw new SponsorError(400, 'Send a JSON body.');
    })) as Record<string, unknown>;
    if (!body || typeof body !== 'object')
      throw new SponsorError(400, 'Send a JSON body.');
    const action = string(body.action);
    if (
      ['heartbeat', 'pull', 'event', 'context', 'console'].includes(action) &&
      v.INTERACT_ORIGIN
    )
      return await studioProxy(request, v, body);
    const d = await sponsorDatabase(v);
    if (['heartbeat', 'pull', 'event', 'context', 'console'].includes(action)) {
      const studioId = assertSponsorStudio(request, v);
      if (action === 'console') {
        const rows = await d
          .prepare(
            "SELECT o.* FROM sponsor_orders o WHERE paid_attempt_id IS NOT NULL ORDER BY CASE WHEN status IN ('paid','leased','prepared','playing','paused') THEN 0 ELSE 1 END,paid_at DESC LIMIT 30",
          )
          .all<db.OrderRow>();
        return response({
          orders: rows.results.map((o) => ({
            id: o.id,
            draft: JSON.parse(o.draft),
            status: o.status,
            fulfillment: db.fulfillment(o),
          })),
        });
      }
      if (action === 'heartbeat') {
        await db.heartbeat(
          d,
          studioId,
          capabilities(body.capabilities),
          Date.now(),
        );
        return response({ ok: true });
      }
      const owner = await d
        .prepare(
          "SELECT p.studio_id,p.seen_at,p.capabilities FROM sponsor_producer p JOIN meta m ON m.key='studio_id' AND m.value=p.studio_id WHERE p.id=1",
        )
        .first<{ studio_id: string; seen_at: number; capabilities: string }>();
      // Pause recovery must work while the client intentionally withholds renewing heartbeats.
      // applyEvent still checks the exact order owner/token and cannot pause a replacement lease.
      const pausing = action === 'event' && body.type === 'paused';
      if (
        !pausing &&
        (!owner ||
          owner.studio_id !== studioId ||
          Date.now() - owner.seen_at >= sponsorLimits.heartbeatMs)
      )
        throw new SponsorError(
          409,
          'Heartbeat from the active studio is required.',
          'STUDIO_BUSY',
        );
      const currentCaps = capabilities(JSON.parse(owner?.capabilities ?? '{}'));
      if (action === 'context') {
        const order = await sponsorContext(
          d,
          string(body.orderId),
          studioId,
          string(body.leaseToken),
          currentCaps,
        );
        return response({ order });
      }
      if (
        action === 'event' &&
        ['prepare', 'start'].includes(string(body.type))
      )
        await sponsorContext(
          d,
          string(body.orderId),
          studioId,
          string(body.leaseToken),
          currentCaps,
        );
      if (action === 'pull') {
        await db.pauseExpired(d, Date.now());
        await db.resumeDue(d, Date.now());
        const rows = await db.leaseOrders(
          d,
          studioId,
          Date.now(),
          3,
          currentCaps,
        );
        const orders: SponsorLease[] = await Promise.all(
          rows.map(async (o) => {
            const draft = JSON.parse(o.draft),
              asset = await qualifiedSponsorAsset(d, draft, currentCaps, 'air');
            return {
              id: o.id,
              draft,
              leaseToken: o.lease_token!,
              leaseUntil: o.lease_until!,
              fulfillment: db.fulfillment(o),
              assetUrl: asset?.url ?? null,
              assetMetadata: asset ? JSON.parse(asset.metadata) : null,
            };
          }),
        );
        return response({ orders });
      }
      const row = await db.applyEvent(
        d,
        {
          orderId: string(body.orderId),
          leaseToken: string(body.leaseToken),
          eventId: string(body.eventId),
          studioId,
          type: body.type as db.FulfillmentEvent['type'],
          stage: body.stage as db.FulfillmentEvent['stage'],
          appearanceId: string(body.appearanceId) || undefined,
          visibleMs:
            typeof body.visibleMs === 'number' ? body.visibleMs : undefined,
        },
        Date.now(),
      );
      return response({
        ok: true,
        status: row?.status,
        fulfillment: row ? db.fulfillment(row) : null,
      });
    }
    if (
      !(await db.allowSponsorRequest(
        d,
        `${action}:${await hashSponsorToken(request.headers.get('cf-connecting-ip') || 'local')}`,
        action === 'confirm' ? 60 : 12,
        Date.now(),
      ))
    )
      throw new SponsorError(
        429,
        'Please wait a moment before trying again.',
        'RATE_LIMIT',
      );
    if (action === 'draft') {
      const draft = validateSponsorDraft(body.draft);
      await qualifiedSponsorAsset(d, draft, undefined, 'order');
      const token = secretToken(),
        id = crypto.randomUUID();
      await db.createOrder(d, {
        id,
        tokenHash: await hashSponsorToken(token),
        draft,
        now: Date.now(),
      });
      return response({
        receipt: await sponsorReceipt(
          d,
          (await db.getOrder(d, id))!,
          token,
          site,
        ),
      });
    }
    const { order, token } = await authenticateReceipt(d, body.token);
    if (action === 'quote')
      return response(
        await quote(
          d,
          v,
          order,
          body.asset as SponsorAsset,
          string(body.wallet) || undefined,
          site,
          token,
        ),
      );
    if (action === 'replaceLogo') {
      await replaceLogo(d, v, order, string(body.assetId, 100));
    } else if (action === 'confirm' && !body.attemptId) {
      const attempts = await d
        .prepare(
          'SELECT * FROM sponsor_payment_attempts WHERE order_id=? ORDER BY last_checked_at ASC LIMIT 5',
        )
        .bind(order.id)
        .all<db.AttemptRow>();
      for (const a of attempts.results) await recoverAttempt(d, v, a);
    } else if (action === 'submit' || action === 'confirm') {
      const a = await db.getAttempt(d, string(body.attemptId));
      if (!a || a.order_id !== order.id)
        throw new SponsorError(404, 'Payment attempt not found.');
      if (action === 'submit')
        await submit(d, v, a, string(body.signedTx, 6001));
      else await recoverAttempt(d, v, a, string(body.signature) || undefined);
    } else if (action === 'reschedule') {
      const live = await producer(d, Date.now());
      if (!live.studioOnline || !live.capabilities[order.product])
        throw new SponsorError(
          409,
          'The studio is not ready to reschedule this placement.',
        );
      await qualifiedSponsorAsset(
        d,
        JSON.parse(order.draft),
        live.capabilities,
        'air',
      );
      await db.reschedule(d, order.id, Date.now());
    } else throw new SponsorError(400, 'Unknown action.');
    return response({
      receipt: await sponsorReceipt(
        d,
        (await db.getOrder(d, order.id))!,
        token,
        site,
      ),
    });
  } catch (e) {
    return sponsorFailure(e);
  }
}
const payCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Accept',
  'Access-Control-Max-Age': '600',
};
export async function handleSolanaPay(
  request: Request,
  v: SponsorVars,
  capability: string,
) {
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: payCors });
  try {
    if (!/^[a-f0-9]{64}$/.test(capability))
      throw new SponsorError(404, 'Payment request not found.');
    const d = await sponsorDatabase(v),
      a = await db.getPayAttempt(d, capability);
    if (!a) throw new SponsorError(404, 'Payment request not found.');
    if (request.method === 'GET')
      return response(
        {
          label: 'Pepe & Chad sponsorship',
          icon: `${new URL(request.url).origin}/logo.png`,
        },
        200,
        payCors,
      );
    if (request.method !== 'POST')
      throw new SponsorError(405, 'Method not allowed.');
    if (!(await db.allowSponsorRequest(d, `pay:${a.id}`, 20, Date.now())))
      throw new SponsorError(
        429,
        'Please wait before retrying this payment request.',
        'RATE_LIMIT',
      );
    const body = (await request.json().catch(() => {
      throw new SponsorError(400, 'Send a JSON body.');
    })) as { account?: unknown };
    const attempt = await walletTransaction(d, v, a, string(body.account));
    return response(
      {
        transaction: attempt.unsigned_tx,
        message: `Sponsor Pepe & Chad — ${amountUi(attempt.amount_base, attempt.decimals)} ${attempt.asset}`,
      },
      200,
      payCors,
    );
  } catch (e) {
    const r = sponsorFailure(e);
    for (const [k, val] of Object.entries(payCors)) r.headers.set(k, val);
    return r;
  }
}
