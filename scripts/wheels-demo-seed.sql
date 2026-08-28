-- STAGING ONLY. Idempotent synthetic fixture; never run from a migration or application startup.
INSERT INTO wheels (
  id, reference_code, public_slug, title, description, lifecycle, visibility, owner_account_id,
  display_order, revision, spin_sequence, official_spin_enabled, public_demo_spin_enabled,
  editing_locked, official_spinning_locked, config_json, participant_count, created_at, updated_at
)
SELECT
  '00000000-0000-4000-8000-00000000d001', 'DEMO-WHEEL-01', 'third-railify-demo-draw',
  'Third Railify Demo Draw', 'A clearly synthetic staging wheel for visual and security acceptance.',
  'active', 'public', 'staging-demo-owner', 0, 1, 0, 1, 1, 0, 0,
  '{"themePreset":"third-rail-gold","palette":["#f3c928","#b8182f","#f3f0e5","#5b2c83"],"pointerAccent":"#f3c928","centreTreatment":"bolt","backgroundIntensity":"high","labelContrast":"light","spinDurationMs":6500,"tickingSoundEnabled":true,"winnerSoundEnabled":true,"celebrationIntensity":"full","winnerMessageTemplate":"Signal locked: {winner}","publicHistoryVisible":true}',
  8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM wheels WHERE reference_code = 'DEMO-WHEEL-01');

INSERT OR IGNORE INTO wheel_access (wheel_id, account_id, role, active, granted_by_account_id, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-00000000d001', 'staging-demo-owner', 'owner', 1, 'staging-demo-owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO wheel_entries (id, wheel_id, display_label, display_order, weight, segment_colour, state, created_at, updated_at) VALUES
('00000000-0000-4000-8100-00000000d001','00000000-0000-4000-8000-00000000d001','Demo GOAT 01',0,1,'#F3C928','active',strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
('00000000-0000-4000-8100-00000000d002','00000000-0000-4000-8000-00000000d001','Demo GOAT 02',1,1,'#B8182F','active',strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
('00000000-0000-4000-8100-00000000d003','00000000-0000-4000-8000-00000000d001','Demo GOAT 03',2,2,'#F3F0E5','active',strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
('00000000-0000-4000-8100-00000000d004','00000000-0000-4000-8000-00000000d001','Demo GOAT 04',3,1,'#5B2C83','active',strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
('00000000-0000-4000-8100-00000000d005','00000000-0000-4000-8000-00000000d001','Demo GOAT 05',4,1,'#F3C928','active',strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
('00000000-0000-4000-8100-00000000d006','00000000-0000-4000-8000-00000000d001','Demo GOAT 06',5,1,'#B8182F','active',strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
('00000000-0000-4000-8100-00000000d007','00000000-0000-4000-8000-00000000d001','Demo GOAT 07',6,3,'#F3F0E5','active',strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
('00000000-0000-4000-8100-00000000d008','00000000-0000-4000-8000-00000000d001','Demo GOAT 08',7,1,'#5B2C83','active',strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

