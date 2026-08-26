-- ============================================================
-- migration_v11.sql — where the money actually sits
--
-- Until now TAMS recorded *that* money moved and how much, but only a loose
-- text label for where it went ('cash', 'bank', 'zaad'). That is enough to
-- total up revenue; it is not enough to answer "how much is in Salaam Bank
-- right now, and does that match the statement the bank sent me".
--
-- This migration introduces real accounts, and makes every movement of money
-- name one. From that, two things follow for free:
--
--   * a balance per account = opening balance + everything in − everything out
--   * one ledger listing every movement, with who it was with and when
--
-- Six things happen here:
--
--   1. payment_accounts        the accounts themselves, seeded per business
--   2. account_id              added to all seven money-moving tables
--   3. cargo_payments          cargo had no payment records at all
--   4. account_transfers       moving money between your own accounts
--   5. v_cash_ledger           every movement, unified
--   6. v_account_balance       the balance each account should hold
--
-- Safe to run more than once. Non-destructive: the old `method` text column
-- is kept, so nothing that reads it today breaks.
-- ============================================================

BEGIN;

-- ── 1. The accounts ──────────────────────────────────────────
--
-- One row per place money can sit. Seeded with the agency's real accounts
-- but editable, because banks come and go.
--
-- `kind` exists only for grouping and iconography in the UI. The arithmetic
-- treats every account identically — a balance is a balance.
CREATE TABLE IF NOT EXISTS payment_accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    kind            VARCHAR(20)  NOT NULL DEFAULT 'bank',
    -- What the account held before TAMS started tracking it. Zero for a
    -- fresh install; set it and the system balance lines up with the real
    -- statement instead of sitting below it by whatever was already there.
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    opening_date    DATE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Two accounts with the same name in one agency would make the ledger
    -- ambiguous to read, which defeats the purpose.
    CONSTRAINT uq_payment_account_name UNIQUE (business_id, name)
);

CREATE INDEX IF NOT EXISTS idx_payment_accounts_business
    ON payment_accounts(business_id, is_active, sort_order);

