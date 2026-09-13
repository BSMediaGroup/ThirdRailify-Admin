-- Bounded chart summaries. Raw roster JSON remains in immutable semantic sets and
-- is never read by the trend endpoint.
ALTER TABLE rumble_intelligence_sources ADD COLUMN current_confirmations INTEGER NOT NULL DEFAULT 1 CHECK(current_confirmations BETWEEN 0 AND 2);
UPDATE rumble_intelligence_sources SET current_confirmations=2 WHERE current_id IS NOT NULL;

CREATE TABLE rumble_intelligence_rollups (
  source TEXT NOT NULL,
  grain TEXT NOT NULL CHECK(grain IN ('change','hour','day')),
  bucket_start TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES rumble_intelligence_observations(id),
  provider_at TEXT NOT NULL,
  observed_at TEXT,
  provenance TEXT NOT NULL CHECK(provenance IN ('live','historical')),
  set_id TEXT NOT NULL REFERENCES rumble_intelligence_sets(id),
  total_count INTEGER NOT NULL CHECK(total_count >= 0),
  paid_count INTEGER NOT NULL CHECK(paid_count >= 0),
  gifted_count INTEGER NOT NULL CHECK(gifted_count >= 0),
  mixed_count INTEGER NOT NULL CHECK(mixed_count >= 0),
  review_count INTEGER NOT NULL CHECK(review_count >= 0),
  raw_count INTEGER NOT NULL CHECK(raw_count >= 0),
  arrivals INTEGER,
  removals INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(source,grain,bucket_start)
) WITHOUT ROWID;

-- Backfill one latest qualified snapshot per reporting bucket. The source table
-- is currently small; this one-time migration replaces all future request-time
-- grouping. Historical arrivals/removals remain unknown rather than invented.
WITH grains(grain,seconds) AS (VALUES('hour',3600),('day',86400)),
ranked AS (
  SELECT o.id,o.source,o.provider_at,o.observed_at,o.provenance,o.set_id,o.metadata_json,
    g.grain,
    strftime('%Y-%m-%dT%H:%M:%SZ',CAST(unixepoch(o.provider_at)/g.seconds AS INTEGER)*g.seconds,'unixepoch') bucket_start,
    ROW_NUMBER() OVER (
      PARTITION BY o.source,g.grain,CAST(unixepoch(o.provider_at)/g.seconds AS INTEGER)
      ORDER BY o.provider_at DESC,CASE o.provenance WHEN 'live' THEN 1 ELSE 0 END DESC,o.id DESC
    ) rank
  FROM rumble_intelligence_observations o CROSS JOIN grains g
  WHERE o.qualified=1
),
chosen AS (
  SELECT * FROM ranked WHERE rank=1
),
account_flags AS (
  SELECT c.source,c.grain,c.bucket_start,c.id,c.provider_at,c.observed_at,c.provenance,c.set_id,c.metadata_json,
    json_extract(j.value,'$.name') account_name,
    MAX(json_extract(j.value,'$.classification')='Self-paid') has_paid,
    MAX(json_extract(j.value,'$.classification')='Gifted') has_gifted,
    MAX(json_extract(j.value,'$.classification')='Needs review') needs_review
  FROM chosen c
  JOIN rumble_intelligence_sets s ON s.id=c.set_id
  JOIN json_each(s.records_json) j
  GROUP BY c.source,c.grain,c.bucket_start,c.id,c.provider_at,c.observed_at,c.provenance,c.set_id,c.metadata_json,account_name
),
summary AS (
  SELECT c.source,c.grain,c.bucket_start,c.id,c.provider_at,c.observed_at,c.provenance,c.set_id,
    COUNT(f.account_name) total_count,
    COALESCE(SUM(f.needs_review=0 AND f.has_paid=1 AND f.has_gifted=0),0) paid_count,
    COALESCE(SUM(f.needs_review=0 AND f.has_paid=0 AND f.has_gifted=1),0) gifted_count,
    COALESCE(SUM(f.needs_review=0 AND f.has_paid=1 AND f.has_gifted=1),0) mixed_count,
    COALESCE(SUM(f.needs_review=1),0) review_count,
    COALESCE(CAST(json_extract(c.metadata_json,'$.rawCount') AS INTEGER),0) raw_count
  FROM chosen c LEFT JOIN account_flags f
    ON f.source=c.source AND f.grain=c.grain AND f.bucket_start=c.bucket_start
  GROUP BY c.source,c.grain,c.bucket_start,c.id,c.provider_at,c.observed_at,c.provenance,c.set_id,c.metadata_json
)
INSERT INTO rumble_intelligence_rollups
  (source,grain,bucket_start,snapshot_id,provider_at,observed_at,provenance,set_id,
   total_count,paid_count,gifted_count,mixed_count,review_count,raw_count,arrivals,removals,created_at,updated_at)
