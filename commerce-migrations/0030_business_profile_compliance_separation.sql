-- Preserve operator-owned business metadata independently from launch policy.
-- The operator explicitly selected Path A: not registered / not required to collect.
INSERT INTO commerce_settings (setting_key, value_json, classification, updated_at, updated_by_account_id)
VALUES ('tax_calculation_provider', '"not_collecting"', 'safe', '2026-09-01T00:00:00.000Z', 'operator-path-a')
ON CONFLICT(setting_key) DO UPDATE SET
  value_json = excluded.value_json,
  classification = 'safe',
  updated_at = excluded.updated_at,
  updated_by_account_id = excluded.updated_by_account_id
WHERE commerce_settings.value_json IN ('"unconfigured"', 'null');

-- This task does not implement or enable transaction disclosure at checkout.
INSERT OR IGNORE INTO commerce_settings (setting_key, value_json, classification, updated_at, updated_by_account_id)
VALUES ('internet_agreement_disclosure_enabled', 'false', 'safe', '2026-09-01T00:00:00.000Z', 'system-fail-closed');
