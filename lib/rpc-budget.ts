// The RPC budgets that have to hold across isolates and colos, counted durably in D1.
//
// Three things count against the browser proxy: the whole deployment (the bill), each caller
// (abuse), and each quote (the relay). Only the database can count any of them across the
// many isolates and machines a colo runs, and this is not a guess: the in-isolate Map before
// this let 200 POSTs from one address through in 14 seconds with none refused, and the native
// rate-limit binding that fronts this file turned out to count per connection -- 150 requests
// over one HTTP/2 connection got 89 refusals, 300 over ten connections got none. A caller
// with ten connections had ten budgets; a botnet had no budget at all.
//
// None of it is charged on the request path. Counting every proxied call with a D1 write
// would spend the write quota on exactly the traffic an attacker sends, and once D1 refuses
// writes the paid-request queue stops. So each isolate accumulates units -- for the deployment
// and per caller -- and flushes one batch after the response is sent. When a flush reports a
// ceiling crossed, the isolate brakes: the deployment for a growing backoff, a caller until its
// minute is up. Every isolate that flushes after the ledger shows a caller over learns the same
// thing, so a spread attacker is refused everywhere within one flush interval. Overshoot is
// bounded by (active isolates x flushEvery) units -- a few hundred credits on a bad day.
import { interactLimits } from './interact';
import { rpcProxyLimits } from './rpcproxy';
const flushEvery = 25;
const flushAtLeastEveryMs = 10_000;
const brakeMinMs = 60_000;
const brakeMaxMs = 15 * 60_000;
const callerWindowMs = 60_000;
/** As long as a quote can stay open, so a broadcast count cannot be reset by waiting. */
const referenceWindowMs = interactLimits.quoteTtlMs + interactLimits.submitGraceMs;
/** Callers carried per flush. Beyond this the rest count toward the deployment only, which is the row that stops a botnet. */
const maxCallersPerFlush = 200;
const sweepEveryMs = 5 * 60_000;
const windows = [
  { id: 'burst', ms: 10_000, cap: rpcProxyLimits.globalPer10s },
  { id: 'day', ms: 86_400_000, cap: rpcProxyLimits.globalPerDay },
] as const;
/** Everything the isolate knows; there is one of these per isolate and that is the point. */
type Meter = {
  pending: number;
  callers: Map<string, number>;
  lastFlushAt: number;
  lastSweepAt: number;
  blockedUntil: number;
  strikes: number;
  flushing: boolean;
  callerBlockedUntil: Map<string, number>;
};
const fresh = (): Meter => ({
  pending: 0,
  callers: new Map(),
  lastFlushAt: 0,
  lastSweepAt: 0,
  blockedUntil: 0,
  strikes: 0,
  flushing: false,
  callerBlockedUntil: new Map(),
});
const meter: Meter = fresh();
/** Exposed for tests; nothing else should reach in. */
export const meterState = () => structuredClone(meter);
export function resetMeter() {
  Object.assign(meter, fresh());
}
/** Whether the isolate is refusing budgeted calls right now, for everyone or for this caller. */
export function braked(caller: string, now: number): 'deployment' | 'caller' | null {
  if (meter.blockedUntil > now) return 'deployment';
  const until = meter.callerBlockedUntil.get(caller);
  if (until === undefined) return null;
  if (until > now) return 'caller';
  meter.callerBlockedUntil.delete(caller);
  return null;
}
/**
 * Add units to the running totals and say whether a flush is due. The route hands the flush
 * to waitUntil so the response never waits on D1.
 */
export function charge(caller: string, units: number, now: number): boolean {
  // The clock starts with the first call, not at the epoch: otherwise a fresh isolate flushes
  // its very first unit alone, which is the per-call write this exists to avoid.
  if (!meter.lastFlushAt) meter.lastFlushAt = now;
  meter.pending += units;
  if (meter.callers.has(caller) || meter.callers.size < maxCallersPerFlush)
    meter.callers.set(caller, (meter.callers.get(caller) ?? 0) + units);
  if (meter.flushing) return false;
  return meter.pending >= flushEvery || now - meter.lastFlushAt >= flushAtLeastEveryMs;
}
type Row = { units: number; window_at: number };
/**
 * One statement per row: start a new window if the old one has closed, otherwise add. It
 * returns the running total and the window it belongs to, so the caller can compare against
 * the cap and know when the window rolls. The deployment rows never grow; caller and quote
 * rows are swept below.
 */
