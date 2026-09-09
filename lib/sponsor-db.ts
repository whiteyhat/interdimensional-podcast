// D1 conditional writes run inside atomic batches. No payment or fulfillment decision is client-owned.
import { heartbeatProducer, producerSchema } from './producer-lease';
import {
  SponsorError,
  sponsorLimits,
  fulfillmentComplete,
  type SponsorDraft,
  type SponsorAsset,
  type SponsorStatus,
  type SponsorFulfillment,
  type SponsorCapabilities,
} from './sponsorship';
export const sponsorSchema = [
  `CREATE TABLE IF NOT EXISTS sponsor_orders (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, draft TEXT NOT NULL, product TEXT NOT NULL,
 target TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL, paid_at INTEGER,
 paid_attempt_id TEXT, paid_signature TEXT UNIQUE, payer TEXT, lease_token TEXT, lease_owner TEXT,
 lease_until INTEGER, started_at INTEGER, completed_at INTEGER, visible_ms INTEGER NOT NULL DEFAULT 0,
 appearances INTEGER NOT NULL DEFAULT 0, intro INTEGER NOT NULL DEFAULT 0, callback INTEGER NOT NULL DEFAULT 0,
 last_progress_at INTEGER, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, pause_count INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS sponsor_payment_attempts (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sponsor_orders(id), pay_token TEXT NOT NULL UNIQUE,
 product_version TEXT NOT NULL DEFAULT 'sponsorship-v1', asset TEXT NOT NULL, mint TEXT, decimals INTEGER NOT NULL, amount_base TEXT NOT NULL, price_usd TEXT NOT NULL,
 price_cents INTEGER NOT NULL, recipient TEXT NOT NULL, reference TEXT NOT NULL UNIQUE, issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued', wallet_hint TEXT, unsigned_tx TEXT,
 last_valid_block_height INTEGER, broadcast_signature TEXT, verified_signature TEXT UNIQUE, signed_tx TEXT,
 scan_before TEXT, scan_started_height INTEGER, scan_complete INTEGER NOT NULL DEFAULT 0, last_checked_at INTEGER NOT NULL DEFAULT 0,
 build_lock TEXT, build_until INTEGER
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sponsor_one_open_attempt ON sponsor_payment_attempts(order_id) WHERE status IN ('issued','submitted')`,
  `CREATE TABLE IF NOT EXISTS sponsor_payments (
 signature TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES sponsor_payment_attempts(id), order_id TEXT NOT NULL,
 payer TEXT NOT NULL, block_time INTEGER NOT NULL, verified_at INTEGER NOT NULL, is_late INTEGER NOT NULL DEFAULT 1
)`,
  `CREATE TABLE IF NOT EXISTS sponsor_fulfillment_events (
 event_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, lease_token TEXT NOT NULL, type TEXT NOT NULL,
 stage TEXT, appearance_id TEXT, visible_ms INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sponsor_unique_appearance ON sponsor_fulfillment_events(order_id,appearance_id) WHERE appearance_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS sponsor_refunds (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL, payment_signature TEXT NOT NULL UNIQUE, asset TEXT NOT NULL,
 mint TEXT, decimals INTEGER NOT NULL, amount_base TEXT NOT NULL, recipient TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', signed_tx TEXT, signature TEXT UNIQUE, last_valid_block_height INTEGER,
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lock_token TEXT, lock_until INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS sponsor_assets (id TEXT PRIMARY KEY, status TEXT NOT NULL, url TEXT NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}')`,
  ...producerSchema,
  `CREATE TABLE IF NOT EXISTS sponsor_rate_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, window_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sponsor_locks (id TEXT PRIMARY KEY, token TEXT NOT NULL, until_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sponsor_order_queue ON sponsor_orders(status,paid_at)`,
  `CREATE INDEX IF NOT EXISTS sponsor_attempt_recovery ON sponsor_payment_attempts(last_checked_at)`,
];
const ready = new WeakMap<D1Database, Promise<void>>();
export function ensureSponsorSchema(d: D1Database): Promise<void> {
  let p = ready.get(d);
  if (!p) {
    p = d.batch(sponsorSchema.map((s) => d.prepare(s))).then(async () => {
      // Cold starts can meet a database created by an earlier local preview of this migration.
      const upgrades: Record<string, Record<string, string>> = {
        sponsor_orders: {
          revision: 'INTEGER NOT NULL DEFAULT 0',
          pause_count: 'INTEGER NOT NULL DEFAULT 0',
          retry_after: 'INTEGER NOT NULL DEFAULT 0',
        },
        sponsor_payment_attempts: {
          scan_started_height: 'INTEGER',
          product_version: "TEXT NOT NULL DEFAULT 'sponsorship-v1'",
        },
      };
      for (const [table, columns] of Object.entries(upgrades)) {
        const existing = await d
          .prepare(`PRAGMA table_info(${table})`)
          .all<{ name: string }>();
        for (const [name, definition] of Object.entries(columns)) {
          if (existing.results.some((column) => column.name === name)) continue;
          try {
            await d
              .prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
              .run();
          } catch (e) {
            if (
              !/duplicate column name/i.test(
                e instanceof Error ? e.message : '',
              )
            )
              throw e;
          }
        }
      }
    });
    p.catch(() => ready.delete(d));
    ready.set(d, p);
  }
  return p;
}
export type OrderRow = {
  id: string;
  token_hash: string;
  draft: string;
  product: SponsorDraft['product'];
  target: string | null;
  status: SponsorStatus;
  created_at: number;
  paid_at: number | null;
  paid_attempt_id: string | null;
  paid_signature: string | null;
  payer: string | null;
  lease_token: string | null;
  lease_owner: string | null;
  lease_until: number | null;
  started_at: number | null;
  completed_at: number | null;
  visible_ms: number;
  appearances: number;
  intro: number;
  callback: number;
  last_progress_at: number | null;
  updated_at: number;
  revision: number;
  pause_count: number;
  retry_after: number;
};
export type AttemptRow = {
  id: string;
  product_version: string;
  order_id: string;
  pay_token: string;
  asset: SponsorAsset;
  mint: string | null;
  decimals: number;
  amount_base: string;
  price_usd: string;
  price_cents: number;
  recipient: string;
  reference: string;
  issued_at: number;
  expires_at: number;
  status: 'issued' | 'submitted' | 'expired' | 'verified';
  wallet_hint: string | null;
  unsigned_tx: string | null;
  last_valid_block_height: number | null;
  broadcast_signature: string | null;
  verified_signature: string | null;
  signed_tx: string | null;
  scan_before: string | null;
  scan_started_height: number | null;
  scan_complete: number;
  last_checked_at: number;
  build_lock: string | null;
  build_until: number | null;
};
export type RefundRow = {
  id: string;
  order_id: string;
  payment_signature: string;
  asset: SponsorAsset;
  mint: string | null;
  decimals: number;
  amount_base: string;
  recipient: string;
  status: 'queued' | 'signed' | 'submitted' | 'confirmed' | 'blocked';
  signed_tx: string | null;
  signature: string | null;
  last_valid_block_height: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  lock_token: string | null;
  lock_until: number | null;
};
export type AssetRow = {
  id: string;
  status: string;
  url: string;
  mime: string;
  created_at: number;
  metadata: string;
};
export const getOrder = (d: D1Database, id: string) =>
  d
    .prepare('SELECT * FROM sponsor_orders WHERE id=?')
    .bind(id)
    .first<OrderRow>();
