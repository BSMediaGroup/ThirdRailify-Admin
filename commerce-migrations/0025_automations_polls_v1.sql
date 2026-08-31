PRAGMA foreign_keys = ON;

CREATE TABLE poll_creator_grants (
  account_id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  may_create_polls INTEGER NOT NULL DEFAULT 0 CHECK (may_create_polls IN (0, 1)),
  granted_by_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  public_slug TEXT NOT NULL UNIQUE,
  owner_account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'open', 'closed', 'archived')),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  web_voting_mode TEXT NOT NULL DEFAULT 'anyone' CHECK (web_voting_mode IN ('anyone', 'signed_in')),
  rumble_enabled INTEGER NOT NULL DEFAULT 0 CHECK (rumble_enabled IN (0, 1)),
  rumble_source_scope TEXT,
  rumble_livestream_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (rumble_livestream_mode IN ('automatic', 'exact')),
  rumble_livestream_id TEXT,
  requested_interval_seconds INTEGER NOT NULL DEFAULT 15 CHECK (requested_interval_seconds BETWEEN 10 AND 30),
  theme_json TEXT NOT NULL DEFAULT '{}',
  result_metadata_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT,
  CHECK (rumble_livestream_mode != 'exact' OR length(rumble_livestream_id) BETWEEN 1 AND 160),
  CHECK (rumble_enabled = 0 OR length(rumble_source_scope) BETWEEN 1 AND 200)
);

CREATE INDEX polls_gallery_idx ON polls (is_public, state, updated_at DESC);
CREATE INDEX polls_owner_idx ON polls (owner_account_id, state, updated_at DESC);

CREATE TABLE poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  display_position INTEGER NOT NULL CHECK (display_position BETWEEN 0 AND 11),
  label TEXT NOT NULL,
  short_description TEXT,
  trigger_raw TEXT NOT NULL,
  trigger_normalized TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (poll_id, display_position),
  UNIQUE (poll_id, trigger_normalized)
);

CREATE INDEX poll_options_poll_idx ON poll_options (poll_id, display_position);

CREATE TABLE poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  source_namespace TEXT NOT NULL CHECK (source_namespace IN ('web_account', 'web_anonymous', 'rumble_chat')),
  voter_key_hash TEXT NOT NULL,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE RESTRICT,
  actor_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, source_namespace, voter_key_hash)
);

CREATE INDEX poll_votes_results_idx ON poll_votes (poll_id, option_id);

CREATE TABLE poll_rumble_event_fingerprints (
  event_fingerprint TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  poll_revision INTEGER NOT NULL,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE RESTRICT,
  source_scope TEXT NOT NULL,
  livestream_id TEXT NOT NULL,
  actor_key_hash TEXT NOT NULL,
  actor_label TEXT,
  provider_event_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE INDEX poll_rumble_events_poll_idx ON poll_rumble_event_fingerprints (poll_id, ingested_at DESC);

CREATE TABLE poll_rumble_leases (
  source_scope TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL UNIQUE REFERENCES polls(id) ON DELETE CASCADE,
  poll_revision INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE poll_rate_limits (
  key_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key_hash, category)
);

CREATE TABLE bot_automation_config (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  desired_revision INTEGER NOT NULL DEFAULT 1,
  desired_state_json TEXT NOT NULL DEFAULT '{}',
  updated_by_account_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE bot_runtime_heartbeat (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  startup_instance_id TEXT NOT NULL,
  bot_version TEXT NOT NULL,
  desired_revision INTEGER NOT NULL,
  applied_revision INTEGER NOT NULL,
  runtime_json TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bot_service_nonces (
  request_id TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX bot_service_nonces_expiry_idx ON bot_service_nonces (expires_at);

CREATE TABLE poll_activity_events (
  id TEXT PRIMARY KEY,
  poll_id TEXT REFERENCES polls(id) ON DELETE SET NULL,
  actor_account_id TEXT,
  event_type TEXT NOT NULL,
  result TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX poll_activity_created_idx ON poll_activity_events (created_at DESC);
CREATE INDEX poll_activity_poll_idx ON poll_activity_events (poll_id, created_at DESC);

INSERT INTO bot_automation_config (singleton_id, desired_revision, desired_state_json, updated_by_account_id, updated_at)
VALUES (1, 1, '{"discord":{},"rumble":{"enabled":false,"intervalSeconds":120,"pollIntervalSeconds":15},"processControl":"deferred"}', NULL, CURRENT_TIMESTAMP);
