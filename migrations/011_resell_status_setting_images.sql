CREATE TABLE resell_tasks_new (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  source_sku TEXT NOT NULL,
  target_offer_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('quick', 'edit')),
  price TEXT NOT NULL,
  old_price TEXT,
  currency TEXT NOT NULL,
  vat TEXT NOT NULL,
  stock INTEGER NOT NULL CHECK (stock >= 0),
  fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('FBO', 'FBS', 'RFBS')),
  warehouse_id TEXT NOT NULL,
  title TEXT,
  description TEXT,
  attributes_json TEXT,
  ozon_task_id TEXT,
  product_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'preflight_failed', 'creating', 'pending', 'created', 'setting_images', 'setting_price', 'setting_stock', 'moderating', 'sellable', 'needs_input', 'failed')),
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  UNIQUE (store_id, source_sku, target_offer_id)
);

INSERT INTO resell_tasks_new (
  id, store_id, source_sku, target_offer_id, mode, price, old_price, currency, vat,
  stock, fulfillment_mode, warehouse_id, title, description, attributes_json,
  ozon_task_id, product_id, status, last_error, created_at_ms, updated_at_ms, completed_at_ms
)
SELECT
  id, store_id, source_sku, target_offer_id, mode, price, old_price, currency, vat,
  stock, fulfillment_mode, warehouse_id, title, description, attributes_json,
  ozon_task_id, product_id, status, last_error, created_at_ms, updated_at_ms, completed_at_ms
FROM resell_tasks;

CREATE TABLE resell_task_events_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES resell_tasks_new(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message TEXT,
  created_at_ms INTEGER NOT NULL
);

INSERT INTO resell_task_events_new (id, task_id, status, message, created_at_ms)
SELECT id, task_id, status, message, created_at_ms
FROM resell_task_events;

DROP TABLE resell_task_events;
DROP TABLE resell_tasks;

ALTER TABLE resell_tasks_new RENAME TO resell_tasks;
ALTER TABLE resell_task_events_new RENAME TO resell_task_events;

CREATE INDEX resell_tasks_store_idx
  ON resell_tasks (store_id, updated_at_ms DESC);
CREATE INDEX resell_tasks_source_idx
  ON resell_tasks (source_sku, created_at_ms DESC);
CREATE INDEX resell_task_events_task_idx
  ON resell_task_events (task_id, created_at_ms ASC);
