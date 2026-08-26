-- ============================================================
-- migration_v17.sql — the tax is not refundable, and a cancelled
--                     ticket tells the truth about what it earned
--
-- Four rules from the agency, all of which touch the same numbers:
--
--   1. Tax is not refundable. A cancelled journey does not cancel the
--      government's claim. Until now the tax accrual dropped cancelled
--      tickets, which quietly forgave a debt the agency still owes.
--
--   2. A ticket can be both partly refunded and have its remaining
--      balance written off. Both figures have to be visible; showing one
--      and hiding the other is how a refund gets paid twice.
--
--   3. Refund everything and the ticket earned nothing. The revenue
--      column has to say so, rather than keep displaying the margin from
--      a sale that no longer exists.
--
--   4. Keep a fee and the ticket earned that fee. It was already in the
--      income statement; it belongs in the revenue column too, or the
--      two screens disagree and neither can be trusted.
--
-- Rules 3 and 4 are one change: `revenue` stops being a formula about the
-- sale and becomes a formula about the outcome. For a ticket that stands,
-- the outcome is the sale, so nothing changes. For a cancelled one it is
-- the fee kept less the fare the airline didn't give back — which is
-- exactly what the income statement already reports in aggregate, so the
-- per-ticket figures now sum to the total on the Financials page.
--
-- Note the cancelled branch works in gross cost, tax included, for the
-- same reason cost of sales does on a live ticket: the tax is money that
-- leaves the agency. Counting it here and in v_tax_account is not double
-- counting — one is the cost, the other is the liability.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ── 1. Tax handed back ───────────────────────────────────────
--
-- Almost always zero. It is not zero when the airline cancels the flight
-- and returns the tax with the fare, at which point the agency passes it
-- to the customer and owes the government nothing. Without somewhere to
-- record that, rule 1 would have the tax section chasing money that has
-- already gone back where it came from.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tax_refunded NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ── 2. Revenue follows the outcome, not the sale ─────────────
--
-- A stored generated column cannot be altered in place, so the column is
-- dropped and rebuilt. Everything it holds is derived, so nothing is
-- lost — Postgres recomputes every row. The two views that read it have
-- to go first and come back after; a view is what makes DROP COLUMN
-- refuse.
-- Sections 2 and 4 are skipped once v18 has run. v18 supersedes both by
-- charging a cancelled ticket only the fare that was actually paid, and
-- re-running an older migration must never quietly undo a newer one — that
-- is how a fixed bug comes back.
DO $v17$
BEGIN
IF EXISTS (
    SELECT 1 FROM pg_attrdef ad
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE ad.adrelid = 'tickets'::regclass AND a.attname = 'revenue'
       AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%airline_paid%')
THEN RETURN; END IF;

EXECUTE $sql$
DROP VIEW IF EXISTS v_group_booking_statement;
DROP VIEW IF EXISTS v_monthly_income;

ALTER TABLE tickets DROP COLUMN IF EXISTS revenue;
ALTER TABLE tickets ADD COLUMN revenue NUMERIC(12,2)
    GENERATED ALWAYS AS (
        CASE
            WHEN status = 'cancelled'
            THEN COALESCE(cancellation_fee, 0)
                 - GREATEST(cost_price - COALESCE(airline_refund, 0), 0)
            ELSE selling_price - cost_price - COALESCE(agent_commission, 0)
        END
    ) STORED;

-- Rebuilt unchanged, on top of the new column.
CREATE VIEW v_group_booking_statement AS
SELECT
    bg.id  AS group_id,
    bg.business_id,
    bg.customer_id,
    bg.group_type,
    bg.group_label,
    bg.from_city,
    bg.to_city,
    bg.flight_date,
    bg.airline_name,
    bg.notes,
    bg.created_at,
    COALESCE(c.company_name, c.name) AS customer_display_name,
    c.phone AS customer_phone,
    u.name  AS created_by_name,
    COUNT(t.id)                                          AS ticket_count,
    COALESCE(SUM(t.cost_price), 0)                       AS total_cost_price,
    COALESCE(SUM(t.selling_price), 0)                    AS total_selling_price,
    COALESCE(SUM(t.revenue), 0)                          AS total_revenue,
    COALESCE(SUM(t.amount_paid), 0)                      AS total_paid,
    COALESCE(SUM(t.selling_price - t.amount_paid), 0)    AS total_balance,
    COALESCE(
        json_agg(
            json_build_object(
                'ticket_id',       t.id,
                'passenger_name',  t.passenger_name,
                'contact_number',  t.contact_number,
                'from_city',       t.from_city,
                'to_city',         t.to_city,
                'flight_date',     t.flight_date,
                'return_date',     t.return_date,
                'trip_type',       t.trip_type,
                'airline_name',    t.airline_name,
                'ticket_reference',t.ticket_reference,
                'ticket_type',     t.ticket_type,
                'cost_price',      t.cost_price,
                'selling_price',   t.selling_price,
                'agent_commission',t.agent_commission,
                'revenue',         t.revenue,
                'amount_paid',     t.amount_paid,
                'balance',         (t.selling_price - t.amount_paid),
                'payment_status',  t.payment_status,
                'status',          t.status,
                'booked_date',     t.created_at
            ) ORDER BY t.created_at
        ) FILTER (WHERE t.id IS NOT NULL),
        '[]'::json
    ) AS passengers
FROM booking_groups bg
JOIN customers c ON c.id = bg.customer_id
JOIN users u     ON u.id = bg.created_by
LEFT JOIN tickets t ON t.booking_group_id = bg.id
GROUP BY bg.id, c.id, u.id;

-- Rebuilt unchanged. This is a sales trend, so it still counts only
-- tickets that stand; a cancellation is not a sale and does not belong on
-- a sales line. What it earned or lost is in the income statement.
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
        0                                                              AS direct_cost,
        0                                                              AS commission,
        COALESCE(SUM(cs.total_price), 0)                               AS gross_profit
    FROM cargo_shipments cs
    WHERE cs.cargo_status <> 'cancelled'
    GROUP BY 1, 2
) combined
GROUP BY business_id, month;

$sql$;
END
$v17$;

-- ── 3. The government is still owed ──────────────────────────
--
-- Every ticket accrues its tax, cancelled or not, less anything actually
-- handed back. The old view filtered cancellations out, so cancelling a
-- ticket made a tax debt disappear from the screen while the money stayed
-- in the agency's account — the books balanced by forgetting.
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
           COALESCE(SUM(GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0)), 0)
                                                        AS tax_accrued,
           COUNT(*) FILTER (
               WHERE GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0) > 0
           )                                            AS taxed_tickets
    FROM tickets
    GROUP BY business_id
) t ON t.business_id = b.id
LEFT JOIN (
    SELECT business_id,
           COALESCE(SUM(amount), 0) AS tax_paid,
           MAX(paid_at)             AS last_payment_at
    FROM tax_payments
    GROUP BY business_id
) p ON p.business_id = b.id;

DO $v17b$
BEGIN
IF EXISTS (
    SELECT 1 FROM pg_attrdef ad
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE ad.adrelid = 'tickets'::regclass AND a.attname = 'revenue'
       AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%airline_paid%')
THEN RETURN; END IF;

EXECUTE $sql$
-- ── 4. The airline page agrees with it ───────────────────────
--
-- Only total_tax changes: it now reports the tax still owed on every
-- ticket including cancelled ones, so the figure beside the airline
-- balance matches the Tax section instead of contradicting it. The
-- airline's own share is untouched.
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
           COALESCE(SUM(
               GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0)
           ), 0)                                           AS total_tax,
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
END
$v17b$;

COMMIT;
