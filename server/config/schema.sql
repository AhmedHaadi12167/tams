-- ============================================================
-- TAMS v2 - Full PostgreSQL Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ENUM TYPES
CREATE TYPE user_role AS ENUM ('super_admin', 'admin', 'agent', 'accountant');
CREATE TYPE ticket_type AS ENUM ('LOCAL', 'INTERNATIONAL');
CREATE TYPE ticket_status AS ENUM ('active', 'cancelled', 'refunded');
CREATE TYPE business_status AS ENUM ('active', 'suspended', 'inactive');
CREATE TYPE cargo_status AS ENUM ('pending', 'in_progress', 'delivered', 'cancelled');
CREATE TYPE payment_status AS ENUM ('unpaid', 'partial', 'paid');
CREATE TYPE expense_category AS ENUM (
    'salaries', 'rent', 'utilities', 'marketing', 'office_supplies',
    'transport', 'communication', 'bank_charges', 'licenses_permits',
    'maintenance', 'refunds', 'other'
);

-- ============================================================
-- businesses
-- ============================================================
CREATE TABLE businesses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    phone           VARCHAR(50),
    address         TEXT,
    logo_url        VARCHAR(500),
    status          business_status NOT NULL DEFAULT 'active',
    opening_cash     NUMERIC(12,2) NOT NULL DEFAULT 0,
    fixed_assets     NUMERIC(12,2) NOT NULL DEFAULT 0,
    liabilities      NUMERIC(12,2) NOT NULL DEFAULT 0,
    owner_capital    NUMERIC(12,2) NOT NULL DEFAULT 0,
    financials_start DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_businesses_email ON businesses(email);
CREATE INDEX idx_businesses_status ON businesses(status);

