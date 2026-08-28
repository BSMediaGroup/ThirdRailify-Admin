PRAGMA foreign_keys = OFF;

ALTER TABLE commerce_business_profiles ADD COLUMN private_phone_ciphertext TEXT;
ALTER TABLE commerce_business_profiles ADD COLUMN business_registration_number_ciphertext TEXT;

CREATE TABLE commerce_tax_registrations_v2 (
  id TEXT PRIMARY KEY,
  business_profile_id TEXT NOT NULL DEFAULT 'primary',
  registration_type TEXT NOT NULL CHECK (registration_type IN ('business_number', 'gst_hst', 'qst', 'pst', 'rst', 'other', 'provincial')),
  jurisdiction TEXT NOT NULL CHECK (length(jurisdiction) BETWEEN 2 AND 80),
  country_code TEXT NOT NULL DEFAULT 'CA' CHECK (length(country_code) = 2),
  province_code TEXT CHECK (province_code IS NULL OR length(province_code) BETWEEN 2 AND 3),
  identifier_ciphertext TEXT NOT NULL,
  masked_identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'pending', 'verified', 'active', 'inactive', 'expired', 'not_registered', 'unavailable')),
  effective_date TEXT,
  expires_at TEXT,
  notes TEXT,
  document_disclosure_enabled INTEGER NOT NULL DEFAULT 0 CHECK (document_disclosure_enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT,
  FOREIGN KEY (business_profile_id) REFERENCES commerce_business_profiles(id) ON DELETE CASCADE,
  UNIQUE (business_profile_id, registration_type, jurisdiction)
);

INSERT INTO commerce_tax_registrations_v2 (
  id, business_profile_id, registration_type, jurisdiction, country_code, province_code,
  identifier_ciphertext, masked_identifier, status, created_at, updated_at, updated_by_account_id
)
SELECT id, business_profile_id, registration_type, jurisdiction,
       CASE WHEN jurisdiction = 'CA' THEN 'CA' ELSE 'CA' END,
       CASE WHEN length(jurisdiction) IN (2, 3) AND jurisdiction <> 'CA' THEN jurisdiction ELSE NULL END,
       identifier_ciphertext, masked_identifier, status, created_at, updated_at, updated_by_account_id
FROM commerce_tax_registrations;

DROP TABLE commerce_tax_registrations;
ALTER TABLE commerce_tax_registrations_v2 RENAME TO commerce_tax_registrations;
CREATE INDEX idx_commerce_tax_profile_status ON commerce_tax_registrations(business_profile_id, status, registration_type);

CREATE TABLE commerce_templates_v2 (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL UNIQUE CHECK (template_key IN ('order_confirmation', 'shipment_notification', 'cancellation', 'refund', 'payment_failure', 'invoice_notification', 'receipt_notification', 'payment_receipt', 'invoice_document')),
  template_kind TEXT NOT NULL DEFAULT 'email' CHECK (template_kind IN ('email', 'document')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  subject TEXT NOT NULL,
  preheader TEXT NOT NULL DEFAULT '',
  heading TEXT NOT NULL,
  introduction TEXT NOT NULL DEFAULT '',
  body_blocks_json TEXT NOT NULL DEFAULT '[]',
  cta_label TEXT NOT NULL DEFAULT '',
  cta_url TEXT NOT NULL DEFAULT '',
  support_text TEXT NOT NULL DEFAULT '',
  footer TEXT NOT NULL DEFAULT '',
  accent_color TEXT NOT NULL DEFAULT '#f3c928',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'disabled', 'ready')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT
);

INSERT INTO commerce_templates_v2 (
  id, template_key, template_kind, display_name, subject, preheader, heading, introduction,
  body_blocks_json, cta_label, cta_url, support_text, footer, accent_color, status, enabled,
  revision, created_at, updated_at, updated_by_account_id
)
SELECT id, template_key, 'email',
       CASE template_key
         WHEN 'order_confirmation' THEN 'Payment and order confirmation'
         WHEN 'shipment_notification' THEN 'Fulfillment and shipment update'
         WHEN 'cancellation' THEN 'Order cancelled'
         WHEN 'refund' THEN 'Refund processed'
         WHEN 'payment_failure' THEN 'Payment incomplete'
         WHEN 'invoice_notification' THEN 'Invoice available'
         ELSE 'Payment receipt available'
       END,
       subject, preheader, heading, introduction, body_blocks_json, cta_label, cta_url,
       support_text, footer, accent_color, status, CASE WHEN status = 'ready' THEN 1 ELSE 0 END,
       revision, created_at, updated_at, updated_by_account_id
