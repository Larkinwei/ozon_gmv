CREATE TABLE online_products_cache (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL,
  items_json TEXT NOT NULL,
  read_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, visibility)
);
