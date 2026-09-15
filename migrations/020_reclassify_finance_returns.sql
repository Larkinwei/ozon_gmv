UPDATE finance_accrual_lines
SET category = 'returns',
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE category = 'logistics'
  AND type_id IN ('6', '45', '59');
