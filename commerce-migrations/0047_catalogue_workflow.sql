-- Additive catalogue job state. No provider, market or checkout policy changes.
CREATE TABLE commerce_sync_policy (
 id TEXT PRIMARY KEY CHECK(id='printful'), revision INTEGER NOT NULL DEFAULT 1,
 interval_minutes INTEGER NOT NULL DEFAULT 0 CHECK(interval_minutes IN (0,15,30,60)),
 auto_import INTEGER NOT NULL DEFAULT 0 CHECK(auto_import IN (0,1)),
 publish_new INTEGER NOT NULL DEFAULT 1 CHECK(publish_new IN (0,1)),
 baseline_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(baseline_json)),
 next_run_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL
);
INSERT INTO commerce_sync_policy(id,updated_at) VALUES('printful',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE commerce_sync_jobs (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL CHECK(store_id='18668025'),
 state TEXT NOT NULL CHECK(state IN ('reading','review','applying','completed','partial','cancelled','failed')),
 phase TEXT NOT NULL, source_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(source_json)),
 fingerprint TEXT, actor_account_id TEXT, scheduled INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until TEXT, retry_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX commerce_sync_active_job ON commerce_sync_jobs(store_id) WHERE state IN ('reading','review','applying');
CREATE TABLE commerce_sync_items (
 job_id TEXT NOT NULL REFERENCES commerce_sync_jobs(id) ON DELETE RESTRICT,
 provider_id TEXT NOT NULL, local_id TEXT, source_json TEXT CHECK(source_json IS NULL OR json_valid(source_json)),
 state TEXT NOT NULL DEFAULT 'pending', selected INTEGER NOT NULL DEFAULT 1,
 publish INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, result_json TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,provider_id)
);
CREATE INDEX commerce_sync_items_pending ON commerce_sync_items(job_id,state);
ALTER TABLE commerce_order_items ADD COLUMN image_snapshot_url TEXT;
