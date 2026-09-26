-- Opening receivables/payables and account overdraft protection.
-- Safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS opening_balance_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    balance_type TEXT NOT NULL CHECK (balance_type IN ('receivable', 'payable')),
    customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT,
    service_type TEXT,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_opening_balance_party CHECK (
        (balance_type = 'receivable' AND customer_id IS NOT NULL
          AND service_type IN ('ticket', 'visa', 'cargo', 'package', 'other'))
        OR
        (balance_type = 'payable' AND customer_id IS NULL AND service_type IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_opening_balance_business_type
    ON opening_balance_items(business_id, balance_type, entry_date);
CREATE INDEX IF NOT EXISTS idx_opening_balance_customer
    ON opening_balance_items(customer_id, entry_date)
    WHERE balance_type = 'receivable';

CREATE TABLE IF NOT EXISTS opening_balance_payments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        opening_item_id UUID NOT NULL REFERENCES opening_balance_items(id) ON DELETE RESTRICT,
        account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT,
        collected_by UUID REFERENCES users(id) ON DELETE SET NULL,
        amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        method VARCHAR(50) NOT NULL DEFAULT 'cash',
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opening_balance_payments_item
        ON opening_balance_payments(opening_item_id, created_at);

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
    FROM ticket_payments p LEFT JOIN tickets t ON t.id = p.ticket_id
 WHERE NOT COALESCE(p.from_deposit, FALSE)
UNION ALL
SELECT p.business_id, p.account_id, p.id,
             CASE WHEN p.amount >= 0 THEN 'in' ELSE 'out' END,
             ABS(p.amount), p.created_at, 'visa', p.visa_id,
             COALESCE(v.applicant_name, 'Visa'), v.destination_country,
             p.note, p.collected_by, p.method
    FROM visa_payments p LEFT JOIN visa_applications v ON v.id = p.visa_id
 WHERE NOT COALESCE(p.from_deposit, FALSE)
UNION ALL
SELECT p.business_id, p.account_id, p.id,
             CASE WHEN p.amount >= 0 THEN 'in' ELSE 'out' END,
             ABS(p.amount), p.created_at, 'package', p.package_id,
             COALESCE(NULLIF(pk.lead_name, ''), pk.label, 'Package'), pk.label,
             p.note, p.collected_by, p.method
    FROM package_payments p LEFT JOIN packages pk ON pk.id = p.package_id
 WHERE NOT COALESCE(p.from_deposit, FALSE)
UNION ALL
SELECT p.business_id, p.account_id, p.id,
             CASE WHEN p.amount >= 0 THEN 'in' ELSE 'out' END,
             ABS(p.amount), p.created_at, 'cargo', p.cargo_id,
             COALESCE(cs.sender_name, 'Cargo'), cs.tracking_number,
             p.note, p.collected_by, p.method
    FROM cargo_payments p LEFT JOIN cargo_shipments cs ON cs.id = p.cargo_id
 WHERE NOT COALESCE(p.from_deposit, FALSE)
UNION ALL
SELECT p.business_id, p.account_id, p.id,
             CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
             ABS(p.amount), p.created_at, 'airline', p.airline_id,
             COALESCE(a.name, 'Airline'), p.reference, p.note, p.paid_by, p.method
    FROM airline_payments p LEFT JOIN airlines a ON a.id = p.airline_id
UNION ALL
SELECT p.business_id, p.account_id, p.id,
             CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
             ABS(p.amount), p.created_at, 'agent', p.agent_id,
             COALESCE(ag.name, 'Agent'), p.reference, p.note, p.paid_by, p.method
    FROM agent_payments p LEFT JOIN agents ag ON ag.id = p.agent_id
UNION ALL
SELECT p.business_id, p.account_id, p.id,
             CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
             ABS(p.amount), p.created_at, 'supplier',
             COALESCE(p.visa_id, p.package_id, p.cargo_id),
             COALESCE('Visa — ' || v.applicant_name,
                                'Package — ' || COALESCE(NULLIF(pk.label, ''), pk.lead_name),
                                'Cargo — ' || COALESCE(cs.tracking_number, cs.sender_name),
                                'Supplier'),
             p.reference, p.note, p.paid_by, p.method
    FROM supplier_payments p
    LEFT JOIN visa_applications v ON v.id = p.visa_id
    LEFT JOIN packages pk ON pk.id = p.package_id
    LEFT JOIN cargo_shipments cs ON cs.id = p.cargo_id
UNION ALL
SELECT d.business_id, d.account_id, d.id,
             CASE WHEN d.amount >= 0 THEN 'in' ELSE 'out' END,
             ABS(d.amount), d.created_at, 'deposit', d.customer_id,
             COALESCE(c.name, 'Customer'), d.reference, d.note, d.collected_by, d.method
    FROM customer_deposits d LEFT JOIN customers c ON c.id = d.customer_id
UNION ALL
SELECT p.business_id, p.account_id, p.id, 'in', p.amount, p.created_at,
             'opening_receivable', p.opening_item_id,
             COALESCE(c.name, 'Customer'), oi.reason, p.note, p.collected_by, p.method
    FROM opening_balance_payments p
    JOIN opening_balance_items oi ON oi.id = p.opening_item_id
    JOIN customers c ON c.id = oi.customer_id
UNION ALL
SELECT e.business_id, e.account_id, e.id,
             CASE WHEN e.amount >= 0 THEN 'out' ELSE 'in' END,
             ABS(e.amount), e.expense_date::TIMESTAMPTZ, 'expense', e.id,
             COALESCE(NULLIF(e.vendor, ''), INITCAP(REPLACE(e.category::TEXT, '_', ' '))),
             e.reference, e.description, e.created_by, e.payment_method
    FROM expenses e
UNION ALL
SELECT p.business_id, p.account_id, p.id, 'out', ABS(p.amount), p.paid_at,
             'tax', p.id, 'Tax authority', p.reference, p.note, p.paid_by, NULL
    FROM tax_payments p
UNION ALL
SELECT t.business_id, t.from_account_id, t.id, 'out', t.amount + t.fee,
             t.transferred_at, 'transfer_out', t.to_account_id, 'Transfer out',
             t.reference, t.note, t.created_by, NULL
    FROM account_transfers t
UNION ALL
SELECT t.business_id, t.to_account_id, t.id, 'in', t.amount,
             t.transferred_at, 'transfer_in', t.from_account_id, 'Transfer in',
             t.reference, t.note, t.created_by, NULL
    FROM account_transfers t;

CREATE VIEW v_account_balance AS
SELECT a.id AS account_id, a.business_id, a.name, a.kind, a.is_active,
             a.sort_order, a.opening_balance, a.opening_date,
             COALESCE(l.total_in, 0) AS total_in,
             COALESCE(l.total_out, 0) AS total_out,
             a.opening_balance + COALESCE(l.total_in, 0) - COALESCE(l.total_out, 0) AS balance,
             l.last_movement_at, COALESCE(l.movements, 0) AS movements
    FROM payment_accounts a
    LEFT JOIN (
            SELECT account_id,
                         COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0) AS total_in,
                         COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0) AS total_out,
                         MAX(occurred_at) AS last_movement_at,
                         COUNT(*) AS movements
                FROM v_cash_ledger WHERE account_id IS NOT NULL GROUP BY account_id
    ) l ON l.account_id = a.id;

