ALTER TABLE postings ADD COLUMN shipment_at_ms INTEGER;
ALTER TABLE postings ADD COLUMN shipment_time_source TEXT NOT NULL DEFAULT 'missing';

CREATE TABLE IF NOT EXISTS finance_accrual_types (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  type_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, type_id)
);

CREATE TABLE IF NOT EXISTS finance_accrual_lines (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_date TEXT NOT NULL,
  accrual_date TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'by_day',
  accrued_category TEXT NOT NULL,
  unit_number TEXT NOT NULL,
  posting_number TEXT,
  sku TEXT,
  type_id TEXT,
  type_name TEXT,
  category TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  quantity INTEGER,
  seller_price TEXT,
  raw_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (store_id, source_key)
);

CREATE TABLE IF NOT EXISTS finance_sync_days (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  accrual_date TEXT NOT NULL,
  cursor TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  error TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, accrual_date)
);

CREATE TABLE IF NOT EXISTS finance_sync_runs (
  id TEXT PRIMARY KEY,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  total_days INTEGER NOT NULL,
  completed_days INTEGER NOT NULL DEFAULT 0,
  failed_days INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_cash_flow_reports (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, from_date, to_date)
);

CREATE INDEX IF NOT EXISTS finance_accrual_lines_store_date_idx
  ON finance_accrual_lines (store_id, accrual_date);
CREATE INDEX IF NOT EXISTS finance_accrual_lines_posting_idx
  ON finance_accrual_lines (store_id, posting_number);
CREATE INDEX IF NOT EXISTS finance_accrual_lines_sku_idx
  ON finance_accrual_lines (store_id, sku);
CREATE INDEX IF NOT EXISTS finance_sync_runs_created_idx
  ON finance_sync_runs (created_at_ms DESC);
