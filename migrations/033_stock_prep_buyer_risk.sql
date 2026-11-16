ALTER TABLE postings ADD COLUMN buyer_key_hash TEXT;
ALTER TABLE postings ADD COLUMN cancellation_initiator TEXT;
ALTER TABLE postings ADD COLUMN cancellation_type TEXT;

CREATE INDEX postings_buyer_key_idx ON postings (store_id, buyer_key_hash, order_at_ms);

CREATE TABLE stock_prep_risk_sync (
  store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'complete', 'failed')),
  from_at_ms INTEGER NOT NULL,
  to_at_ms INTEGER NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  return_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE stock_prep_risk_approvals (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  approved_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, order_number)
);

CREATE TABLE stock_prep_buyer_returns (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  return_id TEXT NOT NULL,
  posting_number TEXT NOT NULL,
  order_number TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,
  return_type TEXT NOT NULL,
  returned_at_ms INTEGER,
  PRIMARY KEY (store_id, return_id)
);
