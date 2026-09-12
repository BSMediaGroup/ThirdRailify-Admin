CREATE TABLE workshop_access (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('granted','suspended','revoked')),
  expires_at TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  changed_by TEXT NOT NULL REFERENCES accounts(id),
  changed_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE workshop_access_audit (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  revision INTEGER NOT NULL,
  previous_json TEXT NOT NULL,
  next_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, revision)
);
CREATE INDEX workshop_access_audit_account ON workshop_access_audit(account_id, created_at DESC);
