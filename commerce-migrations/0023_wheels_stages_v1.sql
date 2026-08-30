-- Wheels Stage V1. Additive normalized Stage authority; creates no stages.
-- Stage membership never grants access to the referenced Wheel.

CREATE TABLE wheel_stages (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 80),
  public_slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(public_slug) BETWEEN 3 AND 80),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR length(description) <= 280),
  owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) BETWEEN 1 AND 160),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX wheel_stages_public_directory_idx
  ON wheel_stages (lifecycle, visibility, updated_at DESC, title COLLATE NOCASE);

CREATE INDEX wheel_stages_owner_idx
  ON wheel_stages (owner_account_id, lifecycle, updated_at DESC);

CREATE TABLE wheel_stage_items (
  stage_id TEXT NOT NULL REFERENCES wheel_stages(id) ON DELETE CASCADE,
  wheel_id TEXT NOT NULL REFERENCES wheels(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 5),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (stage_id, wheel_id),
  UNIQUE (stage_id, position)
);

CREATE INDEX wheel_stage_items_wheel_idx
  ON wheel_stage_items (wheel_id, stage_id, position);
