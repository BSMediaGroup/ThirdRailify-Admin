-- Polls V1.1 appearance media. Reuses the existing Admin-owned media R2 binding.
-- Existing Polls remain valid with procedural cover art and image-free options.

CREATE TABLE poll_media_assets (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 80),
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  poll_option_id TEXT REFERENCES poll_options(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('banner', 'option')),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 20 AND 500),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 10000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 10000),
  original_filename TEXT CHECK (original_filename IS NULL OR length(original_filename) BETWEEN 1 AND 120),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deleted')),
  uploaded_by_account_id TEXT NOT NULL CHECK (length(uploaded_by_account_id) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((purpose = 'banner' AND poll_option_id IS NULL) OR (purpose = 'option' AND poll_option_id IS NOT NULL))
);

CREATE UNIQUE INDEX poll_media_active_banner_idx
  ON poll_media_assets (poll_id)
  WHERE lifecycle = 'active' AND purpose = 'banner';

CREATE UNIQUE INDEX poll_media_active_option_idx
  ON poll_media_assets (poll_option_id)
  WHERE lifecycle = 'active' AND purpose = 'option';

CREATE INDEX poll_media_delivery_idx
  ON poll_media_assets (id, lifecycle, poll_id);

CREATE INDEX poll_media_poll_history_idx
  ON poll_media_assets (poll_id, purpose, created_at DESC);