const upsert = (db: D1Database, id: string, units: number, now: number, windowMs: number) =>
  db
    .prepare(
      `INSERT INTO rpc_budget(id,units,window_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET units=CASE WHEN rpc_budget.window_at<=? THEN excluded.units ELSE rpc_budget.units+excluded.units END,window_at=CASE WHEN rpc_budget.window_at<=? THEN excluded.window_at ELSE rpc_budget.window_at END RETURNING units, window_at`,
    )
    .bind(id, units, now, now - windowMs, now - windowMs);
/**
 * Count a broadcast against its quote. The row is keyed on the reference, so it holds across
 * callers and colos. Over the cap is refused; a write failure is refused too, because this
 * only runs for a broadcast and the relay must not open on a ledger blip.
 */
export async function chargeReference(db: D1Database, reference: string, now: number): Promise<boolean> {
  const row = await upsert(db, `send:${reference}`, 1, now, referenceWindowMs).first<Row>();
  return (row?.units ?? Infinity) <= rpcProxyLimits.sendsPerReference;
}
/**
 * Caller and quote rows older than any window that could still refer to them. Range
 * predicates rather than LIKE, so the primary key serves the scan; the byte after ':' is ';'.
 */
const sweep = (db: D1Database, now: number) =>
  db
    .prepare(
      `DELETE FROM rpc_budget WHERE (id > 'ip:' AND id < 'ip;' AND window_at<?) OR (id > 'send:' AND id < 'send;' AND window_at<?)`,
    )
    .bind(now - 2 * callerWindowMs, now - 2 * referenceWindowMs);
/**
 * Write what has accumulated and apply the brakes; returns the callers found over their
 * minute. Safe to call when nothing is pending. A failed write leaves the units pending for
 * the next flush rather than losing them, and never brakes: a D1 blip must not turn into a
 * self-inflicted outage.
 */
export async function flush(db: D1Database, now: number): Promise<string[]> {
  if (meter.flushing) return [];
  const units = meter.pending;
  const callers = [...meter.callers];
  meter.pending = 0;
  meter.callers = new Map();
  meter.flushing = true;
  try {
    const statements = [
      ...windows.map((w) => upsert(db, w.id, units, now, w.ms)),
      ...callers.map(([caller, n]) => upsert(db, `ip:${caller}`, n, now, callerWindowMs)),
    ];
    const due = now - meter.lastSweepAt >= sweepEveryMs;
    if (due) statements.push(sweep(db, now));
    const rows = await db.batch<Row>(statements);
    meter.lastFlushAt = now;
    if (due) meter.lastSweepAt = now;
    const row = (i: number) => rows[i]?.results?.[0];
    const totals = windows.map((_, i) => row(i)?.units ?? 0);
    const hit = totals.findIndex((total, i) => total > windows[i].cap);
    if (hit >= 0) {
      meter.strikes = Math.min(meter.strikes + 1, 8);
      meter.blockedUntil = now + Math.min(brakeMinMs * 2 ** (meter.strikes - 1), brakeMaxMs);
      console.error(
        `[rpc] deployment ${windows[hit].id} budget crossed (${totals[hit]} > ${windows[hit].cap}); refusing budgeted calls for ${Math.round((meter.blockedUntil - now) / 1000)}s`,
      );
    } else meter.strikes = 0;
    // Brakes that have lapsed leave with the flush, so the map holds live ones only.
    for (const [caller, until] of meter.callerBlockedUntil) if (until <= now) meter.callerBlockedUntil.delete(caller);
    const over: string[] = [];
    callers.forEach(([caller], i) => {
      const r = row(windows.length + i);
      if (r && r.units > rpcProxyLimits.perMinute) {
        // Refused until the caller's own minute rolls, wherever the next request lands.
        meter.callerBlockedUntil.set(caller, r.window_at + callerWindowMs);
        over.push(caller);
      }
    });
    if (over.length)
      console.warn(`[rpc] ${over.length} caller(s) over ${rpcProxyLimits.perMinute}/min:`, over.slice(0, 5).join(' '));
    return over;
  } catch (e) {
    meter.pending += units;
    for (const [caller, n] of callers) meter.callers.set(caller, (meter.callers.get(caller) ?? 0) + n);
    console.warn('[rpc] budget flush failed', e instanceof Error ? e.message : e);
    return [];
  } finally {
    meter.flushing = false;
  }
}
