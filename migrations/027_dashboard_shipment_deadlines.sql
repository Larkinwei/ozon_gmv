ALTER TABLE postings ADD COLUMN shipment_deadline_at_ms INTEGER;
ALTER TABLE postings ADD COLUMN shipment_deadline_source TEXT NOT NULL DEFAULT 'missing';

CREATE INDEX idx_postings_shipment_deadline
  ON postings (shipment_deadline_at_ms, order_at_ms);

CREATE TABLE dashboard_shipment_deadline_backfills (
  store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  completed_at_ms INTEGER NOT NULL
);
