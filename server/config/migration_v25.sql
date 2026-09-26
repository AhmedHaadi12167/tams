-- Record why an unpaid ticket was permanently removed.
-- Paid or otherwise settled tickets are kept and must use cancellation.

BEGIN;

CREATE TABLE IF NOT EXISTS ticket_deletion_audit (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    ticket_id        UUID NOT NULL,
    passenger_name   VARCHAR(255) NOT NULL,
    ticket_reference VARCHAR(100),
    reason           TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    deleted_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    deleted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_deletion_audit_business
    ON ticket_deletion_audit(business_id, deleted_at DESC);

COMMIT;