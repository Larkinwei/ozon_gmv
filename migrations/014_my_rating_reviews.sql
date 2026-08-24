ALTER TABLE my_product_snapshots ADD COLUMN rating REAL;
ALTER TABLE my_product_snapshots ADD COLUMN review_count INTEGER;

CREATE INDEX IF NOT EXISTS my_product_snapshots_rating_idx
  ON my_product_snapshots (rating);
CREATE INDEX IF NOT EXISTS my_product_snapshots_review_count_idx
  ON my_product_snapshots (review_count);
