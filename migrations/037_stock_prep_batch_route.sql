ALTER TABLE stock_prep_batch_items ADD COLUMN supplier_name TEXT;
ALTER TABLE stock_prep_batch_items ADD COLUMN cart_mode TEXT CHECK (cart_mode IN ('wholesale', 'dropship'));
