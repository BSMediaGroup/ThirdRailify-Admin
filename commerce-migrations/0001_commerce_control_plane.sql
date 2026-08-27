PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS commerce_business_profiles (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  trading_name TEXT NOT NULL CHECK (length(trading_name) BETWEEN 1 AND 160),
  legal_business_name_ciphertext TEXT,
  country_code TEXT NOT NULL DEFAULT 'CA' CHECK (length(country_code) = 2),
  province_code TEXT NOT NULL DEFAULT 'ON' CHECK (length(province_code) BETWEEN 2 AND 3),
  currency_code TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency_code) = 3),
  public_address_json TEXT,
  private_address_ciphertext TEXT,
  public_contact_email TEXT,
  support_email TEXT,
  public_phone TEXT,
  website_url TEXT,
  invoice_prefix TEXT,
  document_footer TEXT,
  tax_provider_state TEXT NOT NULL DEFAULT 'unavailable' CHECK (tax_provider_state IN ('unavailable', 'setup_required', 'pending', 'disabled')),
  invoice_accent_color TEXT NOT NULL DEFAULT '#f3c928' CHECK (length(invoice_accent_color) = 7),
  receipt_accent_color TEXT NOT NULL DEFAULT '#f3c928' CHECK (length(receipt_accent_color) = 7),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT
);

CREATE TABLE IF NOT EXISTS commerce_tax_registrations (
  id TEXT PRIMARY KEY,
  business_profile_id TEXT NOT NULL DEFAULT 'primary',
  registration_type TEXT NOT NULL CHECK (registration_type IN ('business_number', 'gst_hst', 'provincial')),
  jurisdiction TEXT NOT NULL,
  identifier_ciphertext TEXT NOT NULL,
  masked_identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'pending', 'verified', 'not_registered', 'unavailable')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT,
  FOREIGN KEY (business_profile_id) REFERENCES commerce_business_profiles(id) ON DELETE CASCADE,
  UNIQUE (business_profile_id, registration_type, jurisdiction)
);

CREATE TABLE IF NOT EXISTS commerce_provider_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE CHECK (provider IN ('stripe', 'printful', 'paypal', 'printify', 'wix')),
  integration_mode TEXT CHECK (integration_mode IS NULL OR integration_mode IN ('direct_merchant', 'fulfillment', 'legacy')),
  credential_custody TEXT NOT NULL CHECK (credential_custody IN ('environment_secret', 'admin_encrypted', 'no_secret')),
  credential_ciphertext TEXT,
  status TEXT NOT NULL CHECK (status IN ('unavailable', 'setup_required', 'pending', 'connected', 'restricted', 'disabled', 'error', 'legacy_production', 'deferred')),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'test', 'live', 'legacy', 'deferred')),
  external_account_id TEXT,
  country_code TEXT,
  currency_code TEXT,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  last_synchronized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (credential_ciphertext IS NULL OR credential_custody = 'admin_encrypted'),
  CHECK (provider <> 'stripe' OR integration_mode = 'direct_merchant'),
  CHECK (provider <> 'stripe' OR credential_custody = 'environment_secret')
);

CREATE TABLE IF NOT EXISTS commerce_templates (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL UNIQUE CHECK (template_key IN ('order_confirmation', 'shipment_notification', 'cancellation', 'refund', 'payment_failure', 'invoice_notification', 'receipt_notification')),
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
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT
);

CREATE TABLE IF NOT EXISTS commerce_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'safe' CHECK (classification IN ('safe', 'private_encrypted')),
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT
);

CREATE TABLE IF NOT EXISTS commerce_permission_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('commerce.view', 'commerce.business.manage', 'commerce.payments.manage', 'commerce.integrations.manage', 'commerce.templates.manage')),
  granted_by_account_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_by_account_id TEXT,
  revoked_at TEXT,
  reason TEXT,
  CHECK ((revoked_at IS NULL AND revoked_by_account_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_account_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_permission_active
  ON commerce_permission_grants(account_id, capability)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_permission_account
  ON commerce_permission_grants(account_id, revoked_at);

CREATE TABLE IF NOT EXISTS commerce_products (
  id TEXT PRIMARY KEY,
  source_provider TEXT NOT NULL CHECK (source_provider IN ('wix_snapshot', 'printful', 'printify', 'manual')),
  external_product_id TEXT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency_code) = 3),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'restricted', 'disabled', 'error', 'legacy_production')),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_provider, external_product_id)
);

