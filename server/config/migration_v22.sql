-- ============================================================
-- migration_v22.sql — suppliers get paid, cargo gets a margin
--
-- THE BUG THIS EXISTS TO FIX
--
-- The balance sheet computed Cash & bank like this:
--
--   cash = opening + collected - expenses - airline_paid - agent_paid
--          - (every visa cost_price + every package total_cost)
--
-- That last term is money that never moved. Typing 1,900 into a visa's cost
-- field made 1,900 vanish from the agency's cash, with no payment, no
-- account, and nothing in the ledger — while the Accounts page, which reads
-- the ledger, still showed it. One visa was the whole 1,900 gap between
-- "Cash & bank $130" and "Total across all accounts $2,030".
--
-- The comment in the code said suppliers "leave cash immediately". They do
-- not. An embassy fee is owed until somebody pays it, exactly like an
-- airline fare — which TAMS already models properly, with a payable and a
-- Pay button. This gives visas, packages and cargo carriers the same
-- treatment, and then Cash & bank can be what it should always have been:
-- the sum of the account balances.
--
-- ── 1. supplier_payments ─────────────────────────────────────
--
-- One table for all three rather than three near-identical ones. What is
-- being paid for is identified by exactly one of the three id columns, and
-- a CHECK enforces exactly one — a row that points at both a visa and a
-- shipment would be counted twice by anything that joins.
--
-- ── 2. cargo profit ──────────────────────────────────────────
--
-- Cargo was treated as pure margin: whatever the customer paid was profit,
-- because the agency was assumed to have no cost. That is true for a parcel
-- carried on a flight the agency already books, and false whenever a
-- carrier is paid per kilo. The price per kg is sometimes the whole margin
-- and sometimes mostly cost, and only the person taking the parcel knows
-- which, so they enter the profit and the cost follows from it.
--
-- profit_amount NULL means "no cost recorded" — the old behaviour, kept so
-- every existing shipment reads exactly as it did before.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ── 1. What has been paid to a supplier ──────────────────────
CREATE TABLE IF NOT EXISTS supplier_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    visa_id      UUID REFERENCES visa_applications(id) ON DELETE CASCADE,
    package_id   UUID REFERENCES packages(id)          ON DELETE CASCADE,
    cargo_id     UUID REFERENCES cargo_shipments(id)   ON DELETE CASCADE,
    -- Negative means the supplier gave money back, the same convention the
    -- ticket and airline payment tables already use. Direction is read from
    -- the sign, never from a separate column that can disagree with it.
    amount       NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
    account_id   UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    paid_by      UUID REFERENCES users(id),
    method       VARCHAR(30),
    reference    VARCHAR(100),
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Exactly one thing is being paid for.
    CONSTRAINT chk_supplier_payment_target CHECK (
        (visa_id IS NOT NULL)::INT
      + (package_id IS NOT NULL)::INT
      + (cargo_id IS NOT NULL)::INT = 1
    )
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_business ON supplier_payments(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_visa     ON supplier_payments(visa_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_package  ON supplier_payments(package_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_cargo    ON supplier_payments(cargo_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_account  ON supplier_payments(account_id);

-- A running total on each record, so a list can show what is still owed
-- without a subquery per row. Kept in step by the controller inside the
-- same transaction as the payment.
ALTER TABLE visa_applications ADD COLUMN IF NOT EXISTS supplier_paid NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE packages          ADD COLUMN IF NOT EXISTS supplier_paid NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE cargo_shipments   ADD COLUMN IF NOT EXISTS supplier_paid NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ── 2. Cargo can carry a cost ────────────────────────────────
--
-- The margin is entered; the cost is derived. Entering the cost instead
-- would mean the person taking a parcel has to do the subtraction, and they
-- are standing at a counter with a customer waiting.
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS profit_amount NUMERIC(12,2);

ALTER TABLE cargo_shipments DROP CONSTRAINT IF EXISTS chk_cargo_profit_within_price;
ALTER TABLE cargo_shipments ADD CONSTRAINT chk_cargo_profit_within_price
    CHECK (profit_amount IS NULL OR profit_amount >= 0);

-- ── 2b. Money taken before there is anything to sell ─────────
--
-- A customer can hand over money with nothing booked yet — a deposit on a
-- trip being planned, or simply cash left on account. Until now the only
-- way to take money was against a specific ticket, so this either could not
-- be recorded at all or got attached to an unrelated booking, which made
-- that booking's balance a lie.
--
-- A deposit is not income. The agency has not earned it and may have to
-- give it back, so it is cash held *and* a liability owed, and it stays
-- that way until it is applied to something or returned. Negative amounts
-- are the money going back out, the same sign convention as everywhere else
-- in this schema.
CREATE TABLE IF NOT EXISTS customer_deposits (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    amount       NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
    account_id   UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    collected_by UUID REFERENCES users(id),
    method       VARCHAR(30),
    reference    VARCHAR(100),
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_deposits_business ON customer_deposits(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_deposits_customer ON customer_deposits(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_deposits_account  ON customer_deposits(account_id);

-- ── 3. The ledger sees supplier payments ─────────────────────
--
-- Money leaving an account has to appear in the ledger or the balance and
-- the movement list stop agreeing. Rebuilt with a tenth source.
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
       p.note, p.paid_by, p.method
  FROM airline_payments p
  LEFT JOIN airlines a ON a.id = p.airline_id

UNION ALL

SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(p.amount), p.created_at,
       'agent', p.agent_id,
       COALESCE(ag.name, 'Agent'),
       p.reference,
       p.note, p.paid_by, p.method
  FROM agent_payments p
  LEFT JOIN agents ag ON ag.id = p.agent_id

UNION ALL

-- New: embassies, tour operators and cargo carriers. Money out, unless the
-- supplier refunded, in which case the sign flips it back.
SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(p.amount), p.created_at,
       'supplier',
       COALESCE(p.visa_id, p.package_id, p.cargo_id),
       COALESCE(
         'Visa — '    || v.applicant_name,
         'Package — ' || COALESCE(NULLIF(pk.label, ''), pk.lead_name),
         'Cargo — '   || COALESCE(cs.tracking_number, cs.sender_name),
         'Supplier'),
       p.reference,
       p.note, p.paid_by, p.method
  FROM supplier_payments p
  LEFT JOIN visa_applications v ON v.id = p.visa_id
  LEFT JOIN packages pk         ON pk.id = p.package_id
  LEFT JOIN cargo_shipments cs  ON cs.id = p.cargo_id

UNION ALL

-- Money held for a customer against nothing in particular.
SELECT d.business_id, d.account_id, d.id,
       CASE WHEN d.amount >= 0 THEN 'in' ELSE 'out' END,
       ABS(d.amount), d.created_at,
       'deposit', d.customer_id,
       COALESCE(c.name, 'Customer'),
       d.reference,
       d.note, d.collected_by, d.method
  FROM customer_deposits d
  LEFT JOIN customers c ON c.id = d.customer_id

UNION ALL

SELECT e.business_id, e.account_id, e.id,
       'out', ABS(e.amount), e.expense_date::TIMESTAMPTZ,
       'expense', e.id,
       COALESCE(NULLIF(e.vendor, ''), INITCAP(REPLACE(e.category::TEXT, '_', ' '))),
       e.reference,
       e.description, e.created_by, e.payment_method
  FROM expenses e

UNION ALL

SELECT p.business_id, p.account_id, p.id,
       'out', ABS(p.amount), p.paid_at,
       'tax', p.id,
       'Tax authority',
       p.reference,
       p.note, p.paid_by, NULL
  FROM tax_payments p

UNION ALL

SELECT t.business_id, t.from_account_id, t.id,
       'out', t.amount + COALESCE(t.fee, 0), t.transferred_at,
       'transfer_out', t.to_account_id,
       'Transfer out', t.reference, t.note, t.created_by, NULL
  FROM account_transfers t

UNION ALL

SELECT t.business_id, t.to_account_id, t.id,
       'in', t.amount, t.transferred_at,
       'transfer_in', t.from_account_id,
       'Transfer in', t.reference, t.note, t.created_by, NULL
  FROM account_transfers t;

CREATE VIEW v_account_balance AS
SELECT
    a.id            AS account_id,
    a.business_id,
    a.name,
    a.kind,
    a.is_active,
    a.sort_order,
    a.opening_balance,
    a.opening_date,
    COALESCE(l.total_in, 0)  AS total_in,
    COALESCE(l.total_out, 0) AS total_out,
    a.opening_balance + COALESCE(l.total_in, 0) - COALESCE(l.total_out, 0) AS balance,
    l.last_movement_at,
    COALESCE(l.movements, 0) AS movements
FROM payment_accounts a
LEFT JOIN (
    SELECT account_id,
           COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0)  AS total_in,
           COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0) AS total_out,
           MAX(occurred_at)                                          AS last_movement_at,
           COUNT(*)                                                  AS movements
      FROM v_cash_ledger
     WHERE account_id IS NOT NULL
     GROUP BY account_id
) l ON l.account_id = a.id;

-- ── 4. The monthly trend counts cargo the same way ───────────
--
-- v_monthly_income treated every shipment as pure margin. Left alone, the
-- chart on the Financials page would disagree with the statement printed
-- directly above it — the exact failure this system keeps being bitten by.
DROP VIEW IF EXISTS v_monthly_income;
CREATE VIEW v_monthly_income AS
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
        -- Only where a margin was entered; otherwise the shipment is all
        -- profit, exactly as it read before the field existed.
        COALESCE(SUM(GREATEST(cs.total_price - cs.profit_amount, 0))
                 FILTER (WHERE cs.profit_amount IS NOT NULL), 0)       AS direct_cost,
        0                                                              AS commission,
        COALESCE(SUM(COALESCE(cs.profit_amount, cs.total_price)), 0)   AS gross_profit
    FROM cargo_shipments cs
    WHERE cs.cargo_status <> 'cancelled'
    GROUP BY 1, 2
) combined
GROUP BY business_id, month;

COMMIT;
