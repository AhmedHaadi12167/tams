-- Run with:  sudo -u postgres psql -d tams_db -v ON_ERROR_STOP=1 -f config/migration_v29.sql
BEGIN;

-- ============================================================
-- migration_v29 — owners, and a journal for every cent
--
--   1. business_owners: who owns the agency, their opening capital, their
--      ownership % and their profit-share %.
--   2. owner_transactions: money an owner puts in (capital) or takes out
--      (drawings), always through a real payment account.
--   3. The cash ledger and the overdraft guard include owners' money.
--   4. journal_accounts + v_journal: every booking, payment, refund,
--      cancellation, expense, transfer, deposit, opening balance and owner
--      movement expressed as balanced double-entry lines, generated from
--      the records themselves — nobody types a journal entry, so it cannot
--      drift from the bookings.
-- Safe to run more than once.
-- ============================================================

-- ── 1. Owners ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_owners (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name              VARCHAR(150) NOT NULL,
    phone             VARCHAR(40),
    email             VARCHAR(150),
    -- Capital the owner already had in the business before TAMS. No cash
    -- moves for it; it is part of the opening position.
    opening_capital   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (opening_capital >= 0),
    ownership_pct     NUMERIC(6,3)  NOT NULL DEFAULT 0 CHECK (ownership_pct BETWEEN 0 AND 100),
    profit_share_pct  NUMERIC(6,3)  NOT NULL DEFAULT 0 CHECK (profit_share_pct BETWEEN 0 AND 100),
    joined_on         DATE,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    notes             TEXT,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_business_owner_name UNIQUE (business_id, name)
);
CREATE INDEX IF NOT EXISTS idx_business_owners_business ON business_owners(business_id);

