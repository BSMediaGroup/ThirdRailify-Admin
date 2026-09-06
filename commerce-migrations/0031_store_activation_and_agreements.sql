-- Revision-bound merchant attestation, transaction-only disclosure authority,
-- and immutable checkout-agreement snapshots for the permanent store launch.

ALTER TABLE commerce_business_profiles ADD COLUMN owner_attested_revision INTEGER;
ALTER TABLE commerce_business_profiles ADD COLUMN owner_attested_at TEXT;
ALTER TABLE commerce_business_profiles ADD COLUMN owner_attested_by_account_id TEXT;
ALTER TABLE commerce_business_profiles ADD COLUMN transaction_disclosure_authorized_revision INTEGER;
ALTER TABLE commerce_business_profiles ADD COLUMN transaction_disclosure_authorized_at TEXT;

CREATE TABLE commerce_order_agreements (
  id TEXT PRIMARY KEY,
  checkout_request_id TEXT NOT NULL UNIQUE,
  order_id TEXT UNIQUE,
  customer_id TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  business_profile_revision INTEGER NOT NULL CHECK (business_profile_revision >= 1),
  tax_policy_revision TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  snapshot_ciphertext TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  acceptance_token_hash TEXT NOT NULL UNIQUE CHECK (length(acceptance_token_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('offered', 'accepted', 'declined', 'expired')),
  qualifying_internet_agreement INTEGER NOT NULL CHECK (qualifying_internet_agreement IN (0, 1)),
  offered_at TEXT NOT NULL,
  accepted_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id) REFERENCES commerce_customers(id) ON DELETE RESTRICT
);

CREATE INDEX idx_commerce_order_agreements_order
  ON commerce_order_agreements(order_id, status);
CREATE INDEX idx_commerce_order_agreements_expiry
  ON commerce_order_agreements(status, expires_at);

INSERT OR IGNORE INTO commerce_settings (setting_key, value_json, classification, updated_at, updated_by_account_id)
VALUES
  ('customer_document_access_enabled', 'false', 'safe', '2026-09-01T00:00:00.000Z', 'system-fail-closed'),
  ('commerce_agreement_schema_version', '1', 'safe', '2026-09-01T00:00:00.000Z', 'system');

-- Accepted agreements cannot be replaced or deleted by later profile/policy edits.
CREATE TRIGGER commerce_accepted_agreement_immutable_update
BEFORE UPDATE ON commerce_order_agreements WHEN OLD.status='accepted'
BEGIN
  SELECT RAISE(ABORT, 'accepted_agreement_immutable');
END;
CREATE TRIGGER commerce_accepted_agreement_immutable_delete
BEFORE DELETE ON commerce_order_agreements WHEN OLD.status='accepted'
BEGIN
  SELECT RAISE(ABORT, 'accepted_agreement_immutable');
END;

ALTER TABLE commerce_order_documents ADD COLUMN snapshot_ciphertext TEXT;
ALTER TABLE commerce_order_documents ADD COLUMN access_token_ciphertext TEXT;
