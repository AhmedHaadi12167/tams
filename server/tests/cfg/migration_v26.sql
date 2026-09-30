-- Preserve a snapshot and reason when an opening receivable/payable is deleted.
-- Existing opening balances and collection history are not changed.

BEGIN;

CREATE TABLE IF NOT EXISTS opening_balance_deletion_audit (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    opening_item_id UUID NOT NULL,
    balance_type TEXT NOT NULL CHECK (balance_type IN ('receivable', 'payable')),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    entry_date DATE NOT NULL,
    deletion_reason TEXT NOT NULL CHECK (length(trim(deletion_reason)) > 0),
    deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opening_balance_deletion_business
    ON opening_balance_deletion_audit(business_id, deleted_at DESC);

COMMIT;