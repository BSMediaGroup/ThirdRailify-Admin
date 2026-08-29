-- Production commerce launch authority, bounded operations jobs, provider
-- diagnostics, shipping markets, and server-owned tax totals.

PRAGMA foreign_keys = ON;

CREATE TABLE commerce_launch_state (
  id TEXT PRIMARY KEY CHECK (id = 'production'),
  state TEXT NOT NULL CHECK (state IN ('preflight', 'active', 'paused')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_plan_digest TEXT CHECK (last_plan_digest IS NULL OR (length(last_plan_digest) = 64 AND last_plan_digest NOT GLOB '*[^0-9a-f]*')),
  last_plan_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(last_plan_json) AND json_type(last_plan_json) = 'object' AND length(last_plan_json) <= 32768),
  activated_at TEXT,
  paused_at TEXT,
  pause_reason TEXT CHECK (pause_reason IS NULL OR length(pause_reason) BETWEEN 1 AND 300),
  updated_by_actor TEXT CHECK (updated_by_actor IS NULL OR length(updated_by_actor) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO commerce_launch_state (id, state, revision, created_at, updated_at)
VALUES ('production', 'preflight', 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

CREATE TABLE commerce_shipping_markets (
  country_code TEXT PRIMARY KEY CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  strategy TEXT NOT NULL CHECK (strategy = 'printful_dynamic'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_actor TEXT CHECK (updated_by_actor IS NULL OR length(updated_by_actor) BETWEEN 1 AND 160)
);

INSERT INTO commerce_shipping_markets (
  country_code, display_name, status, strategy, created_at, updated_at
) VALUES ('CA', 'Canada', 'active', 'printful_dynamic', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

CREATE TABLE commerce_operation_jobs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'coj_*' AND length(id) BETWEEN 40 AND 80),
  job_kind TEXT NOT NULL CHECK (job_kind IN ('fulfillment_submit', 'fulfillment_reconcile', 'email_send')),
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 180),
  order_id TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'retry', 'action_required', 'completed', 'canceled')),
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 16 AND 120),
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
  next_attempt_at TEXT NOT NULL,
  last_error_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(last_error_json) AND json_type(last_error_json) = 'object' AND length(last_error_json) <= 4096),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  UNIQUE (job_kind, event_key),
  CHECK (
    (state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX idx_commerce_operation_jobs_due
  ON commerce_operation_jobs(state, next_attempt_at, created_at);
CREATE INDEX idx_commerce_operation_jobs_order
  ON commerce_operation_jobs(order_id, state, updated_at DESC);

CREATE TABLE commerce_provider_diagnostics (
  id TEXT PRIMARY KEY CHECK (id GLOB 'cpd_*' AND length(id) BETWEEN 40 AND 80),
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'printful', 'resend')),
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  provider_code TEXT CHECK (provider_code IS NULL OR length(provider_code) BETWEEN 1 AND 100),
  provider_reason TEXT CHECK (provider_reason IS NULL OR length(provider_reason) BETWEEN 1 AND 300),
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 160),
  payload_digest TEXT CHECK (payload_digest IS NULL OR (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*')),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_commerce_provider_diagnostics_recent
  ON commerce_provider_diagnostics(provider, occurred_at DESC);

ALTER TABLE commerce_orders ADD COLUMN product_subtotal_amount INTEGER NOT NULL DEFAULT 0 CHECK (product_subtotal_amount BETWEEN 0 AND 2147483647);
ALTER TABLE commerce_orders ADD COLUMN shipping_amount INTEGER NOT NULL DEFAULT 0 CHECK (shipping_amount BETWEEN 0 AND 2147483647);
ALTER TABLE commerce_orders ADD COLUMN tax_amount INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount BETWEEN 0 AND 2147483647);
ALTER TABLE commerce_orders ADD COLUMN tax_status TEXT NOT NULL DEFAULT 'not_calculated'
  CHECK (tax_status IN ('not_calculated', 'calculating', 'complete', 'not_collecting', 'failed'));
ALTER TABLE commerce_orders ADD COLUMN tax_reason TEXT CHECK (tax_reason IS NULL OR length(tax_reason) BETWEEN 1 AND 160);

ALTER TABLE commerce_email_deliveries ADD COLUMN recipient_email_ciphertext TEXT
  CHECK (recipient_email_ciphertext IS NULL OR length(recipient_email_ciphertext) BETWEEN 80 AND 8192);

CREATE TABLE commerce_provider_webhook_events_v2 (
  id TEXT PRIMARY KEY CHECK (id GLOB 'pwe_*' AND length(id) = 68),
  provider TEXT NOT NULL CHECK (provider = 'printful'),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'order_created', 'order_updated', 'order_failed', 'order_canceled',
    'order_put_hold', 'order_put_hold_approval', 'order_remove_hold', 'order_refunded',
    'shipment_sent', 'shipment_delivered', 'shipment_returned', 'shipment_canceled'
  )),
  occurred_at TEXT NOT NULL,
  provider_store_id TEXT NOT NULL CHECK (length(provider_store_id) BETWEEN 1 AND 40),
  provider_order_id TEXT CHECK (provider_order_id IS NULL OR length(provider_order_id) BETWEEN 1 AND 80),
  provider_shipment_id TEXT CHECK (provider_shipment_id IS NULL OR length(provider_shipment_id) BETWEEN 1 AND 80),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('received', 'processed', 'ignored', 'unresolved', 'error')),
  result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 80),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1000000),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (provider, payload_sha256)
);

INSERT INTO commerce_provider_webhook_events_v2 SELECT * FROM commerce_provider_webhook_events;
DROP TABLE commerce_provider_webhook_events;
ALTER TABLE commerce_provider_webhook_events_v2 RENAME TO commerce_provider_webhook_events;
CREATE INDEX idx_commerce_provider_webhooks_order ON commerce_provider_webhook_events(provider, provider_order_id, occurred_at DESC);
CREATE INDEX idx_commerce_provider_webhooks_shipment ON commerce_provider_webhook_events(provider, provider_shipment_id, occurred_at DESC);
CREATE INDEX idx_commerce_provider_webhooks_status ON commerce_provider_webhook_events(provider, processing_status, received_at DESC);

INSERT INTO commerce_settings (setting_key, value_json, classification, updated_at)
VALUES
  ('commerce_emergency_paused', 'false', 'safe', '2026-08-30T00:00:00.000Z'),
  ('commerce_launch_revision', '1', 'safe', '2026-08-30T00:00:00.000Z'),
  ('stripe_live_api_verified', 'false', 'safe', '2026-08-30T00:00:00.000Z'),
  ('stripe_live_webhook_configured', 'false', 'safe', '2026-08-30T00:00:00.000Z'),
  ('printful_v2_webhook_configured', 'false', 'safe', '2026-08-30T00:00:00.000Z'),
  ('printful_v2_signed_delivery_verified', 'false', 'safe', '2026-08-30T00:00:00.000Z'),
  ('resend_domain_verified', 'false', 'safe', '2026-08-30T00:00:00.000Z'),
  ('commerce_operations_worker_configured', 'false', 'safe', '2026-08-30T00:00:00.000Z')
ON CONFLICT(setting_key) DO NOTHING;
