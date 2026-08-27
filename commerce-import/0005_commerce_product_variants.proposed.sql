-- DESIGN ONLY. DO NOT APPLY AS PART OF THE READ-ONLY CATALOGUE MILESTONE.
-- 0004 is already the legitimate goats/community migration, so the requested
-- variant design must use the next available migration number: 0005.

PRAGMA foreign_keys = ON;

CREATE TABLE commerce_product_variants (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  product_id TEXT NOT NULL,
  local_variant_key TEXT NOT NULL CHECK (length(local_variant_key) BETWEEN 1 AND 180),
  printful_target_sync_variant_id TEXT UNIQUE CHECK (printful_target_sync_variant_id IS NULL OR length(printful_target_sync_variant_id) BETWEEN 1 AND 240),
  printful_catalogue_variant_id TEXT CHECK (printful_catalogue_variant_id IS NULL OR length(printful_catalogue_variant_id) BETWEEN 1 AND 240),
  legacy_printful_sync_product_id TEXT CHECK (legacy_printful_sync_product_id IS NULL OR length(legacy_printful_sync_product_id) BETWEEN 1 AND 240),
  legacy_printful_sync_variant_id TEXT UNIQUE CHECK (legacy_printful_sync_variant_id IS NULL OR length(legacy_printful_sync_variant_id) BETWEEN 1 AND 240),
  wix_external_product_id TEXT CHECK (wix_external_product_id IS NULL OR length(wix_external_product_id) BETWEEN 1 AND 240),
  wix_external_variant_id TEXT CHECK (wix_external_variant_id IS NULL OR length(wix_external_variant_id) BETWEEN 1 AND 240),
  sku TEXT CHECK (sku IS NULL OR length(sku) BETWEEN 1 AND 240),
  size_label TEXT CHECK (size_label IS NULL OR length(size_label) BETWEEN 1 AND 120),
  color_label TEXT CHECK (color_label IS NULL OR length(color_label) BETWEEN 1 AND 120),
  option_values_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(option_values_json) AND length(option_values_json) <= 4096 AND json_type(option_values_json) = 'object'),
  file_mapping_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(file_mapping_json) AND length(file_mapping_json) <= 32768 AND json_type(file_mapping_json) = 'array'),
  currency_code TEXT NOT NULL DEFAULT 'CAD' CHECK (currency_code = 'CAD'),
  unit_amount INTEGER NOT NULL CHECK (unit_amount BETWEEN 1 AND 100000000),
  availability_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (availability_status IN ('active', 'out_of_stock', 'discontinued', 'ignored', 'unavailable', 'unknown')),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  is_sellable INTEGER NOT NULL DEFAULT 0 CHECK (is_sellable IN (0, 1)),
  fulfillment_provider TEXT NOT NULL DEFAULT 'printful' CHECK (fulfillment_provider IN ('printful', 'printify', 'manual', 'none')),
  fulfillment_mapping_status TEXT NOT NULL DEFAULT 'unmapped'
    CHECK (fulfillment_mapping_status IN ('unmapped', 'planned', 'mapped', 'conflict', 'manual_review')),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(safe_metadata_json) AND length(safe_metadata_json) <= 16384 AND json_type(safe_metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES commerce_products(id) ON DELETE RESTRICT,
  UNIQUE (product_id, local_variant_key),
  UNIQUE (product_id, wix_external_variant_id)
);

CREATE INDEX idx_commerce_product_variants_product
  ON commerce_product_variants(product_id, is_active DESC, is_sellable DESC, local_variant_key);
CREATE INDEX idx_commerce_product_variants_catalogue
  ON commerce_product_variants(printful_catalogue_variant_id);
CREATE INDEX idx_commerce_product_variants_sku
  ON commerce_product_variants(sku) WHERE sku IS NOT NULL;
CREATE INDEX idx_commerce_product_variants_sellable
  ON commerce_product_variants(is_sellable, availability_status, product_id);

-- commerce_order_items must be rebuilt because its current table-level
-- UNIQUE(order_id, product_id) prevents two concrete variants of one product.
CREATE TABLE commerce_order_items_v2 (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number BETWEEN 1 AND 20),
  product_id TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 160),
  variant_id TEXT CHECK (variant_id IS NULL OR length(variant_id) = 36),
  product_name TEXT NOT NULL CHECK (length(product_name) BETWEEN 1 AND 240),
  variant_name TEXT CHECK (variant_name IS NULL OR length(variant_name) BETWEEN 1 AND 300),
  sku TEXT CHECK (sku IS NULL OR length(sku) BETWEEN 1 AND 240),
  option_values_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(option_values_json) AND length(option_values_json) <= 4096 AND json_type(option_values_json) = 'object'),
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

-- Required application contract after this migration:
-- checkout lines become exactly { productId, variantId, quantity }.
-- The server loads and prices the concrete active/sellable CAD variant, verifies
-- parent product ownership and fulfillment mapping, and snapshots all option,
-- price, SKU, and fulfillment identifiers before contacting Stripe.
