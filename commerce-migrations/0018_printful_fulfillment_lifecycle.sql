-- Normalized Printful provider-order, shipment, item-coverage, and signed
-- webhook evidence. Local payment state remains owned by commerce_orders.

PRAGMA foreign_keys = ON;

CREATE TABLE commerce_fulfillment_orders (
  id TEXT PRIMARY KEY CHECK (id GLOB 'flo_*' AND length(id) BETWEEN 40 AND 80),
  order_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'printful'),
  provider_store_id TEXT NOT NULL CHECK (length(provider_store_id) BETWEEN 1 AND 40),
  provider_order_id TEXT NOT NULL CHECK (length(provider_order_id) BETWEEN 1 AND 80),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 160),
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  provider_state TEXT NOT NULL CHECK (provider_state IN (
    'draft', 'submitted', 'processing', 'on_hold', 'partial', 'complete',
    'failed', 'canceled', 'archived', 'unknown'
  )),
  fulfillment_state TEXT NOT NULL CHECK (fulfillment_state IN (
    'unfulfilled', 'processing', 'partial', 'shipped', 'delivered',
    'returned', 'action_required', 'canceled', 'unknown'
  )),
  confirmation_state TEXT NOT NULL CHECK (confirmation_state IN ('unconfirmed', 'submitted', 'unknown')),
  provider_status TEXT NOT NULL CHECK (length(provider_status) BETWEEN 1 AND 40),
  failure_category TEXT CHECK (failure_category IS NULL OR length(failure_category) BETWEEN 1 AND 80),
  provider_created_at TEXT,
  provider_updated_at TEXT,
  last_provider_evidence_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  UNIQUE (order_id, provider),
  UNIQUE (provider, provider_store_id, provider_order_id),
  UNIQUE (provider, provider_store_id, external_id)
);

CREATE INDEX idx_commerce_fulfillment_orders_environment_state
  ON commerce_fulfillment_orders(environment, fulfillment_state, updated_at DESC);
CREATE INDEX idx_commerce_fulfillment_orders_evidence
  ON commerce_fulfillment_orders(last_provider_evidence_at DESC);

CREATE TABLE commerce_fulfillment_order_items (
  id TEXT PRIMARY KEY CHECK (id GLOB 'fli_*' AND length(id) BETWEEN 40 AND 80),
  fulfillment_order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  provider_order_item_id TEXT CHECK (provider_order_item_id IS NULL OR length(provider_order_item_id) BETWEEN 1 AND 80),
  provider_variant_id TEXT CHECK (provider_variant_id IS NULL OR length(provider_variant_id) BETWEEN 1 AND 160),
  ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (fulfillment_order_id) REFERENCES commerce_fulfillment_orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (order_item_id) REFERENCES commerce_order_items(id) ON DELETE RESTRICT,
  UNIQUE (fulfillment_order_id, order_item_id)
);

CREATE UNIQUE INDEX idx_commerce_fulfillment_items_provider_item
  ON commerce_fulfillment_order_items(fulfillment_order_id, provider_order_item_id)
  WHERE provider_order_item_id IS NOT NULL;
CREATE INDEX idx_commerce_fulfillment_items_order_item
  ON commerce_fulfillment_order_items(order_item_id);

