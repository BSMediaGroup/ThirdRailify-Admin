-- Optional visual components. Existing segment colours/styles, weights and results are untouched.
ALTER TABLE wheel_entries ADD COLUMN entrant_appearance_json TEXT
  CHECK (entrant_appearance_json IS NULL OR
    (json_valid(entrant_appearance_json) AND length(entrant_appearance_json) <= 8192));
