-- ============================================================
-- migration_v19.sql — the agency's own identity on paper
--
-- Everything here exists to make one document better: the invoice a
-- customer is handed. Until now that page said "TAMS" and nothing about
-- the agency that produced it, and it could not tell the customer where to
-- send the money it was asking for.
--
--   1. businesses.logo_url        the mark printed at the top of the page
--                                 and shown in the sidebar while signed in
--   2. businesses.website         completes the contact strip in the footer
--   3. payment_accounts.account_number
--      payment_accounts.account_holder
--                                 so "Premier Bank" can be printed as an
--                                 account a customer can actually pay into
--
-- Nothing here is required. Every column is nullable and every existing row
-- keeps working untouched — an agency with no logo gets the same layout
-- with a lettermark in place of the image, and an account with no number is
-- simply left off the invoice rather than printed as a blank.
--
-- Safe to run more than once.
-- Run with:  psql -U postgres -d tams_db -f config/migration_v19.sql
-- ============================================================

-- ── 1. Agency branding ───────────────────────────────────────
--
-- logo_url has been in the base schema since v2 but was never populated or
-- read. Declared here with IF NOT EXISTS so a database built from an early
-- dump gains it rather than failing on the UPDATE that would follow.
--
-- It holds a file name, not a path — the same convention tickets and cargo
-- photos already use — so moving UPLOAD_PATH never invalidates stored rows.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website  VARCHAR(255);

-- ── 2. Where a customer can actually send money ──────────────
--
-- An account has always had a name. A name alone is not payable: nobody can
-- send money to "EVC". The number is what makes the payment-methods strip
-- at the foot of an invoice useful rather than decorative.
--
-- account_holder is separate from the agency name on purpose. Mobile-money
-- and merchant accounts in Somalia are frequently registered to a director
-- personally, and printing the agency's name over a personal account is how
-- a customer decides the invoice is wrong and phones to check.
--
-- Guarded, because payment_accounts only exists once migration_v11 has run.
-- Without the guard this file would fail outright on an older database
-- instead of doing the part it can.
DO $v19$
BEGIN
    IF to_regclass('public.payment_accounts') IS NULL THEN
        RAISE NOTICE
            '[v19] payment_accounts not found — run migration_v11.sql first. '
            'Skipping the account-number columns; the rest of v19 applied.';
        RETURN;
    END IF;

    EXECUTE $sql$
        ALTER TABLE payment_accounts
            ADD COLUMN IF NOT EXISTS account_number VARCHAR(100);
        ALTER TABLE payment_accounts
            ADD COLUMN IF NOT EXISTS account_holder VARCHAR(150);
    $sql$;
END
$v19$;