CREATE TABLE commerce_fulfillment_shipments (
  id TEXT PRIMARY KEY CHECK (id GLOB 'fls_*' AND length(id) BETWEEN 40 AND 80),
  fulfillment_order_id TEXT NOT NULL,
  provider_shipment_id TEXT NOT NULL CHECK (length(provider_shipment_id) BETWEEN 1 AND 80),
  shipment_state TEXT NOT NULL CHECK (shipment_state IN ('shipped', 'delivered', 'returned', 'canceled', 'unknown')),
  provider_status TEXT CHECK (provider_status IS NULL OR length(provider_status) BETWEEN 1 AND 40),
  carrier TEXT CHECK (carrier IS NULL OR length(carrier) BETWEEN 1 AND 80),
  service TEXT CHECK (service IS NULL OR length(service) BETWEEN 1 AND 120),
  tracking_available INTEGER NOT NULL DEFAULT 0 CHECK (tracking_available IN (0, 1)),
  tracking_number_ciphertext TEXT CHECK (tracking_number_ciphertext IS NULL OR length(tracking_number_ciphertext) BETWEEN 80 AND 8192),
  tracking_url_ciphertext TEXT CHECK (tracking_url_ciphertext IS NULL OR length(tracking_url_ciphertext) BETWEEN 80 AND 8192),
  reshipment INTEGER NOT NULL DEFAULT 0 CHECK (reshipment IN (0, 1)),
  reshipment_of_shipment_id TEXT,
  returned_reason_category TEXT CHECK (returned_reason_category IS NULL OR length(returned_reason_category) BETWEEN 1 AND 80),
  provider_created_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  returned_at TEXT,
  last_provider_evidence_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (fulfillment_order_id) REFERENCES commerce_fulfillment_orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (reshipment_of_shipment_id) REFERENCES commerce_fulfillment_shipments(id) ON DELETE RESTRICT,
  UNIQUE (fulfillment_order_id, provider_shipment_id),
  CHECK (reshipment_of_shipment_id IS NULL OR reshipment = 1)
);

CREATE INDEX idx_commerce_fulfillment_shipments_state
  ON commerce_fulfillment_shipments(fulfillment_order_id, shipment_state, updated_at DESC);
CREATE INDEX idx_commerce_fulfillment_shipments_evidence
  ON commerce_fulfillment_shipments(last_provider_evidence_at DESC);

CREATE TABLE commerce_fulfillment_shipment_items (
  shipment_id TEXT NOT NULL,
  fulfillment_item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  PRIMARY KEY (shipment_id, fulfillment_item_id),
  FOREIGN KEY (shipment_id) REFERENCES commerce_fulfillment_shipments(id) ON DELETE RESTRICT,
  FOREIGN KEY (fulfillment_item_id) REFERENCES commerce_fulfillment_order_items(id) ON DELETE RESTRICT
);

CREATE INDEX idx_commerce_fulfillment_shipment_items_fulfillment_item
  ON commerce_fulfillment_shipment_items(fulfillment_item_id, shipment_id);

CREATE TABLE commerce_provider_webhook_events (
  id TEXT PRIMARY KEY CHECK (id GLOB 'pwe_*' AND length(id) = 68),
  provider TEXT NOT NULL CHECK (provider = 'printful'),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'order_created', 'order_updated', 'order_failed', 'order_canceled',
    'order_put_hold', 'order_remove_hold', 'shipment_sent',
    'shipment_delivered', 'shipment_returned', 'shipment_canceled'
  )),
  occurred_at TEXT NOT NULL,
  provider_store_id TEXT NOT NULL CHECK (length(provider_store_id) BETWEEN 1 AND 40),
  provider_order_id TEXT CHECK (provider_order_id IS NULL OR length(provider_order_id) BETWEEN 1 AND 80),
  provider_shipment_id TEXT CHECK (provider_shipment_id IS NULL OR length(provider_shipment_id) BETWEEN 1 AND 80),
  payload_sha256 TEXT NOT NULL
    CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('received', 'processed', 'ignored', 'unresolved', 'error')),
  result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 80),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1000000),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (provider, payload_sha256)
);

CREATE INDEX idx_commerce_provider_webhooks_order
  ON commerce_provider_webhook_events(provider, provider_order_id, occurred_at DESC);
CREATE INDEX idx_commerce_provider_webhooks_shipment
  ON commerce_provider_webhook_events(provider, provider_shipment_id, occurred_at DESC);
CREATE INDEX idx_commerce_provider_webhooks_status
  ON commerce_provider_webhook_events(provider, processing_status, received_at DESC);
