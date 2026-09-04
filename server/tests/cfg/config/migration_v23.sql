-- ============================================================
-- migration_v23.sql — margin per kilo, and deposits that can be spent
--
-- ── 1. Cargo margin is a rate, not a lump ────────────────────
--
-- v22 asked for the profit on the whole shipment. That is not how the
-- price is quoted: the agency charges $3 a kilo and keeps $1 of it, so the
-- margin on 40 kg is $40 and the person at the counter should not have to
-- work that out. profit_per_kg replaces profit_amount, and the shipment's
-- margin becomes a generated column — weight × rate — so it can never
-- disagree with the numbers it was derived from.
--
-- A flat-priced shipment has no weight to multiply, so it keeps a lump-sum
-- margin. Both routes end at the same column, `profit_total`, and every
-- report reads only that.
--
-- ── 2. A deposit that can actually be used ───────────────────
--
-- v22 could take a deposit and hand it back. It could not spend one, so
-- money held for a customer sat there while their ticket showed unpaid.
--
-- Applying a deposit moves no cash. The money arrived when the deposit was
-- taken and is already in an account; what changes is that the agency stops
-- owing it and the booking stops being unpaid. So an application must NOT
-- reach the cash ledger — if it did, the same cash would be counted twice,
-- once as a deposit and again as a ticket payment, and every account
-- balance would inflate.
--
-- The booking still gets a payment row, because amount_paid has to equal the
-- sum of its payments or the two drift apart. That row is flagged
-- `from_deposit`, and the ledger skips flagged rows: real for the booking,
-- invisible to cash. That flag is the whole trick.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ── 1. Margin per kilo ───────────────────────────────────────
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS profit_per_kg NUMERIC(10,2);

-- Anything entered under v22 was a whole-shipment figure. Carry it across as
-- the lump-sum margin rather than losing it or, worse, reading it as a rate
-- and multiplying it by the weight.
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS profit_flat NUMERIC(12,2);

DO $carry$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'cargo_shipments' AND column_name = 'profit_amount')
    THEN
        EXECUTE 'UPDATE cargo_shipments
                    SET profit_flat = profit_amount
                  WHERE profit_amount IS NOT NULL AND profit_flat IS NULL';
    END IF;
END
$carry$;

-- One column every report reads, so "what did we make on this shipment" has
-- exactly one answer however it was priced.
ALTER TABLE cargo_shipments DROP COLUMN IF EXISTS profit_total;
ALTER TABLE cargo_shipments ADD COLUMN profit_total NUMERIC(12,2)
    GENERATED ALWAYS AS (
        CASE
            WHEN profit_per_kg IS NOT NULL AND weight_kg IS NOT NULL
                THEN GREATEST(weight_kg * profit_per_kg, 0)
            WHEN profit_flat IS NOT NULL
                THEN GREATEST(profit_flat, 0)
            ELSE NULL          -- no margin recorded: the old, all-profit case
        END
    ) STORED;

ALTER TABLE cargo_shipments DROP CONSTRAINT IF EXISTS chk_cargo_profit_within_price;
-- Dropped before it is added, so a second run replaces it rather than
-- failing on a name that is already taken.
ALTER TABLE cargo_shipments DROP CONSTRAINT IF EXISTS chk_cargo_margin_not_negative;
ALTER TABLE cargo_shipments ADD CONSTRAINT chk_cargo_margin_not_negative
    CHECK ((profit_per_kg IS NULL OR profit_per_kg >= 0)
       AND (profit_flat  IS NULL OR profit_flat  >= 0));

-- ── 2. Payments that moved no cash ───────────────────────────
ALTER TABLE ticket_payments  ADD COLUMN IF NOT EXISTS from_deposit BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE visa_payments    ADD COLUMN IF NOT EXISTS from_deposit BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE package_payments ADD COLUMN IF NOT EXISTS from_deposit BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cargo_payments   ADD COLUMN IF NOT EXISTS from_deposit BOOLEAN NOT NULL DEFAULT FALSE;

