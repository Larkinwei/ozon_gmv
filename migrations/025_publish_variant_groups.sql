ALTER TABLE publish_drafts ADD COLUMN variants_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE resell_tasks ADD COLUMN publish_draft_id TEXT REFERENCES publish_drafts(id) ON DELETE SET NULL;
ALTER TABLE resell_tasks ADD COLUMN publish_variant_id TEXT;

CREATE INDEX resell_tasks_publish_group_idx
  ON resell_tasks (publish_draft_id, created_at_ms DESC);

CREATE UNIQUE INDEX resell_tasks_publish_variant_idx
  ON resell_tasks (publish_draft_id, publish_variant_id)
  WHERE publish_draft_id IS NOT NULL AND publish_variant_id IS NOT NULL;
