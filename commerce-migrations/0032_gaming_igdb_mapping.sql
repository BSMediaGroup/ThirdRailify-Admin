-- Optional curated IGDB references. No rotation or seed changes.
ALTER TABLE gaming_games ADD COLUMN igdb_id TEXT;
ALTER TABLE gaming_games ADD COLUMN igdb_url TEXT;
