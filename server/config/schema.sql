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
CREATE TYPE visa_status AS ENUM ('applied','processing','approved','rejected','collected','cancelled');
CREATE TYPE package_type AS ENUM ('hajj','umrah','tour','custom');
CREATE TYPE package_status AS ENUM ('quoted','confirmed','in_progress','completed','cancelled');
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
    -- One active session per account. Set on login, cleared on logout, and
    -- matched against the same value carried inside the JWT. Logging in
    -- elsewhere overwrites it, which retires the previous token.
    session_id      UUID,
    -- Consecutive failed logins, and the time a lockout expires.
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_business_id ON users(business_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- ============================================================
-- login_audit — every attempt to sign in, successful or not.
-- Holds no password material: who, when, from where, what happened.
-- ============================================================
CREATE TABLE login_audit (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    email       VARCHAR(255),
    success     BOOLEAN NOT NULL,
    reason      VARCHAR(64),
    ip_address  VARCHAR(64),
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_login_audit_email   ON login_audit(email, created_at DESC);
CREATE INDEX idx_login_audit_user    ON login_audit(user_id, created_at DESC);
CREATE INDEX idx_login_audit_created ON login_audit(created_at DESC);

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
-- agents (external referrers who earn commission)
-- ============================================================
CREATE TABLE agents (
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

CREATE INDEX idx_agents_business ON agents(business_id);
CREATE INDEX idx_agents_name     ON agents(business_id, name);
CREATE INDEX idx_agents_phone    ON agents(business_id, phone);

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
    agent_id             UUID REFERENCES agents(id) ON DELETE SET NULL,
    airline_paid         NUMERIC(12,2) NOT NULL DEFAULT 0,
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
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
CREATE INDEX idx_tickets_agent_id ON tickets(agent_id);

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
-- v8 tables: payables, visa services, packages
-- ============================================================
CREATE TABLE agent_payments (
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

CREATE INDEX idx_agent_payments_agent    ON agent_payments(agent_id);
CREATE INDEX idx_agent_payments_business ON agent_payments(business_id, created_at);


CREATE TABLE airline_payments (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    airline_id  UUID NOT NULL REFERENCES airlines(id) ON DELETE CASCADE,
    ticket_id   UUID REFERENCES tickets(id) ON DELETE SET NULL,
    paid_by     UUID NOT NULL REFERENCES users(id),
    amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method      VARCHAR(50) NOT NULL DEFAULT 'cash',
    reference   VARCHAR(100),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_airline_payments_airline  ON airline_payments(airline_id);
CREATE INDEX idx_airline_payments_business ON airline_payments(business_id, created_at);
CREATE INDEX idx_airline_payments_ticket   ON airline_payments(ticket_id);


CREATE TABLE visa_applications (
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

CREATE INDEX idx_visa_business   ON visa_applications(business_id);
CREATE INDEX idx_visa_customer   ON visa_applications(customer_id);
CREATE INDEX idx_visa_status     ON visa_applications(business_id, status);
CREATE INDEX idx_visa_country    ON visa_applications(business_id, destination_country);
CREATE INDEX idx_visa_applied    ON visa_applications(business_id, applied_date);
CREATE INDEX idx_visa_applicant  ON visa_applications(business_id, applicant_name);


CREATE TABLE visa_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    visa_id      UUID NOT NULL REFERENCES visa_applications(id) ON DELETE CASCADE,
    collected_by UUID NOT NULL REFERENCES users(id),
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method       VARCHAR(50) NOT NULL DEFAULT 'cash',
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_visa_payments_visa     ON visa_payments(visa_id);
CREATE INDEX idx_visa_payments_business ON visa_payments(business_id, created_at);


CREATE TABLE packages (
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

CREATE INDEX idx_packages_business  ON packages(business_id);
CREATE INDEX idx_packages_customer  ON packages(customer_id);
CREATE INDEX idx_packages_type      ON packages(business_id, package_type);
CREATE INDEX idx_packages_status    ON packages(business_id, status);
CREATE INDEX idx_packages_departure ON packages(business_id, departure_date);


CREATE TABLE package_items (
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

CREATE INDEX idx_package_items_package ON package_items(package_id);
CREATE INDEX idx_package_items_business ON package_items(business_id);

CREATE TABLE package_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    package_id   UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    collected_by UUID NOT NULL REFERENCES users(id),
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method       VARCHAR(50) NOT NULL DEFAULT 'cash',
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_package_payments_package  ON package_payments(package_id);
CREATE INDEX idx_package_payments_business ON package_payments(business_id, created_at);


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
CREATE TRIGGER trg_agents_updated_at   BEFORE UPDATE ON agents   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_visa_updated_at     BEFORE UPDATE ON visa_applications FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_packages_updated_at BEFORE UPDATE ON packages FOR EACH ROW EXECUTE FUNCTION update_updated_at();

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



-- ============================================================
-- Accounts, ledger, refunds, cargo, cancellations, tax
--
-- Byte-identical to migrations v11–v18. All idempotent and order-safe.
-- ============================================================

-- ── 1. The accounts ──────────────────────────────────────────
--
-- One row per place money can sit. Seeded with the agency's real accounts
-- but editable, because banks come and go.
--
-- `kind` exists only for grouping and iconography in the UI. The arithmetic
-- treats every account identically — a balance is a balance.
CREATE TABLE IF NOT EXISTS payment_accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    kind            VARCHAR(20)  NOT NULL DEFAULT 'bank',
    -- What the account held before TAMS started tracking it. Zero for a
    -- fresh install; set it and the system balance lines up with the real
    -- statement instead of sitting below it by whatever was already there.
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    opening_date    DATE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Two accounts with the same name in one agency would make the ledger
    -- ambiguous to read, which defeats the purpose.
    CONSTRAINT uq_payment_account_name UNIQUE (business_id, name)
);

CREATE INDEX IF NOT EXISTS idx_payment_accounts_business
    ON payment_accounts(business_id, is_active, sort_order);

-- The standard set, in one place so the backfill below and the trigger that
-- handles future businesses can never drift apart.
CREATE OR REPLACE FUNCTION seed_payment_accounts(p_business_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    a RECORD;
BEGIN
    FOR a IN
        SELECT * FROM (VALUES
            ('Cash',            'cash',     0),
            ('Premier Bank',    'bank',    10),
            ('Salaam Bank',     'bank',    20),
            ('Amal Bank',       'bank',    30),
            ('MyBank',          'bank',    40),
            ('Dahabshiil Bank', 'bank',    50),
            ('IBS Bank',        'bank',    60),
            ('SOMBANK',         'bank',    70),
            ('Merchant',        'merchant',80),
            ('EVC',             'mobile',  90),
            ('EDahab',          'mobile', 100)
        ) AS t(name, kind, sort_order)
    LOOP
        INSERT INTO payment_accounts (business_id, name, kind, sort_order)
        VALUES (p_business_id, a.name, a.kind, a.sort_order)
        ON CONFLICT (business_id, name) DO NOTHING;
    END LOOP;
END
$$;

-- Every business that exists today.
DO $seed$
DECLARE b RECORD;
BEGIN
    FOR b IN SELECT id FROM businesses LOOP
        PERFORM seed_payment_accounts(b.id);
    END LOOP;
END
$seed$;

-- And every business created from now on. A trigger rather than a line in
-- the business-creation controller, because a new agency with no accounts
-- could take money that lands nowhere — and that failure would be silent
-- until someone tried to reconcile a month later.
CREATE OR REPLACE FUNCTION trg_seed_payment_accounts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM seed_payment_accounts(NEW.id);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS seed_accounts_on_new_business ON businesses;
CREATE TRIGGER seed_accounts_on_new_business
    AFTER INSERT ON businesses
    FOR EACH ROW EXECUTE FUNCTION trg_seed_payment_accounts();

-- ── 2. Point every movement at an account ────────────────────
--
-- Nullable on purpose. Rows written before this migration have no account,
-- and inventing one for them would be fabricating financial history. They
-- show in the ledger as "Unassigned" until someone says where they went.
ALTER TABLE ticket_payments  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE visa_payments    ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE package_payments ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE airline_payments ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE agent_payments   ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;
ALTER TABLE expenses         ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT;

-- ON DELETE RESTRICT, not CASCADE or SET NULL: deleting an account that has
-- transactions must fail loudly. Silently erasing or orphaning financial
-- records is exactly the failure this whole migration exists to prevent.

CREATE INDEX IF NOT EXISTS idx_ticket_payments_account  ON ticket_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_visa_payments_account    ON visa_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_package_payments_account ON package_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_airline_payments_account ON airline_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_agent_payments_account   ON agent_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_expenses_account         ON expenses(account_id);

-- Backfill only where the old text is unambiguous. 'cash' means Cash and
-- 'edahab' means EDahab; 'bank' and 'other' could be any of eight and are
-- deliberately left alone rather than guessed at.
DO $backfill$
DECLARE
    m RECORD;
BEGIN
    FOR m IN
        SELECT * FROM (VALUES
            ('cash',   'Cash'),
            ('edahab', 'EDahab'),
            ('evc',    'EVC')
        ) AS t(old_method, account_name)
    LOOP
        UPDATE ticket_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE visa_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE package_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE airline_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE agent_payments p SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = p.business_id AND a.name = m.account_name
           AND p.account_id IS NULL AND LOWER(TRIM(p.method)) = m.old_method;

        UPDATE expenses e SET account_id = a.id
          FROM payment_accounts a
         WHERE a.business_id = e.business_id AND a.name = m.account_name
           AND e.account_id IS NULL AND LOWER(TRIM(e.payment_method)) = m.old_method;
    END LOOP;
END
$backfill$;

-- ── 3. Cargo payments ────────────────────────────────────────
--
-- Cargo only ever stored a running amount_paid on the shipment. No record of
-- when a payment arrived, which account took it, or who collected it — so
-- cargo money could not appear in a ledger at all. This gives it the same
-- treatment tickets, visas and packages already had.
CREATE TABLE IF NOT EXISTS cargo_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    cargo_id     UUID NOT NULL REFERENCES cargo_shipments(id) ON DELETE CASCADE,
    collected_by UUID REFERENCES users(id),
    account_id   UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method       VARCHAR(50) DEFAULT 'cash',
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cargo_payments_cargo    ON cargo_payments(cargo_id);
CREATE INDEX IF NOT EXISTS idx_cargo_payments_business ON cargo_payments(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cargo_payments_account  ON cargo_payments(account_id);

-- Existing shipments carry a paid total with no history behind it. Create one
-- opening row each so the ledger and the shipment agree, marked plainly as a
-- reconstruction rather than passed off as a real receipt.
INSERT INTO cargo_payments (business_id, cargo_id, amount, method, note, created_at)
SELECT cs.business_id, cs.id, cs.amount_paid, 'cash',
       'Opening balance carried over from before payment tracking', cs.created_at
  FROM cargo_shipments cs
 WHERE cs.amount_paid > 0
   AND NOT EXISTS (SELECT 1 FROM cargo_payments p WHERE p.cargo_id = cs.id);

-- ── 3b. Allow corrections ────────────────────────────────────
--
-- Every payments table insisted amount > 0. That is fine while money only
-- ever arrives, but the edit forms let someone change what a customer has
-- paid — correcting a typo, or recording a refund. When that happens the
-- ledger needs a row for the difference, and the difference can be negative.
--
-- Without this, a downward correction would leave the shipment saying one
-- thing and the ledger another, and the balance would silently be wrong.
-- Zero is still forbidden: a movement of nothing is not an event.
DO $relax$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT con.conname, rel.relname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
         WHERE n.nspname = 'public'
           AND con.contype = 'c'
           AND rel.relname IN ('ticket_payments','visa_payments',
                               'package_payments','cargo_payments')
           AND pg_get_constraintdef(con.oid) ILIKE '%amount > (0)%'
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.relname, c.conname);
    END LOOP;

    FOR c IN
        SELECT unnest(ARRAY['ticket_payments','visa_payments',
                            'package_payments','cargo_payments']) AS relname
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint con
              JOIN pg_class rel ON rel.oid = con.conrelid
             WHERE rel.relname = c.relname
               AND con.conname = c.relname || '_amount_nonzero'
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I ADD CONSTRAINT %I CHECK (amount <> 0)',
                c.relname, c.relname || '_amount_nonzero');
        END IF;
    END LOOP;
END
$relax$;

-- ── 4. Transfers between your own accounts ───────────────────
--
-- Withdrawing EVC into Premier Bank is not income and not an expense — the
-- agency is no richer. Recording it as a movement with two ends keeps both
-- balances right while leaving the total untouched. Without this, every
-- transfer would look like money appearing from nowhere in one account and
-- vanishing from another.
CREATE TABLE IF NOT EXISTS account_transfers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    from_account_id UUID NOT NULL REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    to_account_id   UUID NOT NULL REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    -- Some services charge to move money. Charged to the sending account and
    -- treated as an expense, because unlike the transfer itself it is a real
    -- loss to the business.
    fee             NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
    transferred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reference       VARCHAR(100),
    note            TEXT,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_transfer_distinct CHECK (from_account_id <> to_account_id)
);

CREATE INDEX IF NOT EXISTS idx_transfers_business ON account_transfers(business_id, transferred_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_from     ON account_transfers(from_account_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to       ON account_transfers(to_account_id);

-- ── 5. The ledger ────────────────────────────────────────────
--
-- Every movement of money in the business, from eight sources, in one shape:
--
--   direction  'in' or 'out', from the agency's point of view
--   party      who the money was with — customer, airline, agent, vendor
--   source     which part of the business it came from
--   source_id  the record it belongs to, so the UI can link straight to it
--
-- A single view rather than eight queries stitched together in JavaScript,
-- because the balance and the ledger must be computed the same way or they
-- will eventually disagree — and when they disagree, nobody can tell which
-- one is lying.
--
-- Transfers appear as two rows, one 'out' and one 'in'. The pair cancels in
-- any total across all accounts, which is exactly right: moving your own
-- money between your own accounts makes the business no richer.
-- Drop the dependent view first. v_account_balance is built ON v_cash_ledger,
-- so dropping the ledger while the balance view still refers to it fails —
-- which only shows up the *second* time this migration runs, when both
-- already exist.
DROP VIEW IF EXISTS v_account_balance;
DROP VIEW IF EXISTS v_cash_ledger;
CREATE VIEW v_cash_ledger AS

-- Money in: customers paying for tickets
SELECT p.business_id, p.account_id, p.id AS movement_id,
       'in'::TEXT AS direction, p.amount, p.created_at AS occurred_at,
       'ticket'::TEXT AS source, p.ticket_id AS source_id,
       COALESCE(t.passenger_name, 'Ticket') AS party,
       NULLIF(t.ticket_reference, '') AS reference,
       p.note, p.collected_by AS user_id, p.method AS legacy_method
  FROM ticket_payments p
  LEFT JOIN tickets t ON t.id = p.ticket_id

UNION ALL

-- Money in: visa fees
SELECT p.business_id, p.account_id, p.id,
       'in', p.amount, p.created_at,
       'visa', p.visa_id,
       COALESCE(v.applicant_name, 'Visa'),
       v.destination_country,
       p.note, p.collected_by, p.method
  FROM visa_payments p
  LEFT JOIN visa_applications v ON v.id = p.visa_id

UNION ALL

-- Money in: Hajj, Umrah and other packages
SELECT p.business_id, p.account_id, p.id,
       'in', p.amount, p.created_at,
       'package', p.package_id,
       COALESCE(NULLIF(pk.lead_name, ''), pk.label, 'Package'),
       pk.label,
       p.note, p.collected_by, p.method
  FROM package_payments p
  LEFT JOIN packages pk ON pk.id = p.package_id

UNION ALL

-- Money in: cargo
SELECT p.business_id, p.account_id, p.id,
       'in', p.amount, p.created_at,
       'cargo', p.cargo_id,
       COALESCE(cs.sender_name, 'Cargo'),
       cs.tracking_number,
       p.note, p.collected_by, p.method
  FROM cargo_payments p
  LEFT JOIN cargo_shipments cs ON cs.id = p.cargo_id

UNION ALL

-- Money out: paying airlines for ticket stock
SELECT p.business_id, p.account_id, p.id,
       'out', p.amount, p.created_at,
       'airline', p.airline_id,
       COALESCE(a.name, 'Airline'),
       p.reference,
       NULL, NULL, p.method
  FROM airline_payments p
  LEFT JOIN airlines a ON a.id = p.airline_id

UNION ALL

-- Money out: agent commission
SELECT p.business_id, p.account_id, p.id,
       'out', p.amount, p.created_at,
       'agent', p.agent_id,
       COALESCE(ag.name, 'Agent'),
       p.reference,
       NULL, NULL, p.method
  FROM agent_payments p
  LEFT JOIN agents ag ON ag.id = p.agent_id

UNION ALL

-- Money out: running costs
-- expense_date is a DATE; cast so every row in the view shares one type.
SELECT e.business_id, e.account_id, e.id,
       'out', e.amount, e.expense_date::TIMESTAMPTZ,
       'expense', e.id,
       COALESCE(NULLIF(e.vendor, ''), e.description),
       e.reference,
       e.notes, e.created_by, e.payment_method
  FROM expenses e

UNION ALL

-- Transfers, leaving one account…
SELECT tr.business_id, tr.from_account_id, tr.id,
       'out', tr.amount + tr.fee, tr.transferred_at,
       'transfer_out', tr.id,
       'Transfer to ' || COALESCE(dest.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts dest ON dest.id = tr.to_account_id

UNION ALL

-- …and arriving in another. The fee stays with the sender, so the amount
-- landing is the transfer amount alone.
SELECT tr.business_id, tr.to_account_id, tr.id,
       'in', tr.amount, tr.transferred_at,
       'transfer_in', tr.id,
       'Transfer from ' || COALESCE(src.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts src ON src.id = tr.from_account_id;

-- ── 6. What each account should hold ─────────────────────────
--
-- Derived from the ledger rather than kept as a running total on the account
-- row. A stored balance is one failed update away from being wrong forever,
-- and nothing would reveal it; a derived one cannot drift from the movements
-- it is made of.
CREATE VIEW v_account_balance AS
SELECT a.id AS account_id,
       a.business_id,
       a.name,
       a.kind,
       a.is_active,
       a.sort_order,
       a.opening_balance,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'),  0) AS total_in,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS total_out,
       a.opening_balance
         + COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'),  0)
         - COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS balance,
       COUNT(l.movement_id) AS movement_count,
       MAX(l.occurred_at)   AS last_movement_at
  FROM payment_accounts a
  LEFT JOIN v_cash_ledger l ON l.account_id = a.id
 GROUP BY a.id, a.business_id, a.name, a.kind, a.is_active,
          a.sort_order, a.opening_balance;

-- ── 1. What the cancellation earned ──────────────────────────
--
-- The sale itself stops counting once a ticket is cancelled, but the fee
-- retained is real income and has to survive somewhere. Keeping it on the
-- ticket means the money and the booking it came from never drift apart.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancellation_fee NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS refunded_amount  NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS airline_refund   NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancelled_at     TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancel_reason    TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancelled_by     UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_tickets_cancelled
    ON tickets(business_id, cancelled_at DESC)
    WHERE cancelled_at IS NOT NULL;

-- ── 2. Money can now flow backwards ──────────────────────────
--
-- An airline refunding a cancelled fare is a payment in reverse. Rather than
-- add a second table for reversals, the existing payment tables accept a
-- negative amount — one row type, one place to look, and the arithmetic
-- takes care of itself.
--
-- Zero stays forbidden everywhere: a movement of nothing is not an event.
DO $relax$
DECLARE
    c RECORD;
    tables TEXT[] := ARRAY['airline_payments','agent_payments'];
    t TEXT;
BEGIN
    FOR c IN
        SELECT con.conname, rel.relname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
         WHERE n.nspname = 'public'
           AND con.contype = 'c'
           AND rel.relname = ANY(tables)
           AND pg_get_constraintdef(con.oid) ILIKE '%amount > (0)%'
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.relname, c.conname);
    END LOOP;

    FOREACH t IN ARRAY tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint con
              JOIN pg_class rel ON rel.oid = con.conrelid
             WHERE rel.relname = t AND con.conname = t || '_amount_nonzero'
        ) THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (amount <> 0)',
                           t, t || '_amount_nonzero');
        END IF;
    END LOOP;
END
$relax$;

-- ── 3. The ledger reads the sign ─────────────────────────────
--
-- Until now each source had a fixed direction: a ticket payment was always
-- money in, an airline payment always money out. Refunds break that. A
-- refund to a customer is a negative ticket payment, and showing it as
-- "in −$500" is both ugly and easy to misread.
--
-- So direction is now derived from the sign, and the amount is always
-- positive. The arithmetic is unchanged — "in −500" and "out 500" net
-- identically — but every row now reads the way it happened.
DROP VIEW IF EXISTS v_account_balance;
DROP VIEW IF EXISTS v_cash_ledger;

CREATE VIEW v_cash_ledger AS

-- Customers paying for tickets. Negative = refunded to them.
SELECT p.business_id, p.account_id, p.id AS movement_id,
       CASE WHEN p.amount >= 0 THEN 'in' ELSE 'out' END::TEXT AS direction,
       ABS(p.amount) AS amount, p.created_at AS occurred_at,
       'ticket'::TEXT AS source, p.ticket_id AS source_id,
       COALESCE(t.passenger_name, 'Ticket') AS party,
       NULLIF(t.ticket_reference, '') AS reference,
       p.note, p.collected_by AS user_id, p.method AS legacy_method
  FROM ticket_payments p
  LEFT JOIN tickets t ON t.id = p.ticket_id

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

UNION ALL

-- Paying airlines. Negative = the airline refunded us.
SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(p.amount), p.created_at,
       'airline', p.airline_id,
       COALESCE(a.name, 'Airline'),
       p.reference,
       NULL, NULL, p.method
  FROM airline_payments p
  LEFT JOIN airlines a ON a.id = p.airline_id

UNION ALL

-- Agent commission. Negative = commission clawed back.
SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(p.amount), p.created_at,
       'agent', p.agent_id,
       COALESCE(ag.name, 'Agent'),
       p.reference,
       NULL, NULL, p.method
  FROM agent_payments p
  LEFT JOIN agents ag ON ag.id = p.agent_id

UNION ALL

SELECT e.business_id, e.account_id, e.id,
       CASE WHEN e.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(e.amount), e.expense_date::TIMESTAMPTZ,
       'expense', e.id,
       COALESCE(NULLIF(e.vendor, ''), e.description),
       e.reference,
       e.notes, e.created_by, e.payment_method
  FROM expenses e

UNION ALL

SELECT tr.business_id, tr.from_account_id, tr.id,
       'out', tr.amount + tr.fee, tr.transferred_at,
       'transfer_out', tr.id,
       'Transfer to ' || COALESCE(dest.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts dest ON dest.id = tr.to_account_id

UNION ALL

SELECT tr.business_id, tr.to_account_id, tr.id,
       'in', tr.amount, tr.transferred_at,
       'transfer_in', tr.id,
       'Transfer from ' || COALESCE(src.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts src ON src.id = tr.from_account_id;

CREATE VIEW v_account_balance AS
SELECT a.id AS account_id,
       a.business_id,
       a.name,
       a.kind,
       a.is_active,
       a.sort_order,
       a.opening_balance,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'),  0) AS total_in,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS total_out,
       a.opening_balance
         + COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'),  0)
         - COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS balance,
       COUNT(l.movement_id) AS movement_count,
       MAX(l.occurred_at)   AS last_movement_at
  FROM payment_accounts a
  LEFT JOIN v_cash_ledger l ON l.account_id = a.id
 GROUP BY a.id, a.business_id, a.name, a.kind, a.is_active,
          a.sort_order, a.opening_balance;

-- ── 1. Flexible pricing ──────────────────────────────────────
--
-- total_price is a generated column, so its formula can't be altered in
-- place — the column has to be dropped and rebuilt, and the two views that
-- read it dropped with it. Nothing is lost: a generated column stores no
-- independent data, and every existing row has a weight and a rate, so the
-- rebuilt values come out identical.
DROP VIEW IF EXISTS v_receivables;
DROP VIEW IF EXISTS v_monthly_income;

ALTER TABLE cargo_shipments DROP COLUMN IF EXISTS total_price;

-- A price typed directly, for goods nobody weighs.
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS flat_price NUMERIC(12,2);

-- These three were mandatory because every shipment was assumed to be
-- weighed. That assumption was wrong.
ALTER TABLE cargo_shipments ALTER COLUMN weight_kg        DROP NOT NULL;
ALTER TABLE cargo_shipments ALTER COLUMN price_per_kg     DROP NOT NULL;
ALTER TABLE cargo_shipments ALTER COLUMN item_description DROP NOT NULL;

-- A typed price wins when present; otherwise fall back to weight × rate.
-- Still generated, so the total can never drift from the numbers behind it,
-- and every existing query that reads total_price keeps working untouched.
ALTER TABLE cargo_shipments
    ADD COLUMN total_price NUMERIC(12,2)
    GENERATED ALWAYS AS (
        COALESCE(flat_price, weight_kg * price_per_kg, 0)
    ) STORED;

-- ── 2. Where it landed ───────────────────────────────────────
--
-- Typed per shipment rather than chosen from a list of offices. That means
-- the same office may be spelled differently on different shipments, but it
-- needs no setup before the feature is usable.
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS arrived_city    VARCHAR(255);
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS arrived_office  VARCHAR(255);
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS arrived_phone   VARCHAR(50);
ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS arrived_at      TIMESTAMPTZ;

-- ── 3. Public tracking ───────────────────────────────────────
--
-- The tracking number is the only thing a customer will have, and they will
-- type it with spaces, lower case, and sometimes a stray dash. Indexing the
-- normalised form means a lookup stays fast however they type it.
CREATE INDEX IF NOT EXISTS idx_cargo_tracking_lookup
    ON cargo_shipments (UPPER(REPLACE(REPLACE(tracking_number, ' ', ''), '-', '')));

-- ── 4. Rebuild the views, unchanged ──────────────────────────
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

-- ── 1. What was given up on ──────────────────────────────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS written_off NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ── 2. Tax paid over to the authority ────────────────────────
CREATE TABLE IF NOT EXISTS tax_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id   UUID REFERENCES payment_accounts(id) ON DELETE RESTRICT,
    paid_by      UUID REFERENCES users(id),
    amount       NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
    -- Which period the payment covers, for the agency's own records. The
    -- balance is computed from everything, not from these labels.
    period_from  DATE,
    period_to    DATE,
    reference    VARCHAR(100),
    note         TEXT,
    paid_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_payments_business ON tax_payments(business_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_tax_payments_account  ON tax_payments(account_id);

-- ── 3. The airline no longer gets the tax ────────────────────
--
-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW can
-- only append columns, and total_tax belongs next to total_cost where it
-- can be read alongside it.
--
-- Sections 3 and 4 are skipped once v17 has run. v17 supersedes both views
-- by keeping the tax owed on cancelled tickets, and re-running an older
-- migration must never quietly undo a newer one — that is how a fixed bug
-- comes back.
DO $v15$
BEGIN
IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tickets' AND column_name = 'tax_refunded')
THEN RETURN; END IF;

EXECUTE $sql$
DROP VIEW IF EXISTS v_airline_account;
CREATE VIEW v_airline_account AS
SELECT
    a.id                                     AS airline_id,
    a.business_id,
    a.name                                   AS airline_name,
    COALESCE(t.ticket_count, 0)              AS ticket_count,
    COALESCE(t.total_cost, 0)                AS total_cost,
    COALESCE(t.total_tax, 0)                 AS total_tax,
    COALESCE(p.total_paid, 0)                AS total_paid,
    COALESCE(t.total_cost, 0) - COALESCE(p.total_paid, 0) AS balance,
    COALESCE(t.unsettled_tickets, 0)         AS unsettled_tickets,
    p.last_payment_at
FROM airlines a
LEFT JOIN (
    SELECT airline_id, business_id,
           COUNT(*) FILTER (WHERE status <> 'cancelled')  AS ticket_count,
           -- The airline's share only: the fare less the tax that belongs to
           -- the government. A cancelled ticket still costs whatever the
           -- airline didn't give back.
           COALESCE(SUM(
               CASE WHEN status = 'cancelled'
                    THEN GREATEST(cost_price - COALESCE(tax, 0) - COALESCE(airline_refund, 0), 0)
                    ELSE GREATEST(cost_price - COALESCE(tax, 0), 0)
               END), 0)                                    AS total_cost,
           COALESCE(SUM(COALESCE(tax, 0))
                    FILTER (WHERE status <> 'cancelled'), 0) AS total_tax,
           COUNT(*) FILTER (
               WHERE status <> 'cancelled'
                 AND GREATEST(cost_price - COALESCE(tax, 0), 0) > airline_paid
           )                                               AS unsettled_tickets
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

$sql$;

EXECUTE $sql$
-- ── 4. What is owed to the tax authority ─────────────────────
--
-- Accrues on every ticket that stands. (Superseded by v17, which keeps the
-- tax owed on cancelled tickets too: a journey that doesn't happen does not
-- cancel the government's claim. This body only runs on a database that has
-- not reached v17 yet.)
CREATE OR REPLACE VIEW v_tax_account AS
SELECT
    b.id                                        AS business_id,
    COALESCE(t.tax_accrued, 0)                  AS tax_accrued,
    COALESCE(p.tax_paid, 0)                     AS tax_paid,
    COALESCE(t.tax_accrued, 0) - COALESCE(p.tax_paid, 0) AS tax_owed,
    COALESCE(t.taxed_tickets, 0)                AS taxed_tickets,
    p.last_payment_at
FROM businesses b
LEFT JOIN (
    SELECT business_id,
           COALESCE(SUM(COALESCE(tax, 0)), 0) AS tax_accrued,
           COUNT(*) FILTER (WHERE COALESCE(tax, 0) > 0) AS taxed_tickets
    FROM tickets
    WHERE status <> 'cancelled'
    GROUP BY business_id
) t ON t.business_id = b.id
LEFT JOIN (
    SELECT business_id,
           COALESCE(SUM(amount), 0) AS tax_paid,
           MAX(paid_at)             AS last_payment_at
    FROM tax_payments
    GROUP BY business_id
) p ON p.business_id = b.id;

$sql$;
END
$v15$;

-- ── 5. Tax payments belong in the ledger ─────────────────────
--
-- Money leaving an account has to appear in the ledger, or the balance and
-- the movement list stop agreeing — the exact failure this whole design
-- exists to prevent. Rebuilt here with tax added as a ninth source.
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

UNION ALL

SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(p.amount), p.created_at,
       'airline', p.airline_id,
       COALESCE(a.name, 'Airline'),
       p.reference,
       NULL, NULL, p.method
  FROM airline_payments p
  LEFT JOIN airlines a ON a.id = p.airline_id

UNION ALL

SELECT p.business_id, p.account_id, p.id,
       CASE WHEN p.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(p.amount), p.created_at,
       'agent', p.agent_id,
       COALESCE(ag.name, 'Agent'),
       p.reference,
       NULL, NULL, p.method
  FROM agent_payments p
  LEFT JOIN agents ag ON ag.id = p.agent_id

UNION ALL

SELECT e.business_id, e.account_id, e.id,
       CASE WHEN e.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(e.amount), e.expense_date::TIMESTAMPTZ,
       'expense', e.id,
       COALESCE(NULLIF(e.vendor, ''), e.description),
       e.reference,
       e.notes, e.created_by, e.payment_method
  FROM expenses e

UNION ALL

-- Tax handed over to the government.
SELECT tp.business_id, tp.account_id, tp.id,
       CASE WHEN tp.amount >= 0 THEN 'out' ELSE 'in' END,
       ABS(tp.amount), tp.paid_at,
       'tax', tp.id,
       'Tax authority',
       tp.reference, tp.note, tp.paid_by, NULL
  FROM tax_payments tp

UNION ALL

SELECT tr.business_id, tr.from_account_id, tr.id,
       'out', tr.amount + tr.fee, tr.transferred_at,
       'transfer_out', tr.id,
       'Transfer to ' || COALESCE(dest.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts dest ON dest.id = tr.to_account_id

UNION ALL

SELECT tr.business_id, tr.to_account_id, tr.id,
       'in', tr.amount, tr.transferred_at,
       'transfer_in', tr.id,
       'Transfer from ' || COALESCE(src.name, 'account'),
       tr.reference, tr.note, tr.created_by, NULL
  FROM account_transfers tr
  LEFT JOIN payment_accounts src ON src.id = tr.from_account_id;

CREATE VIEW v_account_balance AS
SELECT a.id AS account_id,
       a.business_id,
       a.name,
       a.kind,
       a.is_active,
       a.sort_order,
       a.opening_balance,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'),  0) AS total_in,
       COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS total_out,
       a.opening_balance
         + COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'in'),  0)
         - COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'out'), 0) AS balance,
       COUNT(l.movement_id) AS movement_count,
       MAX(l.occurred_at)   AS last_movement_at
  FROM payment_accounts a
  LEFT JOIN v_cash_ledger l ON l.account_id = a.id
 GROUP BY a.id, a.business_id, a.name, a.kind, a.is_active,
          a.sort_order, a.opening_balance;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS chk_international_fields;

-- ── 1. Tax handed back ───────────────────────────────────────
--
-- Almost always zero. It is not zero when the airline cancels the flight
-- and returns the tax with the fare, at which point the agency passes it
-- to the customer and owes the government nothing. Without somewhere to
-- record that, rule 1 would have the tax section chasing money that has
-- already gone back where it came from.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tax_refunded NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ── 2. Revenue follows the outcome, not the sale ─────────────
--
-- A stored generated column cannot be altered in place, so the column is
-- dropped and rebuilt. Everything it holds is derived, so nothing is
-- lost — Postgres recomputes every row. The two views that read it have
-- to go first and come back after; a view is what makes DROP COLUMN
-- refuse.
-- Sections 2 and 4 are skipped once v18 has run. v18 supersedes both by
-- charging a cancelled ticket only the fare that was actually paid, and
-- re-running an older migration must never quietly undo a newer one — that
-- is how a fixed bug comes back.
DO $v17$
BEGIN
IF EXISTS (
    SELECT 1 FROM pg_attrdef ad
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE ad.adrelid = 'tickets'::regclass AND a.attname = 'revenue'
       AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%airline_paid%')
THEN RETURN; END IF;

EXECUTE $sql$
DROP VIEW IF EXISTS v_group_booking_statement;
DROP VIEW IF EXISTS v_monthly_income;

ALTER TABLE tickets DROP COLUMN IF EXISTS revenue;
ALTER TABLE tickets ADD COLUMN revenue NUMERIC(12,2)
    GENERATED ALWAYS AS (
        CASE
            WHEN status = 'cancelled'
            THEN COALESCE(cancellation_fee, 0)
                 - GREATEST(cost_price - COALESCE(airline_refund, 0), 0)
            ELSE selling_price - cost_price - COALESCE(agent_commission, 0)
        END
    ) STORED;

-- Rebuilt unchanged, on top of the new column.
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

-- Rebuilt unchanged. This is a sales trend, so it still counts only
-- tickets that stand; a cancellation is not a sale and does not belong on
-- a sales line. What it earned or lost is in the income statement.
CREATE VIEW v_monthly_income AS
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

$sql$;
END
$v17$;

-- ── 3. The government is still owed ──────────────────────────
--
-- Every ticket accrues its tax, cancelled or not, less anything actually
-- handed back. The old view filtered cancellations out, so cancelling a
-- ticket made a tax debt disappear from the screen while the money stayed
-- in the agency's account — the books balanced by forgetting.
CREATE OR REPLACE VIEW v_tax_account AS
SELECT
    b.id                                        AS business_id,
    COALESCE(t.tax_accrued, 0)                  AS tax_accrued,
    COALESCE(p.tax_paid, 0)                     AS tax_paid,
    COALESCE(t.tax_accrued, 0) - COALESCE(p.tax_paid, 0) AS tax_owed,
    COALESCE(t.taxed_tickets, 0)                AS taxed_tickets,
    p.last_payment_at
FROM businesses b
LEFT JOIN (
    SELECT business_id,
           COALESCE(SUM(GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0)), 0)
                                                        AS tax_accrued,
           COUNT(*) FILTER (
               WHERE GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0) > 0
           )                                            AS taxed_tickets
    FROM tickets
    GROUP BY business_id
) t ON t.business_id = b.id
LEFT JOIN (
    SELECT business_id,
           COALESCE(SUM(amount), 0) AS tax_paid,
           MAX(paid_at)             AS last_payment_at
    FROM tax_payments
    GROUP BY business_id
) p ON p.business_id = b.id;

DO $v17b$
BEGIN
IF EXISTS (
    SELECT 1 FROM pg_attrdef ad
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE ad.adrelid = 'tickets'::regclass AND a.attname = 'revenue'
       AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%airline_paid%')
THEN RETURN; END IF;

EXECUTE $sql$
-- ── 4. The airline page agrees with it ───────────────────────
--
-- Only total_tax changes: it now reports the tax still owed on every
-- ticket including cancelled ones, so the figure beside the airline
-- balance matches the Tax section instead of contradicting it. The
-- airline's own share is untouched.
DROP VIEW IF EXISTS v_airline_account;
CREATE VIEW v_airline_account AS
SELECT
    a.id                                     AS airline_id,
    a.business_id,
    a.name                                   AS airline_name,
    COALESCE(t.ticket_count, 0)              AS ticket_count,
    COALESCE(t.total_cost, 0)                AS total_cost,
    COALESCE(t.total_tax, 0)                 AS total_tax,
    COALESCE(p.total_paid, 0)                AS total_paid,
    COALESCE(t.total_cost, 0) - COALESCE(p.total_paid, 0) AS balance,
    COALESCE(t.unsettled_tickets, 0)         AS unsettled_tickets,
    p.last_payment_at
FROM airlines a
LEFT JOIN (
    SELECT airline_id, business_id,
           COUNT(*) FILTER (WHERE status <> 'cancelled')  AS ticket_count,
           -- The airline's share only: the fare less the tax that belongs to
           -- the government. A cancelled ticket still costs whatever the
           -- airline didn't give back.
           COALESCE(SUM(
               CASE WHEN status = 'cancelled'
                    THEN GREATEST(cost_price - COALESCE(tax, 0) - COALESCE(airline_refund, 0), 0)
                    ELSE GREATEST(cost_price - COALESCE(tax, 0), 0)
               END), 0)                                    AS total_cost,
           COALESCE(SUM(
               GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0)
           ), 0)                                           AS total_tax,
           COUNT(*) FILTER (
               WHERE status <> 'cancelled'
                 AND GREATEST(cost_price - COALESCE(tax, 0), 0) > airline_paid
           )                                               AS unsettled_tickets
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

$sql$;
END
$v17b$;

-- ── 1. Take the tax back out of every cancellation fee ───────
--
-- amount_paid on a cancelled ticket is what the customer's payments net to
-- after the refund — the money actually kept. The fee is that, less the
-- tax being held for the government. Deriving it from amount_paid instead
-- of subtracting from the existing fee is what makes this safe to re-run.
UPDATE tickets
   SET cancellation_fee = GREATEST(
           COALESCE(amount_paid, 0)
           - GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0), 0)
 WHERE status = 'cancelled';

-- ── 2. Revenue counts the fare that was actually paid ────────
DROP VIEW IF EXISTS v_group_booking_statement;
DROP VIEW IF EXISTS v_monthly_income;

ALTER TABLE tickets DROP COLUMN IF EXISTS revenue;
ALTER TABLE tickets ADD COLUMN revenue NUMERIC(12,2)
    GENERATED ALWAYS AS (
        CASE
            WHEN status = 'cancelled'
            -- The fee kept, less the fare paid out and not returned.
            -- cancellation_fee already excludes the tax, so the tax is not
            -- subtracted again here.
            THEN COALESCE(cancellation_fee, 0)
                 - GREATEST(COALESCE(airline_paid, 0), 0)
            ELSE selling_price - cost_price - COALESCE(agent_commission, 0)
        END
    ) STORED;

-- Rebuilt unchanged.
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

-- Rebuilt unchanged.
CREATE VIEW v_monthly_income AS
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

-- ── 3. The airline is owed nothing on a cancelled ticket ─────
--
-- What was paid stays paid; what was never paid is not owed. Since the
-- cost contributed equals the payments made, a cancelled ticket nets to
-- zero on the airline's balance instead of sitting there as a debt for a
-- seat nobody took.
DROP VIEW IF EXISTS v_airline_account;
CREATE VIEW v_airline_account AS
SELECT
    a.id                                     AS airline_id,
    a.business_id,
    a.name                                   AS airline_name,
    COALESCE(t.ticket_count, 0)              AS ticket_count,
    COALESCE(t.total_cost, 0)                AS total_cost,
    COALESCE(t.total_tax, 0)                 AS total_tax,
    COALESCE(p.total_paid, 0)                AS total_paid,
    COALESCE(t.total_cost, 0) - COALESCE(p.total_paid, 0) AS balance,
    COALESCE(t.unsettled_tickets, 0)         AS unsettled_tickets,
    p.last_payment_at
FROM airlines a
LEFT JOIN (
    SELECT airline_id, business_id,
           COUNT(*) FILTER (WHERE status <> 'cancelled')  AS ticket_count,
           -- Live tickets: the fare, less the tax that belongs to the
           -- government. Cancelled tickets: whatever was actually paid and
           -- not returned, which is what airline_paid now holds.
           COALESCE(SUM(
               CASE WHEN status = 'cancelled'
                    THEN GREATEST(COALESCE(airline_paid, 0), 0)
                    ELSE GREATEST(cost_price - COALESCE(tax, 0), 0)
               END), 0)                                    AS total_cost,
           COALESCE(SUM(
               GREATEST(COALESCE(tax, 0) - COALESCE(tax_refunded, 0), 0)
           ), 0)                                           AS total_tax,
           COUNT(*) FILTER (
               WHERE status <> 'cancelled'
                 AND GREATEST(cost_price - COALESCE(tax, 0), 0) > airline_paid
           )                                               AS unsettled_tickets
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

-- ============================================================
-- migration_v19.sql — the agency's own identity on paper
--
-- Everything here exists to make one document better: the invoice a
-- customer is handed. Until now that page said "TAMS" and nothing about
-- the agency that produced it, and it could not tell the customer where to
-- send the money it was asking for.
--
--   1. businesses.logo_url        the mark printed at the top of the page
--                                 and shown in the sidebar while signed in
--   2. businesses.website         completes the contact strip in the footer
--   3. payment_accounts.account_number
--      payment_accounts.account_holder
--                                 so "Premier Bank" can be printed as an
--                                 account a customer can actually pay into
--
-- Nothing here is required. Every column is nullable and every existing row
-- keeps working untouched — an agency with no logo gets the same layout
-- with a lettermark in place of the image, and an account with no number is
-- simply left off the invoice rather than printed as a blank.
--
-- Safe to run more than once.
-- Run with:  psql -U postgres -d tams_db -f config/migration_v19.sql
-- ============================================================

-- ── 1. Agency branding ───────────────────────────────────────
--
-- logo_url has been in the base schema since v2 but was never populated or
-- read. Declared here with IF NOT EXISTS so a database built from an early
-- dump gains it rather than failing on the UPDATE that would follow.
--
-- It holds a file name, not a path — the same convention tickets and cargo
-- photos already use — so moving UPLOAD_PATH never invalidates stored rows.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website  VARCHAR(255);

-- ── 2. Where a customer can actually send money ──────────────
--
-- An account has always had a name. A name alone is not payable: nobody can
-- send money to "EVC". The number is what makes the payment-methods strip
-- at the foot of an invoice useful rather than decorative.
--
-- account_holder is separate from the agency name on purpose. Mobile-money
-- and merchant accounts in Somalia are frequently registered to a director
-- personally, and printing the agency's name over a personal account is how
-- a customer decides the invoice is wrong and phones to check.
--
-- Guarded, because payment_accounts only exists once migration_v11 has run.
-- Without the guard this file would fail outright on an older database
-- instead of doing the part it can.
DO $v19$
BEGIN
    IF to_regclass('public.payment_accounts') IS NULL THEN
        RAISE NOTICE
            '[v19] payment_accounts not found — run migration_v11.sql first. '
            'Skipping the account-number columns; the rest of v19 applied.';
        RETURN;
    END IF;

    EXECUTE $sql$
        ALTER TABLE payment_accounts
            ADD COLUMN IF NOT EXISTS account_number VARCHAR(100);
        ALTER TABLE payment_accounts
            ADD COLUMN IF NOT EXISTS account_holder VARCHAR(150);
    $sql$;
END
$v19$;

-- ============================================================
-- migration_v20.sql — icons on accounts, titles on people
--
-- Two more columns, both in service of the same document as v19: the
-- invoice a customer is handed.
--
--   1. payment_accounts.icon_url
--
--      A bank is recognised by its mark long before anyone reads its name.
--      An invoice that says "Premier Bank / 301016651001" makes a customer
--      read; one that shows the bank's logo beside the number makes them
--      recognise. The column holds a file name, like every other upload in
--      TAMS, so moving UPLOAD_PATH never invalidates a stored row.
--
--   2. users.title
--
--      A role is an access level — 'admin' says what someone may change in
--      this system, and means nothing to a customer. A title is what the
--      person actually does: Operations Director, Sales Manager. The
--      invoice is signed by a person, so it should carry the title.
--
--      The two stay separate on purpose. Collapsing them would tie what
--      someone is allowed to do to what their business card says, and the
--      first time a Sales Manager needed to approve a refund somebody would
--      be handed admin rights to fix a job title.
--
-- Both nullable, both optional. An account with no icon falls back to its
-- name; a user with no title falls back to their role, exactly as before.
--
-- Safe to run more than once.
-- Run with:  psql -U postgres -d tams_db -f config/migration_v20.sql
-- ============================================================

-- ── 1. The mark shown beside an account on an invoice ────────
--
-- Guarded: payment_accounts only exists once migration_v11 has run, and
-- failing the whole file would take the users.title column down with it.
DO $v20$
BEGIN
    IF to_regclass('public.payment_accounts') IS NULL THEN
        RAISE NOTICE
            '[v20] payment_accounts not found — run migration_v11.sql first. '
            'Skipping icon_url; the rest of v20 applied.';
    ELSE
        EXECUTE 'ALTER TABLE payment_accounts
                   ADD COLUMN IF NOT EXISTS icon_url VARCHAR(500)';
    END IF;
END
$v20$;

-- ── 2. What a person's job is called ─────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS title VARCHAR(120);

COMMENT ON COLUMN users.title IS
  'Job title shown to customers (e.g. Operations Director). Distinct from '
  'role, which is the access level and is never shown outside the system.';
