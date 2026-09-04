-- ============================================================
-- TAMS v7 Migration — Cargo item photo
-- One proof-of-condition photo per shipment, taken with the
-- device camera or picked from a file.
--
-- Safe to run multiple times (idempotent).
-- Run with:  psql -U postgres -d tams_db -f config/migration_v7.sql
-- ============================================================

ALTER TABLE cargo_shipments ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500);

DO $$ BEGIN
    RAISE NOTICE 'cargo_shipments.photo_url ready.';
END $$;
