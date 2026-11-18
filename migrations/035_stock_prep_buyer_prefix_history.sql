CREATE TABLE IF NOT EXISTS stock_prep_buyer_returns (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  return_id TEXT NOT NULL,
  posting_number TEXT NOT NULL,
  order_number TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,
  return_type TEXT NOT NULL,
  returned_at_ms INTEGER,
  PRIMARY KEY (store_id, return_id)
);

ALTER TABLE stock_prep_buyer_returns ADD COLUMN return_reason TEXT;
ALTER TABLE stock_prep_buyer_returns ADD COLUMN visual_status TEXT;

ALTER TABLE stock_prep_buyer_blacklist ADD COLUMN buyer_prefix_ciphertext TEXT;

UPDATE postings SET buyer_key_hash=NULL WHERE buyer_key_hash IS NOT NULL;
DROP INDEX postings_buyer_key_idx;

-- Old entries use customer_id hashes and cannot be converted to posting-number prefixes.
UPDATE stock_prep_buyer_blacklist
SET status='inactive',
    buyer_key_hash='legacy:' || id,
    buyer_id_ciphertext=NULL,
    notes=CASE WHEN COALESCE(notes,'')='' THEN '旧版 customer_id 规则已停用，请使用订单号第一段重新录入。'
      ELSE notes || char(10) || '旧版 customer_id 规则已停用，请使用订单号第一段重新录入。' END,
    updated_at_ms=unixepoch() * 1000
WHERE status IN ('active','candidate');

-- Approval scope changes from one Ozon order to all current orders for a buyer prefix.
DELETE FROM stock_prep_risk_approvals;
