CREATE TABLE IF NOT EXISTS performance_ad_campaigns (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  campaign_type TEXT NOT NULL DEFAULT '',
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS performance_ad_daily_metrics (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  expense TEXT NOT NULL DEFAULT '0',
  orders INTEGER NOT NULL DEFAULT 0,
  sales TEXT NOT NULL DEFAULT '0',
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store_id, campaign_id, metric_date, sku)
);

CREATE INDEX IF NOT EXISTS idx_performance_ad_metrics_store_date
  ON performance_ad_daily_metrics(store_id, metric_date);

CREATE TABLE IF NOT EXISTS performance_ad_sync_state (
  store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'idle',
  last_started_at_ms INTEGER,
  last_finished_at_ms INTEGER,
  last_error TEXT,
  initial_backfill_done INTEGER NOT NULL DEFAULT 0
);
