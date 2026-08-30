-- Provider-neutral payment authority and direct-merchant PayPal Orders v2.
-- Stripe evidence remains readable but Stripe is intentionally disabled.

PRAGMA foreign_keys = OFF;

CREATE TABLE commerce_payment_provider_state (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  preferred_provider TEXT NOT NULL CHECK (preferred_provider IN ('paypal','stripe')),
  stripe_configured INTEGER NOT NULL CHECK (stripe_configured IN (0,1)),
  stripe_enabled INTEGER NOT NULL CHECK (stripe_enabled IN (0,1)),
  paypal_sandbox_configured INTEGER NOT NULL CHECK (paypal_sandbox_configured IN (0,1)),
  paypal_live_configured INTEGER NOT NULL CHECK (paypal_live_configured IN (0,1)),
  paypal_store_checkout_enabled INTEGER NOT NULL CHECK (paypal_store_checkout_enabled IN (0,1)),
  paypal_live_capture_enabled INTEGER NOT NULL CHECK (paypal_live_capture_enabled IN (0,1)),
  paypal_donations_enabled INTEGER NOT NULL CHECK (paypal_donations_enabled IN (0,1)),
  emergency_paused INTEGER NOT NULL CHECK (emergency_paused IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  transition_reason TEXT NOT NULL CHECK (length(transition_reason) BETWEEN 1 AND 300),
  updated_by_actor TEXT NOT NULL CHECK (length(updated_by_actor) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (stripe_enabled = 0 OR preferred_provider = 'stripe'),
  CHECK (paypal_store_checkout_enabled = 0 OR preferred_provider = 'paypal'),
  CHECK (paypal_live_capture_enabled = 0 OR paypal_live_configured = 1),
  CHECK (paypal_donations_enabled = 0 OR preferred_provider = 'paypal')
);

INSERT INTO commerce_payment_provider_state (
  id,preferred_provider,stripe_configured,stripe_enabled,paypal_sandbox_configured,
  paypal_live_configured,paypal_store_checkout_enabled,paypal_live_capture_enabled,
  paypal_donations_enabled,emergency_paused,revision,transition_reason,updated_by_actor,
  created_at,updated_at
) VALUES (
  'primary','paypal',1,0,0,0,0,0,0,0,1,
  'Owner selected PayPal as the preferred direct merchant payment provider; all activation gates remain closed.',
  'migration-0021','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'
);

CREATE TABLE commerce_donations (
  id TEXT PRIMARY KEY CHECK (id GLOB 'don_*' AND length(id) BETWEEN 40 AND 80),
  request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) = 36),
  request_digest TEXT NOT NULL CHECK (length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  customer_id TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
  currency_code TEXT NOT NULL CHECK (currency_code = 'CAD'),
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 100 AND 1000000),
  status TEXT NOT NULL CHECK (status IN ('created','approved','pending','completed','failed','refunded','reversed','canceled')),
  donor_display_preference TEXT CHECK (donor_display_preference IS NULL OR donor_display_preference IN ('private')),
  donor_contact_ciphertext TEXT CHECK (donor_contact_ciphertext IS NULL OR length(donor_contact_ciphertext) BETWEEN 80 AND 8192),
  approved_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  refunded_at TEXT,
  reversed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES commerce_customers(id) ON DELETE RESTRICT
);

CREATE INDEX idx_commerce_donations_environment_status
  ON commerce_donations(environment,status,created_at DESC);
CREATE INDEX idx_commerce_donations_customer
  ON commerce_donations(customer_id,created_at DESC);

CREATE TABLE commerce_payment_attempts (
  id TEXT PRIMARY KEY CHECK (id GLOB 'pat_*' AND length(id) BETWEEN 40 AND 80),
  commerce_order_id TEXT,
  donation_id TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('paypal','stripe')),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','test','live')),
  provider_order_id TEXT CHECK (provider_order_id IS NULL OR length(provider_order_id) BETWEEN 1 AND 80),
  provider_capture_id TEXT CHECK (provider_capture_id IS NULL OR length(provider_capture_id) BETWEEN 1 AND 80),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 180),
  currency_code TEXT NOT NULL CHECK (currency_code = 'CAD'),
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 2147483647),
  provider_status TEXT NOT NULL CHECK (length(provider_status) BETWEEN 1 AND 40),
  normalized_state TEXT NOT NULL CHECK (normalized_state IN ('created','approved','pending','completed','failed','refunded','reversed','canceled')),
  safe_error_code TEXT CHECK (safe_error_code IS NULL OR length(safe_error_code) BETWEEN 1 AND 100),
  paypal_debug_id TEXT CHECK (paypal_debug_id IS NULL OR length(paypal_debug_id) BETWEEN 1 AND 100),
  create_request_digest TEXT NOT NULL CHECK (length(create_request_digest)=64 AND create_request_digest NOT GLOB '*[^0-9a-f]*'),
  create_response_digest TEXT CHECK (create_response_digest IS NULL OR (length(create_response_digest)=64 AND create_response_digest NOT GLOB '*[^0-9a-f]*')),
  capture_request_digest TEXT CHECK (capture_request_digest IS NULL OR (length(capture_request_digest)=64 AND capture_request_digest NOT GLOB '*[^0-9a-f]*')),
  capture_response_digest TEXT CHECK (capture_response_digest IS NULL OR (length(capture_response_digest)=64 AND capture_response_digest NOT GLOB '*[^0-9a-f]*')),
  approved_at TEXT,
  captured_at TEXT,
  pending_at TEXT,
  failed_at TEXT,
  refunded_at TEXT,
  reversed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (commerce_order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (donation_id) REFERENCES commerce_donations(id) ON DELETE RESTRICT,
  UNIQUE (idempotency_key),
  CHECK ((commerce_order_id IS NOT NULL AND donation_id IS NULL) OR (commerce_order_id IS NULL AND donation_id IS NOT NULL)),
  CHECK ((provider='paypal' AND environment IN ('sandbox','live')) OR (provider='stripe' AND environment IN ('test','live')))
);

