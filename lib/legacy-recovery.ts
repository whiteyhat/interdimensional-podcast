import * as db from './db';
import { address, signature as signatureKey } from '@solana/kit';
import { mintInfo, verifyPayment, rpcFor, type SolanaRpc, configuredRpcUrl } from './solana';
export type LegacySettlement = {
  status: string;
  position?: number;
  error?: string;
};
/** Share one cancellation deadline across every RPC made by a scheduled pass,
 * including account helpers. An unavailable archival node cannot pin the scheduler. */
export function legacyRpcWithDeadline(
  rpc: SolanaRpc,
  signal: AbortSignal,
): SolanaRpc {
  return new Proxy(rpc, {
    get(target, method, receiver) {
      const value = Reflect.get(target, method, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const pending = Reflect.apply(value, target, args) as {
          send(options?: { abortSignal?: AbortSignal }): Promise<unknown>;
        };
        return {
          send(options?: { abortSignal?: AbortSignal }) {
            signal.throwIfAborted();
            return pending.send({
              ...options,
              abortSignal: options?.abortSignal
                ? AbortSignal.any([signal, options.abortSignal])
                : signal,
            });
          },
        };
      };
    },
  });
}

/** An individual failed reference transaction says nothing about later payments. Page past it.
 * Missing transaction bodies leave the page cursor in place for archival/indexing recovery. */
export async function settleLegacy(
  d: D1Database,
  rpc: SolanaRpc,
  row: db.RequestRow,
  now: number,
  offered?: string,
  services = { mintInfo, verifyPayment },
): Promise<LegacySettlement> {
  if (['paid', 'claimed', 'aired'].includes(row.status))
    return {
      status: row.status,
      ...(row.status !== 'aired'
        ? { position: await db.positionOf(d, row.reference) }
        : {}),
    };
  const info = await services.mintInfo(rpc, row.mint);
  const checked = new Map<string, string>();
  async function verify(signature: string) {
    if (checked.has(signature)) return checked.get(signature)!;
    const verdict = await services.verifyPayment(rpc, signature, {
      recipient: row.recipient,
      amountBase: row.amount_base,
      mint: row.mint,
      reference: row.reference,
      program: info.program,
    });
    if (verdict.status === 'paid') {
      try {
        await db.setStatus(
          d,
          row.reference,
          'paid',
          ['quoted', 'submitted', 'expired', 'failed'],
          now,
          signature,
        );
      } catch (e) {
        if (/UNIQUE constraint failed/.test(String(e))) return 'failed';
        throw e;
      }
    }
    checked.set(signature, verdict.status);
    return verdict.status;
  }
  for (const candidate of [offered, row.broadcast_signature, row.signature])
    if (candidate && (await verify(candidate)) === 'paid')
      return {
        status: 'paid',
        position: await db.positionOf(d, row.reference),
      };
  const saved = await d
    .prepare('SELECT cursor FROM legacy_payment_recovery WHERE reference=?')
    .bind(row.reference)
    .first<{ cursor: string | null }>();
  let cursor = saved?.cursor ?? null;
  for (let page = 0; page < 2; page++) {
    const candidates = await rpc
      .getSignaturesForAddress(address(row.reference), {
        commitment: 'confirmed',
        limit: 10,
        ...(cursor ? { before: signatureKey(cursor) } : {}),
      })
      .send();
    let unavailable = false;
    for (const item of candidates) {
      if (item.err) continue;
      const result = await verify(item.signature);
      if (result === 'paid')
        return {
          status: 'paid',
          position: await db.positionOf(d, row.reference),
        };
      if (result === 'pending') unavailable = true;
    }
    if (unavailable) break;
    cursor = candidates.length === 10 ? candidates.at(-1)!.signature : null;
    if (!cursor) break;
  }
  await d
    .prepare(
      'INSERT INTO legacy_payment_recovery(reference,cursor,checked_at) VALUES(?,?,?) ON CONFLICT(reference) DO UPDATE SET cursor=excluded.cursor,checked_at=excluded.checked_at',
    )
    .bind(row.reference, cursor, now)
    .run();
  return { status: 'pending' };
}
export async function reconcileLegacy(v: {
  DB?: D1Database;
  SOLANA_RPC_URL?: string;
}) {
  // No provider, no reconciliation; configuredRpcUrl says why there is no public fallback.
  const url = configuredRpcUrl(v);
  if (!v.DB || !url) return { checked: 0 };
  await db.ensureSchema(v.DB);
  const rows = await db.recoverable(v.DB, Date.now(), 2),
    signal = AbortSignal.timeout(12000),
    rpc = legacyRpcWithDeadline(rpcFor(url), signal);
  for (const row of rows) {
    if (signal.aborted) break;
    try {
      await settleLegacy(v.DB, rpc, row, Date.now());
    } catch {
      await v.DB.prepare(
        'INSERT INTO legacy_payment_recovery(reference,checked_at) VALUES(?,?) ON CONFLICT(reference) DO UPDATE SET checked_at=excluded.checked_at',
      )
        .bind(row.reference, Date.now())
        .run();
    }
  }
  return { checked: rows.length };
}
