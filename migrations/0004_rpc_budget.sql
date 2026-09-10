-- The deployment-wide RPC budget: what the browser proxy has spent, in total, across every
-- isolate and colo. Two rows, forever -- 'burst' and 'day' -- with the window reset in place
-- rather than bucketed by time, the same shape as sponsor_rate_limits, so the table never grows.
--
-- It is written once per flush, not once per call. The per-caller limits are Cloudflare
-- rate-limit bindings, which are per colo and not an accounting system; this is the one number
-- that holds when a flood arrives from many colos at once. See lib/rpc-budget.ts.
--
-- lib/db.ts also carries this statement, so a fresh local database never needs a migration step.
CREATE TABLE IF NOT EXISTS rpc_budget (
  id TEXT PRIMARY KEY,
  units INTEGER NOT NULL,
  window_at INTEGER NOT NULL
);
