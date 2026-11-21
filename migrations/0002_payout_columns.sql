ALTER TABLE ledger_entries ADD COLUMN payout_tx TEXT;
ALTER TABLE ledger_entries ADD COLUMN payout_run_id TEXT;
ALTER TABLE ledger_entries ADD COLUMN paid_at TEXT;
CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger_entries(status);
