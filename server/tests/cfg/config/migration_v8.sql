-- ============================================================
-- TAMS v8 Migration — Agents, payables, visa services, packages
--
-- Adds the money the agency OWES (airlines, agents) alongside the
-- money it is owed, plus two new revenue lines: visa services and
-- Hajj / Umrah packages.
--
-- Safe to run multiple times (idempotent).
-- Run migrations v3–v7 first.
-- Run with:  psql -U postgres -d tams_db -f config/migration_v8.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ENUMS
-- ============================================================
DO $$ BEGIN
    CREATE TYPE visa_status AS ENUM
        ('applied', 'processing', 'approved', 'rejected', 'collected', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE package_type AS ENUM ('hajj', 'umrah', 'tour', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE package_status AS ENUM
        ('quoted', 'confirmed', 'in_progress', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- agents — external people who bring customers and earn commission.
-- Distinct from `users`, who are staff with logins.
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    phone       VARCHAR(50),
    email       VARCHAR(255),
    id_number   VARCHAR(100),
    notes       TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_business ON agents(business_id);
CREATE INDEX IF NOT EXISTS idx_agents_name     ON agents(business_id, name);
CREATE INDEX IF NOT EXISTS idx_agents_phone    ON agents(business_id, phone);

DO $$ BEGIN
    CREATE TRIGGER trg_agents_updated_at BEFORE UPDATE ON agents
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which agent earns the commission on this ticket
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS agent_id UUID
    REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_agent_id ON tickets(agent_id);

-- ============================================================
-- agent_payments — commission actually paid out
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_payments (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    paid_by     UUID NOT NULL REFERENCES users(id),
    amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method      VARCHAR(50) NOT NULL DEFAULT 'cash',
    reference   VARCHAR(100),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_payments_agent    ON agent_payments(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_payments_business ON agent_payments(business_id, created_at);

-- ============================================================
-- airline_payments — settlements to carriers.
-- A running account: what we owe is the total ticket cost, what we
-- paid is the sum here. Airlines invoice in lumps that rarely line up
-- with individual tickets, so payments are account level.
-- ============================================================
CREATE TABLE IF NOT EXISTS airline_payments (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    airline_id  UUID NOT NULL REFERENCES airlines(id) ON DELETE CASCADE,
    paid_by     UUID NOT NULL REFERENCES users(id),
    amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method      VARCHAR(50) NOT NULL DEFAULT 'cash',
    reference   VARCHAR(100),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_airline_payments_airline  ON airline_payments(airline_id);
CREATE INDEX IF NOT EXISTS idx_airline_payments_business ON airline_payments(business_id, created_at);

-- ============================================================
-- visa_applications — visa handled on a customer's behalf
-- ============================================================
CREATE TABLE IF NOT EXISTS visa_applications (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id        UUID REFERENCES customers(id) ON DELETE SET NULL,
    created_by         UUID NOT NULL REFERENCES users(id),
    applicant_name     VARCHAR(255) NOT NULL,
    contact_number     VARCHAR(50),
    passport_number    VARCHAR(100),
    nationality        VARCHAR(100),
    destination_country VARCHAR(100) NOT NULL,
    visa_type          VARCHAR(100),
    reference          VARCHAR(100),
    applied_date       DATE NOT NULL DEFAULT CURRENT_DATE,
    decision_date      DATE,
    expiry_date        DATE,
    status             visa_status NOT NULL DEFAULT 'applied',
    cost_price         NUMERIC(12,2) NOT NULL DEFAULT 0,   -- embassy / handler fee
    selling_price      NUMERIC(12,2) NOT NULL DEFAULT 0,   -- what the customer pays
    revenue            NUMERIC(12,2) GENERATED ALWAYS AS (selling_price - cost_price) STORED,
    amount_paid        NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_status     payment_status NOT NULL DEFAULT 'unpaid',
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visa_business   ON visa_applications(business_id);
CREATE INDEX IF NOT EXISTS idx_visa_customer   ON visa_applications(customer_id);
CREATE INDEX IF NOT EXISTS idx_visa_status     ON visa_applications(business_id, status);
CREATE INDEX IF NOT EXISTS idx_visa_country    ON visa_applications(business_id, destination_country);
CREATE INDEX IF NOT EXISTS idx_visa_applied    ON visa_applications(business_id, applied_date);
CREATE INDEX IF NOT EXISTS idx_visa_applicant  ON visa_applications(business_id, applicant_name);

DO $$ BEGIN
    CREATE TRIGGER trg_visa_updated_at BEFORE UPDATE ON visa_applications
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS visa_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    visa_id      UUID NOT NULL REFERENCES visa_applications(id) ON DELETE CASCADE,
    collected_by UUID NOT NULL REFERENCES users(id),
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method       VARCHAR(50) NOT NULL DEFAULT 'cash',
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visa_payments_visa     ON visa_payments(visa_id);
CREATE INDEX IF NOT EXISTS idx_visa_payments_business ON visa_payments(business_id, created_at);

-- ============================================================
-- packages — Hajj / Umrah and other bundles.
-- Cost is the sum of its lines; the selling price is negotiated,
-- so it is entered by hand rather than derived.
-- ============================================================
CREATE TABLE IF NOT EXISTS packages (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id    UUID REFERENCES customers(id) ON DELETE SET NULL,
    created_by     UUID NOT NULL REFERENCES users(id),
    package_type   package_type NOT NULL DEFAULT 'umrah',
    label          VARCHAR(255) NOT NULL,
    lead_name      VARCHAR(255),
    contact_number VARCHAR(50),
    pilgrim_count  INTEGER NOT NULL DEFAULT 1 CHECK (pilgrim_count > 0),
    departure_date DATE,
    return_date    DATE,
    status         package_status NOT NULL DEFAULT 'quoted',
    total_cost     NUMERIC(12,2) NOT NULL DEFAULT 0,   -- rolled up from package_items
    selling_price  NUMERIC(12,2) NOT NULL DEFAULT 0,   -- negotiated
    revenue        NUMERIC(12,2) GENERATED ALWAYS AS (selling_price - total_cost) STORED,
    amount_paid    NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_status payment_status NOT NULL DEFAULT 'unpaid',
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_packages_business  ON packages(business_id);
CREATE INDEX IF NOT EXISTS idx_packages_customer  ON packages(customer_id);
CREATE INDEX IF NOT EXISTS idx_packages_type      ON packages(business_id, package_type);
CREATE INDEX IF NOT EXISTS idx_packages_status    ON packages(business_id, status);
CREATE INDEX IF NOT EXISTS idx_packages_departure ON packages(business_id, departure_date);

DO $$ BEGIN
    CREATE TRIGGER trg_packages_updated_at BEFORE UPDATE ON packages
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS package_items (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    package_id   UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    item_type    VARCHAR(50) NOT NULL DEFAULT 'other',  -- visa | ticket | hotel | transport | meals | other
    description  VARCHAR(255) NOT NULL,
    quantity     NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_cost    NUMERIC(12,2) NOT NULL DEFAULT 0,
    line_cost    NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
    supplier     VARCHAR(255),
    -- Optional links when a line corresponds to a real record
    visa_id      UUID REFERENCES visa_applications(id) ON DELETE SET NULL,
    ticket_id    UUID REFERENCES tickets(id) ON DELETE SET NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_package_items_package ON package_items(package_id);
CREATE INDEX IF NOT EXISTS idx_package_items_business ON package_items(business_id);

CREATE TABLE IF NOT EXISTS package_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    package_id   UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    collected_by UUID NOT NULL REFERENCES users(id),
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method       VARCHAR(50) NOT NULL DEFAULT 'cash',
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_package_payments_package  ON package_payments(package_id);
CREATE INDEX IF NOT EXISTS idx_package_payments_business ON package_payments(business_id, created_at);

-- ============================================================
-- v_airline_account — what we owe each carrier
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
    p.last_payment_at
FROM airlines a
LEFT JOIN (
    SELECT airline_id, business_id,
           COUNT(*)                  AS ticket_count,
           COALESCE(SUM(cost_price), 0) AS total_cost
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

-- ============================================================
-- v_agent_account — commission earned vs paid
-- ============================================================
CREATE OR REPLACE VIEW v_agent_account AS
SELECT
    ag.id                                      AS agent_id,
    ag.business_id,
    ag.name                                    AS agent_name,
    ag.phone,
    ag.is_active,
    COALESCE(t.ticket_count, 0)                AS ticket_count,
    COALESCE(t.commission_earned, 0)           AS commission_earned,
    COALESCE(p.commission_paid, 0)             AS commission_paid,
    COALESCE(t.commission_earned, 0) - COALESCE(p.commission_paid, 0) AS balance,
    p.last_payment_at
FROM agents ag
LEFT JOIN (
    SELECT agent_id, business_id,
           COUNT(*)                           AS ticket_count,
           COALESCE(SUM(agent_commission), 0) AS commission_earned
    FROM tickets
    WHERE status <> 'cancelled' AND agent_id IS NOT NULL
    GROUP BY agent_id, business_id
) t ON t.agent_id = ag.id AND t.business_id = ag.business_id
LEFT JOIN (
    SELECT agent_id, business_id,
           COALESCE(SUM(amount), 0) AS commission_paid,
           MAX(created_at)          AS last_payment_at
    FROM agent_payments
    GROUP BY agent_id, business_id
) p ON p.agent_id = ag.id AND p.business_id = ag.business_id;

-- ============================================================
-- v_receivables — now spans tickets, cargo, visas and packages
-- ============================================================
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

-- ============================================================
-- recalc_package_total — keep packages.total_cost in step with its lines
-- ============================================================
CREATE OR REPLACE FUNCTION recalc_package_total()
RETURNS TRIGGER AS $$
DECLARE
    pid UUID;
BEGIN
    pid := COALESCE(NEW.package_id, OLD.package_id);
    UPDATE packages
       SET total_cost = COALESCE(
             (SELECT SUM(line_cost) FROM package_items WHERE package_id = pid), 0)
     WHERE id = pid;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_package_items_total ON package_items;
CREATE TRIGGER trg_package_items_total
    AFTER INSERT OR UPDATE OR DELETE ON package_items
    FOR EACH ROW EXECUTE FUNCTION recalc_package_total();

DO $$ BEGIN
    RAISE NOTICE 'v8 ready — agents, agent_payments, airline_payments,';
    RAISE NOTICE '           visa_applications, visa_payments,';
    RAISE NOTICE '           packages, package_items, package_payments.';
END $$;
