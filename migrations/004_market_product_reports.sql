ALTER TABLE selection_imports
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'keyword'
  CHECK (kind IN ('keyword', 'market_product'));

ALTER TABLE selection_imports
  ADD COLUMN report_period_days INTEGER;

CREATE TABLE selection_market_products (
  id TEXT PRIMARY KEY,
  ozon_product_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ozon_url TEXT NOT NULL,
  seller TEXT NOT NULL,
  brand TEXT NOT NULL,
  category_level_1 TEXT NOT NULL,
  category_level_3 TEXT NOT NULL,
  product_flags TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE selection_market_product_snapshots (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES selection_market_products(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES selection_imports(id) ON DELETE CASCADE,
  ordered_amount_minor INTEGER NOT NULL,
  turnover_growth REAL,
  ordered_units INTEGER NOT NULL,
  average_price_minor INTEGER NOT NULL,
  minimum_price_minor INTEGER NOT NULL,
  purchase_rate REAL,
  missed_sales INTEGER NOT NULL,
  out_of_stock_days INTEGER,
  daily_sales_amount_minor INTEGER NOT NULL,
  daily_sales_units INTEGER NOT NULL,
  ending_inventory_units INTEGER NOT NULL,
  fulfillment_scheme TEXT NOT NULL,
  volume_liters REAL NOT NULL,
  impressions INTEGER NOT NULL,
  search_catalog_views INTEGER NOT NULL,
  card_views INTEGER NOT NULL,
  impression_to_order_rate REAL NOT NULL,
  search_catalog_cart_rate REAL NOT NULL,
  card_cart_rate REAL NOT NULL,
  promotion_discount_rate REAL NOT NULL,
  promoted_order_share REAL NOT NULL,
  promotion_days INTEGER NOT NULL,
  advertised_days INTEGER NOT NULL,
  advertising_cost_share REAL NOT NULL,
  product_card_created_date TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (product_id, import_id)
);

CREATE INDEX selection_market_product_snapshots_product_idx
  ON selection_market_product_snapshots (product_id, created_at_ms DESC);
CREATE INDEX selection_market_product_snapshots_import_idx
  ON selection_market_product_snapshots (import_id);
CREATE INDEX selection_market_products_category_idx
  ON selection_market_products (category_level_1, category_level_3);

ALTER TABLE selection_candidates
  ADD COLUMN market_product_id TEXT REFERENCES selection_market_products(id) ON DELETE SET NULL;

CREATE INDEX selection_candidates_market_product_idx
  ON selection_candidates (market_product_id);
