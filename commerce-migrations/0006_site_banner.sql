PRAGMA foreign_keys = ON;

CREATE TABLE site_banner_settings (
  id TEXT PRIMARY KEY CHECK (id = 'global-banner'),
  config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object' AND length(config_json) <= 16384),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT
);

INSERT INTO site_banner_settings (id, config_json, revision, updated_at, updated_by_account_id)
VALUES (
  'global-banner',
  '{"normal":{"enabled":false,"messages":[],"mode":"static","speed":"normal"},"live":{"enabled":true,"label":"LIVE NOW","showTitle":true,"supportingText":null,"ctaLabel":"WATCH NOW","animation":"pulse-sweep","intensity":"normal"}}',
  1,
  '2026-08-28T00:00:00.000Z',
  NULL
);
