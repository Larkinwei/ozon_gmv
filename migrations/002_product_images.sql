CREATE TABLE IF NOT EXISTS product_images (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  primary_image_url TEXT,
  refreshed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, sku)
);

CREATE INDEX IF NOT EXISTS product_images_store_offer_idx
  ON product_images (store_id, offer_id);