CREATE UNIQUE INDEX idx_commerce_payment_attempt_provider_order
  ON commerce_payment_attempts(provider,environment,provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_commerce_payment_attempt_provider_capture
  ON commerce_payment_attempts(provider,environment,provider_capture_id)
  WHERE provider_capture_id IS NOT NULL;
CREATE INDEX idx_commerce_payment_attempt_order
  ON commerce_payment_attempts(commerce_order_id,created_at DESC);
CREATE INDEX idx_commerce_payment_attempt_donation
  ON commerce_payment_attempts(donation_id,created_at DESC);
CREATE INDEX idx_commerce_payment_attempt_state
  ON commerce_payment_attempts(provider,environment,normalized_state,updated_at DESC);

CREATE TABLE commerce_paypal_webhook_events (
  provider_event_id TEXT PRIMARY KEY CHECK (length(provider_event_id) BETWEEN 1 AND 80),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','live','simulator')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'CHECKOUT.ORDER.APPROVED','CHECKOUT.PAYMENT-APPROVAL.REVERSED',
    'PAYMENT.CAPTURE.PENDING','PAYMENT.CAPTURE.COMPLETED','PAYMENT.CAPTURE.DECLINED',
    'PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED'
  )),
  provider_order_id TEXT CHECK (provider_order_id IS NULL OR length(provider_order_id) BETWEEN 1 AND 80),
  provider_capture_id TEXT CHECK (provider_capture_id IS NULL OR length(provider_capture_id) BETWEEN 1 AND 80),
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor BETWEEN 0 AND 2147483647),
  currency_code TEXT CHECK (currency_code IS NULL OR currency_code = 'CAD'),
  merchant_id TEXT CHECK (merchant_id IS NULL OR length(merchant_id) BETWEEN 1 AND 80),
  transmission_id TEXT NOT NULL CHECK (length(transmission_id) BETWEEN 1 AND 80),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified','simulator')),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('processed','ignored','unresolved','error')),
  result_code TEXT NOT NULL CHECK (length(result_code) BETWEEN 1 AND 100),
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (environment,transmission_id),
  UNIQUE (environment,payload_sha256)
);

CREATE INDEX idx_commerce_paypal_webhooks_order
  ON commerce_paypal_webhook_events(environment,provider_order_id,received_at DESC);
CREATE INDEX idx_commerce_paypal_webhooks_capture
  ON commerce_paypal_webhook_events(environment,provider_capture_id,received_at DESC);
CREATE INDEX idx_commerce_paypal_webhooks_status
  ON commerce_paypal_webhook_events(environment,processing_status,received_at DESC);

