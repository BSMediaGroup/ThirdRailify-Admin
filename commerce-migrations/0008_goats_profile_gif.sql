PRAGMA foreign_keys = ON;

CREATE TABLE community_media_profile_gif (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  submission_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('main', 'profile', 'gallery')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 5),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 40 AND 240),
  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/jpeg', 'image/png', 'image/webp')
    OR (role = 'profile' AND content_type = 'image/gif')
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 12000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 12000),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  processing_state TEXT NOT NULL DEFAULT 'ready' CHECK (processing_state IN ('pending', 'ready', 'failed')),
  processing_error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES community_submissions(id) ON DELETE CASCADE
);

INSERT INTO community_media_profile_gif (
  id, submission_id, role, sort_order, object_key, content_type, byte_size, width, height,
  sha256, processing_state, processing_error, created_at
)
SELECT
  id, submission_id, role, sort_order, object_key, content_type, byte_size, width, height,
  sha256, processing_state, processing_error, created_at
FROM community_media;

DROP TABLE community_media;
ALTER TABLE community_media_profile_gif RENAME TO community_media;

CREATE INDEX idx_community_media_submission
  ON community_media(submission_id, role, sort_order);
CREATE UNIQUE INDEX idx_community_media_single_main
  ON community_media(submission_id) WHERE role = 'main';
CREATE UNIQUE INDEX idx_community_media_single_profile
  ON community_media(submission_id) WHERE role = 'profile';
