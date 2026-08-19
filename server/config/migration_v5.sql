-- ============================================================
-- TAMS v5 Migration — Airline master list & duplicate merge
-- Safe to run multiple times (idempotent).
-- Run with:  psql -U postgres -d tams_db -f config/migration_v5.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- airline_match_key(text)
-- Turns whatever an agent typed into a comparable key.
--   'Star Airlines'  -> 'STAR'
--   'star airline '  -> 'STAR'
--   'STAR  AIRWAYS'  -> 'STAR'
--   'Fly Dubai'      -> 'FLYDUBAI'
-- Strips punctuation, collapses whitespace, drops a trailing
-- airline/airlines/airways/airway/air/aviation word, then removes
-- the remaining spaces so 'Fly Dubai' and 'FlyDubai' agree.
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
-- airlines — one row per carrier per agency
-- ============================================================
CREATE TABLE IF NOT EXISTS airlines (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_airlines_business_key
    ON airlines(business_id, match_key);
CREATE INDEX IF NOT EXISTS idx_airlines_business ON airlines(business_id);
CREATE INDEX IF NOT EXISTS idx_airlines_name     ON airlines(business_id, name);

DO $$ BEGIN
    CREATE TRIGGER trg_airlines_updated_at
        BEFORE UPDATE ON airlines
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- link tickets to the master row (name column stays as the display value)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS airline_id UUID
    REFERENCES airlines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_airline_id ON tickets(airline_id);

-- ============================================================
-- Backfill + merge, reporting what changed
-- ============================================================
DO $$
DECLARE
    rec       RECORD;
    merged    INTEGER := 0;
    created   INTEGER := 0;
    relinked  INTEGER := 0;
BEGIN
    -- 1. For every distinct match_key, pick the winning spelling:
    --    the variant used on the most tickets (ties -> longest name,
    --    which is usually the fuller 'Airlines' form).
    FOR rec IN
        SELECT DISTINCT ON (t.business_id, airline_match_key(t.airline_name))
               t.business_id,
               airline_match_key(t.airline_name) AS key,
               t.airline_name                    AS winner
        FROM tickets t
        WHERE t.airline_name IS NOT NULL AND TRIM(t.airline_name) <> ''
        GROUP BY t.business_id, airline_match_key(t.airline_name), t.airline_name
        ORDER BY t.business_id,
                 airline_match_key(t.airline_name),
                 COUNT(*) DESC,
                 LENGTH(t.airline_name) DESC,
                 t.airline_name ASC
    LOOP
        INSERT INTO airlines (business_id, name, match_key)
        VALUES (rec.business_id, rec.winner, rec.key)
        ON CONFLICT (business_id, match_key) DO NOTHING;
        IF FOUND THEN created := created + 1; END IF;
    END LOOP;

    -- 2. Report duplicates before rewriting them
    RAISE NOTICE '--- Airline duplicates being merged -------------------';
    FOR rec IN
        SELECT t.business_id,
               airline_match_key(t.airline_name) AS key,
               STRING_AGG(DISTINCT t.airline_name, '  |  ') AS variants,
               COUNT(DISTINCT t.airline_name) AS variant_count,
               COUNT(*) AS ticket_count
        FROM tickets t
        WHERE t.airline_name IS NOT NULL AND TRIM(t.airline_name) <> ''
        GROUP BY t.business_id, airline_match_key(t.airline_name)
        HAVING COUNT(DISTINCT t.airline_name) > 1
        ORDER BY COUNT(*) DESC
    LOOP
        RAISE NOTICE '  % variants over % tickets:  %',
            rec.variant_count, rec.ticket_count, rec.variants;
        merged := merged + rec.variant_count - 1;
    END LOOP;
    IF merged = 0 THEN
        RAISE NOTICE '  (none found — your airline names were already consistent)';
    END IF;
    RAISE NOTICE '-------------------------------------------------------';

    -- 3. Point every ticket at its master row and adopt the winning spelling
    UPDATE tickets t
    SET airline_id   = a.id,
        airline_name = a.name
    FROM airlines a
    WHERE a.business_id = t.business_id
      AND a.match_key   = airline_match_key(t.airline_name)
      AND (t.airline_id IS DISTINCT FROM a.id OR t.airline_name <> a.name);
    GET DIAGNOSTICS relinked = ROW_COUNT;

    RAISE NOTICE 'Airlines created: %   ·   duplicate spellings merged: %   ·   tickets updated: %',
        created, merged, relinked;
END $$;

-- ============================================================
-- Keep booking_groups display names consistent too
-- ============================================================
UPDATE booking_groups bg
SET airline_name = a.name
FROM airlines a
WHERE a.business_id = bg.business_id
  AND bg.airline_name IS NOT NULL
  AND a.match_key = airline_match_key(bg.airline_name)
  AND bg.airline_name <> a.name;
