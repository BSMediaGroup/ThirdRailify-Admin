-- Removes only the fixed synthetic staging fixture. Official results deliberately prevent cleanup.
DELETE FROM wheel_access WHERE wheel_id = '00000000-0000-4000-8000-00000000d001';
DELETE FROM wheel_entries WHERE wheel_id = '00000000-0000-4000-8000-00000000d001';
DELETE FROM wheels
WHERE id = '00000000-0000-4000-8000-00000000d001'
  AND reference_code = 'DEMO-WHEEL-01'
  AND NOT EXISTS (SELECT 1 FROM wheel_official_spins WHERE wheel_id = '00000000-0000-4000-8000-00000000d001');
