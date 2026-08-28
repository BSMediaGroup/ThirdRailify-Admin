PRAGMA foreign_keys = ON;

-- Normalized collection authority. Product safe_metadata_json remains a
-- backwards-compatible read projection only; memberships below are canonical.
CREATE TABLE commerce_collections (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 160),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 180 AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  display_order INTEGER NOT NULL DEFAULT 1000 CHECK (display_order BETWEEN 0 AND 999999),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT
);

CREATE INDEX idx_commerce_collections_public
  ON commerce_collections(status, visibility, display_order, slug);

CREATE TABLE commerce_product_collections (
  product_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  assigned_by_account_id TEXT,
  PRIMARY KEY (product_id, collection_id),
  FOREIGN KEY (product_id) REFERENCES commerce_products(id) ON DELETE RESTRICT,
  FOREIGN KEY (collection_id) REFERENCES commerce_collections(id) ON DELETE RESTRICT
);

CREATE INDEX idx_commerce_product_collections_collection
  ON commerce_product_collections(collection_id, product_id);

-- Preserve every current category with the same slugs already used by Public.
INSERT INTO commerce_collections (
  id, slug, title, description, visibility, status, display_order,
  revision, created_at, updated_at
) VALUES
  ('collection-accessories-and-other', 'accessories-and-other', 'Accessories & Other', '', 'public', 'active', 10, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
  ('collection-apparel', 'apparel', 'Apparel', '', 'public', 'active', 20, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
  ('collection-just-gina-lore', 'just-gina-lore', 'Just Gina Lore', '', 'public', 'active', 30, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
  ('collection-just-gina-branded', 'just-gina-branded', 'Just Gina™ Branded', '', 'public', 'active', 40, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
  ('collection-kids-apparel', 'kids-apparel', 'Kids Apparel', '', 'public', 'active', 50, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
  ('collection-third-rail-lore', 'third-rail-lore', 'Third Rail Lore', '', 'public', 'active', 60, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
  ('collection-third-railify-branded', 'third-railify-branded', 'Third Railify™ Branded', '', 'public', 'active', 70, 1, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');

INSERT OR IGNORE INTO commerce_product_collections (
  product_id, collection_id, assigned_at, assigned_by_account_id
)
SELECT p.id, c.id, '2026-08-29T00:00:00.000Z', NULL
FROM commerce_products p
JOIN json_each(COALESCE(json_extract(p.safe_metadata_json, '$.categories'), '[]')) category
JOIN commerce_collections c ON c.title = CAST(category.value AS TEXT) COLLATE NOCASE;
