-- 0004_auth_hardening.sql
-- One-time staff enrollment and per-user PBKDF2 PIN salts.
-- Existing SHA-256 PIN hashes remain verifiable for one successful login and
-- are upgraded in-place by the Worker after successful authentication.
ALTER TABLE staff ADD COLUMN pin_salt TEXT;
ALTER TABLE staff ADD COLUMN enrollment_hash TEXT;

CREATE TABLE IF NOT EXISTS auth_attempts (
  attempt_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_blocked ON auth_attempts(blocked_until);
