-- Wheels V1.1 custom media. Uses the existing Admin-owned profile media R2 binding.
-- This migration creates no assets and does not alter wheel results or entries.

CREATE TABLE wheel_media_assets (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 80),
  wheel_id TEXT NOT NULL REFERENCES wheels(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('background', 'centre')),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 20 AND 500),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/svg+xml')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 12000),
  height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 12000),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deleted')),
  uploaded_by_account_id TEXT NOT NULL CHECK (length(uploaded_by_account_id) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX wheel_media_active_purpose_idx
  ON wheel_media_assets (wheel_id, purpose)
  WHERE lifecycle = 'active';

CREATE INDEX wheel_media_delivery_idx
  ON wheel_media_assets (id, lifecycle, wheel_id);

CREATE INDEX wheel_media_wheel_history_idx
  ON wheel_media_assets (wheel_id, purpose, created_at DESC);
