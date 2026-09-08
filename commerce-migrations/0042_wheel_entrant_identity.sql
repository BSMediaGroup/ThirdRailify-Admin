-- Semantic identity is separate from decorative appearance. NULL means legacy /
-- unclassified: never infer a paid event or reassign historical weights by name.
ALTER TABLE wheel_entries ADD COLUMN entrant_identity_json TEXT
  CHECK (entrant_identity_json IS NULL OR (
    json_valid(entrant_identity_json) AND length(entrant_identity_json) <= 512
    AND json_extract(entrant_identity_json, '$.version') IS 1
    AND COALESCE(json_extract(entrant_identity_json, '$.type') IN ('regular','chat','follow','subscription','gift','raid','rant','legacy'), 0)
    AND COALESCE(json_extract(entrant_identity_json, '$.origin') IN ('manual','imported','automation','legacy'), 0)
    AND CASE WHEN json_extract(entrant_identity_json, '$.origin') = 'automation'
      THEN json_type(entrant_identity_json, '$.key') IS 'text' AND length(json_extract(entrant_identity_json, '$.key')) = 64
      ELSE json_type(entrant_identity_json, '$.key') IS NULL END
  ));
-- The wheel revision guard makes competing awards retry; this constraint is the
-- final defence against two live slices claiming the same automatic identity.
CREATE UNIQUE INDEX wheel_entries_automatic_identity
  ON wheel_entries(wheel_id, json_extract(entrant_identity_json, '$.key'))
  WHERE json_extract(entrant_identity_json, '$.origin') = 'automation';
