-- Admin-only actionable inbox and removal of reaction moderation queues.

CREATE TABLE IF NOT EXISTS admin_inbox_messages (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  preview TEXT NOT NULL,
  body_text TEXT NOT NULL,
  action_url TEXT,
  action_label TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_inbox_created ON admin_inbox_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_inbox_source ON admin_inbox_messages(source_type, source_id);

CREATE TABLE IF NOT EXISTS admin_inbox_reads (
  message_id TEXT NOT NULL REFERENCES admin_inbox_messages(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY(message_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_inbox_reads_account ON admin_inbox_reads(account_id, read_at DESC);

UPDATE commerce_settings
SET value_json = '"auto"', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE setting_key = 'community_reactions_mode' AND value_json = '"moderated"';

UPDATE community_submissions SET reaction_mode = 'auto' WHERE reaction_mode = 'moderated';
UPDATE community_reactions SET moderation_state = 'approved', moderated_by_account_id = NULL, moderated_at = NULL
WHERE moderation_state <> 'approved';

INSERT OR IGNORE INTO admin_inbox_messages
  (id, category, source_type, source_id, title, preview, body_text, action_url, action_label, created_at)
SELECT 'goat-submission-' || id, 'moderation', 'goat_submission', id,
  'GOATS submission awaiting review',
  display_name || ' submitted ' || COALESCE(product_name_snapshot, 'a catalogue product') || '.',
  'A GOATS in the Wild submission is waiting for product, media, location, consent, and story review.',
  '/goats/' || id, 'Review submission', COALESCE(submitted_at, updated_at)
FROM community_submissions WHERE status = 'pending';

INSERT OR IGNORE INTO admin_inbox_messages
  (id, category, source_type, source_id, title, preview, body_text, action_url, action_label, created_at)
SELECT 'goat-comment-' || c.id, 'moderation', 'goat_comment', c.id,
  'GOATS comment awaiting review',
  c.author_display_name || ' commented on ' || s.display_name || '.',
  c.body, '/goats/comments?status=pending', 'Moderate comment', c.created_at
FROM community_comments c JOIN community_submissions s ON s.id = c.submission_id
WHERE c.moderation_state = 'pending' AND c.status <> 'deleted';

INSERT OR IGNORE INTO admin_inbox_messages
  (id, category, source_type, source_id, title, preview, body_text, action_url, action_label, created_at)
SELECT 'goat-email-' || id, 'delivery', 'goat_email_failure', id,
  'GOATS email delivery needs attention',
  template_key || ' could not be delivered to its recipient.',
  COALESCE(last_error, 'The transactional email exhausted its current delivery attempt.'),
  '/goats/emails', 'Inspect delivery', updated_at
FROM community_email_outbox WHERE status = 'failed';
