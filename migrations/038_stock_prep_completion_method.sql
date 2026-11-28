ALTER TABLE stock_prep_order_states ADD COLUMN completion_method TEXT
  CHECK (completion_method IN ('automatic', 'manual_mapped', 'manual_unmapped'));

ALTER TABLE stock_prep_order_states ADD COLUMN completion_note TEXT;

UPDATE stock_prep_order_states
SET completion_method = CASE
  WHEN error LIKE '人工确认已采购（无飞书映射）%' THEN 'manual_unmapped'
  WHEN error LIKE '人工确认%' THEN 'manual_mapped'
  ELSE 'automatic'
END
WHERE state = 'added' AND completion_method IS NULL;
