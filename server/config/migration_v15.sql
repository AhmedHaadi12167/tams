-- ============================================================
-- migration_v15.sql — tax is owed to the government, not the airline
--
-- Three related changes.
--
-- 1. The airline was being credited with the tax.
--
--    A ticket's cost_price is the whole amount paid out, and part of that is
--    tax. The airline never sees the tax — it goes to the government. So the
--    airline account has been overstating what the agency owes by exactly
--    the tax on every ticket, and settling "in full" was overpaying.
--
--    The airline is now owed cost_price − tax.
--
-- 2. Tax needs somewhere to live.
--
--    Money collected as tax is not revenue and not the agency's to spend.
--    It accrues as a liability until it is paid over, exactly like an
--    unsettled airline balance, so it gets the same treatment: a running
--    total owed, payments recorded against an account, and a balance that
--    reaches zero when the agency is square with the tax authority.
--
-- 3. A cancelled ticket can leave the customer owing money.
--
--    Chasing a debt for a journey that never happened is not worth anyone's
--    time, so it can be written off at the moment of cancellation. The
--    amount is recorded rather than silently dropped, because a write-off is
--    a real loss and hiding it flatters the profit.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ── 1. What was given up on ──────────────────────────────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS written_off NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ── 2. Tax paid over to the authority ────────────────────────
CREATE TABLE IF NOT EXISTS tax_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id   UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    paid_by      UUID REFERENCES users(id),
    amount       NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
    -- Which period the payment covers, for the agency's own records. The
    -- balance is computed from everything, not from these labels.
    period_from  DATE,
    period_to    DATE,
    reference    VARCHAR(100),
    note         TEXT,
    paid_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_payments_business ON tax_payments(business_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_tax_payments_account  ON tax_payments(account_id);

-- ── 3. The airline no longer gets the tax ────────────────────
--
-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW can
-- only append columns, and total_tax belongs next to total_cost where it
-- can be read alongside it.
--
-- Sections 3 and 4 are skipped once v17 has run. v17 supersedes both views
-- by keeping the tax owed on cancelled tickets, and re-running an older
-- migration must never quietly undo a newer one — that is how a fixed bug
-- comes back.
DO $v15$
BEGIN
IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tickets' AND column_name = 'tax_refunded')
THEN RETURN; END IF;

EXECUTE $sql$
DROP VIEW IF EXISTS v_airline_account;
CREATE VIEW v_airline_account AS
SELECT
    a.id                                     AS airline_id,
    a.business_id,
    a.name                                   AS airline_name,
    COALESCE(t.ticket_count, 0)              AS ticket_count,
    COALESCE(t.total_cost, 0)                AS total_cost,
    COALESCE(t.total_tax, 0)                 AS total_tax,
    COALESCE(p.total_paid, 0)                AS total_paid,
    COALESCE(t.total_cost, 0) - COALESCE(p.total_paid, 0) AS balance,
    COALESCE(t.unsettled_tickets, 0)         AS unsettled_tickets,
    p.last_payment_at
FROM airlines a
LEFT JOIN (
    SELECT airline_id, business_id,
           COUNT(*) FILTER (WHERE status <> 'cancelled')  AS ticket_count,
           -- The airline's share only: the fare less the tax that belongs to
           -- the government. A cancelled ticket still costs whatever the
           -- airline didn't give back.
           COALESCE(SUM(
               CASE WHEN status = 'cancelled'
                    THEN GREATEST(cost_price - COALESCE(tax, 0) - COALESCE(airline_refund, 0), 0)
                    ELSE GREATEST(cost_price - COALESCE(tax, 0), 0)
               END), 0)                                    AS total_cost,
           COALESCE(SUM(COALESCE(tax, 0))
                    FILTER (WHERE status <> 'cancelled'), 0) AS total_tax,
           COUNT(*) FILTER (
               WHERE status <> 'cancelled'
                 AND GREATEST(cost_price - COALESCE(tax, 0), 0) > airline_paid
           )                                               AS unsettled_tickets
    FROM tickets
    WHERE airline_id IS NOT NULL
    GROUP BY airline_id, business_id
) t ON t.airline_id = a.id AND t.business_id = a.business_id
LEFT JOIN (
    SELECT airline_id, business_id,
           COALESCE(SUM(amount), 0) AS total_paid,
           MAX(created_at)          AS last_payment_at
    FROM airline_payments
    GROUP BY airline_id, business_id
) p ON p.airline_id = a.id AND p.business_id = a.business_id;

$sql$;

EXECUTE $sql$
-- ── 4. What is owed to the tax authority ─────────────────────
--
-- Accrues on every ticket that stands. (Superseded by v17, which keeps the
-- tax owed on cancelled tickets too: a journey that doesn't happen does not
-- cancel the government's claim. This body only runs on a database that has
-- not reached v17 yet.)
CREATE OR REPLACE VIEW v_tax_account AS
SELECT
    b.id                                        AS business_id,
    COALESCE(t.tax_accrued, 0)                  AS tax_accrued,
    COALESCE(p.tax_paid, 0)                     AS tax_paid,
    COALESCE(t.tax_accrued, 0) - COALESCE(p.tax_paid, 0) AS tax_owed,
    COALESCE(t.taxed_tickets, 0)                AS taxed_tickets,
    p.last_payment_at
FROM businesses b
LEFT JOIN (
    SELECT business_id,
           COALESCE(SUM(COALESCE(tax, 0)), 0) AS tax_accrued,
           COUNT(*) FILTER (WHERE COALESCE(tax, 0) > 0) AS taxed_tickets
    FROM tickets
    WHERE status <> 'cancelled'
    GROUP BY business_id
) t ON t.business_id = b.id
LEFT JOIN (
    SELECT business_id,
           COALESCE(SUM(amount), 0) AS tax_paid,
           MAX(paid_at)             AS last_payment_at
    FROM tax_payments
    GROUP BY business_id
) p ON p.business_id = b.id;

$sql$;
END
$v15$;

-- ── 5. Tax payments belong in the ledger ─────────────────────
--
-- Money leaving an account has to appear in the ledger, or the balance and
-- the movement list stop agreeing — the exact failure this whole design
-- exists to prevent. Rebuilt here with tax added as a ninth source.
DROP VIEW IF EXISTS v_account_balance;
DROP VIEW IF EXISTS v_cash_ledger;

CREATE VIEW v_cash_ledger AS

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

-- Tax handed over to the government.
SELECT tp.business_id, tp.account_id, tp.id,
       CASE WHEN tp.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(tp.amount), tp.paid_at,
       'tax', tp.id,
       'Tax authority',
       tp.reference, tp.note, tp.paid_by, NULL
  FROM tax_payments tp

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
