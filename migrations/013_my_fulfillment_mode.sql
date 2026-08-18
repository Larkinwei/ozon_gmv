ALTER TABLE my_product_snapshots ADD COLUMN fulfillment_mode TEXT NOT NULL DEFAULT 'unknown'
  CHECK (fulfillment_mode IN ('FBO', 'FBS', 'RFBS', 'unknown'));
