-- Commerce customers are distinct from authentication accounts. Contact identity
-- is encrypted by the existing commerce AES-GCM helper; the keyed fingerprint
-- supports exact guest reuse without exposing plaintext email in D1.

CREATE TABLE commerce_customers (
  id TEXT PRIMARY KEY CHECK (id GLOB 'cst_*' AND length(id) BETWEEN 40 AND 80),
  customer_kind TEXT NOT NULL CHECK (customer_kind IN ('guest', 'account')),
  linked_account_id TEXT,
  contact_name_ciphertext TEXT NOT NULL CHECK (length(contact_name_ciphertext) BETWEEN 80 AND 8192),
  contact_email_ciphertext TEXT NOT NULL CHECK (length(contact_email_ciphertext) BETWEEN 80 AND 8192),
  contact_email_fingerprint TEXT NOT NULL
    CHECK (length(contact_email_fingerprint) BETWEEN 40 AND 64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (customer_kind = 'guest' AND linked_account_id IS NULL)
    OR
    (customer_kind = 'account' AND linked_account_id IS NOT NULL AND length(linked_account_id) BETWEEN 1 AND 160)
  )
);

CREATE UNIQUE INDEX idx_commerce_customers_account
  ON commerce_customers(linked_account_id)
  WHERE customer_kind = 'account';

CREATE UNIQUE INDEX idx_commerce_customers_guest_email
  ON commerce_customers(contact_email_fingerprint)
  WHERE customer_kind = 'guest';

CREATE INDEX idx_commerce_customers_created
  ON commerce_customers(created_at DESC, id ASC);

ALTER TABLE commerce_orders
  ADD COLUMN customer_id TEXT REFERENCES commerce_customers(id) ON DELETE RESTRICT;

CREATE INDEX idx_commerce_orders_customer
  ON commerce_orders(customer_id, created_at DESC);
