-- Finalized locally from the immutable 2026-08-28 commerce migration evidence.
-- UNAPPLIED: this migration must not be applied remotely in this milestone.

PRAGMA foreign_keys = ON;

-- commerce_products needs explicit multi-provider provenance. The existing
-- source_provider/external_product_id pair cannot safely represent both the
-- legacy Wix/Printful identity and the permanent target Printful identity.
ALTER TABLE commerce_products ADD COLUMN target_printful_product_id TEXT
  CHECK (target_printful_product_id IS NULL OR length(target_printful_product_id) BETWEEN 1 AND 240);
ALTER TABLE commerce_products ADD COLUMN legacy_printful_source_product_id TEXT
  CHECK (legacy_printful_source_product_id IS NULL OR length(legacy_printful_source_product_id) BETWEEN 1 AND 240);
ALTER TABLE commerce_products ADD COLUMN legacy_wix_external_product_id TEXT
  CHECK (legacy_wix_external_product_id IS NULL OR length(legacy_wix_external_product_id) BETWEEN 1 AND 240);
ALTER TABLE commerce_products ADD COLUMN migration_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK (migration_status IN ('not_started', 'selected', 'target_created', 'imported', 'manual_review', 'excluded', 'target_native'));
ALTER TABLE commerce_products ADD COLUMN migration_provenance_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(migration_provenance_json) AND json_type(migration_provenance_json) = 'object' AND length(migration_provenance_json) <= 16384);

CREATE UNIQUE INDEX idx_commerce_products_target_printful
  ON commerce_products(target_printful_product_id)
  WHERE target_printful_product_id IS NOT NULL;
CREATE UNIQUE INDEX idx_commerce_products_legacy_printful
  ON commerce_products(legacy_printful_source_product_id)
  WHERE legacy_printful_source_product_id IS NOT NULL;
CREATE UNIQUE INDEX idx_commerce_products_legacy_wix
  ON commerce_products(legacy_wix_external_product_id)
  WHERE legacy_wix_external_product_id IS NOT NULL;

CREATE TABLE commerce_product_variants (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 160),
  product_id TEXT NOT NULL,
  local_variant_key TEXT NOT NULL CHECK (length(local_variant_key) BETWEEN 1 AND 180),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'restricted', 'disabled', 'error')),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public')),
  is_sellable INTEGER NOT NULL DEFAULT 0 CHECK (is_sellable IN (0, 1)),
  availability_status TEXT NOT NULL DEFAULT 'active'
    CHECK (availability_status IN ('active', 'temporarily_out_of_stock', 'discontinued')),
  is_ignored INTEGER NOT NULL DEFAULT 0 CHECK (is_ignored IN (0, 1)),
  unit_amount INTEGER NOT NULL CHECK (unit_amount BETWEEN 1 AND 100000000),
  currency_code TEXT NOT NULL DEFAULT 'CAD' CHECK (currency_code = 'CAD'),
  sku TEXT CHECK (sku IS NULL OR length(sku) BETWEEN 1 AND 240),
  size_label TEXT CHECK (size_label IS NULL OR length(size_label) BETWEEN 1 AND 120),
  color_label TEXT CHECK (color_label IS NULL OR length(color_label) BETWEEN 1 AND 120),
  option_values_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(option_values_json) AND json_type(option_values_json) = 'object' AND length(option_values_json) <= 4096),
  target_printful_product_id TEXT
    CHECK (target_printful_product_id IS NULL OR length(target_printful_product_id) BETWEEN 1 AND 240),
  target_printful_sync_variant_id TEXT
    CHECK (target_printful_sync_variant_id IS NULL OR length(target_printful_sync_variant_id) BETWEEN 1 AND 240),
  target_catalogue_product_id TEXT
    CHECK (target_catalogue_product_id IS NULL OR length(target_catalogue_product_id) BETWEEN 1 AND 240),
  target_catalogue_variant_id TEXT
    CHECK (target_catalogue_variant_id IS NULL OR length(target_catalogue_variant_id) BETWEEN 1 AND 240),
  legacy_source_product_id TEXT
    CHECK (legacy_source_product_id IS NULL OR length(legacy_source_product_id) BETWEEN 1 AND 240),
  legacy_source_variant_id TEXT
    CHECK (legacy_source_variant_id IS NULL OR length(legacy_source_variant_id) BETWEEN 1 AND 240),
  legacy_wix_external_product_id TEXT
    CHECK (legacy_wix_external_product_id IS NULL OR length(legacy_wix_external_product_id) BETWEEN 1 AND 240),
  legacy_wix_external_variant_id TEXT
    CHECK (legacy_wix_external_variant_id IS NULL OR length(legacy_wix_external_variant_id) BETWEEN 1 AND 240),
  fulfillment_provider TEXT NOT NULL DEFAULT 'printful'
    CHECK (fulfillment_provider IN ('printful', 'printify', 'manual', 'none')),
  fulfillment_mapping_status TEXT NOT NULL DEFAULT 'unmapped'
    CHECK (fulfillment_mapping_status IN ('unmapped', 'planned', 'mapped', 'conflict', 'manual_review')),
  migration_status TEXT NOT NULL DEFAULT 'selected'
    CHECK (migration_status IN ('selected', 'target_created', 'imported', 'blocked', 'excluded', 'target_native')),
  migration_provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(migration_provenance_json) AND json_type(migration_provenance_json) = 'object' AND length(migration_provenance_json) <= 16384),
  file_mapping_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(file_mapping_json) AND json_type(file_mapping_json) = 'array' AND length(file_mapping_json) <= 32768),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(safe_metadata_json) AND json_type(safe_metadata_json) = 'object' AND length(safe_metadata_json) <= 16384),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES commerce_products(id) ON DELETE RESTRICT,
  UNIQUE (product_id, local_variant_key),
  UNIQUE (target_printful_sync_variant_id),
  UNIQUE (legacy_source_variant_id),
  UNIQUE (legacy_wix_external_product_id, legacy_wix_external_variant_id)
);

