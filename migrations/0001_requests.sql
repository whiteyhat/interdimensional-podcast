-- Paid audience requests: one row per Solana Pay quote, from quote to air.
-- Idempotent on purpose: lib/db.ts runs the same statements at runtime, so a fresh
-- local database never needs a migration step, and running this file twice is harmless.
CREATE TABLE IF NOT EXISTS requests (
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
);
CREATE INDEX IF NOT EXISTS requests_status_created ON requests (status, created_at);
CREATE INDEX IF NOT EXISTS requests_wallet_created ON requests (wallet, created_at);
-- Small key/value store; today it only carries the studio heartbeat.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
