// D1 access for the paid-request queue. Server only: `D1Database` is the Workers binding.
// Every function takes the binding, so the route decides which database it talks to.
import { interactLimits, type RequestRow, type RowStatus } from './interact';
import { heartbeatProducer, producerSchema } from './producer-lease';
export type { RequestRow, RowStatus } from './interact';

/** Request schema plus shared producer metadata; idempotent on every cold start. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    wallet TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    amount_ui REAL NOT NULL,
    amount_base TEXT NOT NULL,
    mint TEXT NOT NULL,
    recipient TEXT NOT NULL,
    price_usd REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('quoted','submitted','paid','claimed','aired','expired','failed')),
    signature TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    paid_at INTEGER,
    claimed_at INTEGER,
    aired_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS requests_status_created ON requests (status, created_at)',
  'CREATE INDEX IF NOT EXISTS requests_wallet_created ON requests (wallet, created_at)',
  ...producerSchema,
  `CREATE TABLE IF NOT EXISTS legacy_payment_recovery(reference TEXT PRIMARY KEY, cursor TEXT, checked_at INTEGER NOT NULL DEFAULT 0)`,
  // The proxy's deployment-wide budget; two rows that never grow. See migrations/0004 and lib/rpc-budget.ts.
  `CREATE TABLE IF NOT EXISTS rpc_budget(id TEXT PRIMARY KEY, units INTEGER NOT NULL, window_at INTEGER NOT NULL)`,
];
const ready = new WeakMap<D1Database, Promise<void>>();
/** Run the schema once per isolate, so dev never depends on a migration step. */
export function ensureSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db);
  if (!pending) {
    pending = db.batch(schema.map((sql) => db.prepare(sql))).then(async () => {
      const columns=await db.prepare('PRAGMA table_info(requests)').all<{name:string}>();
      if(!columns.results.some(c=>c.name==='broadcast_signature')){
        try{await db.prepare('ALTER TABLE requests ADD COLUMN broadcast_signature TEXT').run();}
        catch(e){if(!/duplicate column/i.test(String(e)))throw e;}
      }
      await db.prepare("UPDATE requests SET broadcast_signature=COALESCE(broadcast_signature,signature),signature=NULL WHERE status IN ('quoted','submitted','expired','failed') AND signature IS NOT NULL").run();
    });
    pending.catch(() => ready.delete(db)); // a failed attempt must not poison the isolate
    ready.set(db, pending);
  }
  return pending;
}

export type NewQuote = Omit<RequestRow, 'status' | 'signature' | 'paid_at' | 'claimed_at' | 'aired_at'>;
export async function insertQuote(db: D1Database, q: NewQuote) {
  await db
    .prepare(
      `INSERT INTO requests (id, reference, wallet, name, message, amount_ui, amount_base, mint, recipient, price_usd, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?)`,
    )
    .bind(
      q.id,
      q.reference,
      q.wallet,
      q.name,
      q.message,
      q.amount_ui,
      q.amount_base,
      q.mint,
      q.recipient,
      q.price_usd,
      q.created_at,
      q.expires_at,
    )
    .run();
}
const byReference = (db: D1Database, reference: string) =>
  db.prepare('SELECT * FROM requests WHERE reference = ?').bind(reference);
export function getByReference(db: D1Database, reference: string) {
  return byReference(db, reference).first<RequestRow>();
}

const stampColumn: Partial<Record<RowStatus, 'paid_at' | 'claimed_at' | 'aired_at'>> = {
  paid: 'paid_at',
  claimed: 'claimed_at',
  aired: 'aired_at',
};
/**
 * Move a row to `status` only if it is currently in one of `from`; the first timestamp
 * for that status is kept and a signature is only ever filled in, never replaced.
 */
