-- Durable human-facing entrant codes, exact provider bindings, receipt detail,
-- and an explicit closed-Wheel succession state. Existing primary keys,
-- weights, labels, media, receipts, results, and lifecycle values are retained.

ALTER TABLE wheel_entries ADD COLUMN entrant_code TEXT
  CHECK (entrant_code IS NULL OR (
    length(entrant_code) = 7
    AND entrant_code NOT GLOB '*[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]*'
  ));
ALTER TABLE wheel_entries ADD COLUMN display_suffix TEXT
  CHECK (display_suffix IS NULL OR length(display_suffix) BETWEEN 1 AND 32);
ALTER TABLE wheel_entries ADD COLUMN provenance_origin TEXT
  CHECK (provenance_origin IS NULL OR provenance_origin IN
    ('manual','automation','roster','imported','template_copy','legacy'));
ALTER TABLE wheel_entries ADD COLUMN origin_rule_id TEXT;
ALTER TABLE wheel_entries ADD COLUMN origin_rule_name TEXT
  CHECK (origin_rule_name IS NULL OR length(origin_rule_name) BETWEEN 1 AND 100);

UPDATE wheel_entries SET provenance_origin = CASE
  WHEN json_extract(entrant_identity_json, '$.origin') = 'automation' THEN 'automation'
  WHEN json_extract(entrant_identity_json, '$.origin') = 'imported' THEN 'imported'
  WHEN json_extract(entrant_identity_json, '$.origin') = 'manual' THEN 'manual'
  ELSE 'legacy' END
WHERE provenance_origin IS NULL;

CREATE UNIQUE INDEX wheel_entries_entrant_code_unique
  ON wheel_entries(entrant_code) WHERE entrant_code IS NOT NULL;
CREATE INDEX wheel_entries_code_lookup
  ON wheel_entries(wheel_id, entrant_code);

CREATE TABLE wheel_entry_source_bindings (
  id TEXT PRIMARY KEY,
  wheel_id TEXT NOT NULL REFERENCES wheels(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider = 'rumble'),
  source_scope TEXT NOT NULL CHECK(length(source_scope) BETWEEN 3 AND 200),
  actor_key TEXT NOT NULL CHECK(length(actor_key) BETWEEN 8 AND 500),
  actor_label_snapshot TEXT NOT NULL CHECK(length(actor_label_snapshot) BETWEEN 1 AND 120),
  entry_type TEXT NOT NULL CHECK(entry_type IN ('chat','follow','subscription','gift','raid','rant')),
  accumulation_group TEXT NOT NULL CHECK(length(accumulation_group) BETWEEN 1 AND 80),
  origin_rule_id TEXT,
  origin_rule_name_snapshot TEXT CHECK(origin_rule_name_snapshot IS NULL OR length(origin_rule_name_snapshot) BETWEEN 1 AND 100),
  created_receipt_id TEXT REFERENCES automation_receipts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE UNIQUE INDEX wheel_entry_source_bindings_current
  ON wheel_entry_source_bindings(wheel_id, provider, source_scope, actor_key, accumulation_group)
  WHERE retired_at IS NULL;
CREATE INDEX wheel_entry_source_bindings_entry
  ON wheel_entry_source_bindings(wheel_id, entry_id, retired_at);

CREATE TABLE automation_receipt_details (
  receipt_id TEXT PRIMARY KEY REFERENCES automation_receipts(id) ON DELETE CASCADE,
  wheel_id TEXT REFERENCES wheels(id) ON DELETE SET NULL,
  entry_id TEXT,
  entrant_code_snapshot TEXT CHECK(entrant_code_snapshot IS NULL OR (
    length(entrant_code_snapshot) = 7
    AND entrant_code_snapshot NOT GLOB '*[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]*'
  )),
  display_label_snapshot TEXT CHECK(display_label_snapshot IS NULL OR length(display_label_snapshot) BETWEEN 1 AND 120),
  display_suffix_snapshot TEXT CHECK(display_suffix_snapshot IS NULL OR length(display_suffix_snapshot) BETWEEN 1 AND 32),
  provider TEXT NOT NULL DEFAULT 'rumble' CHECK(provider = 'rumble'),
  source_scope TEXT CHECK(source_scope IS NULL OR length(source_scope) BETWEEN 3 AND 200),
  actor_key TEXT CHECK(actor_key IS NULL OR length(actor_key) BETWEEN 8 AND 500),
  entry_type TEXT CHECK(entry_type IS NULL OR entry_type IN ('chat','follow','subscription','gift','raid','rant','legacy')),
  provenance_origin TEXT CHECK(provenance_origin IS NULL OR provenance_origin IN ('automation','legacy')),
  rule_name_snapshot TEXT CHECK(rule_name_snapshot IS NULL OR length(rule_name_snapshot) BETWEEN 1 AND 100),
  received_quantity INTEGER CHECK(received_quantity IS NULL OR received_quantity BETWEEN 0 AND 100000000),
  received_unit TEXT CHECK(received_unit IS NULL OR received_unit IN ('event','gifts','cents')),
  award_calculation TEXT CHECK(award_calculation IS NULL OR length(award_calculation) <= 500),
  previous_weight INTEGER CHECK(previous_weight IS NULL OR previous_weight BETWEEN 0 AND 100000),
  new_weight INTEGER CHECK(new_weight IS NULL OR new_weight BETWEEN 0 AND 100000),
  award_delta INTEGER NOT NULL DEFAULT 0 CHECK(award_delta BETWEEN 0 AND 100000),
  safe_reason TEXT CHECK(safe_reason IS NULL OR length(safe_reason) <= 160),
  evidence_json TEXT CHECK(evidence_json IS NULL OR (json_valid(evidence_json) AND length(evidence_json) <= 2048)),
  chat_derived INTEGER NOT NULL DEFAULT 0 CHECK(chat_derived IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX automation_receipt_details_wheel_time
  ON automation_receipt_details(wheel_id, created_at DESC, receipt_id DESC);
CREATE INDEX automation_receipt_details_entry
  ON automation_receipt_details(wheel_id, entry_id, created_at DESC);

ALTER TABLE wheel_official_spins ADD COLUMN winning_entry_snapshot_json TEXT
  CHECK (winning_entry_snapshot_json IS NULL OR (
    json_valid(winning_entry_snapshot_json) AND length(winning_entry_snapshot_json) <= 16384
  ));

ALTER TABLE wheels ADD COLUMN closed_at TEXT;
ALTER TABLE wheels ADD COLUMN decided_result_id TEXT REFERENCES wheel_official_spins(id) ON DELETE RESTRICT;
ALTER TABLE wheels ADD COLUMN successor_wheel_id TEXT REFERENCES wheels(id) ON DELETE RESTRICT;

CREATE TABLE wheel_successions (
  id TEXT PRIMARY KEY,
  original_wheel_id TEXT NOT NULL UNIQUE REFERENCES wheels(id) ON DELETE RESTRICT,
  decided_result_id TEXT NOT NULL UNIQUE REFERENCES wheel_official_spins(id) ON DELETE RESTRICT,
  successor_wheel_id TEXT NOT NULL UNIQUE REFERENCES wheels(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 16 AND 120),
  copied_participants INTEGER NOT NULL CHECK(copied_participants IN (0,1)),
  copied_automation_count INTEGER NOT NULL DEFAULT 0 CHECK(copied_automation_count >= 0),
  created_by_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX wheels_public_directory_open_closed
  ON wheels(lifecycle, visibility, closed_at, display_order, updated_at DESC);
