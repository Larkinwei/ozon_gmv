ALTER TABLE storefront_price_job_items ADD COLUMN front_currency_code TEXT;
ALTER TABLE storefront_price_snapshots ADD COLUMN front_currency_code TEXT;

-- Older captures were collected from the Russian Ozon storefront.
UPDATE storefront_price_job_items
SET front_currency_code = 'RUB'
WHERE front_currency_code IS NULL AND (green_price IS NOT NULL OR black_price IS NOT NULL);

UPDATE storefront_price_snapshots
SET front_currency_code = 'RUB'
WHERE front_currency_code IS NULL AND (green_price IS NOT NULL OR black_price IS NOT NULL);