export async function setStatus(
  db: D1Database,
  reference: string,
  status: RowStatus,
  from: readonly RowStatus[],
  now: number,
  signature?: string,
) {
  const column = stampColumn[status];
  const sets = ['status = ?'];
  const params: (string | number)[] = [status];
  if (column) {
    sets.push(`${column} = COALESCE(${column}, ?)`);
    params.push(now);
  }
  if (signature) {
    sets.push(status==='submitted'?'broadcast_signature = ?':'signature = COALESCE(signature, ?)');
    params.push(signature);
  }
  const marks = from.map(() => '?').join(', ');
  const result = await db
    .prepare(`UPDATE requests SET ${sets.join(', ')} WHERE reference = ? AND status IN (${marks})`)
    .bind(...params, reference, ...from)
    .run();
  return result.meta.changes > 0;
}
/**
 * Atomically hand the oldest paid rows to the studio; a second puller gets the rest. A row the
 * studio claimed but never aired (a reloaded tab) is offered again after reclaimMs; the engine
 * ignores references it already holds, so a live studio sees no duplicates.
 */
export async function claimPaid(db: D1Database, limit: number, now: number) {
  const result = await db
    .prepare(
      `UPDATE requests SET status = 'claimed', claimed_at = ?
       WHERE id IN (
         SELECT id FROM requests
         WHERE status = 'paid' OR (status = 'claimed' AND claimed_at < ?)
         ORDER BY COALESCE(paid_at, created_at) ASC, created_at ASC LIMIT ?)
       RETURNING *`,
    )
    .bind(now, now - interactLimits.reclaimMs, limit)
    .all<RequestRow>();
  return [...result.results].sort(
    (a, b) => (a.paid_at ?? a.created_at) - (b.paid_at ?? b.created_at),
  );
}
export function markAired(db: D1Database, reference: string, now: number) {
  return setStatus(db, reference, 'aired', ['claimed', 'paid'], now);
}

// ---- reads behind GET ?action=status --------------------------------------------------

/** Unaired requests in service order: what the studio already holds first, then paid. */
const queueRead = (db: D1Database) =>
  db.prepare(
    `SELECT reference FROM requests WHERE status IN ('paid', 'claimed')
     ORDER BY CASE status WHEN 'claimed' THEN 0 ELSE 1 END, COALESCE(paid_at, created_at) ASC, created_at ASC`,
  );
/** The latest requests that were actually paid for, newest first. */
const recentRead = (db: D1Database, limit: number) =>
  db
    .prepare(
      `SELECT * FROM requests WHERE status IN ('paid', 'claimed', 'aired')
       ORDER BY COALESCE(paid_at, created_at) DESC LIMIT ?`,
    )
    .bind(limit);
export type StatusReads = {
  /** Only the reference: the queue is read to number places in line, nothing else. */
  queue: readonly Pick<RequestRow, 'reference'>[];
  recent: RequestRow[];
  row: RequestRow | null;
};
/** Everything one viewer poll needs, in a single round trip. */
export async function statusReads(
  db: D1Database,
  limit = interactLimits.recent,
  reference: string | null = null,
): Promise<StatusReads> {
  const statements = [queueRead(db), recentRead(db, limit)];
  if (reference) statements.push(byReference(db, reference));
  const [queued, latest, found] = await db.batch<RequestRow>(statements);
  return { queue: queued.results, recent: latest.results, row: found?.results[0] ?? null };
}
export async function countQueued(db: D1Database) {
  const n = await db
    .prepare(`SELECT COUNT(*) AS n FROM requests WHERE status IN ('paid', 'claimed')`)
    .first<number>('n');
  return n ?? 0;
}
// The queue's service order, as a tuple SQLite can compare row-wise. The row id breaks
// exact ties so every unaired request still gets a place of its own.
const place = (t: string) =>
  `(CASE ${t}.status WHEN 'claimed' THEN 0 ELSE 1 END, COALESCE(${t}.paid_at, ${t}.created_at), ${t}.created_at, ${t}.rowid)`;
