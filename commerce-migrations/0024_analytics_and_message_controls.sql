-- First-party audience analytics authority plus per-recipient inbox state.

CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 80),
  event_type TEXT NOT NULL CHECK (event_type IN ('page_view')),
  occurred_at TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 16 AND 80),
  public_path TEXT NOT NULL CHECK (length(public_path) BETWEEN 1 AND 512),
  page_type TEXT NOT NULL CHECK (length(page_type) BETWEEN 1 AND 48),
  referrer_host TEXT CHECK (referrer_host IS NULL OR length(referrer_host) <= 253),
  source_category TEXT NOT NULL CHECK (length(source_category) BETWEEN 1 AND 40),
  country_code TEXT CHECK (country_code IS NULL OR length(country_code) = 2),
  country_name TEXT CHECK (country_name IS NULL OR length(country_name) <= 100),
  region_code TEXT CHECK (region_code IS NULL OR length(region_code) <= 24),
  region_name TEXT CHECK (region_name IS NULL OR length(region_name) <= 100),
  city TEXT CHECK (city IS NULL OR length(city) <= 100),
  latitude REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  device_class TEXT NOT NULL CHECK (device_class IN ('desktop','mobile','tablet','other')),
  browser_family TEXT NOT NULL CHECK (length(browser_family) BETWEEN 1 AND 32),
  platform_family TEXT NOT NULL CHECK (length(platform_family) BETWEEN 1 AND 32),
  visitor_class TEXT NOT NULL CHECK (visitor_class IN ('guest','member')),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_analytics_events_occurred ON analytics_events(occurred_at DESC);
CREATE INDEX idx_analytics_events_session ON analytics_events(session_id,occurred_at DESC);
CREATE INDEX idx_analytics_events_path ON analytics_events(public_path,occurred_at DESC);
CREATE INDEX idx_analytics_events_geo ON analytics_events(country_code,region_name,city,occurred_at DESC);

ALTER TABLE admin_inbox_reads ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_admin_inbox_reads_deleted ON admin_inbox_reads(account_id,deleted_at,read_at DESC);

CREATE TABLE account_inbox_messages (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 80),
  account_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  source_type TEXT NOT NULL CHECK (length(source_type) BETWEEN 1 AND 80),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 160),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  preview TEXT NOT NULL CHECK (length(preview) BETWEEN 1 AND 320),
  body_text TEXT NOT NULL CHECK (length(body_text) BETWEEN 1 AND 4000),
  action_url TEXT CHECK (action_url IS NULL OR length(action_url) <= 512),
  action_label TEXT CHECK (action_label IS NULL OR length(action_label) <= 60),
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(account_id,source_type,source_id)
);

CREATE INDEX idx_account_inbox_account_created ON account_inbox_messages(account_id,created_at DESC);

CREATE TABLE account_inbox_states (
  message_id TEXT NOT NULL REFERENCES account_inbox_messages(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  read_at TEXT,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(message_id,account_id)
);

CREATE INDEX idx_account_inbox_states_account ON account_inbox_states(account_id,deleted_at,read_at,updated_at DESC);
