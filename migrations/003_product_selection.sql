CREATE TABLE IF NOT EXISTS selection_imports (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL UNIQUE,
  snapshot_date TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  valid_rows INTEGER NOT NULL,
  skipped_rows INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS selection_keywords (
  id TEXT PRIMARY KEY,
  phrase TEXT NOT NULL,
  normalized_phrase TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS selection_keyword_snapshots (
  id TEXT PRIMARY KEY,
  keyword_id TEXT NOT NULL REFERENCES selection_keywords(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES selection_imports(id) ON DELETE CASCADE,
  search_count INTEGER NOT NULL,
  cart_rate REAL NOT NULL,
  order_rate REAL NOT NULL,
  average_price_minor INTEGER,
  demand_score INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (keyword_id, import_id)
);

CREATE INDEX IF NOT EXISTS selection_keyword_snapshots_keyword_idx
  ON selection_keyword_snapshots (keyword_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS selection_keyword_snapshots_import_idx
  ON selection_keyword_snapshots (import_id);

CREATE TABLE IF NOT EXISTS selection_wordstat_snapshots (
  id TEXT PRIMARY KEY,
  keyword_id TEXT NOT NULL REFERENCES selection_keywords(id) ON DELETE CASCADE,
  fetched_at_ms INTEGER NOT NULL,
  total_count_30d INTEGER NOT NULL,
  top_requests_json TEXT NOT NULL,
  associations_json TEXT NOT NULL,
  dynamics_json TEXT NOT NULL,
  growth_3m REAL,
  growth_12m REAL,
  trend TEXT NOT NULL CHECK (trend IN ('rising', 'stable', 'falling'))
);

CREATE TABLE IF NOT EXISTS selection_wordstat_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  force_refresh INTEGER NOT NULL CHECK (force_refresh IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS selection_wordstat_job_items (
  job_id TEXT NOT NULL REFERENCES selection_wordstat_jobs(id) ON DELETE CASCADE,
  keyword_id TEXT NOT NULL REFERENCES selection_keywords(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  error_message TEXT,
  PRIMARY KEY (job_id, keyword_id)
);

CREATE INDEX IF NOT EXISTS selection_wordstat_snapshots_keyword_idx
  ON selection_wordstat_snapshots (keyword_id, fetched_at_ms DESC);
CREATE INDEX IF NOT EXISTS selection_wordstat_job_items_status_idx
  ON selection_wordstat_job_items (job_id, status);

CREATE TABLE IF NOT EXISTS selection_candidates (
  id TEXT PRIMARY KEY,
  keyword_id TEXT REFERENCES selection_keywords(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  ozon_url TEXT,
  ozon_product_id TEXT UNIQUE,
  category TEXT,
  target_price_minor INTEGER,
  status TEXT NOT NULL CHECK (status IN ('watching', 'recommended', 'rejected')),
  decision_reason TEXT,
  note TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS selection_candidates_status_idx
  ON selection_candidates (status, updated_at_ms DESC);
