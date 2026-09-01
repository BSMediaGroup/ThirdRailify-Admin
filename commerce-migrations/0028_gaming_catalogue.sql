PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gaming_games (
  id TEXT PRIMARY KEY,
  display_title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  canonical_slug TEXT,
  platform_label TEXT NOT NULL DEFAULT 'PC via Steam',
  short_description TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  developer TEXT,
  publisher TEXT,
  steam_app_id TEXT,
  steam_store_url TEXT,
  steam_mapping_state TEXT NOT NULL DEFAULT 'unverified' CHECK (steam_mapping_state IN ('unverified', 'verified', 'manual_override')),
  metadata_provenance TEXT NOT NULL DEFAULT 'manual' CHECK (metadata_provenance IN ('manual', 'steam_verified', 'manual_override')),
  artwork_asset_id TEXT,
  remote_artwork_url TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (artwork_asset_id) REFERENCES gaming_media_assets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS gaming_media_assets (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  original_filename TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'retired')),
  uploaded_by_account_id TEXT,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  FOREIGN KEY (game_id) REFERENCES gaming_games(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS gaming_rotation (
  game_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL CHECK (position >= 1),
  added_to_rotation_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES gaming_games(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS gaming_games_slug_unique ON gaming_games(canonical_slug) WHERE canonical_slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS gaming_games_steam_app_unique ON gaming_games(steam_app_id) WHERE steam_app_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gaming_games_title_index ON gaming_games(normalized_title);
CREATE INDEX IF NOT EXISTS gaming_games_archive_index ON gaming_games(archived_at, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS gaming_rotation_position_unique ON gaming_rotation(position);
CREATE INDEX IF NOT EXISTS gaming_media_game_index ON gaming_media_assets(game_id, lifecycle, created_at DESC);

INSERT OR IGNORE INTO gaming_games (id, display_title, normalized_title, canonical_slug, platform_label, short_description, genre, steam_app_id, steam_store_url, steam_mapping_state, metadata_provenance, remote_artwork_url, created_at, updated_at) VALUES
  ('gaming-witcher', 'WITCHER', 'witcher', 'witcher', 'PC via Steam', 'Monster hunting, hard choices, and the side quest that quietly steals the whole session.', 'RPG / ADVENTURE', NULL, NULL, 'unverified', 'manual', NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
  ('gaming-luminary', 'LUMINARY', 'luminary', 'luminary', 'PC via Steam', 'Solo or co-op exploration, character progression, and a campaign built around pushing back the dark with light.', 'ACTION RPG / CO-OP', '1648360', 'https://store.steampowered.com/app/1648360/', 'verified', 'steam_verified', 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1648360/library_600x900.jpg', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
  ('gaming-super-mario-world', 'SUPER MARIO WORLD', 'super mario world', 'super-mario-world', 'PC via Steam', 'Classic platforming rhythm, secret routes, and one more level turning into an entire night.', 'PLATFORMER', NULL, NULL, 'unverified', 'manual', NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
  ('gaming-party-animal', 'PARTY ANIMAL', 'party animal', 'party-animal', 'PC via Steam', 'Physics-driven party chaos where the plan survives roughly one collision.', 'PARTY / PHYSICS', NULL, NULL, 'unverified', 'manual', NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');

INSERT OR IGNORE INTO gaming_rotation (game_id, position, added_to_rotation_at) VALUES
  ('gaming-witcher', 1, '2026-09-01T00:00:00.000Z'),
  ('gaming-luminary', 2, '2026-09-01T00:00:00.000Z'),
  ('gaming-super-mario-world', 3, '2026-09-01T00:00:00.000Z'),
  ('gaming-party-animal', 4, '2026-09-01T00:00:00.000Z');
