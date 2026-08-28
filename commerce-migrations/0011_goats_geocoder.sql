INSERT INTO commerce_settings (setting_key, value_json, classification, updated_at)
VALUES ('community_geocoder_configured', 'true', 'safe', '2026-08-29T00:00:00.000Z')
ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;
