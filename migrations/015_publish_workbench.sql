ALTER TABLE resell_tasks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'follow_sell';
ALTER TABLE resell_tasks ADD COLUMN source_snapshot_json TEXT;
ALTER TABLE resell_tasks ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS resell_tasks_idempotency_idx
  ON resell_tasks (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS resell_tasks_source_type_idx
  ON resell_tasks (source_type, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS publish_drafts (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('follow_sell', 'normal_publish', 'json_import', 'seller_bridge', 'public_page')),
  source_sku TEXT NOT NULL DEFAULT '',
  title TEXT,
  source_snapshot_json TEXT NOT NULL,
  field_overrides_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS publish_drafts_updated_idx
  ON publish_drafts (updated_at_ms DESC);
