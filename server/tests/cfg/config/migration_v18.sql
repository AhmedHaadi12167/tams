-- ============================================================
-- migration_v18.sql — a cancelled ticket only costs what was paid
--
-- Two faults, both of which made a cancellation look like a disaster.
--
-- FAULT 1 — the airline fare was treated as lost even when it had never
-- been handed over. v17 computed the loss as the ticket's cost less
-- whatever the airline gave back, so a ticket cancelled before the agency
-- had paid the airline anything showed the entire fare as unrecovered.
-- The airline cannot refund money it was never sent. Cancel a $160 ticket
-- you hadn't paid for, refund the customer their $60 and forgive the rest,
-- and the screen read -$160 when the true figure was $0.
--
-- The loss on the airline side is what actually left and did not come
-- back: airline_paid, which the cancellation has already reduced by any
-- refund received. Nothing paid, nothing lost.
--
-- The same correction applies to v_airline_account. A cancelled ticket now
-- contributes exactly what was paid on it, which is also exactly what the
-- payments total, so its balance is zero. A cancelled booking leaves the
-- agency square with the airline instead of hanging there as a debt or a
-- phantom credit.
--
-- FAULT 2 — retained tax was being counted as a cancellation fee. The
-- refund is capped at what the customer paid less the government's tax, so
-- the tax stays in the agency's hands by construction. It was landing in
-- cancellation_fee, where the income statement read it as money earned. It
-- is not earned; it is owed. cancellation_fee now means the fee and only
-- the fee, and the tax is left to the Tax section, which is already
-- counting it.
--
-- Both figures are recomputed from amount_paid rather than adjusted, so
-- running this twice changes nothing the second time.
-- ============================================================

BEGIN;

-- ── 1. Take the tax back out of every cancellation fee ───────
--
-- amount_paid on a cancelled ticket is what the customer's payments net to
-- after the refund — the money actually kept. The fee is that, less the
-- tax being held for the government. Deriving it from amount_paid instead
-- of subtracting from the existing fee is what makes this safe to re-run.
UPDATE tickets
   SET cancellation_fee = GREATEST(
           COALESCE(amount_paid, 0)
           - GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0), 0)
 WHERE status = 'cancelled';

-- ── 2. Revenue counts the fare that was actually paid ────────
DROP VIEW IF EXISTS v_group_booking_statement;
DROP VIEW IF EXISTS v_monthly_income;

ALTER TABLE tickets DROP COLUMN IF EXISTS revenue;
ALTER TABLE tickets ADD COLUMN revenue NUMERIC(12,2)
    GENERATED ALWAYS AS (
        CASE
            WHEN status = 'cancelled'
            -- The fee kept, less the fare paid out and not returned.
            -- cancellation_fee already excludes the tax, so the tax is not
            -- subtracted again here.
            THEN COALESCE(cancellation_fee, 0)
                 - GREATEST(COALESCE(airline_paid, 0), 0)
            ELSE selling_price - cost_price - COALESCE(agent_commission, 0)
        END
    ) STORED;

-- Rebuilt unchanged.
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

-- Rebuilt unchanged.
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

-- ── 3. The airline is owed nothing on a cancelled ticket ─────
--
-- What was paid stays paid; what was never paid is not owed. Since the
-- cost contributed equals the payments made, a cancelled ticket nets to
-- zero on the airline's balance instead of sitting there as a debt for a
-- seat nobody took.
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
           -- Live tickets: the fare, less the tax that belongs to the
           -- government. Cancelled tickets: whatever was actually paid and
           -- not returned, which is what airline_paid now holds.
           COALESCE(SUM(
               CASE WHEN status = 'cancelled'
                    THEN GREATEST(COALESCE(airline_paid, 0), 0)
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

COMMIT;
