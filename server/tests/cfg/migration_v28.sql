-- Run with:  psql -U tams_user -d tams_db -f config/migration_v28.sql
BEGIN;

-- ============================================================
-- migration_v28 — money that cannot vanish, and one Cash in Hand
--
--   1. Every business owns exactly one "Cash in Hand" account. Opening cash
--      typed on the business record moves into it, so the balance sheet
--      shows one cash-in-hand figure that is a real, reconcilable balance.
--   2. Visas, packages and cargo remember when and how they were cancelled,
--      so cancelling is an event with a refund, not an edit.
--   3. Payment history can no longer be deleted by deleting the booking,
--      customer or deposit it belongs to (ON DELETE RESTRICT).
--   4. A cancelled ticket's revenue carries the tax the agency still owes
--      but never collected — that shortfall is a real loss.
--   5. Transfer fees become their own ledger movement ("bank_fee") so they
--      show as an expense instead of disappearing inside a transfer.
-- Safe to run more than once.
-- ============================================================

-- ── 1. Cash in Hand ──────────────────────────────────────────
ALTER TABLE payment_accounts
    ADD COLUMN IF NOT EXISTS is_cash_in_hand BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_accounts_cash_in_hand
    ON payment_accounts(business_id) WHERE is_cash_in_hand;

CREATE OR REPLACE FUNCTION ensure_cash_in_hand(p_business_id UUID)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
    acc UUID;
BEGIN
    SELECT id INTO acc FROM payment_accounts
     WHERE business_id = p_business_id AND is_cash_in_hand;
    IF acc IS NOT NULL THEN RETURN acc; END IF;

    -- Reuse the agency's existing cash account rather than adding a second.
    SELECT id INTO acc FROM payment_accounts
     WHERE business_id = p_business_id AND kind = 'cash'
     ORDER BY is_active DESC, sort_order, created_at
     LIMIT 1;

    IF acc IS NOT NULL THEN
        UPDATE payment_accounts
           SET is_cash_in_hand = TRUE,
               is_active = TRUE,
               name = CASE WHEN EXISTS (
                           SELECT 1 FROM payment_accounts o
                            WHERE o.business_id = p_business_id
                              AND o.name = 'Cash in Hand' AND o.id <> acc)
                      THEN name ELSE 'Cash in Hand' END,
               updated_at = NOW()
         WHERE id = acc;
    ELSE
        INSERT INTO payment_accounts
            (business_id, name, kind, sort_order, is_cash_in_hand, notes)
        VALUES (p_business_id,
                CASE WHEN EXISTS (SELECT 1 FROM payment_accounts
                                   WHERE business_id = p_business_id
                                     AND name = 'Cash in Hand')
                     THEN 'Cash in Hand (office)' ELSE 'Cash in Hand' END,
                'cash',
                COALESCE((SELECT MIN(sort_order) - 10 FROM payment_accounts
                           WHERE business_id = p_business_id), 0),
                TRUE,
                'Created automatically. Opening cash is stored here.')
        RETURNING id INTO acc;
    END IF;
    RETURN acc;
END
$$;

-- Every business that exists today: designate the account, then move the
-- old business-level opening cash into it so it is counted exactly once.
DO $cih$
DECLARE
    b RECORD;
    acc UUID;
    extra INTEGER;
BEGIN
    FOR b IN SELECT id, COALESCE(opening_cash, 0) AS opening_cash FROM businesses LOOP
        acc := ensure_cash_in_hand(b.id);
        IF b.opening_cash > 0 THEN
            UPDATE payment_accounts
               SET opening_balance = opening_balance + b.opening_cash,
                   updated_at = NOW()
             WHERE id = acc;
            UPDATE businesses SET opening_cash = 0 WHERE id = b.id;
        END IF;
    END LOOP;

    SELECT COUNT(*) INTO extra FROM payment_accounts
     WHERE kind = 'cash' AND NOT is_cash_in_hand;
    IF extra > 0 THEN
        RAISE NOTICE '% other cash-type account(s) exist. They keep their history; consider transferring their balance into Cash in Hand and marking them inactive.', extra;
    END IF;
END
$cih$;

CREATE OR REPLACE FUNCTION trg_cash_in_hand_for_new_business()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM ensure_cash_in_hand(NEW.id);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cash_in_hand_on_new_business ON businesses;
CREATE TRIGGER cash_in_hand_on_new_business
    AFTER INSERT ON businesses
    FOR EACH ROW EXECUTE FUNCTION trg_cash_in_hand_for_new_business();