SELECT source,grain,bucket_start,id,provider_at,observed_at,provenance,set_id,
  total_count,paid_count,gifted_count,mixed_count,review_count,raw_count,NULL,NULL,datetime('now'),datetime('now')
FROM summary;

-- Preserve every semantic roster transition, including multiple changes within
-- one reporting bucket. Sparse checkpoints and changes are queried separately
-- with independent hard limits and merged by the API.
WITH ordered AS (
  SELECT o.id,o.source,o.provider_at,o.observed_at,o.provenance,o.set_id,o.metadata_json,
    LAG(o.set_id) OVER (PARTITION BY o.source ORDER BY o.provider_at,o.provenance,o.id) prior_set_id
  FROM rumble_intelligence_observations o WHERE o.qualified=1
),
chosen AS (
  SELECT * FROM ordered WHERE prior_set_id IS NULL OR prior_set_id<>set_id
),
account_flags AS (
  SELECT c.source,c.id,c.provider_at,c.observed_at,c.provenance,c.set_id,c.metadata_json,
    json_extract(j.value,'$.name') account_name,
    MAX(json_extract(j.value,'$.classification')='Self-paid') has_paid,
    MAX(json_extract(j.value,'$.classification')='Gifted') has_gifted,
    MAX(json_extract(j.value,'$.classification')='Needs review') needs_review
  FROM chosen c JOIN rumble_intelligence_sets s ON s.id=c.set_id JOIN json_each(s.records_json) j
  GROUP BY c.source,c.id,c.provider_at,c.observed_at,c.provenance,c.set_id,c.metadata_json,account_name
),
summary AS (
  SELECT c.source,c.id,c.provider_at,c.observed_at,c.provenance,c.set_id,
    COUNT(f.account_name) total_count,
    COALESCE(SUM(f.needs_review=0 AND f.has_paid=1 AND f.has_gifted=0),0) paid_count,
    COALESCE(SUM(f.needs_review=0 AND f.has_paid=0 AND f.has_gifted=1),0) gifted_count,
    COALESCE(SUM(f.needs_review=0 AND f.has_paid=1 AND f.has_gifted=1),0) mixed_count,
    COALESCE(SUM(f.needs_review=1),0) review_count,
    COALESCE(CAST(json_extract(c.metadata_json,'$.rawCount') AS INTEGER),0) raw_count
  FROM chosen c LEFT JOIN account_flags f ON f.source=c.source AND f.id=c.id
  GROUP BY c.source,c.id,c.provider_at,c.observed_at,c.provenance,c.set_id,c.metadata_json
)
INSERT INTO rumble_intelligence_rollups
  (source,grain,bucket_start,snapshot_id,provider_at,observed_at,provenance,set_id,
   total_count,paid_count,gifted_count,mixed_count,review_count,raw_count,arrivals,removals,created_at,updated_at)
SELECT source,'change',provider_at,id,provider_at,observed_at,provenance,set_id,
  total_count,paid_count,gifted_count,mixed_count,review_count,raw_count,NULL,NULL,datetime('now'),datetime('now')
FROM summary;
