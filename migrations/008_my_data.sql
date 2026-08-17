CREATE TABLE IF NOT EXISTS my_import_batches (
  id TEXT PRIMARY KEY,
  folder_name TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  valid_rows INTEGER NOT NULL,
  invalid_rows INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'failed'))
);

CREATE TABLE IF NOT EXISTS my_import_files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES my_import_batches(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL,
  valid_rows INTEGER NOT NULL,
  invalid_rows INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS my_product_snapshots (
  id TEXT PRIMARY KEY,
  import_file_id TEXT NOT NULL REFERENCES my_import_files(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  current_price_milli INTEGER NOT NULL,
  monthly_units INTEGER NOT NULL,
  monthly_sales_milli INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  conversion_rate REAL NOT NULL,
  discount_rate REAL NOT NULL,
  keyword TEXT NOT NULL DEFAULT '',
  product_url TEXT NOT NULL,
  image_url TEXT,
  status TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  capture_day TEXT NOT NULL,
  UNIQUE (sku, capture_day, keyword)
);

CREATE INDEX IF NOT EXISTS my_product_snapshots_capture_day_idx
  ON my_product_snapshots (capture_day, captured_at_ms DESC);
CREATE INDEX IF NOT EXISTS my_product_snapshots_sku_idx
  ON my_product_snapshots (sku, capture_day DESC);
CREATE INDEX IF NOT EXISTS my_product_snapshots_keyword_idx
  ON my_product_snapshots (keyword, capture_day DESC);
