-- ============================================================
-- migration_v12.sql — cancellations and refunds
--
-- Cancelling a ticket is not one event but up to three, and they are
-- independent of each other:
--
--   1. money going back to the customer          (out of an account)
--   2. a fee the agency keeps                    (stays, and is earned)
--   3. money the airline returns to the agency   (into an account)
--
-- Nothing here invents amounts. Airline penalties vary by carrier, fare and
-- how late the cancellation is, so every figure is entered by the person
-- who knows what actually happened.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ── 1. What the cancellation earned ──────────────────────────
--
-- The sale itself stops counting once a ticket is cancelled, but the fee
-- retained is real income and has to survive somewhere. Keeping it on the
-- ticket means the money and the booking it came from never drift apart.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancellation_fee NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS refunded_amount  NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS airline_refund   NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancelled_at     TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancel_reason    TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancelled_by     UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_tickets_cancelled
    ON tickets(business_id, cancelled_at DESC)
    WHERE cancelled_at IS NOT NULL;

-- ── 2. Money can now flow backwards ──────────────────────────
--
-- An airline refunding a cancelled fare is a payment in reverse. Rather than
-- add a second table for reversals, the existing payment tables accept a
-- negative amount — one row type, one place to look, and the arithmetic
-- takes care of itself.
--
-- Zero stays forbidden everywhere: a movement of nothing is not an event.
DO $relax$
DECLARE
    c RECORD;
    tables TEXT[] := ARRAY['airline_payments','agent_payments'];
    t TEXT;
BEGIN
    FOR c IN
        SELECT con.conname, rel.relname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
         WHERE n.nspname = 'public'
           AND con.contype = 'c'
           AND rel.relname = ANY(tables)
           AND pg_get_constraintdef(con.oid) ILIKE '%amount > (0)%'
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.relname, c.conname);
    END LOOP;

    FOREACH t IN ARRAY tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint con
              JOIN pg_class rel ON rel.oid = con.conrelid
             WHERE rel.relname = t AND con.conname = t || '_amount_nonzero'
        ) THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (amount <> 0)',
                           t, t || '_amount_nonzero');
        END IF;
    END LOOP;
END
$relax$;

-- ── 3. The ledger reads the sign ─────────────────────────────
--
-- Until now each source had a fixed direction: a ticket payment was always
-- money in, an airline payment always money out. Refunds break that. A
-- refund to a customer is a negative ticket payment, and showing it as
-- "in −$500" is both ugly and easy to misread.
--
-- So direction is now derived from the sign, and the amount is always
-- positive. The arithmetic is unchanged — "in −500" and "out 500" net
-- identically — but every row now reads the way it happened.
DROP VIEW IF EXISTS v_account_balance;
DROP VIEW IF EXISTS v_cash_ledger;

CREATE VIEW v_cash_ledger AS

-- Customers paying for tickets. Negative = refunded to them.
SELECT p.business_id, p.account_id, p.id AS movement_id,
       CASE WHEN p.amount >= 0 THEN 'in' ELSE 'out' END::TEXT AS direction,
       ABS(p.amount) AS amount, p.created_at AS occurred_at,
       'ticket'::TEXT AS source, p.ticket_id AS source_id,
       COALESCE(t.passenger_name, 'Ticket') AS party,
       NULLIF(t.ticket_reference, '') AS reference,
       p.note, p.collected_by AS user_id, p.method AS legacy_method
  FROM ticket_payments p
  LEFT JOIN tickets t ON t.id = p.ticket_id

UNION ALL

SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'in' ELSE 'out' END,
       ABS(p.amount), p.created_at,
       'visa', p.visa_id,
       COALESCE(v.applicant_name, 'Visa'),
       v.destination_country,
       p.note, p.collected_by, p.method
  FROM visa_payments p
  LEFT JOIN visa_applications v ON v.id = p.visa_id

UNION ALL

SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'in' ELSE 'out' END,
       ABS(p.amount), p.created_at,
       'package', p.package_id,
       COALESCE(NULLIF(pk.lead_name, ''), pk.label, 'Package'),
       pk.label,
       p.note, p.collected_by, p.method
  FROM package_payments p
  LEFT JOIN packages pk ON pk.id = p.package_id

UNION ALL

SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'in' ELSE 'out' END,
       ABS(p.amount), p.created_at,
       'cargo', p.cargo_id,
       COALESCE(cs.sender_name, 'Cargo'),
       cs.tracking_number,
       p.note, p.collected_by, p.method
  FROM cargo_payments p
  LEFT JOIN cargo_shipments cs ON cs.id = p.cargo_id

UNION ALL

-- Paying airlines. Negative = the airline refunded us.
SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(p.amount), p.created_at,
       'airline', p.airline_id,
       COALESCE(a.name, 'Airline'),
       p.reference,
       NULL, NULL, p.method
  FROM airline_payments p
  LEFT JOIN airlines a ON a.id = p.airline_id

UNION ALL

-- Agent commission. Negative = commission clawed back.
SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(p.amount), p.created_at,
       'agent', p.agent_id,
       COALESCE(ag.name, 'Agent'),
       p.reference,
       NULL, NULL, p.method
  FROM agent_payments p
  LEFT JOIN agents ag ON ag.id = p.agent_id

UNION ALL

SELECT e.business_id, e.account_id, e.id,
       CASE WHEN e.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(e.amount), e.expense_date::TIMESTAMPTZ,
       'expense', e.id,
       COALESCE(NULLIF(e.vendor, ''), e.description),
       e.reference,
       e.notes, e.created_by, e.payment_method
  FROM expenses e

UNION ALL

SELECT tr.business_id, tr.from_account_id, tr.id,
       'out', tr.amount + tr.fee, tr.transferred_at,
       'transfer_out', tr.id,
       'Transfer to ' || COALESCE(dest.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts dest ON dest.id = tr.to_account_id

UNION ALL

SELECT tr.business_id, tr.to_account_id, tr.id,
       'in', tr.amount, tr.transferred_at,
       'transfer_in', tr.id,
       'Transfer from ' || COALESCE(src.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts src ON src.id = tr.from_account_id;

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
