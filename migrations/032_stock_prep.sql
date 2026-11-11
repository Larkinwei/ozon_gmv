CREATE TABLE store_sku_sources (
  store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  base_token TEXT NOT NULL,
  table_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE stock_prep_order_states (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  posting_number TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'adding', 'added', 'failed', 'uncertain', 'unmatched')),
  batch_id TEXT,
  error TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, posting_number, offer_id)
);

CREATE INDEX stock_prep_order_states_state_idx ON stock_prep_order_states (store_id, state);

CREATE TABLE stock_prep_batches (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'completed_with_errors')),
  total_count INTEGER NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER
);

CREATE TABLE stock_prep_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES stock_prep_batches(id) ON DELETE CASCADE,
  offer_url TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  order_keys_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'added', 'failed', 'uncertain')),
  cart_before INTEGER,
  cart_after INTEGER,
  error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX stock_prep_batch_items_batch_idx ON stock_prep_batch_items (batch_id, created_at_ms);

UPDATE stock_prep_order_states SET state = 'uncertain', error = '服务重启时加购结果尚未确认', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE state = 'adding';
UPDATE stock_prep_batches SET status = 'completed_with_errors', finished_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE status IN ('queued', 'running');
UPDATE stock_prep_batch_items SET status = 'uncertain', error = '服务重启时加购结果尚未确认', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE status IN ('queued', 'running');