CREATE INDEX idx_commerce_product_variants_product
  ON commerce_product_variants(product_id, status, visibility, is_sellable, local_variant_key);
CREATE INDEX idx_commerce_product_variants_sellable
  ON commerce_product_variants(is_sellable, availability_status, product_id);
CREATE INDEX idx_commerce_product_variants_target_printful
  ON commerce_product_variants(target_printful_product_id, target_printful_sync_variant_id);
CREATE INDEX idx_commerce_product_variants_target_catalogue
  ON commerce_product_variants(target_catalogue_product_id, target_catalogue_variant_id);
CREATE INDEX idx_commerce_product_variants_legacy_printful
  ON commerce_product_variants(legacy_source_product_id, legacy_source_variant_id);
CREATE INDEX idx_commerce_product_variants_legacy_wix
  ON commerce_product_variants(legacy_wix_external_product_id, legacy_wix_external_variant_id);
-- SKU is deliberately searchable but nullable and non-unique. The immutable
-- source evidence contains duplicate legacy SKUs.
CREATE INDEX idx_commerce_product_variants_sku
  ON commerce_product_variants(sku) WHERE sku IS NOT NULL;

-- Rebuild order items so the future checkout contract can snapshot an exact
-- authoritative variant. Existing product-only order rows remain valid.
CREATE TABLE commerce_order_items_v2 (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number BETWEEN 1 AND 20),
  product_id TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 160),
  variant_id TEXT CHECK (variant_id IS NULL OR length(variant_id) BETWEEN 1 AND 160),
  product_name TEXT NOT NULL CHECK (length(product_name) BETWEEN 1 AND 240),
  variant_name TEXT CHECK (variant_name IS NULL OR length(variant_name) BETWEEN 1 AND 300),
  sku TEXT CHECK (sku IS NULL OR length(sku) BETWEEN 1 AND 240),
  option_values_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(option_values_json) AND json_type(option_values_json) = 'object' AND length(option_values_json) <= 4096),
  currency_code TEXT NOT NULL CHECK (currency_code = 'CAD'),
  unit_amount INTEGER NOT NULL CHECK (unit_amount BETWEEN 1 AND 100000000),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  line_total_amount INTEGER NOT NULL CHECK (line_total_amount = unit_amount * quantity AND line_total_amount > 0),
  requires_shipping INTEGER NOT NULL DEFAULT 0 CHECK (requires_shipping IN (0, 1)),
  fulfillment_provider TEXT CHECK (fulfillment_provider IN ('printful', 'printify', 'manual', 'none')),
  fulfillment_variant_id TEXT CHECK (fulfillment_variant_id IS NULL OR length(fulfillment_variant_id) BETWEEN 1 AND 240),
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id) REFERENCES commerce_products(id) ON DELETE RESTRICT,
  FOREIGN KEY (variant_id) REFERENCES commerce_product_variants(id) ON DELETE RESTRICT,
  UNIQUE (order_id, line_number),
  UNIQUE (order_id, product_id, variant_id)
);

INSERT INTO commerce_order_items_v2 (
  id, order_id, line_number, product_id, variant_id, product_name, variant_name,
  sku, option_values_json, currency_code, unit_amount, quantity,
  line_total_amount, requires_shipping, fulfillment_provider,
  fulfillment_variant_id, created_at
)
SELECT id, order_id, line_number, product_id, NULL, product_name, NULL,
       NULL, '{}', currency_code, unit_amount, quantity,
       line_total_amount, requires_shipping, NULL, NULL, created_at
FROM commerce_order_items;

DROP TABLE commerce_order_items;
ALTER TABLE commerce_order_items_v2 RENAME TO commerce_order_items;
CREATE INDEX idx_commerce_order_items_order ON commerce_order_items(order_id, line_number);
CREATE INDEX idx_commerce_order_items_variant ON commerce_order_items(variant_id);

-- Future application contract after 0005 is applied and variant rows exist:
-- { productId, variantId, quantity }. D1 remains authoritative for price,
-- CAD currency, sellability, availability, and Printful fulfillment mapping.
PRAGMA foreign_keys = ON;
