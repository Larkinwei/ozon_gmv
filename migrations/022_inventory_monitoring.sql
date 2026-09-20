ALTER TABLE stores ADD COLUMN inventory_monitor_enabled INTEGER NOT NULL DEFAULT 1 CHECK (inventory_monitor_enabled IN (0, 1));

CREATE TABLE IF NOT EXISTS inventory_stock_snapshots (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('FBO', 'FBS', 'RFBS')),
  warehouse_id TEXT NOT NULL,
  warehouse_name TEXT,
  product_id TEXT,
  product_name TEXT NOT NULL,
  image_url TEXT,
  available_stock INTEGER,
  reserved_stock INTEGER,
  checked_at_ms INTEGER NOT NULL,
  last_error TEXT,
  UNIQUE (store_id, sku, offer_id, fulfillment_mode, warehouse_id)
);

CREATE INDEX IF NOT EXISTS inventory_stock_snapshots_store_idx
  ON inventory_stock_snapshots (store_id, checked_at_ms DESC);

CREATE TABLE IF NOT EXISTS inventory_alerts (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('FBO', 'FBS', 'RFBS')),
  product_name TEXT NOT NULL,
  image_url TEXT,
  available_stock INTEGER NOT NULL,
  reserved_stock INTEGER NOT NULL DEFAULT 0,
  threshold INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL CHECK (status IN ('normal', 'open', 'acknowledged')),
  first_low_at_ms INTEGER,
  last_checked_at_ms INTEGER NOT NULL,
  acknowledged_at_ms INTEGER,
  recovered_at_ms INTEGER,
  UNIQUE (store_id, sku, offer_id, fulfillment_mode)
);

CREATE INDEX IF NOT EXISTS inventory_alerts_open_idx
  ON inventory_alerts (status, last_checked_at_ms DESC);
