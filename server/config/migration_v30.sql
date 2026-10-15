-- Run with: psql -U postgres -d tams_db -v ON_ERROR_STOP=1 -f config/migration_v30.sql
BEGIN;

-- Passenger category and saved airport choices for ticket bookings.
ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS passenger_type VARCHAR(10) NOT NULL DEFAULT 'adult'
    CHECK (passenger_type IN ('adult', 'child', 'infant'));

CREATE TABLE IF NOT EXISTS ticket_cities (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    city_name    VARCHAR(150) NOT NULL,
    airport_name VARCHAR(255) NOT NULL,
    iata_code    VARCHAR(3) NOT NULL,
    country_code VARCHAR(2) NOT NULL,
    airport_type VARCHAR(30) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ticket_cities_business_iata UNIQUE (business_id, iata_code)
);

CREATE INDEX IF NOT EXISTS idx_ticket_cities_business_name
    ON ticket_cities (business_id, city_name);

COMMIT;