-- Where a deposit went. Not in the ledger, deliberately: this is a liability
-- being settled, not money moving.
CREATE TABLE IF NOT EXISTS deposit_applications (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    ticket_id   UUID REFERENCES tickets(id)            ON DELETE CASCADE,
    visa_id     UUID REFERENCES visa_applications(id)  ON DELETE CASCADE,
    package_id  UUID REFERENCES packages(id)           ON DELETE CASCADE,
    cargo_id    UUID REFERENCES cargo_shipments(id)    ON DELETE CASCADE,
    applied_by  UUID REFERENCES users(id),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_deposit_application_target CHECK (
        (ticket_id  IS NOT NULL)::INT
      + (visa_id    IS NOT NULL)::INT
      + (package_id IS NOT NULL)::INT
      + (cargo_id   IS NOT NULL)::INT = 1
    )
);

CREATE INDEX IF NOT EXISTS idx_deposit_apps_customer ON deposit_applications(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_apps_business ON deposit_applications(business_id, created_at DESC);

-- What is being held for each customer, right now.
CREATE OR REPLACE VIEW v_customer_deposit AS
SELECT c.id                                   AS customer_id,
       c.business_id,
       c.name,
       COALESCE(d.taken, 0)                   AS taken,
       COALESCE(a.applied, 0)                 AS applied,
       COALESCE(d.taken, 0) - COALESCE(a.applied, 0) AS balance
  FROM customers c
  LEFT JOIN (
      SELECT customer_id, SUM(amount) AS taken
        FROM customer_deposits GROUP BY customer_id
  ) d ON d.customer_id = c.id
  LEFT JOIN (
      SELECT customer_id, SUM(amount) AS applied
        FROM deposit_applications GROUP BY customer_id
  ) a ON a.customer_id = c.id;

-- ── 3. The ledger skips payments that moved no cash ──────────
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
  -- A payment settled from a deposit moved no cash: the money arrived
  -- when the deposit was taken and is already in an account. Counting it
  -- again here would double every balance it touched.
 WHERE NOT COALESCE(p.from_deposit, FALSE)

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
  -- A payment settled from a deposit moved no cash: the money arrived
  -- when the deposit was taken and is already in an account. Counting it
  -- again here would double every balance it touched.
 WHERE NOT COALESCE(p.from_deposit, FALSE)

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
  -- A payment settled from a deposit moved no cash: the money arrived
  -- when the deposit was taken and is already in an account. Counting it
  -- again here would double every balance it touched.
 WHERE NOT COALESCE(p.from_deposit, FALSE)

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
  -- A payment settled from a deposit moved no cash: the money arrived
  -- when the deposit was taken and is already in an account. Counting it
  -- again here would double every balance it touched.
 WHERE NOT COALESCE(p.from_deposit, FALSE)

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

-- The monthly trend reads the one margin column too.
DROP VIEW IF EXISTS v_monthly_income;
CREATE VIEW v_monthly_income AS
SELECT business_id, month,
       SUM(gross_sales) AS gross_sales, SUM(direct_cost) AS direct_cost,
       SUM(commission)  AS commission,  SUM(gross_profit) AS gross_profit
FROM (
    SELECT t.business_id, DATE_TRUNC('month', t.created_at)::DATE AS month,
           COALESCE(SUM(t.selling_price), 0)    AS gross_sales,
           COALESCE(SUM(t.cost_price), 0)       AS direct_cost,
           COALESCE(SUM(t.agent_commission), 0) AS commission,
           COALESCE(SUM(t.revenue), 0)          AS gross_profit
      FROM tickets t WHERE t.status <> 'cancelled' GROUP BY 1, 2
    UNION ALL
    SELECT cs.business_id, DATE_TRUNC('month', cs.created_at)::DATE,
           COALESCE(SUM(cs.total_price), 0),
           COALESCE(SUM(GREATEST(cs.total_price - cs.profit_total, 0))
                    FILTER (WHERE cs.profit_total IS NOT NULL), 0),
           0,
           COALESCE(SUM(COALESCE(cs.profit_total, cs.total_price)), 0)
      FROM cargo_shipments cs WHERE cs.cargo_status <> 'cancelled' GROUP BY 1, 2
) combined
GROUP BY business_id, month;

-- ── 4. Cargo remembers whose parcel it is ────────────────────
--
-- Booking a ticket has always created the customer if they weren't on file.
-- Cargo had no customer at all, so a regular shipper existed in the system
-- only as a name typed on each shipment: no statement, no history, and no
-- way to spend their deposit on a parcel.
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS customer_id UUID
    REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cargo_customer ON cargo_shipments(customer_id);

COMMIT;
