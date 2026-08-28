-- Deterministic replacement-site merchandising reconciliation.
-- Scope: the 49 accepted, currently published Wix migration products only.
-- This deliberately does not touch commerce_catalogue_migrations, provider
-- mappings, sellability, checkout settings, orders, or target-native products.

UPDATE commerce_products
SET safe_metadata_json = json_set(safe_metadata_json, '$.displayOrder',
      10 * (SELECT COUNT(*) FROM commerce_products ranked
        WHERE ranked.source_provider = 'wix_snapshot' AND ranked.legacy_printful_source_product_id IS NOT NULL
          AND ranked.slug <= commerce_products.slug)),
    status = 'active',
    visibility = 'public',
    is_featured = CASE slug
      WHEN 'bleh-unisex-classic-tee' THEN 1
      WHEN 'third-railify-icon-dad-hat' THEN 1
      WHEN 'third-railify-logo-v2-unisex-classic-tee' THEN 1
      WHEN 'third-railify-logo-short-sleeve-t-shirt' THEN 1
      WHEN 'just-gina-icon-basic-short-sleeve-t-shirt' THEN 1
      WHEN 'just-gina-icon-classic-unisex-tee' THEN 1
      WHEN 'just-gina-wordmark-basic-dad-hat' THEN 1
      WHEN 'third-rail-wordmark-basic-dad-hat' THEN 1
      ELSE 0 END,
    featured_order = CASE slug
      WHEN 'bleh-unisex-classic-tee' THEN 10
      WHEN 'third-railify-icon-dad-hat' THEN 20
      WHEN 'third-railify-logo-v2-unisex-classic-tee' THEN 30
      WHEN 'third-railify-logo-short-sleeve-t-shirt' THEN 40
      WHEN 'just-gina-icon-basic-short-sleeve-t-shirt' THEN 50
      WHEN 'just-gina-icon-classic-unisex-tee' THEN 60
      WHEN 'just-gina-wordmark-basic-dad-hat' THEN 70
      WHEN 'third-rail-wordmark-basic-dad-hat' THEN 80
      ELSE NULL END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_provider = 'wix_snapshot'
  AND legacy_printful_source_product_id IS NOT NULL;

UPDATE commerce_product_variants
SET status = 'active',
    visibility = 'public',
    safe_metadata_json = json_set(safe_metadata_json, '$.displayLabel',
      COALESCE(NULLIF(json_extract(safe_metadata_json, '$.displayLabel'), ''),
        NULLIF(trim(COALESCE(size_label || ' / ', '') || COALESCE(color_label, ''), ' /'), ''),
        'Standard')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE product_id IN (
  SELECT id FROM commerce_products
  WHERE source_provider = 'wix_snapshot' AND legacy_printful_source_product_id IS NOT NULL
)
  AND is_ignored = 0
  AND availability_status <> 'discontinued'
  AND migration_status <> 'excluded';

INSERT INTO commerce_audit (id, actor_account_id, action, target_type, target_id, result, metadata_json, created_at)
VALUES (lower(hex(randomblob(16))), NULL, 'commerce.catalogue_reconciled', 'commerce_products', NULL, 'success',
  '{"authority":"accepted_current_wix_catalogue","publicProducts":49,"checkoutEnabled":false,"sellabilityUnchanged":true,"providerMappingsUnchanged":true}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
