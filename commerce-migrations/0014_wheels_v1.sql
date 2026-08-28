-- Third Railify Wheels V1. Admin-owned authority; intentionally creates no wheels or results.

CREATE TABLE wheel_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT
);

INSERT INTO wheel_settings (setting_key, value_json, revision, updated_at, updated_by_account_id)
VALUES (
  'global',
  '{"defaultTheme":"third-rail-gold","maximumParticipants":1000,"maximumWheelsPerCreator":20,"officialSpinCooldownSeconds":2,"defaultCelebrationIntensity":"full","defaultPublicHistory":true}',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
);

CREATE TABLE wheels (
  id TEXT PRIMARY KEY,
  reference_code TEXT NOT NULL UNIQUE,
  public_slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(public_slug) BETWEEN 3 AND 80),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR length(description) <= 280),
  lifecycle TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'active', 'archived')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden')),
  owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) BETWEEN 1 AND 160),
  display_order INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  spin_sequence INTEGER NOT NULL DEFAULT 0 CHECK (spin_sequence >= 0),
  official_spin_enabled INTEGER NOT NULL DEFAULT 1 CHECK (official_spin_enabled IN (0, 1)),
  public_demo_spin_enabled INTEGER NOT NULL DEFAULT 1 CHECK (public_demo_spin_enabled IN (0, 1)),
  editing_locked INTEGER NOT NULL DEFAULT 0 CHECK (editing_locked IN (0, 1)),
  official_spinning_locked INTEGER NOT NULL DEFAULT 0 CHECK (official_spinning_locked IN (0, 1)),
  config_json TEXT NOT NULL CHECK (json_valid(config_json) AND length(config_json) <= 8192),
  participant_count INTEGER NOT NULL DEFAULT 0 CHECK (participant_count BETWEEN 0 AND 1000),
  latest_official_spin_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX wheels_public_directory_idx ON wheels (lifecycle, visibility, display_order, updated_at DESC);
CREATE INDEX wheels_owner_idx ON wheels (owner_account_id, lifecycle, updated_at DESC);

CREATE TABLE wheel_entries (
  id TEXT PRIMARY KEY,
  wheel_id TEXT NOT NULL REFERENCES wheels(id) ON DELETE CASCADE,
  display_label TEXT NOT NULL CHECK (length(display_label) BETWEEN 1 AND 120),
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 100000),
  segment_colour TEXT CHECK (segment_colour IS NULL OR (length(segment_colour) = 7 AND substr(segment_colour, 1, 1) = '#' AND substr(segment_colour, 2) NOT GLOB '*[^0-9A-Fa-f]*')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'hidden')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (wheel_id, display_order)
);

CREATE INDEX wheel_entries_wheel_idx ON wheel_entries (wheel_id, state, display_order, id);

CREATE TABLE wheel_creator_grants (
  account_id TEXT PRIMARY KEY CHECK (length(account_id) BETWEEN 1 AND 160),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  may_create_wheels INTEGER NOT NULL DEFAULT 1 CHECK (may_create_wheels IN (0, 1)),
  maximum_owned_wheels INTEGER CHECK (maximum_owned_wheels IS NULL OR maximum_owned_wheels BETWEEN 1 AND 100),
  granted_by_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE wheel_access (
  wheel_id TEXT NOT NULL REFERENCES wheels(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 160),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'spinner')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  granted_by_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (wheel_id, account_id)
);

CREATE INDEX wheel_access_account_idx ON wheel_access (account_id, active, wheel_id);

CREATE TABLE wheel_official_spins (
  id TEXT PRIMARY KEY,
  wheel_id TEXT NOT NULL REFERENCES wheels(id) ON DELETE RESTRICT,
  wheel_revision INTEGER NOT NULL CHECK (wheel_revision >= 1),
  participant_snapshot_hash TEXT NOT NULL CHECK (length(participant_snapshot_hash) = 64),
  winning_entry_id TEXT NOT NULL,
  winning_label_snapshot TEXT NOT NULL CHECK (length(winning_label_snapshot) BETWEEN 1 AND 120),
  winning_weight_snapshot INTEGER NOT NULL CHECK (winning_weight_snapshot BETWEEN 1 AND 100000),
  performed_by_account_id TEXT NOT NULL,
  result_type TEXT NOT NULL DEFAULT 'official' CHECK (result_type = 'official'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 120),
  created_at TEXT NOT NULL,
  voided_at TEXT,
  void_reason TEXT CHECK (void_reason IS NULL OR length(void_reason) BETWEEN 3 AND 500),
  voided_by_account_id TEXT,
  UNIQUE (wheel_id, idempotency_key)
);

CREATE INDEX wheel_official_spins_history_idx ON wheel_official_spins (wheel_id, created_at DESC, id DESC);
CREATE INDEX wheel_official_spins_actor_idx ON wheel_official_spins (performed_by_account_id, created_at DESC);

CREATE TABLE wheel_audit_events (
  id TEXT PRIMARY KEY,
  wheel_id TEXT REFERENCES wheels(id) ON DELETE SET NULL,
  actor_account_id TEXT,
  target_account_id TEXT,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 3 AND 80),
  metadata_json TEXT CHECK (metadata_json IS NULL OR (json_valid(metadata_json) AND length(metadata_json) <= 8192)),
  created_at TEXT NOT NULL
);

CREATE INDEX wheel_audit_events_wheel_idx ON wheel_audit_events (wheel_id, created_at DESC);
CREATE INDEX wheel_audit_events_actor_idx ON wheel_audit_events (actor_account_id, created_at DESC);

CREATE TABLE wheel_rate_limits (
  key_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  blocked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key_hash, category)
);
