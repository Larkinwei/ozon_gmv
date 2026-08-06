CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS administrators (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  api_key_ciphertext TEXT NOT NULL,
  webhook_token_hash TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL CHECK (color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  api_key_expires_at_ms INTEGER,
  last_sync_started_at_ms INTEGER,
  last_sync_finished_at_ms INTEGER,
  last_sync_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS store_fulfillment_modes (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('FBO', 'FBS', 'RFBS')),
  PRIMARY KEY (store_id, mode)
);

CREATE TABLE IF NOT EXISTS postings (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  posting_number TEXT NOT NULL,
  order_number TEXT NOT NULL,
  fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('FBO', 'FBS', 'RFBS')),
  order_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  substatus TEXT,
  gross_amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  cancelled_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (store_id, posting_number)
);

CREATE TABLE IF NOT EXISTS posting_items (
  id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3)
);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('FBO', 'FBS')),
  cursor TEXT,
  window_from_ms INTEGER,
  window_to_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, fulfillment_mode)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  event_hash TEXT NOT NULL,
  message_type TEXT NOT NULL,
  posting_number TEXT,
  received_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'received',
  error_message TEXT,
  UNIQUE (store_id, event_hash)
);

CREATE TABLE IF NOT EXISTS wallboard_pairings (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS postings_order_at_idx ON postings (order_at_ms DESC);
CREATE INDEX IF NOT EXISTS postings_store_order_at_idx ON postings (store_id, order_at_ms DESC);
CREATE INDEX IF NOT EXISTS postings_cancelled_at_idx ON postings (cancelled_at_ms) WHERE cancelled_at_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS posting_items_posting_id_idx ON posting_items (posting_id);
CREATE INDEX IF NOT EXISTS webhook_events_received_at_idx ON webhook_events (received_at_ms DESC);