CREATE TABLE commerce_operation_jobs_v2 (
  id TEXT PRIMARY KEY CHECK (id GLOB 'coj_*' AND length(id) BETWEEN 40 AND 80),
  job_kind TEXT NOT NULL CHECK (job_kind IN (
    'fulfillment_submit','fulfillment_reconcile','email_send','paypal_order_reconcile',
    'paypal_capture_recover','paypal_pending_reconcile','paypal_webhook_recover',
    'store_payment_complete','donation_payment_complete'
  )),
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 180),
  order_id TEXT,
  donation_id TEXT,
  payment_attempt_id TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','test','live')),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','retry','action_required','completed','canceled')),
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 16 AND 120),
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
  next_attempt_at TEXT NOT NULL,
  last_error_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(last_error_json) AND json_type(last_error_json)='object' AND length(last_error_json)<=4096),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (donation_id) REFERENCES commerce_donations(id) ON DELETE RESTRICT,
  FOREIGN KEY (payment_attempt_id) REFERENCES commerce_payment_attempts(id) ON DELETE RESTRICT,
  UNIQUE (job_kind,event_key),
  CHECK ((state='leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state<>'leased' AND lease_token IS NULL AND lease_expires_at IS NULL))
);

INSERT INTO commerce_operation_jobs_v2 (
  id,job_kind,event_key,order_id,environment,payload_digest,state,lease_token,
  lease_expires_at,attempt_count,max_attempts,next_attempt_at,last_error_json,
  completed_at,created_at,updated_at
) SELECT id,job_kind,event_key,order_id,environment,payload_digest,state,lease_token,
  lease_expires_at,attempt_count,max_attempts,next_attempt_at,last_error_json,
  completed_at,created_at,updated_at FROM commerce_operation_jobs;
DROP TABLE commerce_operation_jobs;
ALTER TABLE commerce_operation_jobs_v2 RENAME TO commerce_operation_jobs;
CREATE INDEX idx_commerce_operation_jobs_due ON commerce_operation_jobs(state,next_attempt_at,created_at);
CREATE INDEX idx_commerce_operation_jobs_order ON commerce_operation_jobs(order_id,state,updated_at DESC);
CREATE INDEX idx_commerce_operation_jobs_payment ON commerce_operation_jobs(payment_attempt_id,state,updated_at DESC);
CREATE INDEX idx_commerce_operation_jobs_donation ON commerce_operation_jobs(donation_id,state,updated_at DESC);

CREATE TABLE commerce_provider_diagnostics_v2 (
  id TEXT PRIMARY KEY CHECK (id GLOB 'cpd_*' AND length(id) BETWEEN 40 AND 80),
  provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal','printful','resend')),
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  provider_code TEXT CHECK (provider_code IS NULL OR length(provider_code) BETWEEN 1 AND 100),
  provider_reason TEXT CHECK (provider_reason IS NULL OR length(provider_reason) BETWEEN 1 AND 300),
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 160),
  payload_digest TEXT CHECK (payload_digest IS NULL OR (length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*')),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0,1)),
  occurred_at TEXT NOT NULL
);
INSERT INTO commerce_provider_diagnostics_v2 SELECT * FROM commerce_provider_diagnostics;
DROP TABLE commerce_provider_diagnostics;
ALTER TABLE commerce_provider_diagnostics_v2 RENAME TO commerce_provider_diagnostics;
CREATE INDEX idx_commerce_provider_diagnostics_recent ON commerce_provider_diagnostics(provider,occurred_at DESC);

INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at)
VALUES
  ('preferred_payment_provider','"paypal"','safe','2026-08-30T00:00:00.000Z'),
  ('stripe_enabled','false','safe','2026-08-30T00:00:00.000Z'),
  ('paypal_sandbox_configured','false','safe','2026-08-30T00:00:00.000Z'),
  ('paypal_sandbox_webhook_configured','false','safe','2026-08-30T00:00:00.000Z'),
  ('paypal_live_configured','false','safe','2026-08-30T00:00:00.000Z'),
  ('paypal_live_webhook_configured','false','safe','2026-08-30T00:00:00.000Z'),
  ('paypal_store_checkout_enabled','false','safe','2026-08-30T00:00:00.000Z'),
  ('paypal_live_capture_enabled','false','safe','2026-08-30T00:00:00.000Z'),
  ('paypal_donations_enabled','false','safe','2026-08-30T00:00:00.000Z')
ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,classification='safe',updated_at=excluded.updated_at;

UPDATE commerce_provider_connections
SET status='disabled',environment='test',credential_custody='environment_secret',
    safe_metadata_json=json_set(safe_metadata_json,
      '$.preferred',json('false'),'$.enabled',json('false'),'$.checkout_enabled',json('false'),
      '$.live_payments_enabled',json('false'),'$.retained_for_future_activation',json('true')),
    updated_at='2026-08-30T00:00:00.000Z'
WHERE provider='stripe';

UPDATE commerce_provider_connections
SET integration_mode='direct_merchant',credential_custody='environment_secret',credential_ciphertext=NULL,
    status='setup_required',environment='live',country_code='CA',currency_code='CAD',
    safe_metadata_json='{"preferred":true,"provider_api":"Orders v2","intent":"CAPTURE","sandbox":{"client_id_configured":false,"client_secret_configured":false,"webhook_configured":false},"live":{"client_id_configured":false,"client_secret_configured":false,"webhook_configured":false},"store_checkout_enabled":false,"donations_enabled":false,"live_capture_enabled":false}',
    updated_at='2026-08-30T00:00:00.000Z'
WHERE provider='paypal';

INSERT INTO commerce_audit(id,actor_account_id,action,target_type,target_id,result,metadata_json,created_at)
VALUES (
  'audit-paypal-provider-selection-0021',NULL,'commerce.payment_provider_selected',
  'commerce_payment_provider_state','primary','success',
  '{"preferredProvider":"paypal","stripeState":"configured_disabled","paypalState":"setup_required","reason":"owner_selected_provider_migration"}',
  '2026-08-30T00:00:00.000Z'
);

PRAGMA foreign_keys = ON;
