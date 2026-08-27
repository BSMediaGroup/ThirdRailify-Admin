PRAGMA foreign_keys = ON;

ALTER TABLE commerce_products ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1));
ALTER TABLE commerce_products ADD COLUMN featured_order INTEGER CHECK (featured_order IS NULL OR featured_order BETWEEN 0 AND 9999);
ALTER TABLE commerce_products ADD COLUMN unit_amount INTEGER CHECK (unit_amount IS NULL OR unit_amount BETWEEN 1 AND 100000000);
ALTER TABLE commerce_products ADD COLUMN checkout_environment TEXT NOT NULL DEFAULT 'test' CHECK (checkout_environment IN ('test', 'live'));
ALTER TABLE commerce_products ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'));
ALTER TABLE commerce_products ADD COLUMN max_checkout_quantity INTEGER NOT NULL DEFAULT 20 CHECK (max_checkout_quantity BETWEEN 1 AND 20);
ALTER TABLE commerce_products ADD COLUMN requires_shipping INTEGER NOT NULL DEFAULT 0 CHECK (requires_shipping IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_commerce_products_featured
  ON commerce_products(is_featured DESC, featured_order ASC, slug ASC);
CREATE INDEX IF NOT EXISTS idx_commerce_products_checkout
  ON commerce_products(status, visibility, checkout_environment, currency_code);

INSERT OR IGNORE INTO commerce_settings (setting_key, value_json, classification, updated_at)
VALUES ('checkout_turnstile_required', 'false', 'safe', '2026-08-27T00:00:00.000Z');

ALTER TABLE commerce_orders ADD COLUMN checkout_request_id TEXT CHECK (checkout_request_id IS NULL OR length(checkout_request_id) = 36);
ALTER TABLE commerce_orders ADD COLUMN checkout_request_digest TEXT CHECK (checkout_request_digest IS NULL OR (length(checkout_request_digest) = 64 AND checkout_request_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE commerce_orders ADD COLUMN cart_digest TEXT CHECK (cart_digest IS NULL OR (length(cart_digest) = 64 AND cart_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE commerce_orders ADD COLUMN environment TEXT NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'live'));
ALTER TABLE commerce_orders ADD COLUMN checkout_status TEXT NOT NULL DEFAULT 'checkout_pending' CHECK (checkout_status IN ('checkout_pending', 'checkout_created', 'checkout_failed'));
ALTER TABLE commerce_orders ADD COLUMN stripe_checkout_url TEXT CHECK (stripe_checkout_url IS NULL OR length(stripe_checkout_url) BETWEEN 1 AND 2048);
ALTER TABLE commerce_orders ADD COLUMN stripe_payment_intent_id TEXT CHECK (stripe_payment_intent_id IS NULL OR length(stripe_payment_intent_id) BETWEEN 1 AND 255);
ALTER TABLE commerce_orders ADD COLUMN checkout_failure_code TEXT CHECK (checkout_failure_code IS NULL OR length(checkout_failure_code) BETWEEN 1 AND 80);
ALTER TABLE commerce_orders ADD COLUMN checkout_created_at TEXT;
ALTER TABLE commerce_orders ADD COLUMN payment_confirmed_at TEXT;
ALTER TABLE commerce_orders ADD COLUMN payment_failed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_orders_checkout_request
  ON commerce_orders(checkout_request_id)
  WHERE checkout_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_orders_payment_intent
  ON commerce_orders(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_orders_checkout_status
  ON commerce_orders(checkout_status, payment_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS commerce_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number BETWEEN 1 AND 20),
  product_id TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 160),
  product_name TEXT NOT NULL CHECK (length(product_name) BETWEEN 1 AND 240),
  currency_code TEXT NOT NULL CHECK (currency_code = 'CAD'),
  unit_amount INTEGER NOT NULL CHECK (unit_amount BETWEEN 1 AND 100000000),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  line_total_amount INTEGER NOT NULL CHECK (line_total_amount = unit_amount * quantity AND line_total_amount > 0),
  requires_shipping INTEGER NOT NULL DEFAULT 0 CHECK (requires_shipping IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  UNIQUE (order_id, line_number),
  UNIQUE (order_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_order_items_order
  ON commerce_order_items(order_id, line_number);

CREATE TABLE commerce_webhook_events_v2 (
  provider TEXT NOT NULL CHECK (provider = 'stripe'),
  provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 255),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 255),
  event_created_at INTEGER CHECK (event_created_at IS NULL OR event_created_at >= 0),
  received_at TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  api_version TEXT CHECK (api_version IS NULL OR length(api_version) BETWEEN 1 AND 80),
  related_object_id TEXT CHECK (related_object_id IS NULL OR length(related_object_id) BETWEEN 1 AND 255),
  related_object_type TEXT CHECK (related_object_type IS NULL OR length(related_object_type) BETWEEN 1 AND 120),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('received', 'accepted_noop', 'processed', 'ignored', 'error')),
  processed_at TEXT,
  result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 80),
  payload_sha256 TEXT CHECK (payload_sha256 IS NULL OR (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (provider, provider_event_id)
);

INSERT INTO commerce_webhook_events_v2 (
  provider, provider_event_id, event_type, event_created_at, received_at, livemode,
  api_version, related_object_id, related_object_type, processing_status,
  processed_at, result_code, payload_sha256
)
SELECT
  provider, provider_event_id, event_type, event_created_at, received_at, livemode,
  api_version, related_object_id, related_object_type, processing_status,
  processed_at, result_code, payload_sha256
FROM commerce_webhook_events;

DROP TABLE commerce_webhook_events;
ALTER TABLE commerce_webhook_events_v2 RENAME TO commerce_webhook_events;

CREATE INDEX IF NOT EXISTS idx_commerce_webhook_events_event_id
  ON commerce_webhook_events(provider_event_id);
CREATE INDEX IF NOT EXISTS idx_commerce_webhook_events_type_created
  ON commerce_webhook_events(provider, event_type, event_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_webhook_events_received
  ON commerce_webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_webhook_events_status
  ON commerce_webhook_events(provider, processing_status, received_at DESC);
