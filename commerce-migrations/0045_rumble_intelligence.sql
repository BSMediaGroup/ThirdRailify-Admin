-- Independent intelligence-only authority; no business/event triggers or sample seeds.
CREATE TABLE rumble_intelligence_sets (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  records_json TEXT NOT NULL CHECK(json_valid(records_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX rumble_intelligence_sets_source ON rumble_intelligence_sets(source);
CREATE TABLE rumble_intelligence_observations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  provider_at TEXT NOT NULL,
  observed_at TEXT,
  received_at TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('live','historical')),
  qualified INTEGER NOT NULL CHECK(qualified IN (0,1)),
  set_id TEXT NOT NULL REFERENCES rumble_intelligence_sets(id),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  UNIQUE(source,provider_at,provenance)
);
CREATE INDEX rumble_intelligence_observations_source_time ON rumble_intelligence_observations(source,qualified,provider_at DESC);
CREATE TABLE rumble_intelligence_sources (
  source TEXT PRIMARY KEY,
  current_id TEXT REFERENCES rumble_intelligence_observations(id),
  current_at TEXT,
  attempt_at TEXT NOT NULL,
  attempt_json TEXT NOT NULL CHECK(json_valid(attempt_json))
);
CREATE TABLE rumble_intelligence_imports (
  observation_id TEXT PRIMARY KEY REFERENCES rumble_intelligence_observations(id),
  account_id TEXT NOT NULL,
  received_at TEXT NOT NULL
);
