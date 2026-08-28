PRAGMA foreign_keys = ON;

ALTER TABLE community_submissions ADD COLUMN comment_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (comment_mode IN ('inherit', 'disabled', 'auto', 'moderated'));
ALTER TABLE community_submissions ADD COLUMN reaction_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (reaction_mode IN ('inherit', 'disabled', 'auto', 'moderated'));
ALTER TABLE community_submissions ADD COLUMN legacy_source TEXT;
ALTER TABLE community_submissions ADD COLUMN legacy_source_id TEXT;
ALTER TABLE community_submissions ADD COLUMN legacy_owner_id TEXT;
ALTER TABLE community_submissions ADD COLUMN legacy_product_url TEXT;
ALTER TABLE community_submissions ADD COLUMN legacy_uploaded_at TEXT;
ALTER TABLE community_submissions ADD COLUMN legacy_updated_at TEXT;
ALTER TABLE community_submissions ADD COLUMN legacy_like_count INTEGER NOT NULL DEFAULT 0 CHECK (legacy_like_count >= 0);
ALTER TABLE community_submissions ADD COLUMN legacy_dislike_count INTEGER NOT NULL DEFAULT 0 CHECK (legacy_dislike_count >= 0);
ALTER TABLE community_submissions ADD COLUMN legacy_comment_count INTEGER NOT NULL DEFAULT 0 CHECK (legacy_comment_count >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_submissions_legacy_source
  ON community_submissions(legacy_source, legacy_source_id)
  WHERE legacy_source IS NOT NULL AND legacy_source_id IS NOT NULL;

ALTER TABLE community_comments ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'approved'
  CHECK (moderation_state IN ('approved', 'pending', 'hidden'));

ALTER TABLE community_reactions ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'approved'
  CHECK (moderation_state IN ('approved', 'pending', 'hidden'));
ALTER TABLE community_reactions ADD COLUMN moderated_by_account_id TEXT;
ALTER TABLE community_reactions ADD COLUMN moderated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_community_comments_moderation
  ON community_comments(moderation_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_reactions_moderation
  ON community_reactions(moderation_state, updated_at DESC);

INSERT OR IGNORE INTO commerce_settings (setting_key, value_json, classification, updated_at) VALUES
  ('community_comments_mode', '"auto"', 'safe', '2026-08-28T00:00:00.000Z'),
  ('community_reactions_mode', '"auto"', 'safe', '2026-08-28T00:00:00.000Z');
