PRAGMA foreign_keys = ON;

CREATE TABLE automation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'rumble' CHECK (provider = 'rumble'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  source_scope TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('rumble.chat.exact','rumble.rant','rumble.follow','rumble.subscribe','rumble.gift_purchase')),
  conditions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(conditions_json)),
  action_type TEXT NOT NULL DEFAULT 'wheel.add_actor' CHECK (action_type = 'wheel.add_actor'),
  target_wheel_id TEXT REFERENCES wheels(id) ON DELETE SET NULL,
  duplicate_policy TEXT NOT NULL DEFAULT 'skip' CHECK (duplicate_policy = 'skip'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  activated_at TEXT,
  created_by_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  matched INTEGER NOT NULL DEFAULT 0,
  executed INTEGER NOT NULL DEFAULT 0,
  duplicate_events INTEGER NOT NULL DEFAULT 0,
  duplicate_entrants INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  last_match_at TEXT,
  last_outcome TEXT,
  last_fault TEXT
);
CREATE INDEX automation_rules_active_idx ON automation_rules(enabled, deleted_at, event_type);
CREATE INDEX automation_rules_wheel_idx ON automation_rules(target_wheel_id, deleted_at, updated_at DESC);

CREATE TABLE automation_receipts (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE RESTRICT,
  rule_revision INTEGER NOT NULL,
  event_fingerprint TEXT NOT NULL CHECK (length(event_fingerprint) = 64),
  event_type TEXT NOT NULL,
  provider_event_at TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('added','duplicate_entrant','wheel_unavailable')),
  target_wheel_id TEXT REFERENCES wheels(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(rule_id, event_fingerprint)
);
CREATE INDEX automation_receipts_rule_time_idx ON automation_receipts(rule_id, created_at DESC);
CREATE INDEX automation_receipts_time_idx ON automation_receipts(created_at DESC);
CREATE INDEX automation_receipts_wheel_time_idx ON automation_receipts(target_wheel_id, created_at DESC);
