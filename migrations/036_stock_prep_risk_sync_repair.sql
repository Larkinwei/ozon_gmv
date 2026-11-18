CREATE TABLE IF NOT EXISTS stock_prep_risk_sync (
  store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'complete', 'failed')),
  from_at_ms INTEGER NOT NULL,
  to_at_ms INTEGER NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  return_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at_ms INTEGER NOT NULL
);
