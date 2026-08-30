PRAGMA foreign_keys = ON;

-- Absence means default Full Admin access. Rows record only explicit Master Admin denials.
CREATE TABLE IF NOT EXISTS admin_role_capability_denials (
  role TEXT NOT NULL CHECK (role = 'full'),
  capability TEXT NOT NULL,
  denied_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (role, capability)
);

CREATE INDEX IF NOT EXISTS admin_role_capability_denials_updated_idx
  ON admin_role_capability_denials(updated_at DESC);

