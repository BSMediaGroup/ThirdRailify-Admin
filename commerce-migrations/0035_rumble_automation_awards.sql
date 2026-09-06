-- V1.1: Admin-owned award policy. Keep the legacy Bot matching projection compatible.
ALTER TABLE automation_rules ADD COLUMN action_config_json TEXT NOT NULL
  DEFAULT '{"version":2,"repeatActorPolicy":"skip","award":{"mode":"fixed","entriesPerUnit":1,"unitCents":100}}'
  CHECK (json_valid(action_config_json));
ALTER TABLE automation_rules ADD COLUMN source_label TEXT;
ALTER TABLE automation_receipts ADD COLUMN awarded_entries INTEGER NOT NULL DEFAULT 0 CHECK (awarded_entries BETWEEN 0 AND 100000);
ALTER TABLE automation_receipts ADD COLUMN action_result TEXT;
UPDATE automation_receipts SET awarded_entries=1,action_result='created' WHERE outcome='added';
