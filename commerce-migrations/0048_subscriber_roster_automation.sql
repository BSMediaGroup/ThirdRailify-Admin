-- Current self-paid subscriber roster automation. The registry remains the
-- evidence authority; these tables store only rule state, sparse transitions,
-- and rule-owned Wheel contribution provenance.
CREATE TABLE subscriber_roster_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  source_scope TEXT NOT NULL CHECK(length(source_scope) BETWEEN 3 AND 200),
  source_label TEXT,
  target_wheel_id TEXT NOT NULL REFERENCES wheels(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  sync_mode TEXT NOT NULL DEFAULT 'add_missing' CHECK(sync_mode IN ('add_missing','exact_managed')),
  entries_per_member INTEGER NOT NULL DEFAULT 1 CHECK(entries_per_member BETWEEN 1 AND 100000),
  minimum_quality TEXT NOT NULL DEFAULT 'qualified_live_current' CHECK(minimum_quality='qualified_live_current'),
  appearance_json TEXT CHECK(appearance_json IS NULL OR (json_valid(appearance_json) AND length(appearance_json)<=8192)),
  last_evaluated_snapshot_id TEXT REFERENCES rumble_intelligence_observations(id),
  last_roster_fingerprint TEXT CHECK(last_roster_fingerprint IS NULL OR length(last_roster_fingerprint)=64),
  last_successful_sync_at TEXT,
  last_result TEXT,
  eligible INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  gifted_excluded INTEGER NOT NULL DEFAULT 0,
  mixed_current INTEGER NOT NULL DEFAULT 0,
  review_excluded INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  sync_token TEXT,
  created_by_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX subscriber_roster_rules_wheel ON subscriber_roster_rules(target_wheel_id,deleted_at,enabled);
CREATE INDEX subscriber_roster_rules_source ON subscriber_roster_rules(source_scope,deleted_at,enabled);

CREATE TABLE wheel_entry_contributions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES subscriber_roster_rules(id) ON DELETE RESTRICT,
  wheel_id TEXT NOT NULL REFERENCES wheels(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  actor_label TEXT NOT NULL CHECK(length(actor_label) BETWEEN 1 AND 120),
  contribution_type TEXT NOT NULL CHECK(contribution_type='subscriber_roster'),
  weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 100000),
  snapshot_id TEXT NOT NULL REFERENCES rumble_intelligence_observations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(rule_id,actor_key),
  UNIQUE(rule_id,entry_id)
);
CREATE INDEX wheel_entry_contributions_wheel ON wheel_entry_contributions(wheel_id,entry_id);
CREATE INDEX wheel_entry_contributions_rule ON wheel_entry_contributions(rule_id,actor_key);

CREATE TABLE subscriber_roster_syncs (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES subscriber_roster_rules(id) ON DELETE RESTRICT,
  snapshot_id TEXT NOT NULL REFERENCES rumble_intelligence_observations(id) ON DELETE RESTRICT,
  roster_fingerprint TEXT NOT NULL CHECK(length(roster_fingerprint)=64),
  outcome TEXT NOT NULL CHECK(outcome IN ('changed','removal_blocked','failed')),
  counts_json TEXT NOT NULL CHECK(json_valid(counts_json) AND length(counts_json)<=2048),
  actor_account_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX subscriber_roster_syncs_rule_time ON subscriber_roster_syncs(rule_id,created_at DESC);