-- The standard set, in one place so the backfill below and the trigger that
-- handles future businesses can never drift apart.
CREATE OR REPLACE FUNCTION seed_payment_accounts(p_business_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    a RECORD;
BEGIN
    FOR a IN
        SELECT * FROM (VALUES
            ('Cash',            'cash',     0),
            ('Premier Bank',    'bank',    10),
            ('Salaam Bank',     'bank',    20),
            ('Amal Bank',       'bank',    30),
            ('MyBank',          'bank',    40),
            ('Dahabshiil Bank', 'bank',    50),
            ('IBS Bank',        'bank',    60),
            ('SOMBANK',         'bank',    70),
            ('Merchant',        'merchant',80),
            ('EVC',             'mobile',  90),
            ('EDahab',          'mobile', 100)
        ) AS t(name, kind, sort_order)
    LOOP
        INSERT INTO payment_accounts (business_id, name, kind, sort_order)
        VALUES (p_business_id, a.name, a.kind, a.sort_order)
        ON CONFLICT (business_id, name) DO NOTHING;
    END LOOP;
END
$$;

-- Every business that exists today.
DO $seed$
DECLARE b RECORD;
BEGIN
    FOR b IN SELECT id FROM businesses LOOP
        PERFORM seed_payment_accounts(b.id);
    END LOOP;
END
$seed$;

-- And every business created from now on. A trigger rather than a line in
-- the business-creation controller, because a new agency with no accounts
-- could take money that lands nowhere — and that failure would be silent
-- until someone tried to reconcile a month later.
CREATE OR REPLACE FUNCTION trg_seed_payment_accounts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM seed_payment_accounts(NEW.id);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS seed_accounts_on_new_business ON businesses;
CREATE TRIGGER seed_accounts_on_new_business
    AFTER INSERT ON businesses
    FOR EACH ROW EXECUTE FUNCTION trg_seed_payment_accounts();

-- ── 2. Point every movement at an account ────────────────────
--
-- Nullable on purpose. Rows written before this migration have no account,
-- and inventing one for them would be fabricating financial history. They
-- show in the ledger as "Unassigned" until someone says where they went.
ALTER TABLE ticket_payments  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE visa_payments    ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE package_payments ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE airline_payments ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE agent_payments   ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE expenses         ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;

-- ON DELETE RESTRICT, not CASCADE or SET NULL: deleting an account that has
-- transactions must fail loudly. Silently erasing or orphaning financial
-- records is exactly the failure this whole migration exists to prevent.

CREATE INDEX IF NOT EXISTS idx_ticket_payments_account  ON ticket_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_visa_payments_account    ON visa_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_package_payments_account ON package_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_airline_payments_account ON airline_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_agent_payments_account   ON agent_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_expenses_account         ON expenses(account_id);

-- Backfill only where the old text is unambiguous. 'cash' means Cash and
-- 'edahab' means EDahab; 'bank' and 'other' could be any of eight and are
-- deliberately left alone rather than guessed at.
DO $backfill$
DECLARE
    m RECORD;
BEGIN
    FOR m IN
        SELECT * FROM (VALUES
            ('cash',   'Cash'),
            ('edahab', 'EDahab'),
            ('evc',    'EVC')
        ) AS t(old_method, account_name)
    LOOP
        UPDATE ticket_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE visa_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE package_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE airline_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE agent_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE expenses e SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = e.business_id AND a.name = m.account_name
           AND e.account_id IS NULL AND LOWER(TRIM(e.payment_method)) = m.old_method;
    END LOOP;
END
$backfill$;

-- ── 3. Cargo payments ────────────────────────────────────────
--
-- Cargo only ever stored a running amount_paid on the shipment. No record of
-- when a payment arrived, which account took it, or who collected it — so
-- cargo money could not appear in a ledger at all. This gives it the same
-- treatment tickets, visas and packages already had.
CREATE TABLE IF NOT EXISTS cargo_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    cargo_id     UUID NOT NULL REFERENCES cargo_shipments(id) ON DELETE CASCADE,
    collected_by UUID REFERENCES users(id),
    account_id   UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method       VARCHAR(50) DEFAULT 'cash',
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cargo_payments_cargo    ON cargo_payments(cargo_id);
CREATE INDEX IF NOT EXISTS idx_cargo_payments_business ON cargo_payments(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cargo_payments_account  ON cargo_payments(account_id);

-- Existing shipments carry a paid total with no history behind it. Create one
-- opening row each so the ledger and the shipment agree, marked plainly as a
-- reconstruction rather than passed off as a real receipt.
INSERT INTO cargo_payments (business_id, cargo_id, amount, method, note, created_at)
SELECT cs.business_id, cs.id, cs.amount_paid, 'cash',
       'Opening balance carried over from before payment tracking', cs.created_at
  FROM cargo_shipments cs
 WHERE cs.amount_paid > 0
   AND NOT EXISTS (SELECT 1 FROM cargo_payments p WHERE p.cargo_id = cs.id);

-- ── 3b. Allow corrections ────────────────────────────────────
--
-- Every payments table insisted amount > 0. That is fine while money only
-- ever arrives, but the edit forms let someone change what a customer has
-- paid — correcting a typo, or recording a refund. When that happens the
-- ledger needs a row for the difference, and the difference can be negative.
--
-- Without this, a downward correction would leave the shipment saying one
-- thing and the ledger another, and the balance would silently be wrong.
-- Zero is still forbidden: a movement of nothing is not an event.
DO $relax$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT con.conname, rel.relname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
         WHERE n.nspname = 'public'
           AND con.contype = 'c'
           AND rel.relname IN ('ticket_payments','visa_payments',
                               'package_payments','cargo_payments')
           AND pg_get_constraintdef(con.oid) ILIKE '%amount > (0)%'
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.relname, c.conname);
    END LOOP;

    FOR c IN
        SELECT unnest(ARRAY['ticket_payments','visa_payments',
                            'package_payments','cargo_payments']) AS relname
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint con
              JOIN pg_class rel ON rel.oid = con.conrelid
             WHERE rel.relname = c.relname
               AND con.conname = c.relname || '_amount_nonzero'
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I ADD CONSTRAINT %I CHECK (amount <> 0)',
                c.relname, c.relname || '_amount_nonzero');
        END IF;
    END LOOP;
