CREATE TABLE online_product_source_links (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, product_id)
);
