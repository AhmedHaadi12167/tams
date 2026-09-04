-- ============================================================
-- TAMS v4 Migration — Expenses & Service-Company Financials
-- Safe to run multiple times (idempotent).
-- Run with:  psql -d <your_db> -f server/config/migration_v4.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── expense categories enum ─────────────────────────────────
DO $$ BEGIN
    CREATE TYPE expense_category AS ENUM (
        'salaries',
        'rent',
        'utilities',
        'marketing',
        'office_supplies',
        'transport',
        'communication',
        'bank_charges',
        'licenses_permits',
        'maintenance',
        'refunds',
        'other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── expenses ────────────────────────────────────────────────
-- Operating expenses for the agency. These are what turn
-- gross profit (ticket + cargo margin) into net profit.
CREATE TABLE IF NOT EXISTS expenses (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    created_by     UUID NOT NULL REFERENCES users(id),
    category       expense_category NOT NULL DEFAULT 'other',
    description    VARCHAR(255) NOT NULL,
    amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    expense_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    vendor         VARCHAR(255),
    payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
    reference      VARCHAR(100),
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_business    ON expenses(business_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date        ON expenses(business_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category    ON expenses(business_id, category);
CREATE INDEX IF NOT EXISTS idx_expenses_created_by  ON expenses(created_by);

DO $$ BEGIN
    CREATE TRIGGER trg_expenses_updated_at
        BEFORE UPDATE ON expenses
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── business opening balances ───────────────────────────────
-- A service company's balance sheet needs a starting point:
-- cash the agency already had, equipment it owns, money it owes.
-- Everything after this is derived from tickets / cargo / expenses.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS opening_cash       NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS fixed_assets       NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS liabilities        NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_capital      NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS financials_start   DATE;

-- ── cargo payment ledger parity with tickets ────────────────
-- Cargo already tracks amount_paid; expose the balance the same
-- way tickets do so the receivables report can union both.
CREATE OR REPLACE VIEW v_receivables AS
SELECT
    t.business_id,
    'ticket'                                   AS source,
    t.id                                       AS source_id,
    t.passenger_name                           AS party_name,
    t.contact_number                           AS party_contact,
    t.created_at                               AS issued_at,
    t.selling_price                            AS total_amount,
    t.amount_paid                              AS paid_amount,
    (t.selling_price - t.amount_paid)          AS balance,
    t.payment_status
FROM tickets t
WHERE t.status <> 'cancelled'
  AND (t.selling_price - t.amount_paid) > 0
UNION ALL
SELECT
    cs.business_id,
    'cargo'                                    AS source,
    cs.id                                      AS source_id,
    cs.sender_name                             AS party_name,
    cs.sender_contact                          AS party_contact,
    cs.created_at                              AS issued_at,
    cs.total_price                             AS total_amount,
    cs.amount_paid                             AS paid_amount,
    (cs.total_price - cs.amount_paid)          AS balance,
    cs.payment_status
FROM cargo_shipments cs
WHERE cs.cargo_status <> 'cancelled'
  AND (cs.total_price - cs.amount_paid) > 0;

-- ── monthly income summary (used by P&L trend chart) ────────
CREATE OR REPLACE VIEW v_monthly_income AS
SELECT
    business_id,
    month,
    SUM(gross_sales)   AS gross_sales,
    SUM(direct_cost)   AS direct_cost,
    SUM(commission)    AS commission,
    SUM(gross_profit)  AS gross_profit
FROM (
    SELECT
        t.business_id,
        DATE_TRUNC('month', t.created_at)::DATE                        AS month,
        COALESCE(SUM(t.selling_price), 0)                              AS gross_sales,
        COALESCE(SUM(t.cost_price), 0)                                 AS direct_cost,
        COALESCE(SUM(t.agent_commission), 0)                           AS commission,
        COALESCE(SUM(t.revenue), 0)                                    AS gross_profit
    FROM tickets t
    WHERE t.status <> 'cancelled'
    GROUP BY 1, 2
    UNION ALL
    SELECT
        cs.business_id,
        DATE_TRUNC('month', cs.created_at)::DATE                       AS month,
        COALESCE(SUM(cs.total_price), 0)                               AS gross_sales,
        0                                                              AS direct_cost,
        0                                                              AS commission,
        COALESCE(SUM(cs.total_price), 0)                               AS gross_profit
    FROM cargo_shipments cs
    WHERE cs.cargo_status <> 'cancelled'
    GROUP BY 1, 2
) combined
GROUP BY business_id, month;
