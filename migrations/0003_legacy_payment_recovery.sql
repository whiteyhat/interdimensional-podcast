ALTER TABLE requests ADD COLUMN broadcast_signature TEXT;
UPDATE requests SET broadcast_signature=signature,signature=NULL
WHERE status IN ('quoted','submitted','expired','failed') AND signature IS NOT NULL;
CREATE TABLE IF NOT EXISTS legacy_payment_recovery (
 reference TEXT PRIMARY KEY,
 cursor TEXT,
 checked_at INTEGER NOT NULL DEFAULT 0
);