/** 1-based place in line for one request, counted in SQL instead of by reading the queue. */
export async function positionOf(db: D1Database, reference: string) {
  const n = await db
    .prepare(
      `SELECT 1 + (
         SELECT COUNT(*) FROM requests q
         WHERE q.status IN ('paid', 'claimed') AND ${place('q')} < ${place('r')}
       ) AS n
       FROM requests r WHERE r.reference = ? AND r.status IN ('paid', 'claimed')`,
    )
    .bind(reference)
    .first<number>('n');
  return n ?? undefined;
}
/** Quotes nobody paid for, and broadcasts that never landed, stop counting as pending. */
export async function expireStale(db: D1Database, now: number) {
  const result = await db
    .prepare(
      `UPDATE requests SET status = 'expired'
       WHERE (status = 'quoted' AND created_at < ?) OR (status = 'submitted' AND created_at < ?)`,
    )
    .bind(now - interactLimits.staleQuoteMs, now - interactLimits.staleSubmittedMs)
    .run();
  return result.meta.changes;
}
/** Recent quotes the page gave up on; their payment may still have landed on chain. */
export async function recoverable(db: D1Database, now: number, limit: number) {
  const result = await db
    .prepare(
      `SELECT r.* FROM requests r LEFT JOIN legacy_payment_recovery c ON c.reference=r.reference
       WHERE r.status IN ('quoted','expired','submitted','failed') AND r.created_at < ?
       ORDER BY COALESCE(c.checked_at,0),r.created_at LIMIT ?`,
    )
    .bind(now - interactLimits.staleQuoteMs, limit)
    .all<RequestRow>();
  return result.results;
}

// ---- meta: one timestamp per key -------------------------------------------------------

const RECOVER = 'recover_at';
const HEARTBEAT = 'studio_seen_at';
const STUDIO = 'studio_id';
const metaRead = (db: D1Database, key: string) =>
  db.prepare('SELECT value FROM meta WHERE key = ?').bind(key);
/** A stored timestamp, or 0 when the key was never written or holds nonsense. */
const readMs = (value: unknown) => {
  const at = Number(value);
  return Number.isFinite(at) ? at : 0;
};
async function getMeta(db: D1Database, key: string) {
  return readMs(await metaRead(db, key).first<string>('value'));
}
const metaWrite = (db: D1Database, key: string, value: string, now: number) =>
  db
    .prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now);
async function setMeta(db: D1Database, key: string, now: number) {
  await metaWrite(db, key, String(now), now).run();
}
/** True once per recoverEveryMs, so the sweep costs at most a couple of RPC calls a minute. */
export async function recoverDue(db: D1Database, now: number) {
  if (now - (await getMeta(db, RECOVER)) < interactLimits.recoverEveryMs) return false;
  await setMeta(db, RECOVER, now);
  return true;
}
/** Check in only if this studio acquires the shared producer lease. */
export function heartbeat(db: D1Database, now: number, id: string) {
  return heartbeatProducer(db, id, now);
}
/** Who last claimed the air, and when. An empty id means nobody ever has. */
export async function getStudio(db: D1Database) {
  const row = await db
    .prepare('SELECT value,updated_at FROM meta WHERE key=?')
    .bind(STUDIO)
    .first<{ value: string; updated_at: number }>();
  return { seenAt: readMs(row?.updated_at), id: row?.value ?? '' };
}
/** Milliseconds since the epoch of the studio's last pull, or 0 when it never pulled. */
export function getHeartbeat(db: D1Database) {
  return getMeta(db, HEARTBEAT);
}
/** Both gates a quote must clear before any chain work, in a single round trip. */
export async function quoteGates(db: D1Database, wallet: string, now: number) {
  const [seen, quotes] = await db.batch<Record<string, unknown>>([
    metaRead(db, HEARTBEAT),
    db
      .prepare('SELECT COUNT(*) AS n FROM requests WHERE wallet = ? AND created_at > ?')
      .bind(wallet, now - 60_000),
  ]);
  return {
    studioSeenAt: readMs(seen.results[0]?.value),
    quotesInLastMinute: readMs(quotes.results[0]?.n),
  };
}
