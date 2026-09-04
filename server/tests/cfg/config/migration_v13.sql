-- ============================================================
-- migration_v13.sql — cargo that isn't weighed, and public tracking
--
-- Three changes, all about cargo:
--
--   1. Not everything goes on a scale. A box of electronics is priced by
--      eye, so weight and price-per-kg become optional and a flat price can
--      be typed instead.
--   2. The item description becomes optional too.
--   3. When a shipment lands, the office holding it and that office's phone
--      number are recorded, so the customer can be told where to collect.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ── 1. Flexible pricing ──────────────────────────────────────
--
-- total_price is a generated column, so its formula can't be altered in
-- place — the column has to be dropped and rebuilt, and the two views that
-- read it dropped with it. Nothing is lost: a generated column stores no
-- independent data, and every existing row has a weight and a rate, so the
-- rebuilt values come out identical.
DROP VIEW IF EXISTS v_receivables;
DROP VIEW IF EXISTS v_monthly_income;

ALTER TABLE cargo_shipments DROP COLUMN IF EXISTS total_price;

-- A price typed directly, for goods nobody weighs.
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS flat_price NUMERIC(12,2);

-- These three were mandatory because every shipment was assumed to be
-- weighed. That assumption was wrong.
ALTER TABLE cargo_shipments ALTER COLUMN weight_kg        DROP NOT NULL;
ALTER TABLE cargo_shipments ALTER COLUMN price_per_kg     DROP NOT NULL;
ALTER TABLE cargo_shipments ALTER COLUMN item_description DROP NOT NULL;

-- A typed price wins when present; otherwise fall back to weight × rate.
-- Still generated, so the total can never drift from the numbers behind it,
-- and every existing query that reads total_price keeps working untouched.
ALTER TABLE cargo_shipments
    ADD COLUMN total_price NUMERIC(12,2)
    GENERATED ALWAYS AS (
        COALESCE(flat_price, weight_kg * price_per_kg, 0)
    ) STORED;

-- ── 2. Where it landed ───────────────────────────────────────
--
-- Typed per shipment rather than chosen from a list of offices. That means
-- the same office may be spelled differently on different shipments, but it
-- needs no setup before the feature is usable.
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS arrived_city    VARCHAR(255);
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS arrived_office  VARCHAR(255);
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS arrived_phone   VARCHAR(50);
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS arrived_at      TIMESTAMPTZ;

-- ── 3. Public tracking ───────────────────────────────────────
--
-- The tracking number is the only thing a customer will have, and they will
-- type it with spaces, lower case, and sometimes a stray dash. Indexing the
-- normalised form means a lookup stays fast however they type it.
CREATE INDEX IF NOT EXISTS idx_cargo_tracking_lookup
    ON cargo_shipments (UPPER(REPLACE(REPLACE(tracking_number, ' ', ''), '-', '')));

-- ── 4. Rebuild the views, unchanged ──────────────────────────
CREATE OR REPLACE VIEW v_receivables AS
SELECT t.business_id, 'ticket' AS source, t.id AS source_id,
       t.passenger_name AS party_name, t.contact_number AS party_contact,
       t.created_at AS issued_at, t.selling_price AS total_amount,
       t.amount_paid AS paid_amount, (t.selling_price - t.amount_paid) AS balance,
       t.payment_status
FROM tickets t
WHERE t.status <> 'cancelled' AND (t.selling_price - t.amount_paid) > 0
UNION ALL
SELECT cs.business_id, 'cargo', cs.id,
       cs.sender_name, cs.sender_contact,
       cs.created_at, cs.total_price,
       cs.amount_paid, (cs.total_price - cs.amount_paid),
       cs.payment_status
FROM cargo_shipments cs
WHERE cs.cargo_status <> 'cancelled' AND (cs.total_price - cs.amount_paid) > 0
UNION ALL
SELECT v.business_id, 'visa', v.id,
       v.applicant_name, v.contact_number,
       v.created_at, v.selling_price,
       v.amount_paid, (v.selling_price - v.amount_paid),
       v.payment_status
FROM visa_applications v
WHERE v.status <> 'cancelled' AND (v.selling_price - v.amount_paid) > 0
UNION ALL
SELECT pk.business_id, 'package', pk.id,
       COALESCE(pk.lead_name, pk.label), pk.contact_number,
       pk.created_at, pk.selling_price,
       pk.amount_paid, (pk.selling_price - pk.amount_paid),
       pk.payment_status
FROM packages pk
WHERE pk.status <> 'cancelled' AND (pk.selling_price - pk.amount_paid) > 0;

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

COMMIT;
