ALTER TABLE finance_sync_runs ADD COLUMN store_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE finance_sync_runs ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'rebuild';

CREATE INDEX IF NOT EXISTS finance_sync_runs_scope_idx
  ON finance_sync_runs (from_date, to_date, state, created_at_ms DESC);
