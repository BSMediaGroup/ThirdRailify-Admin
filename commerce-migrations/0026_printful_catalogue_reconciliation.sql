-- Current-store Printful catalogue authority and auditable reconciliation.
-- This migration is additive: legacy catalogue and historical order rows are
-- retained until an explicitly confirmed reconciliation archives them.

PRAGMA foreign_keys = ON;

ALTER TABLE commerce_products ADD COLUMN provider_store_id TEXT
  CHECK (provider_store_id IS NULL OR length(provider_store_id) BETWEEN 1 AND 40);
ALTER TABLE commerce_products ADD COLUMN provider_presence TEXT NOT NULL DEFAULT 'legacy'
  CHECK (provider_presence IN ('current', 'provider_missing', 'wrong_store', 'legacy'));
ALTER TABLE commerce_products ADD COLUMN provider_reconciliation_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (provider_reconciliation_status IN ('current', 'needs_review', 'ambiguous', 'archived', 'legacy'));
ALTER TABLE commerce_products ADD COLUMN provider_last_seen_at TEXT;
ALTER TABLE commerce_products ADD COLUMN provider_reconciled_at TEXT;
ALTER TABLE commerce_products ADD COLUMN provider_snapshot_hash TEXT
  CHECK (provider_snapshot_hash IS NULL OR (length(provider_snapshot_hash) = 64 AND provider_snapshot_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE commerce_products ADD COLUMN archived_at TEXT;
ALTER TABLE commerce_products ADD COLUMN archived_reason TEXT
  CHECK (archived_reason IS NULL OR length(archived_reason) BETWEEN 1 AND 160);

CREATE INDEX idx_commerce_products_provider_current
  ON commerce_products(provider_store_id, provider_presence, provider_reconciliation_status, visibility, status);
CREATE INDEX idx_commerce_products_provider_sync_identity
  ON commerce_products(provider_store_id, target_printful_product_id)
  WHERE target_printful_product_id IS NOT NULL;
CREATE INDEX idx_commerce_products_archived
  ON commerce_products(archived_at, archived_reason)
  WHERE archived_at IS NOT NULL;

ALTER TABLE commerce_product_variants ADD COLUMN provider_store_id TEXT
  CHECK (provider_store_id IS NULL OR length(provider_store_id) BETWEEN 1 AND 40);
ALTER TABLE commerce_product_variants ADD COLUMN provider_presence TEXT NOT NULL DEFAULT 'legacy'
  CHECK (provider_presence IN ('current', 'provider_missing', 'wrong_store', 'legacy'));
ALTER TABLE commerce_product_variants ADD COLUMN provider_last_seen_at TEXT;
ALTER TABLE commerce_product_variants ADD COLUMN provider_reconciled_at TEXT;
ALTER TABLE commerce_product_variants ADD COLUMN provider_snapshot_hash TEXT
  CHECK (provider_snapshot_hash IS NULL OR (length(provider_snapshot_hash) = 64 AND provider_snapshot_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE commerce_product_variants ADD COLUMN archived_at TEXT;

CREATE INDEX idx_commerce_product_variants_provider_current
  ON commerce_product_variants(provider_store_id, provider_presence, product_id, status, visibility);

CREATE TABLE commerce_catalogue_reconciliation_runs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'ccr_*' AND length(id) BETWEEN 40 AND 80),
  state TEXT NOT NULL CHECK (state IN ('previewed', 'applying', 'applied', 'failed', 'superseded')),
  provider_store_id TEXT NOT NULL CHECK (length(provider_store_id) BETWEEN 1 AND 40),
  provider_store_name TEXT NOT NULL CHECK (length(provider_store_name) BETWEEN 1 AND 240),
  provider_store_type TEXT NOT NULL CHECK (length(provider_store_type) BETWEEN 1 AND 80),
  provider_contract TEXT NOT NULL CHECK (provider_contract = 'printful-v1-sync-products'),
  provider_snapshot_hash TEXT NOT NULL
    CHECK (length(provider_snapshot_hash) = 64 AND provider_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  provider_product_count INTEGER NOT NULL CHECK (provider_product_count > 0),
  provider_variant_count INTEGER NOT NULL CHECK (provider_variant_count >= 0),
  confirmation_text TEXT NOT NULL CHECK (length(confirmation_text) BETWEEN 11 AND 40),
  unusual_reduction INTEGER NOT NULL DEFAULT 0 CHECK (unusual_reduction IN (0, 1)),
  preview_json TEXT NOT NULL
    CHECK (json_valid(preview_json) AND json_type(preview_json) = 'object' AND length(preview_json) <= 262144),
  result_json TEXT
    CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object' AND length(result_json) <= 131072)),
  actor_account_id TEXT NOT NULL CHECK (length(actor_account_id) BETWEEN 1 AND 160),
  previewed_at TEXT NOT NULL,
  applied_at TEXT,
  failed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_commerce_catalogue_reconciliation_runs_recent
  ON commerce_catalogue_reconciliation_runs(created_at DESC);
CREATE INDEX idx_commerce_catalogue_reconciliation_runs_store
  ON commerce_catalogue_reconciliation_runs(provider_store_id, state, created_at DESC);

CREATE TABLE commerce_catalogue_reconciliation_items (
  id TEXT PRIMARY KEY CHECK (id GLOB 'cci_*' AND length(id) BETWEEN 40 AND 80),
  run_id TEXT NOT NULL,
  local_product_id TEXT,
  provider_sync_product_id TEXT,
  classification TEXT NOT NULL CHECK (classification IN (
    'current_exact_match', 'current_incomplete_local_data', 'current_provider_not_imported',
    'wrong_store', 'provider_missing', 'legacy_unidentified',
    'ambiguous_replacement_candidate', 'historically_referenced', 'safe_unreferenced_legacy'
  )),
  planned_action TEXT NOT NULL CHECK (planned_action IN ('keep', 'update', 'insert', 'archive', 'review')),
  historically_referenced INTEGER NOT NULL DEFAULT 0 CHECK (historically_referenced IN (0, 1)),
  detail_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object' AND length(detail_json) <= 16384),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES commerce_catalogue_reconciliation_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (local_product_id) REFERENCES commerce_products(id) ON DELETE RESTRICT
);

CREATE INDEX idx_commerce_catalogue_reconciliation_items_run
  ON commerce_catalogue_reconciliation_items(run_id, classification, planned_action);
CREATE INDEX idx_commerce_catalogue_reconciliation_items_local
  ON commerce_catalogue_reconciliation_items(local_product_id, created_at DESC);

PRAGMA foreign_keys = ON;
