PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS community_submissions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  reference_code TEXT NOT NULL UNIQUE CHECK (length(reference_code) BETWEEN 8 AND 24),
  public_slug TEXT UNIQUE CHECK (public_slug IS NULL OR (length(public_slug) BETWEEN 3 AND 120 AND public_slug NOT GLOB '*[^a-z0-9-]*')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  draft_token_hash TEXT CHECK (draft_token_hash IS NULL OR length(draft_token_hash) = 64),
  draft_expires_at TEXT,
  submitter_account_id TEXT CHECK (submitter_account_id IS NULL OR length(submitter_account_id) BETWEEN 1 AND 160),
  submitter_email TEXT,
  display_name TEXT,
  description TEXT,
  product_id TEXT,
  product_slug_snapshot TEXT,
  product_name_snapshot TEXT,
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  city TEXT,
  region TEXT,
  country_code TEXT CHECK (country_code IS NULL OR (length(country_code) = 2 AND country_code = upper(country_code))),
  public_location_label TEXT,
  public_latitude REAL CHECK (public_latitude IS NULL OR public_latitude BETWEEN -85 AND 85),
  public_longitude REAL CHECK (public_longitude IS NULL OR public_longitude BETWEEN -180 AND 180),
  location_confirmed_at TEXT,
  consent_version TEXT,
  consented_at TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  rejected_at TEXT,
  moderator_account_id TEXT,
  moderator_note TEXT,
  rejection_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (status <> 'draft' OR (draft_token_hash IS NOT NULL AND draft_expires_at IS NOT NULL)),
  CHECK (status <> 'approved' OR (public_slug IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (is_published = 0 OR status = 'approved'),
  FOREIGN KEY (product_id) REFERENCES commerce_products(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_community_submissions_status
  ON community_submissions(status, is_published, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_submissions_product
  ON community_submissions(product_id, status, is_published);
CREATE INDEX IF NOT EXISTS idx_community_submissions_location
  ON community_submissions(country_code, status, is_published);
CREATE INDEX IF NOT EXISTS idx_community_submissions_draft_expiry
  ON community_submissions(status, draft_expires_at);

CREATE TABLE IF NOT EXISTS community_media (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  submission_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('main', 'profile', 'gallery')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 5),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 40 AND 240),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 12000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 12000),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  processing_state TEXT NOT NULL DEFAULT 'ready' CHECK (processing_state IN ('pending', 'ready', 'failed')),
  processing_error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES community_submissions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_community_media_submission
  ON community_media(submission_id, role, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_media_single_main
  ON community_media(submission_id) WHERE role = 'main';
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_media_single_profile
  ON community_media(submission_id) WHERE role = 'profile';

CREATE TABLE IF NOT EXISTS community_reactions (
  submission_id TEXT NOT NULL,
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 160),
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (submission_id, account_id),
  FOREIGN KEY (submission_id) REFERENCES community_submissions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_community_reactions_listing
  ON community_reactions(submission_id, value);

CREATE TABLE IF NOT EXISTS community_comments (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  submission_id TEXT NOT NULL,
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 160),
  author_display_name TEXT NOT NULL CHECK (length(author_display_name) BETWEEN 1 AND 80),
  author_avatar_url TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1200),
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  moderated_by_account_id TEXT,
  moderated_at TEXT,
  FOREIGN KEY (submission_id) REFERENCES community_submissions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_community_comments_public
  ON community_comments(submission_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_comments_account
  ON community_comments(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_moderation_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  submission_id TEXT NOT NULL,
  actor_account_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted', 'updated', 'approved', 'rejected', 'hidden', 'restored', 'comment_hidden', 'comment_restored', 'email_retried')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES community_submissions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_community_moderation_submission
  ON community_moderation_events(submission_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_email_templates (
  template_key TEXT PRIMARY KEY CHECK (template_key IN ('goat_submission_received', 'goat_submission_admin_alert', 'goat_submission_approved', 'goat_submission_rejected')),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  html_body TEXT NOT NULL CHECK (length(html_body) BETWEEN 1 AND 20000),
  text_body TEXT NOT NULL CHECK (length(text_body) BETWEEN 1 AND 10000),
  variables_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'disabled', 'ready')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT
);

CREATE TABLE IF NOT EXISTS community_email_outbox (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  template_key TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 12 AND 180),
  variables_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  last_error TEXT,
  provider_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (template_key) REFERENCES community_email_templates(template_key) ON DELETE RESTRICT,
  FOREIGN KEY (submission_id) REFERENCES community_submissions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_community_email_outbox_state
  ON community_email_outbox(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_email_outbox_submission
  ON community_email_outbox(submission_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_rate_limits (
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
  category TEXT NOT NULL CHECK (category IN ('draft', 'upload', 'finalise', 'reaction', 'comment')),
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  blocked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key_hash, category)
);

INSERT OR IGNORE INTO commerce_settings (setting_key, value_json, classification, updated_at) VALUES
  ('community_submission_enabled', 'true', 'safe', '2026-08-27T00:00:00.000Z'),
  ('community_consent_version', '"goats-v2-2026-08"', 'safe', '2026-08-27T00:00:00.000Z'),
  ('community_geocoder_configured', 'false', 'safe', '2026-08-27T00:00:00.000Z');

INSERT OR IGNORE INTO community_email_templates (
  template_key, subject, html_body, text_body, variables_json, status, created_at, updated_at
) VALUES
  ('goat_submission_received', 'We received your GOATS in the Wild submission', '<h1>Submission received</h1><p>Hi {{display_name}},</p><p>We received submission <strong>{{submission_reference}}</strong> for {{product_name}}. It will remain private until approved.</p><p>{{support_url}}</p>', 'Submission received\n\nHi {{display_name}},\n\nWe received submission {{submission_reference}} for {{product_name}}. It will remain private until approved.\n\n{{support_url}}', '["display_name","submission_reference","product_name","submitted_date","status","support_url"]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('goat_submission_admin_alert', 'New GOATS submission pending review', '<h1>Moderation requested</h1><p>{{display_name}} submitted {{submission_reference}} for {{product_name}}.</p><p><a href="{{moderation_url}}">Open moderation</a></p>', 'Moderation requested\n\n{{display_name}} submitted {{submission_reference}} for {{product_name}}.\n\n{{moderation_url}}', '["display_name","submission_reference","product_name","submitted_date","status","moderation_url"]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('goat_submission_approved', 'Your GOATS in the Wild page is live', '<h1>You are in the Wild</h1><p>Hi {{display_name}},</p><p>Your {{product_name}} submission is approved.</p><p><a href="{{public_listing_url}}">View your listing</a></p>', 'You are in the Wild\n\nHi {{display_name}},\n\nYour {{product_name}} submission is approved.\n\n{{public_listing_url}}', '["display_name","submission_reference","product_name","submitted_date","status","public_listing_url","support_url"]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  ('goat_submission_rejected', 'An update on your GOATS submission', '<h1>Submission update</h1><p>Hi {{display_name}},</p><p>We could not publish submission {{submission_reference}}.</p><p>{{rejection_reason}}</p><p>{{support_url}}</p>', 'Submission update\n\nHi {{display_name}},\n\nWe could not publish submission {{submission_reference}}.\n\n{{rejection_reason}}\n\n{{support_url}}', '["display_name","submission_reference","product_name","submitted_date","status","rejection_reason","support_url"]', 'draft', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