FROM commerce_templates;

DROP TABLE commerce_templates;
ALTER TABLE commerce_templates_v2 RENAME TO commerce_templates;
CREATE INDEX idx_commerce_templates_kind_status ON commerce_templates(template_kind, status, enabled);

INSERT OR IGNORE INTO commerce_templates (
  id, template_key, template_kind, display_name, subject, heading, introduction,
  body_blocks_json, support_text, footer, status, enabled, created_at, updated_at
) VALUES
  ('template-payment-receipt', 'payment_receipt', 'document', 'Payment receipt', 'Payment receipt', 'Payment receipt',
   'Payment confirmed for {{order_reference}}.', '["{{product_summary}}","Total: {{order_total}} {{currency}}"]',
   'Questions? Contact {{support_email}}.', 'Third Railify Official', 'ready', 1,
   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
  ('template-invoice-document', 'invoice_document', 'document', 'Invoice / sales document', 'Invoice / sales document', 'Invoice / sales document',
   'Document for {{order_reference}}.', '["{{product_summary}}","Total: {{order_total}} {{currency}}"]',
   'Questions? Contact {{support_email}}.', 'Tax and legal disclosures appear only when configured.', 'draft', 0,
   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');

CREATE TABLE commerce_email_deliveries (
  id TEXT PRIMARY KEY,
  delivery_key TEXT NOT NULL UNIQUE CHECK (length(delivery_key) = 64 AND delivery_key NOT GLOB '*[^0-9a-f]*'),
  template_key TEXT NOT NULL,
  template_revision INTEGER NOT NULL CHECK (template_revision >= 1),
  order_id TEXT,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  recipient_email TEXT NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 254),
  purpose TEXT NOT NULL CHECK (purpose IN ('transactional', 'test_preview')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  provider_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (template_key) REFERENCES commerce_templates(template_key) ON DELETE RESTRICT,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT
);
CREATE INDEX idx_commerce_email_order_event ON commerce_email_deliveries(order_id, event_key, status);
CREATE INDEX idx_commerce_email_status ON commerce_email_deliveries(status, updated_at);

CREATE TABLE commerce_order_documents (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('receipt', 'invoice')),
  display_reference TEXT NOT NULL CHECK (length(display_reference) BETWEEN 1 AND 180),
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'issued', 'revoked')),
  template_key TEXT NOT NULL,
  template_revision INTEGER NOT NULL CHECK (template_revision >= 1),
  snapshot_json TEXT NOT NULL,
  access_token_hash TEXT UNIQUE CHECK (access_token_hash IS NULL OR (length(access_token_hash) = 64 AND access_token_hash NOT GLOB '*[^0-9a-f]*')),
  issued_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (template_key) REFERENCES commerce_templates(template_key) ON DELETE RESTRICT,
  UNIQUE (order_id, document_type)
);
CREATE INDEX idx_commerce_documents_token ON commerce_order_documents(access_token_hash, status);

INSERT OR IGNORE INTO commerce_settings (setting_key, value_json, classification, updated_at) VALUES
  ('tax_calculation_provider', '"unconfigured"', 'safe', '2026-08-29T00:00:00.000Z'),
  ('stripe_tax_enabled', 'false', 'safe', '2026-08-29T00:00:00.000Z'),
  ('shipping_strategy', '"unconfigured"', 'safe', '2026-08-29T00:00:00.000Z'),
  ('transactional_email_enabled', 'false', 'safe', '2026-08-29T00:00:00.000Z'),
  ('customer_document_access_enabled', 'false', 'safe', '2026-08-29T00:00:00.000Z');

PRAGMA foreign_keys = ON;