END
$relax$;

-- ── 4. Transfers between your own accounts ───────────────────
--
-- Withdrawing EVC into Premier Bank is not income and not an expense — the
-- agency is no richer. Recording it as a movement with two ends keeps both
-- balances right while leaving the total untouched. Without this, every
-- transfer would look like money appearing from nowhere in one account and
-- vanishing from another.
CREATE TABLE IF NOT EXISTS account_transfers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    from_account_id UUID NOT NULL REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    to_account_id   UUID NOT NULL REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    -- Some services charge to move money. Charged to the sending account and
    -- treated as an expense, because unlike the transfer itself it is a real
    -- loss to the business.
    fee             NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
    transferred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reference       VARCHAR(100),
    note            TEXT,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_transfer_distinct CHECK (from_account_id <> to_account_id)
);

CREATE INDEX IF NOT EXISTS idx_transfers_business ON account_transfers(business_id, transferred_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_from     ON account_transfers(from_account_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to       ON account_transfers(to_account_id);

-- ── 5. The ledger ────────────────────────────────────────────
--
-- Every movement of money in the business, from eight sources, in one shape:
--
--   direction  'in' or 'out', from the agency's point of view
--   party      who the money was with — customer, airline, agent, vendor
--   source     which part of the business it came from
--   source_id  the record it belongs to, so the UI can link straight to it
--
-- A single view rather than eight queries stitched together in JavaScript,
-- because the balance and the ledger must be computed the same way or they
-- will eventually disagree — and when they disagree, nobody can tell which
-- one is lying.
--
-- Transfers appear as two rows, one 'out' and one 'in'. The pair cancels in
-- any total across all accounts, which is exactly right: moving your own
-- money between your own accounts makes the business no richer.
-- Drop the dependent view first. v_account_balance is built ON v_cash_ledger,
-- so dropping the ledger while the balance view still refers to it fails —
-- which only shows up the *second* time this migration runs, when both
-- already exist.
DROP VIEW IF EXISTS v_account_balance;
DROP VIEW IF EXISTS v_cash_ledger;
CREATE VIEW v_cash_ledger AS

-- Money in: customers paying for tickets
SELECT p.business_id, p.account_id, p.id AS movement_id,
       'in'::TEXT AS direction, p.amount, p.created_at AS occurred_at,
       'ticket'::TEXT AS source, p.ticket_id AS source_id,
       COALESCE(t.passenger_name, 'Ticket') AS party,
       NULLIF(t.ticket_reference, '') AS reference,
       p.note, p.collected_by AS user_id, p.method AS legacy_method
  FROM ticket_payments p
  LEFT JOIN tickets t ON t.id = p.ticket_id

UNION ALL

-- Money in: visa fees
SELECT p.business_id, p.account_id, p.id,
       'in', p.amount, p.created_at,
       'visa', p.visa_id,
       COALESCE(v.applicant_name, 'Visa'),
       v.destination_country,
       p.note, p.collected_by, p.method
  FROM visa_payments p
  LEFT JOIN visa_applications v ON v.id = p.visa_id

UNION ALL

-- Money in: Hajj, Umrah and other packages
SELECT p.business_id, p.account_id, p.id,
       'in', p.amount, p.created_at,
       'package', p.package_id,
       COALESCE(NULLIF(pk.lead_name, ''), pk.label, 'Package'),
       pk.label,
       p.note, p.collected_by, p.method
  FROM package_payments p
  LEFT JOIN packages pk ON pk.id = p.package_id

UNION ALL

-- Money in: cargo
SELECT p.business_id, p.account_id, p.id,
       'in', p.amount, p.created_at,
       'cargo', p.cargo_id,
       COALESCE(cs.sender_name, 'Cargo'),
       cs.tracking_number,
       p.note, p.collected_by, p.method
  FROM cargo_payments p
  LEFT JOIN cargo_shipments cs ON cs.id = p.cargo_id

UNION ALL

-- Money out: paying airlines for ticket stock
SELECT p.business_id, p.account_id, p.id,
       'out', p.amount, p.created_at,
       'airline', p.airline_id,
       COALESCE(a.name, 'Airline'),
       p.reference,
       NULL, NULL, p.method
  FROM airline_payments p
  LEFT JOIN airlines a ON a.id = p.airline_id

UNION ALL

-- Money out: agent commission
SELECT p.business_id, p.account_id, p.id,
       'out', p.amount, p.created_at,
       'agent', p.agent_id,
       COALESCE(ag.name, 'Agent'),
       p.reference,
       NULL, NULL, p.method
  FROM agent_payments p
  LEFT JOIN agents ag ON ag.id = p.agent_id

UNION ALL

-- Money out: running costs
-- expense_date is a DATE; cast so every row in the view shares one type.
SELECT e.business_id, e.account_id, e.id,
       'out', e.amount, e.expense_date::TIMESTAMPTZ,
       'expense', e.id,
       COALESCE(NULLIF(e.vendor, ''), e.description),
       e.reference,
       e.notes, e.created_by, e.payment_method
  FROM expenses e

UNION ALL

-- Transfers, leaving one account…
SELECT tr.business_id, tr.from_account_id, tr.id,
       'out', tr.amount + tr.fee, tr.transferred_at,
       'transfer_out', tr.id,
       'Transfer to ' || COALESCE(dest.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts dest ON dest.id = tr.to_account_id

UNION ALL

-- …and arriving in another. The fee stays with the sender, so the amount
-- landing is the transfer amount alone.
SELECT tr.business_id, tr.to_account_id, tr.id,
       'in', tr.amount, tr.transferred_at,
       'transfer_in', tr.id,
       'Transfer from ' || COALESCE(src.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts src ON src.id = tr.from_account_id;

-- ── 6. What each account should hold ─────────────────────────
--
-- Derived from the ledger rather than kept as a running total on the account
-- row. A stored balance is one failed update away from being wrong forever,
-- and nothing would reveal it; a derived one cannot drift from the movements
-- it is made of.
CREATE VIEW v_account_balance AS
SELECT a.id AS account_id,
       a.business_id,
       a.name,
       a.kind,
       a.is_active,
       a.sort_order,
       a.opening_balance,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'),  0) AS total_in,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS total_out,
       a.opening_balance
         + COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'),  0)
         - COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS balance,
       COUNT(l.movement_id) AS movement_count,
       MAX(l.occurred_at)   AS last_movement_at
  FROM payment_accounts a
  LEFT JOIN v_cash_ledger l ON l.account_id = a.id
 GROUP BY a.id, a.business_id, a.name, a.kind, a.is_active,
          a.sort_order, a.opening_balance;

COMMIT;

-- ── Note on unassigned money ─────────────────────────────────
-- Rows written before this migration, and any where the old text label was
-- too vague to map, have account_id IS NULL. Their money is real and appears
-- in the ledger, but belongs to no account, so it is excluded from every
-- balance. The Accounts page surfaces these so they can be assigned. To see
-- how much is waiting:
--
--   SELECT direction, COUNT(*), SUM(amount)
--     FROM v_cash_ledger WHERE account_id IS NULL GROUP BY direction;
