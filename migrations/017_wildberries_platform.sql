ALTER TABLE stores ADD COLUMN platform TEXT NOT NULL DEFAULT 'ozon'
  CHECK (platform IN ('ozon', 'wildberries'));

ALTER TABLE stores ADD COLUMN external_store_id TEXT;

CREATE INDEX IF NOT EXISTS stores_platform_idx ON stores (platform, enabled);

CREATE TABLE IF NOT EXISTS store_credentials (
  store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ozon', 'wildberries')),
  credential_type TEXT NOT NULL CHECK (credential_type IN ('ozon_api_key', 'wildberries_api_token')),
  credential_ciphertext TEXT NOT NULL,
  expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO store_credentials (
  store_id, platform, credential_type, credential_ciphertext, expires_at_ms, created_at_ms, updated_at_ms
)
SELECT id, 'ozon', 'ozon_api_key', api_key_ciphertext, api_key_expires_at_ms, created_at_ms, updated_at_ms
FROM stores;

UPDATE stores SET external_store_id = client_id WHERE external_store_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stores_platform_external_id_idx
  ON stores (platform, external_store_id);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform = 'wildberries'),
  external_order_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  fulfillment_mode TEXT NOT NULL,
  order_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  substatus TEXT,
  gross_amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  cancelled_at_ms INTEGER,
  raw_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (store_id, platform, external_order_id)
);

CREATE TABLE IF NOT EXISTS marketplace_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3)
);

CREATE INDEX IF NOT EXISTS marketplace_orders_order_at_idx
  ON marketplace_orders (store_id, order_at_ms DESC);

CREATE TABLE IF NOT EXISTS marketplace_sales (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform = 'wildberries'),
  external_sale_id TEXT NOT NULL,
  source_order_id TEXT,
  sale_at_ms INTEGER NOT NULL,
  fact_type TEXT NOT NULL CHECK (fact_type IN ('sale', 'return')),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  sku TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  raw_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (store_id, platform, external_sale_id)
);

CREATE INDEX IF NOT EXISTS marketplace_sales_sale_at_idx
  ON marketplace_sales (store_id, sale_at_ms DESC);

CREATE TABLE IF NOT EXISTS marketplace_sync_checkpoints (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform = 'wildberries'),
  source TEXT NOT NULL CHECK (source IN ('orders', 'sales')),
  window_from_ms INTEGER,
  window_to_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, platform, source)
);
