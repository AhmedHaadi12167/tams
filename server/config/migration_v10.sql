-- ============================================================
-- migration_v10.sql — session control and brute-force defence
--
-- Three additions, all to do with who is allowed to be logged in:
--
--   1. users.session_id      one active session per account
--   2. users.failed_attempts + locked_until   brute-force lockout
--   3. login_audit           a record of who tried to get in, and from where
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ── 1. One session per user ──────────────────────────────────
--
-- Every successful login mints a fresh random session_id, stores it here,
-- and puts the same value inside the JWT. The auth middleware compares the
-- two on every request. Logging in somewhere else overwrites the column, so
-- the older token stops matching and is refused from that moment on.
--
-- This costs nothing extra at request time: the middleware already fetches
-- the user row to check is_active, so the comparison rides along on a query
-- that was happening anyway.
--
-- NULL means "no active session" — that is what logout writes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_id UUID;

-- ── 2. Brute-force lockout ───────────────────────────────────
--
-- failed_attempts counts consecutive failures and resets to zero on any
-- success. locked_until is a timestamp in the future while the account is
-- frozen; a NULL or past value means the account is usable.
--
-- Locking the account rather than the IP is what actually protects a
-- password, because an attacker can rotate addresses far more easily than
-- they can guess a passphrase.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ;

-- ── 3. Login audit ───────────────────────────────────────────
--
-- Records every attempt, successful or not. Deliberately stores no
-- password material — only who, when, from where, and what happened.
--
-- user_id is nullable on purpose: an attempt against an address that does
-- not exist still deserves a row, and that is exactly the pattern that
-- reveals someone probing for valid accounts.
CREATE TABLE IF NOT EXISTS login_audit (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    email       VARCHAR(255),
    success     BOOLEAN NOT NULL,
    reason      VARCHAR(64),
    ip_address  VARCHAR(64),
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_audit_email   ON login_audit(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_audit_user    ON login_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_audit_created ON login_audit(created_at DESC);

COMMIT;

-- ── Housekeeping note ────────────────────────────────────────
-- login_audit grows forever if left alone. To keep ninety days:
--
--   DELETE FROM login_audit WHERE created_at < NOW() - INTERVAL '90 days';
--
-- At this scale that is a yearly chore at most, not a nightly job.
