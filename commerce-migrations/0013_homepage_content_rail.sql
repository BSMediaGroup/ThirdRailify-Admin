-- Extend the existing Site Content authority with the homepage hero rail.

UPDATE site_banner_settings
SET config_json = json_set(
  config_json,
  '$.homeRail',
  json('{"enabled":true,"items":["THIRD RAILIFY","NEWS HANGOUT","ABOOT NOTHING","POP CULTURE BEAT DOWN"],"mode":"marquee","speed":"normal","easing":"linear","glyph":"zap"}')
),
revision = revision + 1,
updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'global-banner' AND json_type(config_json, '$.homeRail') IS NULL;