-- amount is signed: positive = capital put in, negative = drawings taken out.
-- The kind is stored as well so a report never has to guess from the sign,
-- and the constraint keeps the two from disagreeing.
CREATE TABLE IF NOT EXISTS owner_transactions (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    owner_id     UUID NOT NULL REFERENCES business_owners(id) ON DELETE RESTRICT,
    kind         VARCHAR(20) NOT NULL,
    amount       NUMERIC(14,2) NOT NULL,
    account_id   UUID NOT NULL REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reference    VARCHAR(100),
    note         TEXT,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_owner_tx_kind CHECK (
        (kind = 'contribution' AND amount > 0) OR
        (kind = 'withdrawal'   AND amount < 0)
    )
);
CREATE INDEX IF NOT EXISTS idx_owner_tx_owner ON owner_transactions(owner_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_tx_business ON owner_transactions(business_id, occurred_at DESC);

-- ── 2. The overdraft guard knows about owners' money ──────────
CREATE OR REPLACE FUNCTION prevent_account_overdraft()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    target_account_id UUID;
    target_business_id UUID;
    old_account_id UUID;
    current_balance NUMERIC(14,2);
    new_impact NUMERIC(14,2) := 0;
    old_impact NUMERIC(14,2) := 0;
    movement_amount NUMERIC(14,2);
    old_amount NUMERIC(14,2);
    movement_fee NUMERIC(14,2);
    old_fee NUMERIC(14,2);
BEGIN
    IF TG_TABLE_NAME = 'payment_accounts' THEN
        target_account_id := OLD.id;
        target_business_id := OLD.business_id;
        new_impact := NEW.opening_balance - OLD.opening_balance;
    ELSIF TG_TABLE_NAME = 'account_transfers' THEN
        target_account_id := NEW.from_account_id;
        target_business_id := NEW.business_id;
        movement_amount := NEW.amount;
        movement_fee := COALESCE(NEW.fee, 0);
        new_impact := -(movement_amount + movement_fee);
        IF TG_OP = 'UPDATE' THEN
            old_account_id := OLD.from_account_id;
            old_amount := OLD.amount;
            old_fee := COALESCE(OLD.fee, 0);
            IF old_account_id = target_account_id THEN
                old_impact := -(old_amount + old_fee);
            END IF;
        END IF;
    ELSE
        target_account_id := NULLIF(to_jsonb(NEW)->>'account_id', '')::UUID;
        target_business_id := (to_jsonb(NEW)->>'business_id')::UUID;
        movement_amount := COALESCE((to_jsonb(NEW)->>'amount')::NUMERIC, 0);

        IF TG_TABLE_NAME IN ('ticket_payments', 'visa_payments',
                             'package_payments', 'cargo_payments',
                             'customer_deposits', 'owner_transactions') THEN
            new_impact := movement_amount;
        ELSIF TG_TABLE_NAME IN ('airline_payments', 'agent_payments',
                                'supplier_payments') THEN
            new_impact := -movement_amount;
        ELSE
            new_impact := -ABS(movement_amount);
        END IF;

        IF TG_OP = 'UPDATE' THEN
            old_account_id := NULLIF(to_jsonb(OLD)->>'account_id', '')::UUID;
            old_amount := COALESCE((to_jsonb(OLD)->>'amount')::NUMERIC, 0);
            IF old_account_id = target_account_id THEN
                IF TG_TABLE_NAME IN ('ticket_payments', 'visa_payments',
                                     'package_payments', 'cargo_payments',
                                     'customer_deposits', 'owner_transactions') THEN
                    old_impact := old_amount;
                ELSIF TG_TABLE_NAME IN ('airline_payments', 'agent_payments',
                                        'supplier_payments') THEN
                    old_impact := -old_amount;
                ELSE
                    old_impact := -ABS(old_amount);
                END IF;
            END IF;
        END IF;
    END IF;

    IF target_account_id IS NULL OR new_impact - old_impact >= 0 THEN
        RETURN NEW;
    END IF;

    PERFORM 1 FROM payment_accounts
         WHERE id = target_account_id
             AND payment_accounts.business_id = target_business_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT balance INTO current_balance
      FROM v_account_balance
    WHERE v_account_balance.account_id = target_account_id;

    IF COALESCE(current_balance, 0) + new_impact - old_impact < 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'chk_account_balance_nonnegative',
            MESSAGE = 'Insufficient account balance';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_account_overdraft_on_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    target_account_id UUID;
    target_business_id UUID;
    current_balance NUMERIC(14,2);
    movement_amount NUMERIC(14,2);
    balance_change NUMERIC(14,2);
BEGIN
    target_business_id := (to_jsonb(OLD)->>'business_id')::UUID;
    IF TG_TABLE_NAME = 'account_transfers' THEN
        target_account_id := OLD.to_account_id;
        balance_change := -OLD.amount;
    ELSE
        target_account_id := NULLIF(to_jsonb(OLD)->>'account_id', '')::UUID;
        movement_amount := COALESCE((to_jsonb(OLD)->>'amount')::NUMERIC, 0);
        IF TG_TABLE_NAME IN ('ticket_payments', 'visa_payments',
                             'package_payments', 'cargo_payments',
                             'customer_deposits', 'opening_balance_payments',
                             'owner_transactions') THEN
            balance_change := -movement_amount;
        ELSIF TG_TABLE_NAME IN ('airline_payments', 'agent_payments',
                                'supplier_payments') THEN
            balance_change := movement_amount;
        ELSIF TG_TABLE_NAME = 'expenses' THEN
            balance_change := movement_amount;
        ELSE
            balance_change := ABS(movement_amount);
        END IF;
    END IF;

    IF target_account_id IS NULL OR balance_change >= 0 THEN
        RETURN OLD;
    END IF;

    PERFORM 1 FROM payment_accounts
     WHERE id = target_account_id
       AND payment_accounts.business_id = target_business_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN OLD;
    END IF;

    SELECT balance INTO current_balance
      FROM v_account_balance
     WHERE v_account_balance.account_id = target_account_id;
    IF COALESCE(current_balance, 0) + balance_change < 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'chk_account_balance_nonnegative',
            MESSAGE = 'Insufficient account balance';
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_owner_transactions_overdraft_guard ON owner_transactions;
CREATE TRIGGER trg_owner_transactions_overdraft_guard
    BEFORE INSERT OR UPDATE ON owner_transactions
    FOR EACH ROW EXECUTE FUNCTION prevent_account_overdraft();
DROP TRIGGER IF EXISTS trg_owner_transactions_delete_overdraft_guard ON owner_transactions;
CREATE TRIGGER trg_owner_transactions_delete_overdraft_guard
    BEFORE DELETE ON owner_transactions
    FOR EACH ROW EXECUTE FUNCTION prevent_account_overdraft_on_delete();

-- ── 3. The cash ledger sees owners' money ────────────────────
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

-- Owners putting money in (capital) or taking it out (drawings).
SELECT o.business_id, o.account_id, o.id,
       CASE WHEN o.amount >= 0 THEN 'in' ELSE 'out' END,
       ABS(o.amount), o.occurred_at,
       CASE WHEN o.amount >= 0 THEN 'owner_contribution' ELSE 'owner_withdrawal' END,
       o.owner_id,
       COALESCE(ow.name, 'Owner'),
       o.reference, o.note, o.created_by, NULL
  FROM owner_transactions o
  LEFT JOIN business_owners ow ON ow.id = o.owner_id

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



-- ── 4. The chart of accounts the journal posts to ────────────
CREATE TABLE IF NOT EXISTS journal_accounts (
    code        VARCHAR(10) PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    type        VARCHAR(20)  NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
    description TEXT
);
INSERT INTO journal_accounts (code, name, type, description) VALUES
 ('1000','Cash & bank','asset','Every payment account, including Cash in Hand'),
 ('1100','Accounts receivable','asset','What customers owe, per customer'),
 ('1200','Fixed assets','asset','Furniture, computers and equipment'),
 ('2000','Payable to airlines','liability','Fares owed to airlines, per airline (debit = airline credit)'),
 ('2050','Other opening payables','liability','Payables brought forward with no airline named'),
 ('2100','Payable to suppliers','liability','Embassies, tour operators and cargo carriers'),
 ('2200','Customer deposits','liability','Money held for customers against nothing yet'),
 ('2300','Tax payable','liability','Ticket tax owed to the government'),
 ('2400','Agent commission payable','liability','Commission earned by agents, not yet paid'),
 ('2500','Other liabilities','liability','Loans and bills entered as opening liabilities'),
 ('3000','Owner capital','equity','Capital put in by each owner'),
 ('3100','Owner drawings','equity','Money taken out by each owner'),
 ('3200','Opening balance equity','equity','The other side of everything brought forward from before TAMS'),
 ('4000','Ticket sales','income',NULL),
 ('4100','Visa sales','income',NULL),
 ('4200','Package sales','income',NULL),
 ('4300','Cargo sales','income',NULL),
 ('4900','Cancellation income','income','What customers paid on bookings later cancelled, net of refunds'),
 ('5000','Airline fares','expense','Cost of tickets, excluding tax'),
 ('5010','Ticket tax','expense','Government tax on tickets (passed through to the customer)'),
 ('5100','Visa costs','expense',NULL),
 ('5200','Package costs','expense',NULL),
 ('5300','Cargo carrier costs','expense',NULL),
 ('5900','Cancellation losses','expense','Money paid to airlines or suppliers and not returned'),
 ('6000','Agent commission','expense',NULL),
 ('6100','Operating expenses','expense','Rent, salaries, utilities — by category'),
 ('6900','Bank & transfer fees','expense',NULL)
ON CONFLICT (code) DO UPDATE
   SET name = EXCLUDED.name, type = EXCLUDED.type, description = EXCLUDED.description;

-- ── 5. The journal ───────────────────────────────────────────
--
-- amount is signed: positive = debit, negative = credit. Every event below
-- emits lines that sum to zero, so the whole journal — and any slice of it
-- by business or date — always balances.
DROP VIEW IF EXISTS v_journal;
CREATE VIEW v_journal AS
-- Ticket booked: the customer owes the price; the airline is owed the
-- fare; the government is owed the tax; the agent is owed commission.
SELECT t.business_id AS business_id, t.created_at AS entry_at, 'ticket_sale'::TEXT AS source, t.id AS source_id, 'Ticket — ' || COALESCE(t.passenger_name, '') || ' (' || COALESCE(t.from_city, '') || '→' || COALESCE(t.to_city, '') || ')' AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM tickets t
CROSS JOIN LATERAL (VALUES
  ('1100'::TEXT, NULL::TEXT, 'customer'::TEXT, COALESCE(t.booked_by_customer_id, t.customer_id)::UUID, (t.selling_price)::NUMERIC),
  ('4000', NULL, NULL, NULL, (-t.selling_price)),
  ('5000', NULL, NULL, NULL, (GREATEST(t.cost_price - COALESCE(t.tax, 0), 0))),
  ('2000', NULL, 'airline', t.airline_id, (-GREATEST(t.cost_price - COALESCE(t.tax, 0), 0))),
  ('5010', NULL, NULL, NULL, (COALESCE(t.tax, 0))),
  ('2300', NULL, NULL, NULL, (-COALESCE(t.tax, 0))),
  ('6000', NULL, NULL, NULL, (COALESCE(t.agent_commission, 0))),
  ('2400', NULL, 'agent', t.agent_id, (-COALESCE(t.agent_commission, 0)))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Ticket cancelled: the sale, fare and commission are reversed. Tax the
-- airline returned stops being owed. What the customer's payments net to
-- becomes cancellation income; fare paid and not returned becomes a
-- cancellation loss. Tax still owed stays as the ticket's cost.
SELECT t.business_id AS business_id, t.cancel_at AS entry_at, 'ticket_cancel'::TEXT AS source, t.id AS source_id, 'Ticket cancelled — ' || COALESCE(t.passenger_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM (
    SELECT t.*, COALESCE(t.cancelled_at, t.created_at) AS cancel_at,
           (SELECT COALESCE(SUM(p.amount), 0) FROM ticket_payments p
             WHERE p.ticket_id = t.id AND p.created_at <= COALESCE(t.cancelled_at, t.created_at)) AS kept,
           (SELECT COALESCE(SUM(a.amount), 0) FROM airline_payments a
             WHERE a.ticket_id = t.id AND a.created_at <= COALESCE(t.cancelled_at, t.created_at)) AS airline_kept
      FROM tickets t WHERE t.status = 'cancelled'
  ) t
CROSS JOIN LATERAL (VALUES
  ('1100'::TEXT, NULL::TEXT, 'customer'::TEXT, COALESCE(t.booked_by_customer_id, t.customer_id)::UUID, (-t.selling_price)::NUMERIC),
  ('4000', NULL, NULL, NULL, (t.selling_price)),
  ('5000', NULL, NULL, NULL, (-GREATEST(t.cost_price - COALESCE(t.tax, 0), 0))),
  ('2000', NULL, 'airline', t.airline_id, (GREATEST(t.cost_price - COALESCE(t.tax, 0), 0))),
  ('6000', NULL, NULL, NULL, (-COALESCE(t.agent_commission, 0))),
  ('2400', NULL, 'agent', t.agent_id, (COALESCE(t.agent_commission, 0))),
  ('2300', NULL, NULL, NULL, (LEAST(COALESCE(t.tax_refunded, 0), COALESCE(t.tax, 0)))),
  ('5010', NULL, NULL, NULL, (-LEAST(COALESCE(t.tax_refunded, 0), COALESCE(t.tax, 0)))),
  ('1100', NULL, 'customer', COALESCE(t.booked_by_customer_id, t.customer_id), (t.kept)),
  ('4900', NULL, NULL, NULL, (-t.kept)),
  ('5900', NULL, NULL, NULL, (t.airline_kept)),
  ('2000', NULL, 'airline', t.airline_id, (-t.airline_kept))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Money from (or refunded to) the customer on a ticket. Paid from a
-- deposit: no cash moves, the deposit liability goes down instead.
SELECT p.business_id AS business_id, p.created_at AS entry_at, 'ticket_payment'::TEXT AS source, p.id AS source_id, 'Payment — ' || COALESCE(t.passenger_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM ticket_payments p
  JOIN tickets t ON t.id = p.ticket_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN COALESCE(p.from_deposit, FALSE) THEN '2200' ELSE '1000' END::TEXT, NULL::TEXT, CASE WHEN COALESCE(p.from_deposit, FALSE) THEN 'customer' ELSE 'account' END::TEXT, CASE WHEN COALESCE(p.from_deposit, FALSE) THEN COALESCE(t.booked_by_customer_id, t.customer_id) ELSE p.account_id END::UUID, (p.amount)::NUMERIC),
  (CASE WHEN (t.status::TEXT = 'cancelled' AND p.created_at > COALESCE(t.cancelled_at, t.created_at)) THEN '4900' ELSE '1100' END, NULL, 'customer', COALESCE(t.booked_by_customer_id, t.customer_id), (-p.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Visa sold: the customer owes the price, the supplier is owed the cost.
SELECT v.business_id AS business_id, v.created_at AS entry_at, 'visa_sale'::TEXT AS source, v.id AS source_id, 'Visa — ' || COALESCE(v.applicant_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM visa_applications v
CROSS JOIN LATERAL (VALUES
  ('1100'::TEXT, NULL::TEXT, 'customer'::TEXT, v.customer_id::UUID, (v.selling_price)::NUMERIC),
  ('4100', NULL, NULL, NULL, (-v.selling_price)),
  ('5100', NULL, NULL, NULL, (COALESCE(v.cost_price, 0))),
  ('2100', NULL, 'visa', v.id, (-(COALESCE(v.cost_price, 0))))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Visa cancelled: sale and cost reversed; what the customer's
-- payments net to is cancellation income; supplier money not returned is a loss.
SELECT v.business_id AS business_id, v.cancel_at AS entry_at, 'visa_cancel'::TEXT AS source, v.id AS source_id, 'Cancelled — ' || 'Visa — ' || COALESCE(v.applicant_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM (
    SELECT v.*, COALESCE(v.cancelled_at, v.created_at) AS cancel_at,
           (SELECT COALESCE(SUM(p.amount), 0) FROM visa_payments p
             WHERE p.visa_id = v.id AND p.created_at <= COALESCE(v.cancelled_at, v.created_at)) AS kept,
           (SELECT COALESCE(SUM(s.amount), 0) FROM supplier_payments s
             WHERE s.visa_id = v.id AND s.created_at <= COALESCE(v.cancelled_at, v.created_at)) AS supplier_kept
      FROM visa_applications v WHERE v.status::TEXT = 'cancelled'
  ) v
CROSS JOIN LATERAL (VALUES
  ('1100'::TEXT, NULL::TEXT, 'customer'::TEXT, v.customer_id::UUID, (-v.selling_price)::NUMERIC),
  ('4100', NULL, NULL, NULL, (v.selling_price)),
  ('5100', NULL, NULL, NULL, (-(COALESCE(v.cost_price, 0)))),
  ('2100', NULL, 'visa', v.id, (COALESCE(v.cost_price, 0))),
  ('1100', NULL, 'customer', v.customer_id, (v.kept)),
  ('4900', NULL, NULL, NULL, (-v.kept)),
  ('5900', NULL, NULL, NULL, (v.supplier_kept)),
  ('2100', NULL, 'visa', v.id, (-v.supplier_kept))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Money from (or refunded to) the customer on a visa. Paid from a
-- deposit: no cash moves, the deposit liability goes down instead.
SELECT p.business_id AS business_id, p.created_at AS entry_at, 'visa_payment'::TEXT AS source, p.id AS source_id, 'Payment — ' || 'Visa — ' || COALESCE(v.applicant_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM visa_payments p
  JOIN visa_applications v ON v.id = p.visa_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN COALESCE(p.from_deposit, FALSE) THEN '2200' ELSE '1000' END::TEXT, NULL::TEXT, CASE WHEN COALESCE(p.from_deposit, FALSE) THEN 'customer' ELSE 'account' END::TEXT, CASE WHEN COALESCE(p.from_deposit, FALSE) THEN v.customer_id ELSE p.account_id END::UUID, (p.amount)::NUMERIC),
  (CASE WHEN (v.status::TEXT = 'cancelled' AND p.created_at > COALESCE(v.cancelled_at, v.created_at)) THEN '4900' ELSE '1100' END, NULL, 'customer', v.customer_id, (-p.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Paying the visa supplier (negative = the supplier returned money).
SELECT s.business_id AS business_id, s.created_at AS entry_at, 'visa_supplier'::TEXT AS source, s.id AS source_id, 'Supplier — ' || 'Visa — ' || COALESCE(v.applicant_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM supplier_payments s
  JOIN visa_applications v ON v.id = s.visa_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN (v.status::TEXT = 'cancelled' AND s.created_at > COALESCE(v.cancelled_at, v.created_at)) THEN '5900' ELSE '2100' END::TEXT, NULL::TEXT, 'visa'::TEXT, v.id::UUID, (s.amount)::NUMERIC),
  ('1000', NULL, 'account', s.account_id, (-s.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Package sold: the customer owes the price, the supplier is owed the cost.
SELECT pk.business_id AS business_id, pk.created_at AS entry_at, 'package_sale'::TEXT AS source, pk.id AS source_id, 'Package — ' || COALESCE(NULLIF(pk.label, ''), pk.lead_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM packages pk
CROSS JOIN LATERAL (VALUES
  ('1100'::TEXT, NULL::TEXT, 'customer'::TEXT, pk.customer_id::UUID, (pk.selling_price)::NUMERIC),
  ('4200', NULL, NULL, NULL, (-pk.selling_price)),
  ('5200', NULL, NULL, NULL, (COALESCE(pk.total_cost, 0))),
  ('2100', NULL, 'package', pk.id, (-(COALESCE(pk.total_cost, 0))))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Package cancelled: sale and cost reversed; what the customer's
-- payments net to is cancellation income; supplier money not returned is a loss.
SELECT pk.business_id AS business_id, pk.cancel_at AS entry_at, 'package_cancel'::TEXT AS source, pk.id AS source_id, 'Cancelled — ' || 'Package — ' || COALESCE(NULLIF(pk.label, ''), pk.lead_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM (
    SELECT pk.*, COALESCE(pk.cancelled_at, pk.created_at) AS cancel_at,
           (SELECT COALESCE(SUM(p.amount), 0) FROM package_payments p
             WHERE p.package_id = pk.id AND p.created_at <= COALESCE(pk.cancelled_at, pk.created_at)) AS kept,
           (SELECT COALESCE(SUM(s.amount), 0) FROM supplier_payments s
             WHERE s.package_id = pk.id AND s.created_at <= COALESCE(pk.cancelled_at, pk.created_at)) AS supplier_kept
      FROM packages pk WHERE pk.status::TEXT = 'cancelled'
  ) pk
CROSS JOIN LATERAL (VALUES
  ('1100'::TEXT, NULL::TEXT, 'customer'::TEXT, pk.customer_id::UUID, (-pk.selling_price)::NUMERIC),
  ('4200', NULL, NULL, NULL, (pk.selling_price)),
  ('5200', NULL, NULL, NULL, (-(COALESCE(pk.total_cost, 0)))),
  ('2100', NULL, 'package', pk.id, (COALESCE(pk.total_cost, 0))),
  ('1100', NULL, 'customer', pk.customer_id, (pk.kept)),
  ('4900', NULL, NULL, NULL, (-pk.kept)),
  ('5900', NULL, NULL, NULL, (pk.supplier_kept)),
  ('2100', NULL, 'package', pk.id, (-pk.supplier_kept))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Money from (or refunded to) the customer on a package. Paid from a
-- deposit: no cash moves, the deposit liability goes down instead.
SELECT p.business_id AS business_id, p.created_at AS entry_at, 'package_payment'::TEXT AS source, p.id AS source_id, 'Payment — ' || 'Package — ' || COALESCE(NULLIF(pk.label, ''), pk.lead_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM package_payments p
  JOIN packages pk ON pk.id = p.package_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN COALESCE(p.from_deposit, FALSE) THEN '2200' ELSE '1000' END::TEXT, NULL::TEXT, CASE WHEN COALESCE(p.from_deposit, FALSE) THEN 'customer' ELSE 'account' END::TEXT, CASE WHEN COALESCE(p.from_deposit, FALSE) THEN pk.customer_id ELSE p.account_id END::UUID, (p.amount)::NUMERIC),
  (CASE WHEN (pk.status::TEXT = 'cancelled' AND p.created_at > COALESCE(pk.cancelled_at, pk.created_at)) THEN '4900' ELSE '1100' END, NULL, 'customer', pk.customer_id, (-p.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Paying the package supplier (negative = the supplier returned money).
SELECT s.business_id AS business_id, s.created_at AS entry_at, 'package_supplier'::TEXT AS source, s.id AS source_id, 'Supplier — ' || 'Package — ' || COALESCE(NULLIF(pk.label, ''), pk.lead_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM supplier_payments s
  JOIN packages pk ON pk.id = s.package_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN (pk.status::TEXT = 'cancelled' AND s.created_at > COALESCE(pk.cancelled_at, pk.created_at)) THEN '5900' ELSE '2100' END::TEXT, NULL::TEXT, 'package'::TEXT, pk.id::UUID, (s.amount)::NUMERIC),
  ('1000', NULL, 'account', s.account_id, (-s.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Cargo sold: the customer owes the price, the supplier is owed the cost.
SELECT cs.business_id AS business_id, cs.created_at AS entry_at, 'cargo_sale'::TEXT AS source, cs.id AS source_id, 'Cargo — ' || COALESCE(cs.tracking_number, cs.sender_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM cargo_shipments cs
CROSS JOIN LATERAL (VALUES
  ('1100'::TEXT, NULL::TEXT, 'customer'::TEXT, cs.customer_id::UUID, (cs.total_price)::NUMERIC),
  ('4300', NULL, NULL, NULL, (-cs.total_price)),
  ('5300', NULL, NULL, NULL, (CASE WHEN cs.profit_total IS NULL THEN 0 ELSE GREATEST(cs.total_price - cs.profit_total, 0) END)),
  ('2100', NULL, 'cargo', cs.id, (-(CASE WHEN cs.profit_total IS NULL THEN 0 ELSE GREATEST(cs.total_price - cs.profit_total, 0) END)))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Cargo cancelled: sale and cost reversed; what the customer's
-- payments net to is cancellation income; supplier money not returned is a loss.
SELECT cs.business_id AS business_id, cs.cancel_at AS entry_at, 'cargo_cancel'::TEXT AS source, cs.id AS source_id, 'Cancelled — ' || 'Cargo — ' || COALESCE(cs.tracking_number, cs.sender_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM (
    SELECT cs.*, COALESCE(cs.cancelled_at, cs.created_at) AS cancel_at,
           (SELECT COALESCE(SUM(p.amount), 0) FROM cargo_payments p
             WHERE p.cargo_id = cs.id AND p.created_at <= COALESCE(cs.cancelled_at, cs.created_at)) AS kept,
           (SELECT COALESCE(SUM(s.amount), 0) FROM supplier_payments s
             WHERE s.cargo_id = cs.id AND s.created_at <= COALESCE(cs.cancelled_at, cs.created_at)) AS supplier_kept
      FROM cargo_shipments cs WHERE cs.cargo_status::TEXT = 'cancelled'
  ) cs
CROSS JOIN LATERAL (VALUES
  ('1100'::TEXT, NULL::TEXT, 'customer'::TEXT, cs.customer_id::UUID, (-cs.total_price)::NUMERIC),
  ('4300', NULL, NULL, NULL, (cs.total_price)),
  ('5300', NULL, NULL, NULL, (-(CASE WHEN cs.profit_total IS NULL THEN 0 ELSE GREATEST(cs.total_price - cs.profit_total, 0) END))),
  ('2100', NULL, 'cargo', cs.id, (CASE WHEN cs.profit_total IS NULL THEN 0 ELSE GREATEST(cs.total_price - cs.profit_total, 0) END)),
  ('1100', NULL, 'customer', cs.customer_id, (cs.kept)),
  ('4900', NULL, NULL, NULL, (-cs.kept)),
  ('5900', NULL, NULL, NULL, (cs.supplier_kept)),
  ('2100', NULL, 'cargo', cs.id, (-cs.supplier_kept))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Money from (or refunded to) the customer on a cargo. Paid from a
-- deposit: no cash moves, the deposit liability goes down instead.
SELECT p.business_id AS business_id, p.created_at AS entry_at, 'cargo_payment'::TEXT AS source, p.id AS source_id, 'Payment — ' || 'Cargo — ' || COALESCE(cs.tracking_number, cs.sender_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM cargo_payments p
  JOIN cargo_shipments cs ON cs.id = p.cargo_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN COALESCE(p.from_deposit, FALSE) THEN '2200' ELSE '1000' END::TEXT, NULL::TEXT, CASE WHEN COALESCE(p.from_deposit, FALSE) THEN 'customer' ELSE 'account' END::TEXT, CASE WHEN COALESCE(p.from_deposit, FALSE) THEN cs.customer_id ELSE p.account_id END::UUID, (p.amount)::NUMERIC),
  (CASE WHEN (cs.cargo_status::TEXT = 'cancelled' AND p.created_at > COALESCE(cs.cancelled_at, cs.created_at)) THEN '4900' ELSE '1100' END, NULL, 'customer', cs.customer_id, (-p.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Paying the cargo supplier (negative = the supplier returned money).
SELECT s.business_id AS business_id, s.created_at AS entry_at, 'cargo_supplier'::TEXT AS source, s.id AS source_id, 'Supplier — ' || 'Cargo — ' || COALESCE(cs.tracking_number, cs.sender_name, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM supplier_payments s
  JOIN cargo_shipments cs ON cs.id = s.cargo_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN (cs.cargo_status::TEXT = 'cancelled' AND s.created_at > COALESCE(cs.cancelled_at, cs.created_at)) THEN '5900' ELSE '2100' END::TEXT, NULL::TEXT, 'cargo'::TEXT, cs.id::UUID, (s.amount)::NUMERIC),
  ('1000', NULL, 'account', s.account_id, (-s.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Paying an airline (negative = the airline refunded).
SELECT ap.business_id AS business_id, ap.created_at AS entry_at, 'airline_payment'::TEXT AS source, ap.id AS source_id, 'Airline — ' || COALESCE(al.name, 'Airline') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM airline_payments ap
  LEFT JOIN airlines al ON al.id = ap.airline_id
  LEFT JOIN tickets t ON t.id = ap.ticket_id
  LEFT JOIN opening_balance_items oi ON oi.id = ap.opening_item_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN (t.status = 'cancelled' AND ap.created_at > COALESCE(t.cancelled_at, t.created_at)) THEN '5900' WHEN ap.opening_item_id IS NOT NULL AND oi.airline_id IS NULL THEN '2050' ELSE '2000' END::TEXT, NULL::TEXT, 'airline'::TEXT, ap.airline_id::UUID, (ap.amount)::NUMERIC),
  ('1000', NULL, 'account', ap.account_id, (-ap.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Paying agents their commission.
SELECT g.business_id AS business_id, g.created_at AS entry_at, 'agent_payment'::TEXT AS source, g.id AS source_id, 'Agent commission — ' || COALESCE(ag.name, 'Agent') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM agent_payments g LEFT JOIN agents ag ON ag.id = g.agent_id
CROSS JOIN LATERAL (VALUES
  ('2400'::TEXT, NULL::TEXT, 'agent'::TEXT, g.agent_id::UUID, (g.amount)::NUMERIC),
  ('1000', NULL, 'account', g.account_id, (-g.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Customer deposits (negative = handed back).
SELECT d.business_id AS business_id, d.created_at AS entry_at, 'deposit'::TEXT AS source, d.id AS source_id, 'Deposit — ' || COALESCE(c.name, 'Customer') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM customer_deposits d LEFT JOIN customers c ON c.id = d.customer_id
CROSS JOIN LATERAL (VALUES
  ('1000'::TEXT, NULL::TEXT, 'account'::TEXT, d.account_id::UUID, (d.amount)::NUMERIC),
  ('2200', NULL, 'customer', d.customer_id, (-d.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Balances brought forward from the previous system.
SELECT o.business_id AS business_id, o.entry_date::TIMESTAMPTZ AS entry_at, 'opening_' || o.balance_type || ''::TEXT AS source, o.id AS source_id, 'Opening balance — ' || o.reason AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM opening_balance_items o
CROSS JOIN LATERAL (VALUES
  (CASE WHEN o.balance_type = 'receivable' THEN '1100' ELSE '3200' END::TEXT, NULL::TEXT, CASE WHEN o.balance_type = 'receivable' THEN 'customer' END::TEXT, CASE WHEN o.balance_type = 'receivable' THEN o.customer_id END::UUID, (o.amount)::NUMERIC),
  (CASE WHEN o.balance_type = 'receivable' THEN '3200' WHEN o.airline_id IS NOT NULL THEN '2000' ELSE '2050' END, NULL, CASE WHEN o.balance_type = 'payable' AND o.airline_id IS NOT NULL THEN 'airline' END, CASE WHEN o.balance_type = 'payable' THEN o.airline_id END, (-o.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Collecting an opening receivable.
SELECT p.business_id AS business_id, p.created_at AS entry_at, 'opening_collection'::TEXT AS source, p.id AS source_id, 'Collected opening balance — ' || oi.reason AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM opening_balance_payments p JOIN opening_balance_items oi ON oi.id = p.opening_item_id
CROSS JOIN LATERAL (VALUES
  ('1000'::TEXT, NULL::TEXT, 'account'::TEXT, p.account_id::UUID, (p.amount)::NUMERIC),
  ('1100', NULL, 'customer', oi.customer_id, (-p.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Tax paid over to the government.
SELECT x.business_id AS business_id, x.paid_at AS entry_at, 'tax_payment'::TEXT AS source, x.id AS source_id, 'Tax paid' || COALESCE(' — ' || x.reference, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM tax_payments x
CROSS JOIN LATERAL (VALUES
  ('2300'::TEXT, NULL::TEXT, NULL::TEXT, NULL::UUID, (x.amount)::NUMERIC),
  ('1000', NULL, 'account', x.account_id, (-x.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Expenses.
SELECT e.business_id AS business_id, e.expense_date::TIMESTAMPTZ AS entry_at, 'expense'::TEXT AS source, e.id AS source_id, COALESCE(NULLIF(e.description, ''), INITCAP(REPLACE(e.category::TEXT, '_', ' '))) AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM expenses e
CROSS JOIN LATERAL (VALUES
  ('6100'::TEXT, INITCAP(REPLACE(e.category::TEXT, '_', ' '))::TEXT, NULL::TEXT, NULL::UUID, (ABS(e.amount))::NUMERIC),
  ('1000', NULL, 'account', e.account_id, (-ABS(e.amount)))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Moving money between the agency's own accounts, and the fee it cost.
SELECT tr.business_id AS business_id, tr.transferred_at AS entry_at, 'transfer'::TEXT AS source, tr.id AS source_id, 'Transfer' || COALESCE(' — ' || tr.reference, '') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM account_transfers tr
CROSS JOIN LATERAL (VALUES
  ('1000'::TEXT, NULL::TEXT, 'account'::TEXT, tr.to_account_id::UUID, (tr.amount)::NUMERIC),
  ('1000', NULL, 'account', tr.from_account_id, (-tr.amount)),
  ('6900', NULL, NULL, NULL, (COALESCE(tr.fee, 0))),
  ('1000', NULL, 'account', tr.from_account_id, (-COALESCE(tr.fee, 0)))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- What each account held when the agency started using TAMS.
SELECT a.business_id AS business_id, COALESCE(a.opening_date::TIMESTAMPTZ, TIMESTAMPTZ '1970-01-01') AS entry_at, 'account_opening'::TEXT AS source, a.id AS source_id, 'Opening balance — ' || a.name AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM payment_accounts a
CROSS JOIN LATERAL (VALUES
  ('1000'::TEXT, NULL::TEXT, 'account'::TEXT, a.id::UUID, (a.opening_balance)::NUMERIC),
  ('3200', NULL, NULL, NULL, (-a.opening_balance))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- The business's own opening figures.
SELECT b.id AS business_id, TIMESTAMPTZ '1970-01-01' AS entry_at, 'business_opening'::TEXT AS source, b.id AS source_id, 'Opening position — ' || b.name AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM businesses b
CROSS JOIN LATERAL (VALUES
  ('1000'::TEXT, NULL::TEXT, NULL::TEXT, NULL::UUID, (COALESCE(b.opening_cash, 0))::NUMERIC),
  ('3200', NULL, NULL, NULL, (-COALESCE(b.opening_cash, 0))),
  ('1200', NULL, NULL, NULL, (COALESCE(b.fixed_assets, 0))),
  ('3200', NULL, NULL, NULL, (-COALESCE(b.fixed_assets, 0))),
  ('3200', NULL, NULL, NULL, (COALESCE(b.liabilities, 0))),
  ('2500', NULL, NULL, NULL, (-COALESCE(b.liabilities, 0)))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Owners' capital brought into TAMS.
SELECT ow.business_id AS business_id, TIMESTAMPTZ '1970-01-01' AS entry_at, 'owner_opening'::TEXT AS source, ow.id AS source_id, 'Opening capital — ' || ow.name AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM business_owners ow
CROSS JOIN LATERAL (VALUES
  ('3200'::TEXT, NULL::TEXT, NULL::TEXT, NULL::UUID, (ow.opening_capital)::NUMERIC),
  ('3000', NULL, 'owner', ow.id, (-ow.opening_capital))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0

UNION ALL

-- Owners putting money in (capital) or taking it out (drawings).
SELECT o.business_id AS business_id, o.occurred_at AS entry_at, 'owner_' || o.kind || ''::TEXT AS source, o.id AS source_id, CASE WHEN o.kind = 'contribution' THEN 'Capital from ' ELSE 'Drawings by ' END || COALESCE(ow.name, 'owner') AS memo,
       l.code, l.detail, l.party_type, l.party_id, l.amount
  FROM owner_transactions o JOIN business_owners ow ON ow.id = o.owner_id
CROSS JOIN LATERAL (VALUES
  ('1000'::TEXT, NULL::TEXT, 'account'::TEXT, o.account_id::UUID, (o.amount)::NUMERIC),
  (CASE WHEN o.kind = 'contribution' THEN '3000' ELSE '3100' END, NULL, 'owner', o.owner_id, (-o.amount))
) AS l(code, detail, party_type, party_id, amount)
WHERE l.amount <> 0;

-- The app connects as tams_user; objects created by postgres need granting.
DO $g$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tams_user') THEN
  GRANT ALL ON ALL TABLES IN SCHEMA public TO tams_user;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO tams_user;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tams_user;
END IF; END $g$;

COMMIT;
