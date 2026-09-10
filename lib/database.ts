// The one way a route opens the database: both schemas, once per isolate. The paid-request
// queue and the sponsorship tables are bootstrapped by different modules, and a route that ran
// only one of them would answer "no such table" for the other -- which the broadcast gate has
// to treat as an outage. Sequential, not parallel: each bootstrap is a transaction of its own.
import { ensureSchema } from './db';
import { ensureSponsorSchema } from './sponsor-db';
export async function openDatabase(d: D1Database): Promise<D1Database> {
  await ensureSchema(d);
  await ensureSponsorSchema(d);
  return d;
}
