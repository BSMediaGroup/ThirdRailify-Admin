-- Account V2 saved delivery-address authority. Saved addresses are mutable
-- customer convenience data; commerce_order_delivery_snapshots remain immutable
-- historical order records and are never linked back to these rows.

ALTER TABLE commerce_customers
  ADD COLUMN contact_phone_ciphertext TEXT
  CHECK (contact_phone_ciphertext IS NULL OR length(contact_phone_ciphertext) BETWEEN 80 AND 8192);

CREATE TABLE commerce_saved_addresses (
  id TEXT PRIMARY KEY CHECK (id GLOB 'adr_*' AND length(id) BETWEEN 40 AND 80),
  customer_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  address_ciphertext TEXT NOT NULL CHECK (length(address_ciphertext) BETWEEN 80 AND 8192),
  country_code TEXT NOT NULL CHECK (length(country_code) = 2),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deleted')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES commerce_customers(id) ON DELETE RESTRICT,
  CHECK (
    (lifecycle = 'active' AND deleted_at IS NULL)
    OR
    (lifecycle = 'deleted' AND deleted_at IS NOT NULL AND is_default = 0)
  )
);

CREATE UNIQUE INDEX idx_commerce_saved_addresses_default
  ON commerce_saved_addresses(customer_id)
  WHERE lifecycle = 'active' AND is_default = 1;

CREATE INDEX idx_commerce_saved_addresses_customer
  ON commerce_saved_addresses(customer_id, lifecycle, is_default DESC, created_at ASC);
