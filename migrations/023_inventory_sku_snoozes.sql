CREATE TABLE IF NOT EXISTS inventory_sku_snoozes (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  suppressed_until_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, sku)
);

CREATE INDEX IF NOT EXISTS inventory_sku_snoozes_expiry_idx
  ON inventory_sku_snoozes (suppressed_until_ms);
