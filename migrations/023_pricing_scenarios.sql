CREATE TABLE IF NOT EXISTS pricing_scenarios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('target-price', 'existing-price')),
  inputs_json TEXT NOT NULL,
  fee_rates_json TEXT NOT NULL,
  exchange_rate TEXT NOT NULL,
  exchange_source TEXT,
  exchange_effective_date TEXT,
  rule_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  risk_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pricing_scenarios_created_at
  ON pricing_scenarios (created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_scenarios_name
  ON pricing_scenarios (name);
CREATE INDEX IF NOT EXISTS idx_pricing_scenarios_sku
  ON pricing_scenarios (sku);
