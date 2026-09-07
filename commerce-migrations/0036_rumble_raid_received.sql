-- Requires 0034 and 0035. Local-only: preserve rules, awards, receipts and FKs.
CREATE TABLE automation_rules_raid_upgrade (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'rumble' CHECK (provider = 'rumble'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  source_scope TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('rumble.chat.exact','rumble.rant','rumble.follow','rumble.subscribe','rumble.gift_purchase','rumble.raid.received')),
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
  action_config_json TEXT NOT NULL DEFAULT '{"version":2,"repeatActorPolicy":"skip","award":{"mode":"fixed","entriesPerUnit":1,"unitCents":100}}' CHECK (json_valid(action_config_json)),
  source_label TEXT,
  last_fault TEXT
);

INSERT INTO automation_rules_raid_upgrade (id,name,description,provider,enabled,source_scope,event_type,conditions_json,action_type,target_wheel_id,duplicate_policy,revision,activated_at,created_by_account_id,created_at,updated_at,deleted_at,matched,executed,duplicate_events,duplicate_entrants,rejected,failed,last_match_at,last_outcome,action_config_json,source_label,last_fault) SELECT id,name,description,provider,enabled,source_scope,event_type,conditions_json,action_type,target_wheel_id,duplicate_policy,revision,activated_at,created_by_account_id,created_at,updated_at,deleted_at,matched,executed,duplicate_events,duplicate_entrants,rejected,failed,last_match_at,last_outcome,action_config_json,source_label,last_fault FROM automation_rules;
CREATE TABLE automation_receipts_raid_backup AS SELECT * FROM automation_receipts;
DROP TABLE automation_receipts;
DROP TABLE automation_rules;
ALTER TABLE automation_rules_raid_upgrade RENAME TO automation_rules;
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
  awarded_entries INTEGER NOT NULL DEFAULT 0 CHECK (awarded_entries BETWEEN 0 AND 100000),
  action_result TEXT,
  UNIQUE(rule_id, event_fingerprint)
);
CREATE INDEX automation_receipts_rule_time_idx ON automation_receipts(rule_id, created_at DESC);
CREATE INDEX automation_receipts_time_idx ON automation_receipts(created_at DESC);
CREATE INDEX automation_receipts_wheel_time_idx ON automation_receipts(target_wheel_id, created_at DESC);

INSERT INTO automation_receipts SELECT * FROM automation_receipts_raid_backup;
DROP TABLE automation_receipts_raid_backup;
