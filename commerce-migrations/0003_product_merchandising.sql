PRAGMA foreign_keys = ON;

ALTER TABLE commerce_products ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1));
ALTER TABLE commerce_products ADD COLUMN featured_order INTEGER CHECK (featured_order IS NULL OR featured_order BETWEEN 0 AND 9999);

CREATE INDEX IF NOT EXISTS idx_commerce_products_featured
  ON commerce_products(is_featured DESC, featured_order ASC, slug ASC);

INSERT OR IGNORE INTO commerce_products (
  id, source_provider, external_product_id, slug, title, currency_code, status,
  safe_metadata_json, is_featured, featured_order, created_at, updated_at
) VALUES
  ('c2cb6ed3-d090-48a9-a742-3d3ed7cfe5c4', 'wix_snapshot', 'c2cb6ed3-d090-48a9-a742-3d3ed7cfe5c4', 'bleh-unisex-classic-tee', 'BLEH | Unisex classic tee', 'CAD', 'legacy_production', '{"public_image_captured":true,"public_price_captured":true}', 1, 20, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('third-railify-icon-dad-hat', 'wix_snapshot', 'third-railify-icon-dad-hat', 'third-railify-icon-dad-hat', 'Third Railify Icon | Dad hat', 'CAD', 'legacy_production', '{"public_image_captured":true,"public_price_captured":true}', 1, 10, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('third-railify-logo-v2-unisex-classic-tee', 'wix_snapshot', 'third-railify-logo-v2-unisex-classic-tee', 'third-railify-logo-v2-unisex-classic-tee', 'Third Railify Logo V2 | Unisex classic tee', 'CAD', 'legacy_production', '{"public_image_captured":true,"public_price_captured":true}', 1, 30, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('third-railify-logo-short-sleeve-t-shirt', 'wix_snapshot', 'third-railify-logo-short-sleeve-t-shirt', 'third-railify-logo-short-sleeve-t-shirt', 'Third Railify Logo | Short Sleeve T-shirt', 'CAD', 'legacy_production', '{"public_image_captured":true,"public_price_captured":true}', 1, 40, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('just-gina-icon-basic-short-sleeve-t-shirt', 'wix_snapshot', 'just-gina-icon-basic-short-sleeve-t-shirt', 'just-gina-icon-basic-short-sleeve-t-shirt', 'Just Gina Icon | Short Sleeve T-shirt', 'CAD', 'legacy_production', '{"public_image_captured":true,"public_price_captured":true}', 0, NULL, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('just-gina-icon-classic-unisex-tee', 'wix_snapshot', 'just-gina-icon-classic-unisex-tee', 'just-gina-icon-classic-unisex-tee', 'Just Gina Icon | Unisex tee', 'CAD', 'legacy_production', '{"public_image_captured":true,"public_price_captured":true}', 0, NULL, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('just-gina-wordmark-basic-dad-hat', 'wix_snapshot', 'just-gina-wordmark-basic-dad-hat', 'just-gina-wordmark-basic-dad-hat', 'Just Gina Wordmark | Dad hat', 'CAD', 'legacy_production', '{"public_image_captured":true,"public_price_captured":true}', 0, NULL, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('third-rail-wordmark-basic-dad-hat', 'wix_snapshot', 'third-rail-wordmark-basic-dad-hat', 'third-rail-wordmark-basic-dad-hat', 'Third Railify Wordmark | Dad hat', 'CAD', 'legacy_production', '{"public_image_captured":true,"public_price_captured":true}', 0, NULL, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
