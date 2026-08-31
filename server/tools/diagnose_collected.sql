-- ============================================================
-- diagnose_collected.sql — why two screens quote different totals
--
-- Run this against production when a "collected" figure looks wrong:
--
--   psql -U tams_user -d tams_db -h localhost -f tools/diagnose_collected.sql
--
-- It compares the ledger (every payment as an event, which is what makes the
-- account balances reconcile) against the amount_paid column on the booking
-- rows, and then shows exactly which records account for any difference.
--
-- Read-only. It changes nothing.
-- ============================================================

\echo ''
\echo '── 1. The ledger, by source ────────────────────────────────'
SELECT b.name AS business,
       l.source,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'), 0)  AS money_in,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS money_out,
       COUNT(*) AS movements
  FROM v_cash_ledger l
  JOIN businesses b ON b.id = l.business_id
 WHERE l.source NOT LIKE 'transfer%'
 GROUP BY 1, 2
 ORDER BY 1, 3 DESC;

\echo ''
\echo '── 2. Ledger total vs what the booking rows claim ──────────'
\echo '   A difference is not automatically wrong. Money taken on a booking'
\echo '   that was later cancelled is still money received, so the ledger'
\echo '   counts it while a query that skips cancelled rows does not.'
WITH ledger AS (
  SELECT business_id,
         SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END) AS net_in
    FROM v_cash_ledger
   WHERE source NOT LIKE 'transfer%'
     AND source IN ('ticket', 'cargo', 'visa', 'package')
   GROUP BY 1
), rows_live AS (
  SELECT b.id AS business_id,
         (SELECT COALESCE(SUM(amount_paid), 0) FROM tickets
           WHERE business_id = b.id AND status <> 'cancelled')
       + (SELECT COALESCE(SUM(amount_paid), 0) FROM cargo_shipments
           WHERE business_id = b.id AND cargo_status <> 'cancelled')
       + COALESCE((SELECT SUM(amount_paid) FROM visa_applications
           WHERE business_id = b.id AND status <> 'cancelled'), 0)
       + COALESCE((SELECT SUM(amount_paid) FROM packages
           WHERE business_id = b.id AND status <> 'cancelled'), 0) AS claimed
    FROM businesses b
)
SELECT b.name AS business,
       ROUND(COALESCE(l.net_in, 0), 2)                   AS ledger_says,
       ROUND(COALESCE(r.claimed, 0), 2)                  AS live_rows_say,
       ROUND(COALESCE(l.net_in, 0) - COALESCE(r.claimed, 0), 2) AS difference
  FROM businesses b
  LEFT JOIN ledger    l ON l.business_id = b.id
  LEFT JOIN rows_live r ON r.business_id = b.id
 ORDER BY 1;

\echo ''
\echo '── 3. Cash received on bookings that were later cancelled ──'
\echo '   This is the usual explanation for the ledger being higher.'
SELECT b.name AS business, l.source, l.party,
       SUM(CASE WHEN l.direction = 'in' THEN l.amount ELSE -l.amount END) AS net_received
  FROM v_cash_ledger l
  JOIN businesses b ON b.id = l.business_id
  LEFT JOIN tickets  t ON t.id = l.source_id AND l.source = 'ticket'
  LEFT JOIN cargo_shipments cs ON cs.id = l.source_id AND l.source = 'cargo'
 WHERE l.source IN ('ticket', 'cargo')
   AND (t.status = 'cancelled' OR cs.cargo_status = 'cancelled')
 GROUP BY 1, 2, 3
HAVING SUM(CASE WHEN l.direction = 'in' THEN l.amount ELSE -l.amount END) <> 0
 ORDER BY 4 DESC;

\echo ''
\echo '── 4. Bookings claiming money with no payment behind it ────'
\echo '   amount_paid was set without a payment record — usually a row'
\echo '   edited directly in the database. The money is claimed on the'
\echo '   booking but never arrived in any account.'
SELECT 'ticket' AS kind, t.passenger_name AS who, t.amount_paid AS claimed,
       COALESCE((SELECT SUM(amount) FROM ticket_payments WHERE ticket_id = t.id), 0) AS recorded
  FROM tickets t
 WHERE t.amount_paid <> COALESCE(
         (SELECT SUM(amount) FROM ticket_payments WHERE ticket_id = t.id), 0)
UNION ALL
SELECT 'cargo', cs.tracking_number, cs.amount_paid,
       COALESCE((SELECT SUM(amount) FROM cargo_payments WHERE cargo_id = cs.id), 0)
  FROM cargo_shipments cs
 WHERE cs.amount_paid <> COALESCE(
         (SELECT SUM(amount) FROM cargo_payments WHERE cargo_id = cs.id), 0)
 ORDER BY 3 DESC;

\echo ''
\echo '── 5. Payments left behind by a deleted booking ────────────'
\echo '   Deleting a ticket cascades its payments away, so these should be'
\echo '   empty. Anything here is money the ledger counts against nothing.'
SELECT 'ticket_payments' AS table_name, COUNT(*) AS orphans
  FROM ticket_payments p LEFT JOIN tickets t ON t.id = p.ticket_id
 WHERE t.id IS NULL
UNION ALL
SELECT 'cargo_payments', COUNT(*)
  FROM cargo_payments p LEFT JOIN cargo_shipments cs ON cs.id = p.cargo_id
 WHERE cs.id IS NULL;

\echo ''
\echo '── 6. Payments with no account, which no balance can include ──'
SELECT b.name AS business, l.source, COUNT(*) AS movements,
       SUM(l.amount) AS amount
  FROM v_cash_ledger l
  JOIN businesses b ON b.id = l.business_id
 WHERE l.account_id IS NULL
 GROUP BY 1, 2
 ORDER BY 4 DESC;
