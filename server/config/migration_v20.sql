-- ============================================================
-- migration_v20.sql — icons on accounts, titles on people
--
-- Two more columns, both in service of the same document as v19: the
-- invoice a customer is handed.
--
--   1. payment_accounts.icon_url
--
--      A bank is recognised by its mark long before anyone reads its name.
--      An invoice that says "Premier Bank / 301016651001" makes a customer
--      read; one that shows the bank's logo beside the number makes them
--      recognise. The column holds a file name, like every other upload in
--      TAMS, so moving UPLOAD_PATH never invalidates a stored row.
--
--   2. users.title
--
--      A role is an access level — 'admin' says what someone may change in
--      this system, and means nothing to a customer. A title is what the
--      person actually does: Operations Director, Sales Manager. The
--      invoice is signed by a person, so it should carry the title.
--
--      The two stay separate on purpose. Collapsing them would tie what
--      someone is allowed to do to what their business card says, and the
--      first time a Sales Manager needed to approve a refund somebody would
--      be handed admin rights to fix a job title.
--
-- Both nullable, both optional. An account with no icon falls back to its
-- name; a user with no title falls back to their role, exactly as before.
--
-- Safe to run more than once.
-- Run with:  psql -U postgres -d tams_db -f config/migration_v20.sql
-- ============================================================

-- ── 1. The mark shown beside an account on an invoice ────────
--
-- Guarded: payment_accounts only exists once migration_v11 has run, and
-- failing the whole file would take the users.title column down with it.
DO $v20$
BEGIN
    IF to_regclass('public.payment_accounts') IS NULL THEN
        RAISE NOTICE
            '[v20] payment_accounts not found — run migration_v11.sql first. '
            'Skipping icon_url; the rest of v20 applied.';
    ELSE
        EXECUTE 'ALTER TABLE payment_accounts
                   ADD COLUMN IF NOT EXISTS icon_url VARCHAR(500)';
    END IF;
END
$v20$;

-- ── 2. What a person's job is called ─────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS title VARCHAR(120);

COMMENT ON COLUMN users.title IS
  'Job title shown to customers (e.g. Operational Director). Distinct from '
  'role, which is the access level and is never shown outside the system.';