-- ============================================================
-- users
-- ============================================================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            user_role NOT NULL DEFAULT 'agent',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_business_id ON users(business_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- ============================================================
-- customers
-- ============================================================
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    phone           VARCHAR(50),
    email           VARCHAR(255),
    passport_number VARCHAR(100),
    date_of_birth   DATE,
    nationality     VARCHAR(100),
    customer_type   VARCHAR(20) NOT NULL DEFAULT 'individual',
    company_name    VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_business_id ON customers(business_id);
CREATE INDEX idx_customers_name ON customers(business_id, name);
CREATE INDEX idx_customers_passport ON customers(business_id, passport_number);

-- ============================================================
-- airline_match_key — normalises a typed airline name so
-- 'Star Airline', 'star airlines' and 'STAR AIRWAYS' all agree
-- ============================================================
CREATE OR REPLACE FUNCTION airline_match_key(raw TEXT)
RETURNS TEXT AS $$
DECLARE
    k TEXT;
BEGIN
    IF raw IS NULL THEN RETURN NULL; END IF;

    k := UPPER(TRIM(raw));
    -- fold accented letters so 'Ünïted' and 'United' agree
    k := TRANSLATE(k,
        'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ',
        'AAAAAACEEEEIIIINOOOOOUUUUY');
    -- punctuation becomes a space, never nothing, or 'Star-Airlines'
    -- glues into 'STARAIRLINES' and the suffix rule can't see the last word
    k := REGEXP_REPLACE(k, '[^A-Z0-9]+', ' ', 'g');
    -- collapse runs of whitespace
    k := REGEXP_REPLACE(k, '\s+', ' ', 'g');
    k := TRIM(k);

    -- remove a trailing generic carrier word (repeat twice for
    -- cases like 'AIR LINES' or 'AIRLINES COMPANY')
    k := REGEXP_REPLACE(k, '\s+(AIRLINES|AIRLINE|AIRWAYS|AIRWAY|AVIATION|AIRLINES CO|LINES)$', '');
    k := REGEXP_REPLACE(k, '\s+(AIRLINES|AIRLINE|AIRWAYS|AIRWAY|AVIATION|AIR|LINES)$', '');

    -- ignore spacing differences ('Fly Dubai' vs 'FlyDubai')
    k := REPLACE(k, ' ', '');

    IF k = '' THEN
        -- name was nothing but a generic word; fall back to the raw text
        k := REGEXP_REPLACE(
               TRANSLATE(UPPER(TRIM(raw)),
                 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ',
                 'AAAAAACEEEEIIIINOOOOOUUUUY'),
               '[^A-Z0-9]', '', 'g');
    END IF;

    RETURN k;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- airlines (master list per agency)
-- ============================================================
CREATE TABLE airlines (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    match_key   VARCHAR(255) NOT NULL,
    iata_code   VARCHAR(8),
    country     VARCHAR(100),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_airlines_business_key ON airlines(business_id, match_key);
CREATE INDEX idx_airlines_business ON airlines(business_id);
CREATE INDEX idx_airlines_name     ON airlines(business_id, name);


-- ============================================================
-- airline_aliases — 'THY' / 'TK' resolve to Turkish Airlines
-- ============================================================
CREATE TABLE airline_aliases (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    airline_id  UUID NOT NULL REFERENCES airlines(id) ON DELETE CASCADE,
    alias       VARCHAR(255) NOT NULL,
    match_key   VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_airline_aliases_key     ON airline_aliases(business_id, match_key);
CREATE INDEX        idx_airline_aliases_airline ON airline_aliases(airline_id);

-- ============================================================
-- booking_groups (group ticket bookings)
-- ============================================================
CREATE TABLE booking_groups (
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

CREATE INDEX idx_booking_groups_business ON booking_groups(business_id);
CREATE INDEX idx_booking_groups_customer ON booking_groups(customer_id);

-- ============================================================
-- tickets
-- ============================================================
CREATE TABLE tickets (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id          UUID REFERENCES customers(id) ON DELETE SET NULL,
    created_by           UUID NOT NULL REFERENCES users(id),
    ticket_type          ticket_type NOT NULL,
    status               ticket_status NOT NULL DEFAULT 'active',
    passenger_name       VARCHAR(255) NOT NULL,
    contact_number       VARCHAR(50),
    from_city            VARCHAR(255) NOT NULL,
    to_city              VARCHAR(255) NOT NULL,
    flight_date          DATE NOT NULL,
    trip_type            VARCHAR(12) NOT NULL DEFAULT 'one_way' CHECK (trip_type IN ('one_way','round_trip')),
    return_date          DATE,
    airline_name         VARCHAR(255) NOT NULL,
    airline_id           UUID REFERENCES airlines(id) ON DELETE SET NULL,
    ticket_reference     VARCHAR(100),
    base_price           NUMERIC(12, 2),
    tax                  NUMERIC(12, 2),
    surcharge            NUMERIC(12, 2),
    cost_price           NUMERIC(12, 2) NOT NULL,
    selling_price        NUMERIC(12, 2) NOT NULL,
    agent_commission     NUMERIC(12, 2) NOT NULL DEFAULT 0,
    revenue              NUMERIC(12, 2) GENERATED ALWAYS AS (selling_price - cost_price - COALESCE(agent_commission, 0)) STORED,
    payment_status       payment_status NOT NULL DEFAULT 'unpaid',
    amount_paid          NUMERIC(12, 2) NOT NULL DEFAULT 0,
    booked_by_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    booking_group_id     UUID REFERENCES booking_groups(id) ON DELETE SET NULL,
    passport_number      VARCHAR(100),
    date_of_birth        DATE,
    nationality          VARCHAR(100),
    visa_type            VARCHAR(100),
    visa_expiry_date     DATE,
    passport_expiry_date DATE,
    source_file_url      VARCHAR(500),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_international_fields CHECK (
        ticket_type = 'LOCAL'
        OR (ticket_type = 'INTERNATIONAL' AND passport_number IS NOT NULL)
    )
);

CREATE INDEX idx_tickets_business_id ON tickets(business_id);
CREATE INDEX idx_tickets_customer_id ON tickets(customer_id);
CREATE INDEX idx_tickets_created_by ON tickets(created_by);
CREATE INDEX idx_tickets_flight_date ON tickets(business_id, flight_date);
CREATE INDEX idx_tickets_status ON tickets(business_id, status);
CREATE INDEX idx_tickets_type ON tickets(business_id, ticket_type);
CREATE INDEX idx_tickets_passenger ON tickets(business_id, passenger_name);
CREATE INDEX idx_tickets_created_at ON tickets(business_id, created_at);
CREATE INDEX idx_tickets_airline_id ON tickets(airline_id);

CREATE INDEX idx_tickets_payment_status ON tickets(business_id, payment_status);
CREATE INDEX idx_tickets_booked_by ON tickets(booked_by_customer_id);
CREATE INDEX idx_tickets_booking_group ON tickets(booking_group_id);

-- ============================================================
-- ticket_payments (money collections — any user can collect)
-- ============================================================
CREATE TABLE ticket_payments (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    ticket_id     UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    collected_by  UUID NOT NULL REFERENCES users(id),
    amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method        VARCHAR(50) DEFAULT 'cash',
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ticket_payments_ticket ON ticket_payments(ticket_id);
CREATE INDEX idx_ticket_payments_business ON ticket_payments(business_id, created_at);

-- ============================================================
-- cargo_shipments
-- Tracks cargo items sent between cities
-- ============================================================
CREATE TABLE cargo_shipments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    created_by          UUID NOT NULL REFERENCES users(id),

    -- Item
    item_description    VARCHAR(255) NOT NULL,       -- e.g. "Clothes", "Electronics"
    weight_kg           NUMERIC(10, 2) NOT NULL,     -- Weight in KG
    price_per_kg        NUMERIC(10, 2) NOT NULL,     -- Price per KG
    total_price         NUMERIC(12, 2) GENERATED ALWAYS AS (weight_kg * price_per_kg) STORED,

    -- Sender
    sender_name         VARCHAR(255) NOT NULL,
    sender_contact      VARCHAR(50),
    from_city           VARCHAR(255) NOT NULL,

    -- Receiver
    receiver_name       VARCHAR(255) NOT NULL,
    receiver_contact    VARCHAR(50),
    to_city             VARCHAR(255) NOT NULL,

    -- Tracking
    tracking_number     VARCHAR(100) UNIQUE,         -- Optional internal tracking code
    photo_url           VARCHAR(500),                -- Proof-of-condition photo
    notes               TEXT,

    -- Status
    cargo_status        cargo_status NOT NULL DEFAULT 'pending',
    payment_status      payment_status NOT NULL DEFAULT 'unpaid',
    amount_paid         NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- For partial payments

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cargo_business_id ON cargo_shipments(business_id);
CREATE INDEX idx_cargo_created_by ON cargo_shipments(created_by);
CREATE INDEX idx_cargo_status ON cargo_shipments(business_id, cargo_status);
CREATE INDEX idx_cargo_sender ON cargo_shipments(business_id, sender_name);
CREATE INDEX idx_cargo_receiver ON cargo_shipments(business_id, receiver_name);
CREATE INDEX idx_cargo_created_at ON cargo_shipments(business_id, created_at);
CREATE INDEX idx_cargo_tracking ON cargo_shipments(tracking_number);

-- ============================================================
-- expenses (operating costs — service company P&L)
-- ============================================================
CREATE TABLE expenses (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    created_by     UUID NOT NULL REFERENCES users(id),
    category       expense_category NOT NULL DEFAULT 'other',
    description    VARCHAR(255) NOT NULL,
    amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    expense_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    vendor         VARCHAR(255),
    payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
    reference      VARCHAR(100),
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_expenses_business   ON expenses(business_id);
CREATE INDEX idx_expenses_date       ON expenses(business_id, expense_date);
CREATE INDEX idx_expenses_category   ON expenses(business_id, category);
CREATE INDEX idx_expenses_created_by ON expenses(created_by);

-- ============================================================
-- AUTO-UPDATE updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_businesses_updated_at BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_tickets_updated_at BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_cargo_updated_at BEFORE UPDATE ON cargo_shipments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_booking_groups_updated_at BEFORE UPDATE ON booking_groups FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_expenses_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_airlines_updated_at BEFORE UPDATE ON airlines FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- v_group_booking_statement
-- ============================================================
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

-- ============================================================
-- v_receivables — outstanding money from tickets + cargo
-- ============================================================
CREATE OR REPLACE VIEW v_receivables AS
SELECT
    t.business_id,
    'ticket'                                   AS source,
    t.id                                       AS source_id,
    t.passenger_name                           AS party_name,
    t.contact_number                           AS party_contact,
    t.created_at                               AS issued_at,
    t.selling_price                            AS total_amount,
    t.amount_paid                              AS paid_amount,
    (t.selling_price - t.amount_paid)          AS balance,
    t.payment_status
FROM tickets t
WHERE t.status <> 'cancelled'
  AND (t.selling_price - t.amount_paid) > 0
UNION ALL
SELECT
    cs.business_id,
    'cargo'                                    AS source,
    cs.id                                      AS source_id,
    cs.sender_name                             AS party_name,
    cs.sender_contact                          AS party_contact,
    cs.created_at                              AS issued_at,
    cs.total_price                             AS total_amount,
    cs.amount_paid                             AS paid_amount,
    (cs.total_price - cs.amount_paid)          AS balance,
    cs.payment_status
FROM cargo_shipments cs
WHERE cs.cargo_status <> 'cancelled'
  AND (cs.total_price - cs.amount_paid) > 0;

-- ============================================================
-- v_monthly_income — P&L trend source
-- ============================================================
CREATE OR REPLACE VIEW v_monthly_income AS
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
