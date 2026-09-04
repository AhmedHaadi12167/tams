-- ============================================================
-- migration_v14.sql — cancelled tickets and the airline account
--
-- The airline account went negative after a cancellation, and the reason
-- exposed a real hole in the books.
--
-- v_airline_account excluded cancelled tickets from what the agency owes,
-- but still counted every payment made. So a ticket bought for $150 and then
-- cancelled left $150 of payments against $0 of cost — a balance of −$150,
-- reading as though the airline owed the agency money.
--
-- It doesn't. If the airline kept the fare, that $150 is simply gone: a real
-- loss, not a credit. And because the cancelled ticket had also dropped out
-- of cost of sales, the loss had vanished from the profit and loss too —
-- net profit was overstated by exactly the amount lost.
--
-- The fix is to keep cancelled tickets in the account at what they actually
-- ended up costing: the fare less whatever the airline gave back.
--
--   airline refunded in full  -> costs nothing, balance nets to zero
--   airline refunded nothing  -> costs the full fare, balance nets to zero,
--                                and the loss shows in the P&L where it belongs
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- Skipped when migration_v15 has already run. v15 supersedes this view by
-- also holding back the tax, and re-running an older migration must never
-- quietly undo a newer one — that is how a fixed bug comes back.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'v_airline_account' AND column_name = 'total_tax'
  ) THEN
    RAISE NOTICE 'v_airline_account already superseded by migration_v15 — leaving it alone';
    RETURN;
  END IF;

  -- Dropped rather than replaced. CREATE OR REPLACE VIEW insists the new
  -- definition has the same columns, in the same order, with the same names —
  -- so it fails on any database whose view was built by an earlier migration
  -- with a different column list. Dropping first works from any starting
  -- point, which is what a migration has to do.
  DROP VIEW IF EXISTS v_airline_account;

  EXECUTE $view$
CREATE VIEW v_airline_account AS
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
           -- Cancelled tickets are no longer counted as bookings…
           COUNT(*) FILTER (WHERE status <> 'cancelled')      AS ticket_count,
           -- …but what they cost the agency still counts, net of any refund.
           COALESCE(SUM(
               CASE WHEN status = 'cancelled'
                    THEN GREATEST(cost_price - COALESCE(airline_refund, 0), 0)
                    ELSE cost_price
               END), 0)                                        AS total_cost,
           COUNT(*) FILTER (
               WHERE status <> 'cancelled' AND cost_price > airline_paid
           )                                                   AS unsettled_tickets
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
  $view$;
END
$guard$;

COMMIT;
