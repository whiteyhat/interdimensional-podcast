import { interactLimits } from './interact';

// The existing studio_id meta row is the authoritative lease for both queues.
// Its updated_at is ownership liveness; each queue retains its own readiness heartbeat.
export const producerSchema = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sponsor_producer (id INTEGER PRIMARY KEY CHECK(id=1), studio_id TEXT NOT NULL, seen_at INTEGER NOT NULL, capabilities TEXT NOT NULL)`,
  // Preserve a sponsorship-only installation when first adopting the shared lease.
  // An existing legacy lease already owns this key and must not be displaced.
  `INSERT OR IGNORE INTO meta(key,value,updated_at) SELECT 'studio_id',studio_id,seen_at FROM sponsor_producer WHERE id=1`,
];

/** Claim ownership and publish this queue's readiness in the same atomic D1 batch. */
export async function heartbeatProducer(
  d: D1Database,
  studioId: string,
  now: number,
  capabilities?: unknown,
): Promise<boolean> {
  const claim = d
    .prepare(
      `INSERT INTO meta(key,value,updated_at) VALUES('studio_id',?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=MAX(meta.updated_at,excluded.updated_at)
       WHERE meta.value=excluded.value OR meta.value='' OR meta.updated_at<=?
       RETURNING value`,
    )
    .bind(studioId, now, now - interactLimits.heartbeatMs);
  const readiness =
    capabilities === undefined
      ? d
          .prepare(
            `INSERT INTO meta(key,value,updated_at)
       SELECT 'studio_seen_at',?,? WHERE EXISTS(SELECT 1 FROM meta WHERE key='studio_id' AND value=?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
          )
          .bind(String(now), now, studioId)
      : d
          .prepare(
            `INSERT INTO sponsor_producer(id,studio_id,seen_at,capabilities)
       SELECT 1,?,?,? WHERE EXISTS(SELECT 1 FROM meta WHERE key='studio_id' AND value=?)
       ON CONFLICT(id) DO UPDATE SET studio_id=excluded.studio_id,seen_at=excluded.seen_at,capabilities=excluded.capabilities`,
          )
          .bind(studioId, now, JSON.stringify(capabilities), studioId);
  const [result] = await d.batch([claim, readiness]);
  return result.results.length > 0;
}
