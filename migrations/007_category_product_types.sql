-- Materialize the product-type lookup so localized category names never scan JSON at request time.
CREATE TABLE selection_category_product_types (
  batch_id TEXT NOT NULL REFERENCES selection_discovery_batches(id) ON DELETE CASCADE,
  product_type_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES selection_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, product_type_id)
);

CREATE INDEX selection_category_product_types_category_idx
  ON selection_category_product_types (batch_id, category_id);

INSERT OR IGNORE INTO selection_category_product_types (batch_id, product_type_id, category_id)
SELECT links.batch_id, CAST(type_id.value AS TEXT), links.category_id
FROM selection_category_links links, json_each(links.product_type_ids_json) type_id;
