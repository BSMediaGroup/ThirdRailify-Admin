-- Separate LIVE donation capture authority from physical store capture authority.
INSERT INTO commerce_settings (setting_key, value_json, classification, updated_at)
VALUES ('paypal_donation_live_capture_enabled', 'false', 'safe', '2026-09-01T00:00:00.000Z')
ON CONFLICT(setting_key) DO NOTHING;
