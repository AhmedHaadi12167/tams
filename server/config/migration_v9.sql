-- ============================================================
-- TAMS v9 Migration — Per-passenger airline settlement
--
-- Until now a payment to an airline reduced the account balance but
-- said nothing about WHICH tickets it covered. Agents want to settle
-- specific passengers, so every payment is now attributed to a ticket
-- and each ticket carries how much of its cost has been paid.
--
-- Both views stay in step: the account balance is still
-- SUM(cost) - SUM(payments), and it now also equals the sum of the
-- individual ticket balances.
--
-- Safe to run multiple times (idempotent). Requires v8.
-- Run with:  psql -U postgres -d tams_db -f config/migration_v9.sql
-- ============================================================

DO $$ BEGIN
    IF to_regclass('public.airline_payments') IS NULL THEN
        RAISE EXCEPTION 'airline_payments is missing. Run migration_v8.sql first.';
    END IF;
END $$;

-- Which ticket this settlement covers. NULL means a legacy account-level
-- payment that predates this migration.
ALTER TABLE airline_payments ADD COLUMN IF NOT EXISTS ticket_id UUID
    REFERENCES tickets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_airline_payments_ticket ON airline_payments(ticket_id);

-- How much of this ticket's airline cost has been settled.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS airline_paid NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ============================================================
-- Backfill: spread existing account-level payments over the tickets
-- they were always implicitly paying for — oldest ticket first.
-- ============================================================
DO $$
DECLARE
    biz        RECORD;
    t          RECORD;
    pool       NUMERIC(12,2);
    take       NUMERIC(12,2);
    updated    INTEGER := 0;
BEGIN
    FOR biz IN
        SELECT p.business_id, p.airline_id,
               COALESCE(SUM(p.amount), 0) AS paid
        FROM airline_payments p
        WHERE p.ticket_id IS NULL
        GROUP BY p.business_id, p.airline_id
    LOOP
        pool := biz.paid;
        FOR t IN
            SELECT id, cost_price, airline_paid
            FROM tickets
            WHERE business_id = biz.business_id
              AND airline_id  = biz.airline_id
              AND status <> 'cancelled'
            ORDER BY created_at
        LOOP
            EXIT WHEN pool <= 0;
            take := LEAST(pool, GREATEST(t.cost_price - t.airline_paid, 0));
            IF take > 0 THEN
                UPDATE tickets SET airline_paid = airline_paid + take WHERE id = t.id;
                pool := pool - take;
                updated := updated + 1;
            END IF;
        END LOOP;
    END LOOP;

    RAISE NOTICE 'Allocated existing airline payments across % ticket(s).', updated;
END $$;

-- ============================================================
-- v_airline_account — unchanged shape, now also exposing how much
-- of the balance is attributable to individual tickets.
-- ============================================================
CREATE OR REPLACE VIEW v_airline_account AS
SELECT
    a.id                                     AS airline_id,
    a.business_id,
    a.name                                   AS airline_name,
    COALESCE(t.ticket_count, 0)              AS ticket_count,
    COALESCE(t.total_cost, 0)                AS total_cost,
    COALESCE(p.total_paid, 0)                AS total_paid,
    COALESCE(t.total_cost, 0) - COALESCE(p.total_paid, 0) AS balance,
    COALESCE(t.unsettled_tickets, 0)         AS unsettled_tickets,
    p.last_payment_at
FROM airlines a
LEFT JOIN (
    SELECT airline_id, business_id,
           COUNT(*)                                          AS ticket_count,
           COALESCE(SUM(cost_price), 0)                      AS total_cost,
           COUNT(*) FILTER (WHERE cost_price > airline_paid)  AS unsettled_tickets
    FROM tickets
    WHERE status <> 'cancelled' AND airline_id IS NOT NULL
    GROUP BY airline_id, business_id
) t ON t.airline_id = a.id AND t.business_id = a.business_id
LEFT JOIN (
    SELECT airline_id, business_id,
           COALESCE(SUM(amount), 0) AS total_paid,
           MAX(created_at)          AS last_payment_at
    FROM airline_payments
    GROUP BY airline_id, business_id
) p ON p.airline_id = a.id AND p.business_id = a.business_id;

DO $$ BEGIN
    RAISE NOTICE 'v9 ready — airline settlements can now be attributed per passenger.';
END $$;
