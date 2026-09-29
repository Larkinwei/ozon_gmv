CREATE TABLE publish_drafts_new (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('follow_sell', 'normal_publish', 'json_import', 'seller_bridge', 'public_page', '1688_collector')),
  source_sku TEXT NOT NULL DEFAULT '',
  title TEXT,
  source_snapshot_json TEXT NOT NULL,
  field_overrides_json TEXT NOT NULL DEFAULT '{}',
  workflow_stage TEXT NOT NULL DEFAULT 'collected'
    CHECK (workflow_stage IN ('collected', 'processing', 'ready', 'submitted')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

INSERT INTO publish_drafts_new
  (id, source_type, source_sku, title, source_snapshot_json, field_overrides_json, workflow_stage, created_at_ms, updated_at_ms)
SELECT id, source_type, source_sku, title, source_snapshot_json, field_overrides_json, 'collected', created_at_ms, updated_at_ms
FROM publish_drafts;

DROP TABLE publish_drafts;
ALTER TABLE publish_drafts_new RENAME TO publish_drafts;

CREATE INDEX publish_drafts_updated_idx ON publish_drafts (updated_at_ms DESC);
CREATE INDEX publish_drafts_stage_idx ON publish_drafts (workflow_stage, updated_at_ms DESC);