-- ── 2. Cancellation is an event ──────────────────────────────
ALTER TABLE visa_applications ADD COLUMN IF NOT EXISTS cancelled_at    TIMESTAMPTZ;
ALTER TABLE visa_applications ADD COLUMN IF NOT EXISTS cancelled_by    UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE visa_applications ADD COLUMN IF NOT EXISTS cancel_reason   TEXT;
ALTER TABLE visa_applications ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE packages ADD COLUMN IF NOT EXISTS cancelled_at    TIMESTAMPTZ;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS cancelled_by    UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS cancel_reason   TEXT;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

UPDATE visa_applications SET cancelled_at = COALESCE(updated_at, created_at)
 WHERE status = 'cancelled' AND cancelled_at IS NULL;
UPDATE packages SET cancelled_at = COALESCE(updated_at, created_at)
 WHERE status = 'cancelled' AND cancelled_at IS NULL;
UPDATE cargo_shipments SET cancelled_at = COALESCE(updated_at, created_at)
 WHERE cargo_status = 'cancelled' AND cancelled_at IS NULL;
UPDATE tickets SET cancelled_at = COALESCE(updated_at, created_at)
 WHERE status = 'cancelled' AND cancelled_at IS NULL;

-- ── 3. Payment history cannot be deleted from under the accounts ─
DO $fk$
DECLARE
    r RECORD;
    c RECORD;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('ticket_payments',      'ticket_id',  'tickets'),
        ('visa_payments',        'visa_id',    'visa_applications'),
        ('package_payments',     'package_id', 'packages'),
        ('cargo_payments',       'cargo_id',   'cargo_shipments'),
        ('supplier_payments',    'visa_id',    'visa_applications'),
        ('supplier_payments',    'package_id', 'packages'),
        ('supplier_payments',    'cargo_id',   'cargo_shipments'),
        ('deposit_applications', 'ticket_id',  'tickets'),
        ('deposit_applications', 'visa_id',    'visa_applications'),
        ('deposit_applications', 'package_id', 'packages'),
        ('deposit_applications', 'cargo_id',   'cargo_shipments'),
        ('deposit_applications', 'customer_id','customers'),
        ('customer_deposits',    'customer_id','customers')
    ) AS v(tbl, col, ref)
    LOOP
        IF to_regclass(r.tbl) IS NULL THEN CONTINUE; END IF;
        FOR c IN
            SELECT con.conname
              FROM pg_constraint con
              JOIN pg_attribute a
                ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
             WHERE con.contype = 'f'
               AND con.conrelid = r.tbl::regclass
               AND array_length(con.conkey, 1) = 1
               AND a.attname = r.col
        LOOP
            EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, c.conname);
        END LOOP;
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE RESTRICT',
            r.tbl, 'fk_' || r.tbl || '_' || r.col || '_restrict', r.col, r.ref);
    END LOOP;
END
$fk$;

-- ── 4. Cancelled-ticket revenue includes the uncollected tax ─
--
-- revenue = what the customer's payments net to
--         - tax still owed to the government
--         - fare paid to the airline and not returned
-- When the customer paid at least the tax this equals the old
-- "fee kept - airline loss". When they paid less, the agency must still
-- pay the tax out of its own pocket and the ticket shows that loss.
DROP VIEW IF EXISTS v_group_booking_statement;
DROP VIEW IF EXISTS v_monthly_income;

ALTER TABLE tickets DROP COLUMN IF EXISTS revenue;
ALTER TABLE tickets ADD COLUMN revenue NUMERIC(12,2)
    GENERATED ALWAYS AS (
        CASE
            WHEN status = 'cancelled'
            THEN COALESCE(amount_paid, 0)
                 - GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0)
                 - GREATEST(COALESCE(airline_paid, 0), 0)
            ELSE selling_price - cost_price - COALESCE(agent_commission, 0)
        END
    ) STORED;

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

-- ── 5. Transfer fees are their own movement ─────────────────
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

SELECT p.business_id, p.account_id, p.id, 'in', p.amount, p.created_at,
             'opening_receivable', p.opening_item_id,
             COALESCE(c.name, 'Customer'), oi.reason, p.note, p.collected_by, p.method
    FROM opening_balance_payments p
    JOIN opening_balance_items oi ON oi.id = p.opening_item_id
    JOIN customers c ON c.id = oi.customer_id

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
       'out', t.amount, t.transferred_at,
       'transfer_out', t.to_account_id,
       'Transfer out', t.reference, t.note, t.created_by, NULL
  FROM account_transfers t

UNION ALL

-- The fee on a transfer is money the agency no longer has: a bank charge,
-- not a move between pockets. Its own row, so every report that skips
-- transfers still sees it as an outflow and the income statement can
-- count it as an expense.
SELECT t.business_id, t.from_account_id, t.id,
       'out', t.fee, t.transferred_at,
       'bank_fee', t.to_account_id,
       'Transfer fee', t.reference, t.note, t.created_by, NULL
  FROM account_transfers t
 WHERE COALESCE(t.fee, 0) > 0

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


COMMIT;
