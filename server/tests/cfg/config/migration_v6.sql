-- ============================================================
-- TAMS v6 Migration — Airline aliases
-- Lets "THY", "TK" or "Turkish Air" resolve to Turkish Airlines.
-- Normalisation alone can't do this: they're different words, not
-- different spellings.
--
-- Safe to run multiple times (idempotent).
-- Requires migration_v5.sql to have been run first.
-- Run with:  psql -U postgres -d tams_db -f config/migration_v6.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$ BEGIN
    IF to_regclass('public.airlines') IS NULL THEN
        RAISE EXCEPTION 'The airlines table is missing. Run migration_v5.sql before this one.';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS airline_aliases (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    airline_id  UUID NOT NULL REFERENCES airlines(id) ON DELETE CASCADE,
    alias       VARCHAR(255) NOT NULL,
    match_key   VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One alias key per agency, so an alias can never point at two carriers
CREATE UNIQUE INDEX IF NOT EXISTS idx_airline_aliases_key
    ON airline_aliases(business_id, match_key);
CREATE INDEX IF NOT EXISTS idx_airline_aliases_airline
    ON airline_aliases(airline_id);

-- An alias must not collide with a real airline name in the same agency.
-- Enforced in the application (airlineController) because a cross-table
-- unique constraint isn't expressible here.

-- ── IATA code doubles as an alias ───────────────────────────
-- Where an airline already has a code recorded, register it as an alias
-- so a ticket showing only "TK" resolves.
INSERT INTO airline_aliases (business_id, airline_id, alias, match_key)
SELECT a.business_id, a.id, a.iata_code, airline_match_key(a.iata_code)
FROM airlines a
WHERE a.iata_code IS NOT NULL
  AND TRIM(a.iata_code) <> ''
  AND airline_match_key(a.iata_code) IS NOT NULL
  -- skip if that key is already taken by an airline name or another alias
  AND NOT EXISTS (
      SELECT 1 FROM airlines x
      WHERE x.business_id = a.business_id
        AND x.match_key = airline_match_key(a.iata_code)
  )
ON CONFLICT (business_id, match_key) DO NOTHING;

DO $$
DECLARE n INTEGER;
BEGIN
    SELECT COUNT(*) INTO n FROM airline_aliases;
    RAISE NOTICE 'airline_aliases ready — % alias(es) registered.', n;
    RAISE NOTICE 'Add more from the Airlines page: Manage & merge -> Aliases.';
END $$;
