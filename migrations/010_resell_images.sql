CREATE TABLE IF NOT EXISTS resell_image_assets (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS resell_task_images (
  task_id TEXT NOT NULL REFERENCES resell_tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  asset_id TEXT REFERENCES resell_image_assets(id) ON DELETE SET NULL,
  source_url TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (task_id, position),
  CHECK (asset_id IS NOT NULL OR source_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS resell_task_images_asset_idx
  ON resell_task_images (asset_id);

CREATE INDEX IF NOT EXISTS resell_image_assets_last_used_idx
  ON resell_image_assets (last_used_at_ms);
