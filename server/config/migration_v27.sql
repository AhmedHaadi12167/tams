-- Associate opening payables with a registered airline when applicable.
-- Generic opening payables and customer receivables remain supported.

BEGIN;

ALTER TABLE opening_balance_items
    ADD COLUMN IF NOT EXISTS airline_id UUID REFERENCES airlines(id) ON DELETE RESTRICT;

ALTER TABLE airline_payments
    ADD COLUMN IF NOT EXISTS opening_item_id UUID REFERENCES opening_balance_items(id) ON DELETE RESTRICT;

ALTER TABLE opening_balance_items
    DROP CONSTRAINT IF EXISTS chk_opening_balance_party;
ALTER TABLE opening_balance_items
    ADD CONSTRAINT chk_opening_balance_party CHECK (
        (balance_type = 'receivable' AND customer_id IS NOT NULL
          AND airline_id IS NULL
          AND service_type IN ('ticket', 'visa', 'cargo', 'package', 'other'))
        OR
        (balance_type = 'payable' AND customer_id IS NULL AND service_type IS NULL)
    );

ALTER TABLE opening_balance_deletion_audit
    ADD COLUMN IF NOT EXISTS airline_id UUID REFERENCES airlines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_opening_balance_airline
    ON opening_balance_items(airline_id)
    WHERE airline_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_airline_payments_opening_item
    ON airline_payments(opening_item_id)
    WHERE opening_item_id IS NOT NULL;

DROP VIEW IF EXISTS v_airline_account;
CREATE VIEW v_airline_account AS
SELECT a.id AS airline_id,
       a.business_id,
       a.name AS airline_name,
       COALESCE(t.ticket_count, 0) AS ticket_count,
       COALESCE(t.total_cost, 0) + COALESCE(o.total_cost, 0) AS total_cost,
       COALESCE(t.total_tax, 0) AS total_tax,
       COALESCE(p.total_paid, 0) AS total_paid,
       COALESCE(t.total_cost, 0) + COALESCE(o.total_cost, 0)
           - COALESCE(p.total_paid, 0) AS balance,
       COALESCE(t.unsettled_tickets, 0) AS unsettled_tickets,
       p.last_payment_at
  FROM airlines a
  LEFT JOIN (
      SELECT airline_id, business_id,
             COUNT(*) FILTER (WHERE status <> 'cancelled') AS ticket_count,
             COALESCE(SUM(CASE WHEN status = 'cancelled'
                 THEN GREATEST(COALESCE(airline_paid, 0), 0)
                 ELSE GREATEST(cost_price - COALESCE(tax, 0), 0)
             END), 0) AS total_cost,
             COALESCE(SUM(GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0)), 0) AS total_tax,
             COUNT(*) FILTER (WHERE status <> 'cancelled'
                 AND GREATEST(cost_price - COALESCE(tax, 0), 0) > airline_paid) AS unsettled_tickets
        FROM tickets
       WHERE airline_id IS NOT NULL
       GROUP BY airline_id, business_id
  ) t ON t.airline_id = a.id AND t.business_id = a.business_id
  LEFT JOIN (
      SELECT airline_id, business_id, COALESCE(SUM(amount), 0) AS total_cost
        FROM opening_balance_items
       WHERE balance_type = 'payable' AND airline_id IS NOT NULL
       GROUP BY airline_id, business_id
  ) o ON o.airline_id = a.id AND o.business_id = a.business_id
  LEFT JOIN (
      SELECT airline_id, business_id,
             COALESCE(SUM(amount), 0) AS total_paid,
             MAX(created_at) AS last_payment_at
        FROM airline_payments
       GROUP BY airline_id, business_id
  ) p ON p.airline_id = a.id AND p.business_id = a.business_id;

COMMIT;
