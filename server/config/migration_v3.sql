-- ============================================================
-- TAMS v3 Migration — Payments, Commission, Round Trip, Groups
-- Safe to run multiple times (idempotent).
-- Run with:  psql -d <your_db> -f server/config/migration_v3.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Ensure the payment_status enum exists (v2 schemas have it for cargo)
DO $$ BEGIN
    CREATE TYPE payment_status AS ENUM ('unpaid', 'partial', 'paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── customers: company support (used by group bookings) ─────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type VARCHAR(20) NOT NULL DEFAULT 'individual';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_name  VARCHAR(255);

-- ── booking_groups (group ticket bookings) ──────────────────
CREATE TABLE IF NOT EXISTS booking_groups (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    created_by          UUID NOT NULL REFERENCES users(id),
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    group_type          VARCHAR(20) NOT NULL DEFAULT 'family',
    group_label         VARCHAR(255),
    from_city           VARCHAR(255),
    to_city             VARCHAR(255),
    flight_date         DATE,
    airline_name        VARCHAR(255),
    notes               TEXT,
    total_cost_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_selling_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_revenue       NUMERIC(12,2) GENERATED ALWAYS AS (total_selling_price - total_cost_price) STORED,
    ticket_count        INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_groups_business ON booking_groups(business_id);
CREATE INDEX IF NOT EXISTS idx_booking_groups_customer ON booking_groups(customer_id);

-- If booking_groups already existed, make sure required columns are present
ALTER TABLE booking_groups ADD COLUMN IF NOT EXISTS total_cost_price    NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE booking_groups ADD COLUMN IF NOT EXISTS total_selling_price NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE booking_groups ADD COLUMN IF NOT EXISTS ticket_count        INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'booking_groups' AND column_name = 'total_revenue'
    ) THEN
        ALTER TABLE booking_groups ADD COLUMN total_revenue NUMERIC(12,2)
            GENERATED ALWAYS AS (total_selling_price - total_cost_price) STORED;
    END IF;
END $$;

-- ── tickets: new columns ────────────────────────────────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS base_price NUMERIC(12,2);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tax        NUMERIC(12,2);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS surcharge  NUMERIC(12,2);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS booking_group_id UUID REFERENCES booking_groups(id) ON DELETE SET NULL;

-- Payment tracking
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS payment_status payment_status NOT NULL DEFAULT 'unpaid';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Agent commission (subtracted from revenue)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS agent_commission NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Who booked (family member / friend bookings)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS booked_by_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

-- Round trip (go and back)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip_type VARCHAR(12) NOT NULL DEFAULT 'one_way';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS return_date DATE;
DO $$ BEGIN
    ALTER TABLE tickets ADD CONSTRAINT chk_trip_type CHECK (trip_type IN ('one_way','round_trip'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── revenue = selling_price - cost_price - agent_commission ─
-- (drop the old generated column and any dependent views, re-create)
DROP VIEW IF EXISTS v_group_booking_statement;
ALTER TABLE tickets DROP COLUMN IF EXISTS revenue CASCADE;
ALTER TABLE tickets ADD COLUMN revenue NUMERIC(12,2)
    GENERATED ALWAYS AS (selling_price - cost_price - COALESCE(agent_commission, 0)) STORED;

CREATE INDEX IF NOT EXISTS idx_tickets_payment_status ON tickets(business_id, payment_status);
CREATE INDEX IF NOT EXISTS idx_tickets_booked_by ON tickets(booked_by_customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_booking_group ON tickets(booking_group_id);

-- ── ticket_payments: every money collection is logged ───────
CREATE TABLE IF NOT EXISTS ticket_payments (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    ticket_id     UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    collected_by  UUID NOT NULL REFERENCES users(id),
    amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method        VARCHAR(50) DEFAULT 'cash',
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_payments_ticket ON ticket_payments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_payments_business ON ticket_payments(business_id, created_at);

-- ── group booking statement view ────────────────────────────
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

-- ── updated_at trigger for booking_groups ───────────────────
DO $$ BEGIN
    CREATE TRIGGER trg_booking_groups_updated_at
        BEFORE UPDATE ON booking_groups
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