export const getOrderByToken = (d: D1Database, hash: string) =>
  d
    .prepare('SELECT * FROM sponsor_orders WHERE token_hash=?')
    .bind(hash)
    .first<OrderRow>();
export const getAttempt = (d: D1Database, id: string) =>
  d
    .prepare('SELECT * FROM sponsor_payment_attempts WHERE id=?')
    .bind(id)
    .first<AttemptRow>();
export const getPayAttempt = (d: D1Database, token: string) =>
  d
    .prepare('SELECT * FROM sponsor_payment_attempts WHERE pay_token=?')
    .bind(token)
    .first<AttemptRow>();
export const getAsset = (d: D1Database, id: string) =>
  d
    .prepare('SELECT * FROM sponsor_assets WHERE id=?')
    .bind(id)
    .first<AssetRow>();
export async function createOrder(
  d: D1Database,
  v: { id: string; tokenHash: string; draft: SponsorDraft; now: number },
) {
  await d
    .prepare(
      'INSERT INTO sponsor_orders (id,token_hash,draft,product,target,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .bind(
      v.id,
      v.tokenHash,
      JSON.stringify(v.draft),
      v.draft.product,
      v.draft.target ?? null,
      v.now,
      v.now,
    )
    .run();
}
// Released only by verified chain expiry or an atomic fulfillment/refund transition.
// A frontend quote timer is not evidence that a transfer cannot still arrive.
const capObligation = `(c.product='cap' AND ((c.paid_attempt_id IS NOT NULL AND c.status IN ('paid','leased','prepared','playing','paused')) OR (c.paid_attempt_id IS NULL AND EXISTS(SELECT 1 FROM sponsor_payment_attempts a WHERE a.order_id=c.id AND a.status IN ('issued','submitted')))))`;
export async function capInventory(
  d: D1Database,
): Promise<{ host: boolean; guest: boolean }> {
  const rows = await d
    .prepare(
      `SELECT DISTINCT c.target FROM sponsor_orders c WHERE ${capObligation}`,
    )
    .all<{ target: string }>();
  return {
    host: !rows.results.some((r) => r.target === 'host'),
    guest: !rows.results.some((r) => r.target === 'guest'),
  };
}
export async function insertAttempt(
  d: D1Database,
  v: Pick<
    AttemptRow,
    | 'id'
    | 'order_id'
    | 'pay_token'
    | 'asset'
    | 'mint'
    | 'decimals'
    | 'amount_base'
    | 'price_usd'
    | 'price_cents'
    | 'recipient'
    | 'reference'
    | 'issued_at'
    | 'expires_at'
  >,
  quoteLock?: string,
) {
  await d.batch([
    d
      .prepare(
        `INSERT INTO sponsor_payment_attempts(id,order_id,pay_token,asset,mint,decimals,amount_base,price_usd,price_cents,recipient,reference,issued_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sponsor_orders o WHERE o.id=? AND o.paid_attempt_id IS NULL AND o.status IN ('draft','payment-pending') AND (o.product!='cap' OR NOT EXISTS(SELECT 1 FROM sponsor_orders c WHERE c.id!=o.id AND c.target=o.target AND ${capObligation}))) AND (? IS NULL OR EXISTS(SELECT 1 FROM sponsor_locks WHERE id='quotes' AND token=? AND until_at>?))`,
      )
      .bind(
        v.id,
        v.order_id,
        v.pay_token,
        v.asset,
        v.mint,
        v.decimals,
        v.amount_base,
        v.price_usd,
        v.price_cents,
        v.recipient,
        v.reference,
        v.issued_at,
        v.expires_at,
        v.order_id,
        quoteLock ?? null,
        quoteLock ?? null,
        v.issued_at,
      ),
    d
      .prepare(
        "UPDATE sponsor_orders SET status='payment-pending',updated_at=? WHERE id=? AND status='draft' AND EXISTS(SELECT 1 FROM sponsor_payment_attempts WHERE id=?)",
      )
      .bind(v.issued_at, v.order_id, v.id),
  ]);
  if (!(await getAttempt(d, v.id))) {
    const order = await getOrder(d, v.order_id);
    if (
      order?.product === 'cap' &&
      (order.target === 'host' || order.target === 'guest') &&
      !(await capInventory(d))[order.target]
    )
      throw new SponsorError(
        409,
        'This host’s cap is already reserved. Choose the other host or come back after this placement.',
        'INVENTORY',
      );
    throw new SponsorError(
      409,
      'This order can no longer accept a new payment.',
    );
  }
}
export async function settlePayment(
  d: D1Database,
  attemptId: string,
  p: { signature: string; payer: string; blockTime: number },
  now: number,
) {
  await d.batch([
    d
      .prepare(
        `INSERT OR IGNORE INTO sponsor_payments(signature,attempt_id,order_id,payer,block_time,verified_at) SELECT ?,id,order_id,?,?,? FROM sponsor_payment_attempts WHERE id=?`,
      )
      .bind(p.signature, p.payer, p.blockTime, now, attemptId),
    d
      .prepare(
        `UPDATE sponsor_orders SET paid_attempt_id=?,paid_signature=?,payer=?,paid_at=?,status='paid',updated_at=? WHERE paid_attempt_id IS NULL AND status IN ('draft','payment-pending') AND id=(SELECT order_id FROM sponsor_payment_attempts WHERE id=?) AND EXISTS(SELECT 1 FROM sponsor_payments WHERE signature=? AND attempt_id=?)`,
      )
      .bind(
        attemptId,
        p.signature,
        p.payer,
        now,
        now,
        attemptId,
        p.signature,
        attemptId,
      ),
    d
      .prepare(
        `UPDATE sponsor_payments SET is_late=0 WHERE signature=? AND attempt_id=? AND EXISTS(SELECT 1 FROM sponsor_orders WHERE paid_signature=? AND paid_attempt_id=?)`,
      )
      .bind(p.signature, attemptId, p.signature, attemptId),
    d
      .prepare(
        `UPDATE sponsor_payment_attempts SET status='verified',verified_signature=COALESCE(verified_signature,?) WHERE id=? AND EXISTS(SELECT 1 FROM sponsor_payments WHERE signature=? AND attempt_id=?)`,
      )
      .bind(p.signature, attemptId, p.signature, attemptId),
    // Extra transfers are always separate refund obligations; they never deliver another sponsorship.
    d
      .prepare(
        `INSERT OR IGNORE INTO sponsor_refunds(id,order_id,payment_signature,asset,mint,decimals,amount_base,recipient,created_at,updated_at) SELECT p.signature,p.order_id,p.signature,a.asset,a.mint,a.decimals,a.amount_base,p.payer,?,? FROM sponsor_payments p JOIN sponsor_payment_attempts a ON a.id=p.attempt_id WHERE p.signature=? AND p.attempt_id=? AND p.is_late=1`,
      )
      .bind(now, now, p.signature, attemptId),
  ]);
}
export function fulfillment(row: OrderRow): SponsorFulfillment {
  return {
    visibleMs: row.visible_ms,
    appearances: row.appearances,
    intro: !!row.intro,
    callback: !!row.callback,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
export async function leaseOrders(
  d: D1Database,
  studioId: string,
  now: number,
  limit = 3,
  caps?: SponsorCapabilities,
): Promise<OrderRow[]> {
  const active = await d
    .prepare(
      `SELECT * FROM sponsor_orders WHERE lease_owner=? AND lease_until>? AND status IN ('leased','prepared','playing') ORDER BY paid_at LIMIT 20`,
    )
    .bind(studioId, now)
    .all<OrderRow>();
  const leased = [...active.results];
  for (let i = leased.length; i < limit; i++) {
    const token = crypto.randomUUID();
    const rows = await d
      .prepare(
        `UPDATE sponsor_orders SET status='leased',lease_owner=?,lease_token=?,lease_until=?,updated_at=? WHERE id=(SELECT o.id FROM sponsor_orders o WHERE o.status='paid' AND CASE o.product WHEN 'message' THEN ? WHEN 'spotlight' THEN ? WHEN 'cap' THEN ? ELSE 0 END=1 AND (o.product!='cap' OR ((? IS NULL OR EXISTS(SELECT 1 FROM sponsor_assets a WHERE a.id=json_extract(o.draft,'$.assetId') AND a.status='qualified' AND json_extract(a.metadata,'$.templateVersion')=?)) AND NOT EXISTS(SELECT 1 FROM sponsor_orders c WHERE c.product='cap' AND c.target=o.target AND c.status IN ('leased','prepared','playing')))) ORDER BY o.paid_at ASC LIMIT 1) AND status='paid' RETURNING *`,
      )
      .bind(
        studioId,
        token,
        now + sponsorLimits.leaseMs,
        now,
        caps ? Number(caps.message) : 1,
        caps ? Number(caps.spotlight) : 1,
        caps ? Number(caps.cap) : 1,
        caps?.capTemplateVersion ?? null,
        caps?.capTemplateVersion ?? null,
      )
      .all<OrderRow>();
    if (!rows.results.length) break;
    leased.push(rows.results[0]);
  }
  return leased;
}

export async function heartbeat(
  d: D1Database,
  studioId: string,
  capabilities: unknown,
  now: number,
) {
  if (!(await heartbeatProducer(d, studioId, now, capabilities)))
    throw new SponsorError(409, 'Another studio is on air.', 'STUDIO_BUSY');
  await d
    .prepare(
      `UPDATE sponsor_orders SET lease_until=? WHERE lease_owner=? AND status IN ('leased','prepared','playing') AND lease_until>?`,
    )
    .bind(now + sponsorLimits.leaseMs, studioId, now)
    .run();
}
export type FulfillmentEvent = {
  orderId: string;
  studioId: string;
  leaseToken: string;
  eventId: string;
  type: 'prepare' | 'start' | 'progress' | 'complete' | 'paused';
  stage?: 'intro' | 'callback';
  appearanceId?: string;
  visibleMs?: number;
};
export async function applyEvent(
  d: D1Database,
  e: FulfillmentEvent,
  now: number,
) {
  if (
    !['prepare', 'start', 'progress', 'complete', 'paused'].includes(e.type) ||
    !e.eventId ||
    e.eventId.length > 150 ||
    (e.appearanceId && e.appearanceId.length > 150) ||
    (e.stage && !['intro', 'callback'].includes(e.stage))
  )
    throw new SponsorError(400, 'Invalid fulfillment event.');
  const prior = await d
    .prepare(
      'SELECT order_id,lease_token,type,stage,appearance_id FROM sponsor_fulfillment_events WHERE event_id=?',
    )
    .bind(e.eventId)
    .first<{
      order_id: string;
      lease_token: string;
      type: string;
      stage: string | null;
      appearance_id: string | null;
    }>();
  if (prior) {
    if (
      prior.order_id !== e.orderId ||
      prior.lease_token !== e.leaseToken ||
      prior.type !== e.type ||
      prior.stage !== (e.stage ?? null) ||
      prior.appearance_id !== (e.appearanceId ?? null)
    )
      throw new SponsorError(409, 'Event id belongs to another delivery.');
    const current = await getOrder(d, e.orderId);
    if (
      !current ||
      current.lease_token !== e.leaseToken ||
      current.lease_owner !== e.studioId ||
      (!['complete', 'paused'].includes(e.type) &&
        (!current.lease_until || current.lease_until < now)) ||
      ![
        'leased',
        'prepared',
        'playing',
        ...(e.type === 'complete' ? ['fulfilled'] : []),
        ...(e.type === 'paused' ? ['paused'] : []),
      ].includes(current.status)
    )
      throw new SponsorError(
        409,
        'The delivery lease ended or a refund cancelled delivery.',
        'LEASE',
      );
    return current;
  }
  const order = await getOrder(d, e.orderId);
  if (
    !order ||
    order.lease_owner !== e.studioId ||
    order.lease_token !== e.leaseToken ||
    !order.lease_until ||
    order.lease_until < now ||
    !['leased', 'prepared', 'playing'].includes(order.status)
  )
    throw new SponsorError(
      409,
      'The delivery lease ended or a refund cancelled delivery.',
      'LEASE',
    );
  if ((e.stage || e.appearanceId) && e.type !== 'progress')
    throw new SponsorError(
      400,
      'A played stage or appearance must be recorded as progress.',
    );
  if (e.type === 'start' && !['prepared', 'playing'].includes(order.status))
    throw new SponsorError(409, 'Prepare this sponsorship before playback.');
  if (
    (e.type === 'progress' || e.type === 'complete') &&
    order.status !== 'playing'
  )
    throw new SponsorError(409, 'Playback has not started.');
  const elapsed = Math.max(
    0,
    now - (order.last_progress_at ?? order.started_at ?? now),
  );
  const ms =
    e.type === 'progress'
      ? Math.max(
          0,
          Math.min(
            30000,
            elapsed,
            Number.isFinite(e.visibleMs) ? Math.floor(e.visibleMs!) : 0,
          ),
        )
      : 0;
  const after = {
    ...fulfillment(order),
    visibleMs: order.visible_ms + ms,
    appearances: order.appearances + (e.appearanceId ? 1 : 0),
    intro: !!order.intro || e.stage === 'intro',
    callback: !!order.callback || e.stage === 'callback',
  };
  if (e.type === 'complete' && !fulfillmentComplete(order.product, after))
    throw new SponsorError(
      409,
      'The promised sponsorship delivery is incomplete.',
      'INCOMPLETE',
    );
  const status =
    e.type === 'prepare'
      ? order.status === 'playing'
        ? 'playing'
        : 'prepared'
      : e.type === 'start'
        ? 'playing'
        : e.type === 'paused'
          ? 'paused'
          : e.type === 'complete'
            ? 'fulfilled'
            : order.status;
  const rows = await d.batch([
    d
      .prepare(
        `INSERT OR IGNORE INTO sponsor_fulfillment_events(event_id,order_id,lease_token,type,stage,appearance_id,visible_ms,at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sponsor_orders WHERE id=? AND lease_token=? AND lease_owner=? AND lease_until>=? AND status=? AND revision=?)`,
      )
      .bind(
        e.eventId,
        e.orderId,
        e.leaseToken,
        e.type,
        e.stage ?? null,
        e.appearanceId ?? null,
        ms,
        now,
        e.orderId,
        e.leaseToken,
        e.studioId,
        now,
        order.status,
        order.revision,
      ),
    d
      .prepare(
        `UPDATE sponsor_orders SET status=?,visible_ms=visible_ms+?,appearances=appearances+?,intro=MAX(intro,?),callback=MAX(callback,?),started_at=CASE WHEN ?='start' THEN COALESCE(started_at,?) ELSE started_at END,completed_at=CASE WHEN ?='complete' THEN ? ELSE completed_at END,last_progress_at=?,lease_until=?,updated_at=?,revision=revision+1,pause_count=pause_count+CASE WHEN ?='paused' THEN 1 ELSE 0 END,retry_after=CASE WHEN ?='paused' THEN ? ELSE retry_after END WHERE id=? AND lease_token=? AND lease_owner=? AND status=? AND revision=? AND changes()=1 AND EXISTS(SELECT 1 FROM sponsor_fulfillment_events WHERE event_id=? AND at=?) RETURNING *`,
      )
      .bind(
        status,
        ms,
        e.appearanceId ? 1 : 0,
        e.stage === 'intro' ? 1 : 0,
        e.stage === 'callback' ? 1 : 0,
        e.type,
        now,
        e.type,
        now,
        now,
        now + sponsorLimits.leaseMs,
        now,
        e.type,
        e.type,
        now + Math.min(300000, 30000 * 2 ** order.pause_count),
        e.orderId,
        e.leaseToken,
        e.studioId,
        order.status,
        order.revision,
        e.eventId,
        now,
      ),
  ]);
  const result = rows[1].results?.[0] as OrderRow | undefined;
  if (!result)
    throw new SponsorError(
      409,
      'Delivery changed; refresh its lease before retrying.',
      'LEASE',
    );
  return result;
}
export async function requestRefund(
  d: D1Database,
  orderId: string,
  now: number,
) {
  await d.batch([
    d
      .prepare(
        `UPDATE sponsor_orders SET status='refund-pending',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND paid_attempt_id IS NOT NULL AND (status IN ('paid','paused') OR (status IN ('leased','prepared') AND started_at IS NULL))`,
      )
      .bind(now, orderId),
    d
      .prepare(
        `INSERT OR IGNORE INTO sponsor_refunds(id,order_id,payment_signature,asset,mint,decimals,amount_base,recipient,created_at,updated_at) SELECT o.id,o.id,o.paid_signature,a.asset,a.mint,a.decimals,a.amount_base,o.payer,?,? FROM sponsor_orders o JOIN sponsor_payment_attempts a ON a.id=o.paid_attempt_id WHERE o.id=? AND o.status='refund-pending'`,
      )
      .bind(now, now, orderId),
  ]);
  const order = await getOrder(d, orderId);
  if (!order || !['refund-pending', 'refunded'].includes(order.status))
    throw new SponsorError(
      409,
      'Pause active playback before requesting a refund. Completed sponsorships cannot be refunded.',
      'REFUND',
    );
}
export async function reschedule(d: D1Database, id: string, now: number) {
  await d
    .prepare(
      `UPDATE sponsor_orders SET status='paid',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?,pause_count=0,retry_after=0 WHERE id=? AND status='paused'`,
    )
    .bind(now, id)
    .run();
  return getOrder(d, id);
}
export async function pauseExpired(d: D1Database, now: number) {
  await d
    .prepare(
      `UPDATE sponsor_orders SET status=CASE WHEN started_at IS NULL THEN 'paid' ELSE 'paused' END,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?,pause_count=pause_count+CASE WHEN started_at IS NULL THEN 0 ELSE 1 END,retry_after=? WHERE status IN ('leased','prepared','playing') AND lease_until<?`,
    )
    .bind(now, now + 60000, now)
    .run();
}
export async function acquireLock(
  d: D1Database,
  id: string,
  now: number,
  ttl = 30000,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const r = await d
    .prepare(
      `INSERT INTO sponsor_locks(id,token,until_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,until_at=excluded.until_at WHERE sponsor_locks.until_at<? RETURNING token`,
    )
    .bind(id, token, now + ttl, now)
    .all<{ token: string }>();
  return r.results[0]?.token ?? null;
}
export async function releaseLock(d: D1Database, id: string, token: string) {
  await d
    .prepare('DELETE FROM sponsor_locks WHERE id=? AND token=?')
    .bind(id, token)
    .run();
}

export async function allowSponsorRequest(
  d: D1Database,
  id: string,
  limit: number,
  now: number,
): Promise<boolean> {
  const row = await d
    .prepare(
      `INSERT INTO sponsor_rate_limits(id,count,window_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN sponsor_rate_limits.window_at<=? THEN 1 ELSE sponsor_rate_limits.count+1 END,window_at=CASE WHEN sponsor_rate_limits.window_at<=? THEN excluded.window_at ELSE sponsor_rate_limits.window_at END WHERE sponsor_rate_limits.window_at<=? OR sponsor_rate_limits.count<? RETURNING count`,
    )
    .bind(id, now, now - 60000, now - 60000, now - 60000, limit)
    .all();
  return row.results.length > 0;
}

export async function resumeDue(d: D1Database, now: number) {
  await d
    .prepare(
      `UPDATE sponsor_orders SET status='paid',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='paused' AND pause_count<=3 AND retry_after<=? AND EXISTS(SELECT 1 FROM sponsor_producer p JOIN meta m ON m.key='studio_id' AND m.value=p.studio_id WHERE p.id=1 AND p.seen_at>? AND json_extract(p.capabilities,'$.'||sponsor_orders.product)=1)`,
    )
    .bind(now, now, now - sponsorLimits.heartbeatMs)
    .run();
}
