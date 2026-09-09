-- Durable sponsorship commerce; legacy requests are unchanged.
CREATE TABLE IF NOT EXISTS sponsor_orders (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, draft TEXT NOT NULL, product TEXT NOT NULL,
 target TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL, paid_at INTEGER,
 paid_attempt_id TEXT, paid_signature TEXT UNIQUE, payer TEXT, lease_token TEXT, lease_owner TEXT,
 lease_until INTEGER, started_at INTEGER, completed_at INTEGER, visible_ms INTEGER NOT NULL DEFAULT 0,
 appearances INTEGER NOT NULL DEFAULT 0, intro INTEGER NOT NULL DEFAULT 0, callback INTEGER NOT NULL DEFAULT 0,
 last_progress_at INTEGER, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, pause_count INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sponsor_payment_attempts (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sponsor_orders(id), pay_token TEXT NOT NULL UNIQUE,
 product_version TEXT NOT NULL DEFAULT 'sponsorship-v1', asset TEXT NOT NULL, mint TEXT, decimals INTEGER NOT NULL, amount_base TEXT NOT NULL, price_usd TEXT NOT NULL,
 price_cents INTEGER NOT NULL, recipient TEXT NOT NULL, reference TEXT NOT NULL UNIQUE, issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued', wallet_hint TEXT, unsigned_tx TEXT,
 last_valid_block_height INTEGER, broadcast_signature TEXT, verified_signature TEXT UNIQUE, signed_tx TEXT,
 scan_before TEXT, scan_started_height INTEGER, scan_complete INTEGER NOT NULL DEFAULT 0, last_checked_at INTEGER NOT NULL DEFAULT 0,
 build_lock TEXT, build_until INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS sponsor_one_open_attempt ON sponsor_payment_attempts(order_id) WHERE status IN ('issued','submitted');

CREATE TABLE IF NOT EXISTS sponsor_payments (
 signature TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES sponsor_payment_attempts(id), order_id TEXT NOT NULL,
 payer TEXT NOT NULL, block_time INTEGER NOT NULL, verified_at INTEGER NOT NULL, is_late INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sponsor_fulfillment_events (
 event_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, lease_token TEXT NOT NULL, type TEXT NOT NULL,
 stage TEXT, appearance_id TEXT, visible_ms INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sponsor_unique_appearance ON sponsor_fulfillment_events(order_id,appearance_id) WHERE appearance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sponsor_refunds (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL, payment_signature TEXT NOT NULL UNIQUE, asset TEXT NOT NULL,
 mint TEXT, decimals INTEGER NOT NULL, amount_base TEXT NOT NULL, recipient TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', signed_tx TEXT, signature TEXT UNIQUE, last_valid_block_height INTEGER,
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lock_token TEXT, lock_until INTEGER
);

CREATE TABLE IF NOT EXISTS sponsor_assets (id TEXT PRIMARY KEY, status TEXT NOT NULL, url TEXT NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');

CREATE TABLE IF NOT EXISTS sponsor_producer (id INTEGER PRIMARY KEY CHECK(id=1), studio_id TEXT NOT NULL, seen_at INTEGER NOT NULL, capabilities TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sponsor_rate_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, window_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sponsor_locks (id TEXT PRIMARY KEY, token TEXT NOT NULL, until_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS sponsor_order_queue ON sponsor_orders(status,paid_at);

CREATE INDEX IF NOT EXISTS sponsor_attempt_recovery ON sponsor_payment_attempts(last_checked_at);
