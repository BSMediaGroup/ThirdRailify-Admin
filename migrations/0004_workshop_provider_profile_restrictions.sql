PRAGMA foreign_keys = ON;

CREATE TABLE workshop_provider_profile_policies (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('replicate','openai','xai','pexels','pixabay','unsplash')),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('all','selected')),
  default_profile_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  changed_by TEXT NOT NULL REFERENCES accounts(id),
  changed_at TEXT NOT NULL,
  write_token TEXT NOT NULL,
  PRIMARY KEY(account_id, provider)
);

CREATE TABLE workshop_provider_profile_grants (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  PRIMARY KEY(account_id, provider, profile_id),
  FOREIGN KEY(account_id, provider) REFERENCES workshop_provider_profile_policies(account_id, provider) ON DELETE CASCADE
);

CREATE TABLE workshop_provider_profile_audit (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  previous_json TEXT NOT NULL,
  next_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX workshop_provider_profile_audit_account
  ON workshop_provider_profile_audit(account_id, created_at DESC);