CREATE TABLE IF NOT EXISTS commerce_orders (
  id TEXT PRIMARY KEY,
  customer_payment_provider TEXT NOT NULL DEFAULT 'stripe' CHECK (customer_payment_provider IN ('stripe', 'paypal', 'wix_legacy')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'refunded', 'partially_refunded', 'disputed', 'failed', 'canceled')),
  fulfillment_provider TEXT CHECK (fulfillment_provider IN ('printful', 'printify', 'manual', 'wix_legacy')),
  fulfillment_status TEXT NOT NULL DEFAULT 'disabled' CHECK (fulfillment_status IN ('disabled', 'pending', 'draft', 'submitted', 'fulfilled', 'canceled', 'error')),
  currency_code TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency_code) = 3),
  customer_gross_amount INTEGER NOT NULL DEFAULT 0 CHECK (customer_gross_amount >= 0),
  stripe_fee_amount INTEGER NOT NULL DEFAULT 0 CHECK (stripe_fee_amount >= 0),
  refund_amount INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  printful_product_cost_amount INTEGER NOT NULL DEFAULT 0 CHECK (printful_product_cost_amount >= 0),
  printful_shipping_cost_amount INTEGER NOT NULL DEFAULT 0 CHECK (printful_shipping_cost_amount >= 0),
  printful_tax_amount INTEGER NOT NULL DEFAULT 0 CHECK (printful_tax_amount >= 0),
  printful_refund_credit_amount INTEGER NOT NULL DEFAULT 0 CHECK (printful_refund_credit_amount >= 0),
  gross_margin_amount INTEGER NOT NULL DEFAULT 0,
  stripe_checkout_session_id TEXT UNIQUE,
  printful_order_id TEXT UNIQUE,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commerce_orders_created
  ON commerce_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_orders_status
  ON commerce_orders(payment_status, fulfillment_status);

CREATE TABLE IF NOT EXISTS commerce_audit (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('success', 'rejected', 'error')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commerce_audit_created
  ON commerce_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_audit_actor
  ON commerce_audit(actor_account_id, created_at DESC);

INSERT OR IGNORE INTO commerce_business_profiles (
  id, trading_name, country_code, province_code, currency_code,
  public_contact_email, support_email, website_url, invoice_prefix,
  document_footer, created_at, updated_at
) VALUES (
  'primary', 'Third Railify Official', 'CA', 'ON', 'CAD',
  'info@thirdrailify.com', NULL, NULL, '',
  '', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'
);

INSERT OR IGNORE INTO commerce_provider_connections (
  id, provider, integration_mode, credential_custody, status, environment, country_code, currency_code,
  safe_metadata_json, created_at, updated_at
) VALUES
  ('provider-stripe', 'stripe', 'direct_merchant', 'environment_secret', 'setup_required', 'test', 'CA', 'CAD', '{"account_display_name":"Third Railify Official","account_created":true,"api_configured":false,"webhook_configured":false,"checkout_enabled":false,"live_payments_enabled":false,"live_payout_readiness":"unverified","payment_methods":["cards","eligible_apple_pay","eligible_google_pay"]}', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('provider-printful', 'printful', 'fulfillment', 'environment_secret', 'setup_required', 'staging', NULL, 'CAD', '{"mode":"draft_only","api_active":false,"fulfillment_enabled":false,"parallel_store_planned":true}', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('provider-paypal', 'paypal', 'direct_merchant', 'admin_encrypted', 'deferred', 'deferred', 'CA', 'CAD', '{"credentials_configured":false,"donations_active":false,"vip_active":false,"shop_processor":false}', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('provider-printify', 'printify', NULL, 'no_secret', 'unavailable', 'staging', NULL, NULL, '{"connectivity_verified":false,"custody_undecided":true}', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('provider-wix', 'wix', 'legacy', 'no_secret', 'legacy_production', 'legacy', 'CA', 'CAD', '{"must_remain_untouched":true}', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');

INSERT OR IGNORE INTO commerce_settings (setting_key, value_json, classification, updated_at) VALUES
  ('commerce_environment', '"staging"', 'safe', '2026-08-27T00:00:00.000Z'),
  ('checkout_enabled', 'false', 'safe', '2026-08-27T00:00:00.000Z'),
  ('live_payment_capture_enabled', 'false', 'safe', '2026-08-27T00:00:00.000Z'),
  ('fulfillment_submission_enabled', 'false', 'safe', '2026-08-27T00:00:00.000Z'),
  ('stripe_account_created', 'true', 'safe', '2026-08-27T00:00:00.000Z'),
  ('stripe_api_configured', 'false', 'safe', '2026-08-27T00:00:00.000Z'),
  ('stripe_webhook_configured', 'false', 'safe', '2026-08-27T00:00:00.000Z'),
  ('printful_order_mode', '"draft_only"', 'safe', '2026-08-27T00:00:00.000Z');

INSERT OR IGNORE INTO commerce_templates (
  id, template_key, subject, heading, introduction, body_blocks_json, status, created_at, updated_at
) VALUES
  ('template-order-confirmation', 'order_confirmation', 'We received your Third Railify order', 'Order received', 'Your order has been received. Payment and fulfillment status will be confirmed separately.', '[]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('template-shipment-notification', 'shipment_notification', 'Your Third Railify order has shipped', 'Order shipped', 'Tracking information will appear here after fulfillment confirms shipment.', '[]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('template-cancellation', 'cancellation', 'Your Third Railify order was cancelled', 'Order cancelled', 'This order has been cancelled.', '[]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('template-refund', 'refund', 'A refund was issued for your Third Railify order', 'Refund issued', 'Stripe has recorded a refund for this order.', '[]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('template-payment-failure', 'payment_failure', 'Payment was not completed', 'Payment incomplete', 'No order will be fulfilled from an incomplete payment.', '[]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('template-invoice-notification', 'invoice_notification', 'Your Third Railify invoice', 'Invoice available', 'Your invoice details are available through the approved payment workflow.', '[]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('template-receipt-notification', 'receipt_notification', 'Your Third Railify receipt', 'Payment receipt', 'This receipt reflects the authoritative payment record.', '[]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
