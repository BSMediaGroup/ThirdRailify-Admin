-- Optional entrant image. Legacy entries retain the styled fallback.
ALTER TABLE wheel_entries ADD COLUMN avatar_url TEXT CHECK (avatar_url IS NULL OR (length(avatar_url) <= 2048 AND avatar_url LIKE 'https://%'));
