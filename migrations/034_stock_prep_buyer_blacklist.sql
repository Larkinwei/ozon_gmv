CREATE TABLE stock_prep_buyer_blacklist (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  buyer_key_hash TEXT NOT NULL,
  buyer_id_ciphertext TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'inactive')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'agent', 'order')),
  reason_code TEXT NOT NULL,
  summary TEXT,
  evidence_orders_json TEXT NOT NULL DEFAULT '[]',
  rule_version TEXT,
  notes TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (store_id, buyer_key_hash)
);
CREATE INDEX stock_prep_buyer_blacklist_status_idx ON stock_prep_buyer_blacklist (store_id, status);

CREATE TABLE stock_prep_buyer_blacklist_events (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES stock_prep_buyer_blacklist(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL
);
