CREATE TABLE storefront_price_jobs (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  store_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'cancelled')),
  total_count INTEGER NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  no_data_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER
);

CREATE TABLE storefront_price_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES storefront_price_jobs(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  sku TEXT,
  offer_id TEXT NOT NULL,
  product_name TEXT,
  image_url TEXT,
  backend_price TEXT,
  currency_code TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'no_data', 'cancelled')),
  green_price TEXT,
  black_price TEXT,
  error TEXT,
  captured_at_ms INTEGER,
  UNIQUE (job_id, product_id)
);

CREATE TABLE storefront_price_snapshots (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  product_name TEXT,
  image_url TEXT,
  backend_price TEXT,
  green_price TEXT,
  black_price TEXT,
  currency_code TEXT,
  captured_at_ms INTEGER NOT NULL
);

CREATE INDEX storefront_price_jobs_store_created_idx ON storefront_price_jobs(store_id, created_at_ms DESC);
CREATE INDEX storefront_price_job_items_job_status_idx ON storefront_price_job_items(job_id, status);
CREATE INDEX storefront_price_snapshots_store_product_time_idx ON storefront_price_snapshots(store_id, product_id, captured_at_ms DESC);
