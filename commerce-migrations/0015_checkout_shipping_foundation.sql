-- Customer checkout shipping foundation. Quotes contain fingerprints and safe
-- provider-rate projections only; customer delivery data is encrypted on the
-- one-to-one historical order snapshot.

CREATE TABLE commerce_shipping_quotes (
  id TEXT PRIMARY KEY CHECK (id GLOB 'shq_*' AND length(id) BETWEEN 40 AND 80),
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  cart_fingerprint TEXT NOT NULL CHECK (length(cart_fingerprint) = 64 AND cart_fingerprint NOT GLOB '*[^0-9a-f]*'),
  recipient_fingerprint TEXT NOT NULL CHECK (length(recipient_fingerprint) = 64 AND recipient_fingerprint NOT GLOB '*[^0-9a-f]*'),
  currency_code TEXT NOT NULL CHECK (currency_code = 'CAD'),
  shipping_strategy TEXT NOT NULL CHECK (shipping_strategy IN ('none', 'printful_dynamic')),
  provider TEXT CHECK (provider IS NULL OR provider = 'printful'),
  rate_options_json TEXT NOT NULL
    CHECK (json_valid(rate_options_json) AND json_type(rate_options_json) = 'array' AND length(rate_options_json) BETWEEN 2 AND 16384),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_commerce_shipping_quotes_expiry
  ON commerce_shipping_quotes(environment, expires_at);

CREATE TABLE commerce_order_delivery_snapshots (
  order_id TEXT PRIMARY KEY,
  recipient_ciphertext TEXT NOT NULL CHECK (length(recipient_ciphertext) BETWEEN 80 AND 8192),
  destination_country_code TEXT NOT NULL CHECK (length(destination_country_code) = 2),
  destination_region_code TEXT CHECK (destination_region_code IS NULL OR length(destination_region_code) BETWEEN 1 AND 80),
  shipping_strategy TEXT NOT NULL CHECK (shipping_strategy IN ('none', 'printful_dynamic')),
  provider TEXT CHECK (provider IS NULL OR provider = 'printful'),
  provider_shipping_method_id TEXT CHECK (provider_shipping_method_id IS NULL OR length(provider_shipping_method_id) BETWEEN 1 AND 120),
  display_shipping_method TEXT NOT NULL CHECK (length(display_shipping_method) BETWEEN 1 AND 100),
  shipping_amount INTEGER NOT NULL CHECK (shipping_amount BETWEEN 0 AND 2147483647),
  currency_code TEXT NOT NULL CHECK (currency_code = 'CAD'),
  source_quote_id TEXT NOT NULL UNIQUE,
  quoted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_quote_id) REFERENCES commerce_shipping_quotes(id) ON DELETE RESTRICT
);

CREATE INDEX idx_commerce_order_delivery_environment
  ON commerce_order_delivery_snapshots(destination_country_code, created_at DESC);
