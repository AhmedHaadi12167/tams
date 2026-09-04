-- ============================================================
-- migration_v16.sql — the passport number becomes optional
--
-- The database refused to save an international ticket without a passport
-- number. That reads as sensible and isn't: a booking is often made from a
-- phone call, with the document details following later. Refusing the sale
-- until the passport is to hand doesn't make the agency more careful, it
-- makes staff type something false into the box to get past it — which is
-- worse than leaving it empty, because a wrong passport number looks like a
-- right one.
--
-- The field stays on the form. It simply no longer blocks the booking.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS chk_international_fields;

COMMIT;