ALTER TABLE payment_accounts
    DROP CONSTRAINT IF EXISTS chk_payment_accounts_opening_balance_nonnegative;
ALTER TABLE payment_accounts
    ADD CONSTRAINT chk_payment_accounts_opening_balance_nonnegative
    CHECK (opening_balance >= 0) NOT VALID;

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
                             'customer_deposits') THEN
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
                                     'customer_deposits') THEN
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

    -- Serializes account debits so two simultaneous withdrawals cannot both
    -- pass against the same previously-read balance.
    PERFORM 1 FROM payment_accounts
         WHERE id = target_account_id
             AND payment_accounts.business_id = target_business_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NEW; -- Let the account foreign key report a missing account.
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

DROP TRIGGER IF EXISTS trg_payment_accounts_opening_balance_guard ON payment_accounts;
CREATE TRIGGER trg_payment_accounts_opening_balance_guard
    BEFORE UPDATE OF opening_balance ON payment_accounts
    FOR EACH ROW EXECUTE FUNCTION prevent_account_overdraft();

DO $$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'ticket_payments', 'visa_payments', 'package_payments',
        'cargo_payments', 'airline_payments', 'agent_payments',
        'supplier_payments', 'customer_deposits', 'expenses',
        'tax_payments', 'account_transfers'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_overdraft_guard ON %I',
                       table_name, table_name);
        EXECUTE format(
            'CREATE TRIGGER trg_%I_overdraft_guard BEFORE INSERT OR UPDATE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION prevent_account_overdraft()',
            table_name, table_name
        );
    END LOOP;
END $$;

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
                             'customer_deposits', 'opening_balance_payments') THEN
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

DO $$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'ticket_payments', 'visa_payments', 'package_payments',
        'cargo_payments', 'airline_payments', 'agent_payments',
        'supplier_payments', 'customer_deposits', 'opening_balance_payments',
        'expenses', 'tax_payments', 'account_transfers'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_delete_overdraft_guard ON %I',
                       table_name, table_name);
        EXECUTE format(
            'CREATE TRIGGER trg_%I_delete_overdraft_guard BEFORE DELETE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION prevent_account_overdraft_on_delete()',
            table_name, table_name
        );
    END LOOP;
END $$;

COMMIT;