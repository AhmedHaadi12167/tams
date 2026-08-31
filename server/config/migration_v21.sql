-- ============================================================
-- migration_v21.sql — the agency names its own accounts
--
-- v11 gave every business eleven ready-made accounts: Cash, EVC, EDahab,
-- Premier Bank, Salaam Bank and the rest. The intent was that a new agency
-- could take money on day one without configuring anything. In practice it
-- guessed wrong — an agency banks where it banks, and a list of eleven
-- mostly-unused names makes the one account that matters harder to find in
-- a dropdown.
--
-- So the seeding stops, and the accounts nobody used are removed.
--
-- WHAT IS NOT REMOVED
--
-- An account that has taken money is a real record. Its payments, expenses
-- and transfers all point at it, and the account balances that reconcile
-- against the ledger are computed from exactly those rows. Deleting one
-- would either fail on its foreign keys or, worse, take the history with
-- it. So this migration deletes only accounts that have never been touched:
--
--   * no movement in the ledger,
--   * neither end of any transfer,
--   * no opening balance carried in from before TAMS,
--   * and still bearing the name it was seeded with.
--
-- Anything else stays exactly as it is. Rename it on the Accounts page to
-- whatever the agency actually calls it, or mark it inactive to keep the
-- history and drop it out of the dropdowns.
--
-- The last condition matters: an agency that renamed "Premier Bank" to
-- "Premier — 3010166" clearly wants it, even if it hasn't been used yet.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ── 1. No more automatic accounts ────────────────────────────
--
-- The trigger goes first. Dropping it before the delete means a business
-- created while this migration runs cannot be handed a fresh set of the
-- very accounts being removed.
DROP TRIGGER IF EXISTS seed_accounts_on_new_business ON businesses;
DROP FUNCTION IF EXISTS trg_seed_payment_accounts();
DROP FUNCTION IF EXISTS seed_payment_accounts(UUID);

-- ── 2. Remove the ones nobody ever used ──────────────────────
--
-- Written as a single DELETE with NOT EXISTS rather than a loop, so it is
-- one atomic statement: either every unused account goes or none does.
DELETE FROM payment_accounts pa
 WHERE pa.name IN (
         'Cash', 'Premier Bank', 'Salaam Bank', 'Amal Bank', 'MyBank',
         'Dahabshiil Bank', 'IBS Bank', 'Merchant', 'EVC', 'EDahab', 'SOMBANK'
       )
   AND COALESCE(pa.opening_balance, 0) = 0
   -- Nothing in the ledger. This covers tickets, visas, packages, cargo,
   -- airlines, agents, expenses and tax in one condition, because the
   -- ledger is the union of all of them.
   AND NOT EXISTS (
         SELECT 1 FROM v_cash_ledger l
          WHERE l.account_id = pa.id
       )
   -- Transfers appear in the ledger too, but only once the view has been
   -- rebuilt; check the table directly so this holds on any version.
   AND NOT EXISTS (
         SELECT 1 FROM account_transfers t
          WHERE t.from_account_id = pa.id OR t.to_account_id = pa.id
       );

-- ── 3. Say so, rather than leaving it to be discovered ───────
--
-- A count in the migration output is the difference between "it worked" and
-- "I think it worked".
DO $report$
DECLARE
    kept    INTEGER;
    empty   INTEGER;
BEGIN
    SELECT COUNT(*) INTO kept FROM payment_accounts;
    SELECT COUNT(*) INTO empty
      FROM businesses b
     WHERE NOT EXISTS (
             SELECT 1 FROM payment_accounts pa WHERE pa.business_id = b.id
           );

    RAISE NOTICE 'payment accounts remaining: %', kept;
    RAISE NOTICE 'businesses now with no accounts: % (they must add their own before taking money)', empty;
END
$report$;

COMMIT;
