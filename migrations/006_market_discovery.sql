CREATE TABLE selection_discovery_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  stage TEXT CHECK (stage IN ('categories', 'products', 'queries', 'publishing')),
  total_steps INTEGER NOT NULL DEFAULT 0,
  completed_steps INTEGER NOT NULL DEFAULT 0,
  current_item TEXT,
  stage_progress_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  cloud_published INTEGER NOT NULL DEFAULT 0 CHECK (cloud_published IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER
);

CREATE INDEX selection_discovery_jobs_created_idx
  ON selection_discovery_jobs (created_at_ms DESC);

-- One row per completed API page keeps resume writes small and independently verifiable.
CREATE TABLE selection_discovery_stage_pages (
  job_id TEXT NOT NULL REFERENCES selection_discovery_jobs(id) ON DELETE CASCADE,
  page_key TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('categories', 'products', 'queries', 'links')),
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, page_key)
);

CREATE INDEX selection_discovery_stage_pages_stage_idx
  ON selection_discovery_stage_pages (job_id, stage);

CREATE TABLE selection_discovery_batches (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL UNIQUE,
  collected_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('collector', 'cloud')),
  category_batch_id TEXT NOT NULL REFERENCES selection_category_batches(id) ON DELETE CASCADE,
  product_ranking_count INTEGER NOT NULL,
  query_ranking_count INTEGER NOT NULL,
  category_link_count INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX selection_discovery_batches_collected_idx
  ON selection_discovery_batches (collected_at_ms DESC);

CREATE TABLE selection_category_links (
  batch_id TEXT NOT NULL REFERENCES selection_discovery_batches(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES selection_categories(id) ON DELETE CASCADE,
  product_type_ids_json TEXT NOT NULL,
  query_groups_json TEXT NOT NULL,
  query_scope TEXT NOT NULL CHECK (query_scope IN ('category_level_1', 'unavailable')),
  PRIMARY KEY (batch_id, category_id)
);

CREATE TABLE selection_market_product_rankings (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES selection_discovery_batches(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES selection_market_products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'category')),
  scope_category_id TEXT,
  period_days INTEGER NOT NULL CHECK (period_days IN (7, 28)),
  rank INTEGER NOT NULL,
  photo_url TEXT,
  category_level_1_id TEXT NOT NULL,
  category_level_3_id TEXT NOT NULL,
  seller_id TEXT,
  brand_id TEXT,
  ordered_amount_minor INTEGER NOT NULL,
  ordered_units INTEGER NOT NULL,
  turnover_growth REAL,
  average_price_minor INTEGER NOT NULL,
  minimum_price_minor INTEGER NOT NULL,
  purchase_rate REAL,
  missed_sales_minor INTEGER NOT NULL,
  out_of_stock_days INTEGER,
  stock INTEGER,
  fbo_stock INTEGER,
  fbs_stock INTEGER,
  fulfillment_scheme TEXT NOT NULL,
  volume_liters REAL,
  impressions INTEGER NOT NULL,
  search_views INTEGER NOT NULL,
  card_views INTEGER NOT NULL,
  impression_to_order_rate REAL NOT NULL,
  search_to_cart_rate REAL NOT NULL,
  card_to_cart_rate REAL NOT NULL,
  promotion_discount_rate REAL NOT NULL,
  promoted_order_share REAL NOT NULL,
  promotion_days INTEGER NOT NULL,
  advertised_days INTEGER NOT NULL,
  advertising_cost_share REAL NOT NULL,
  product_card_created_date TEXT,
  UNIQUE (batch_id, scope, scope_category_id, period_days, rank)
);

CREATE INDEX selection_market_product_rankings_lookup_idx
  ON selection_market_product_rankings (batch_id, scope, scope_category_id, period_days, ordered_amount_minor DESC);
CREATE INDEX selection_market_product_rankings_product_idx
  ON selection_market_product_rankings (product_id, batch_id);

CREATE TABLE selection_market_query_rankings (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES selection_discovery_batches(id) ON DELETE CASCADE,
  keyword_id TEXT NOT NULL REFERENCES selection_keywords(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'group')),
  group_name TEXT,
  period_days INTEGER NOT NULL CHECK (period_days = 7),
  rank INTEGER NOT NULL,
  search_count INTEGER NOT NULL,
  searches_with_cart INTEGER NOT NULL,
  cart_rate REAL NOT NULL,
  ordered_units INTEGER NOT NULL,
  order_rate REAL NOT NULL,
  ordered_amount_minor INTEGER NOT NULL,
  average_price_minor INTEGER NOT NULL,
  product_views INTEGER NOT NULL,
  competing_sellers INTEGER NOT NULL,
  no_interaction_count INTEGER NOT NULL,
  no_interaction_rate REAL NOT NULL,
  no_result_count INTEGER NOT NULL,
  no_result_rate REAL NOT NULL,
  average_product_count REAL NOT NULL,
  UNIQUE (batch_id, scope, group_name, rank)
);

CREATE INDEX selection_market_query_rankings_lookup_idx
  ON selection_market_query_rankings (batch_id, scope, group_name, search_count DESC);
CREATE INDEX selection_market_query_rankings_keyword_idx
  ON selection_market_query_rankings (keyword_id, batch_id);
