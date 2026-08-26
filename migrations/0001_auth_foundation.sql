PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email_normalized TEXT UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  admin_level TEXT NOT NULL DEFAULT 'none' CHECK (admin_level IN ('none', 'full', 'master')),
  status TEXT NOT NULL DEFAULT 'pending_email' CHECK (status IN ('pending_email', 'active', 'disabled')),
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  source TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS accounts_role_status_idx ON accounts(role, status);
CREATE INDEX IF NOT EXISTS accounts_created_at_idx ON accounts(created_at DESC);

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  provider_username TEXT,
  provider_email TEXT,
  provider_email_verified INTEGER NOT NULL DEFAULT 0 CHECK (provider_email_verified IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS auth_identities_account_idx ON auth_identities(account_id);
CREATE INDEX IF NOT EXISTS auth_identities_email_idx ON auth_identities(provider_email);

CREATE TABLE IF NOT EXISTS password_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL,
  work_factor INTEGER NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  source_origin TEXT NOT NULL,
  user_agent_hash TEXT
);

CREATE INDEX IF NOT EXISTS sessions_account_active_idx ON sessions(account_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_transactions (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  pkce_verifier TEXT,
  target_origin TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS oauth_transactions_expires_idx ON oauth_transactions(expires_at);

CREATE TABLE IF NOT EXISTS auth_handoffs (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_origin TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS auth_handoffs_expires_idx ON auth_handoffs(expires_at);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  target_origin TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_account_idx ON email_verification_tokens(account_id, consumed_at);
CREATE INDEX IF NOT EXISTS email_verification_tokens_expires_idx ON email_verification_tokens(expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  target_origin TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_account_idx ON password_reset_tokens(account_id, consumed_at);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx ON password_reset_tokens(expires_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(key_hash, category)
);

CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_idx ON auth_rate_limits(updated_at);

CREATE TABLE IF NOT EXISTS auth_audit (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT,
  target_account_id TEXT,
  event_type TEXT NOT NULL,
  provider TEXT,
  result TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_audit_created_idx ON auth_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS auth_audit_actor_idx ON auth_audit(actor_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_audit_target_idx ON auth_audit(target_account_id, created_at DESC);
