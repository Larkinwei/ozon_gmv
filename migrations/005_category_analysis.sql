CREATE TABLE selection_category_sync_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'completed', 'failed')),
  total_steps INTEGER NOT NULL,
  completed_steps INTEGER NOT NULL,
  current_category TEXT,
  staging_json TEXT NOT NULL,
  error_message TEXT,
  cloud_published INTEGER NOT NULL DEFAULT 0 CHECK (cloud_published IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER
);

CREATE INDEX selection_category_sync_jobs_created_idx
  ON selection_category_sync_jobs (created_at_ms DESC);

CREATE TABLE selection_category_batches (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL UNIQUE,
  collected_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('collector', 'cloud')),
  row_count INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX selection_category_batches_collected_idx
  ON selection_category_batches (collected_at_ms DESC);

CREATE TABLE selection_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_level_1_id TEXT NOT NULL,
  category_level_1_name TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX selection_categories_level_1_idx
  ON selection_categories (category_level_1_id, name);

CREATE TABLE selection_category_metrics (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES selection_category_batches(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES selection_categories(id) ON DELETE CASCADE,
  period_days INTEGER NOT NULL CHECK (period_days IN (7, 28)),
  gmv_minor INTEGER NOT NULL,
  gmv_growth REAL,
  ordered_units INTEGER NOT NULL,
  average_price_minor INTEGER NOT NULL,
  average_price_growth REAL,
  seller_count INTEGER,
  brand_count INTEGER,
  cluster_count INTEGER,
  buyout_rate REAL,
  top_five_seller_share REAL,
  category_share REAL,
  rating REAL,
  maximum_rating REAL,
  UNIQUE (batch_id, category_id, period_days)
);

CREATE INDEX selection_category_metrics_period_gmv_idx
  ON selection_category_metrics (batch_id, period_days, gmv_minor DESC);
CREATE INDEX selection_category_metrics_category_idx
  ON selection_category_metrics (category_id, period_days, batch_id);
