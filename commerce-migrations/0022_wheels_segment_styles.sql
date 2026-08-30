-- Wheels V1.8 segment styles and bounded segment-fill media.
-- Additive participant style storage; official spins/history are untouched.

ALTER TABLE wheel_entries
  ADD COLUMN segment_style_json TEXT
  CHECK (segment_style_json IS NULL OR (json_valid(segment_style_json) AND length(segment_style_json) <= 512));

ALTER TABLE wheel_media_assets RENAME TO wheel_media_assets_v17;

CREATE TABLE wheel_media_assets (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 80),
  wheel_id TEXT NOT NULL REFERENCES wheels(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('background', 'centre', 'segment_fill')),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 20 AND 500),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif', 'image/svg+xml')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 12000),
  height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 12000),
  original_filename TEXT CHECK (original_filename IS NULL OR length(original_filename) BETWEEN 1 AND 120),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deleted')),
  uploaded_by_account_id TEXT NOT NULL CHECK (length(uploaded_by_account_id) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO wheel_media_assets (
  id, wheel_id, purpose, object_key, sha256, content_type, byte_size, width, height,
  original_filename, lifecycle, uploaded_by_account_id, created_at, updated_at, deleted_at
)
SELECT id, wheel_id, purpose, object_key, sha256, content_type, byte_size, width, height,
       NULL, lifecycle, uploaded_by_account_id, created_at, updated_at, deleted_at
FROM wheel_media_assets_v17;

DROP TABLE wheel_media_assets_v17;

CREATE UNIQUE INDEX wheel_media_active_purpose_idx
  ON wheel_media_assets (wheel_id, purpose)
  WHERE lifecycle = 'active' AND purpose IN ('background', 'centre');

CREATE UNIQUE INDEX wheel_segment_media_active_hash_idx
  ON wheel_media_assets (wheel_id, purpose, sha256)
  WHERE lifecycle = 'active' AND purpose = 'segment_fill';

CREATE INDEX wheel_media_delivery_idx
  ON wheel_media_assets (id, lifecycle, wheel_id);

CREATE INDEX wheel_media_wheel_history_idx
  ON wheel_media_assets (wheel_id, purpose, created_at DESC);
