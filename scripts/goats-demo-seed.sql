-- LOCAL/TEST ONLY. Never add this file to a remote migration command.
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO commerce_products (
  id, source_provider, slug, title, currency_code, status, safe_metadata_json,
  created_at, updated_at, is_featured, featured_order, unit_amount,
  checkout_environment, visibility, max_checkout_quantity, requires_shipping
) VALUES
  ('demo-goats-product-hoodie', 'manual', 'demo-goated-hoodie', 'Demo GOATED Hoodie', 'CAD', 'active', '{}', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', 0, NULL, 6500, 'test', 'public', 5, 1),
  ('demo-goats-product-cap', 'manual', 'demo-rail-cap', 'Demo Third Rail Cap', 'CAD', 'active', '{}', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', 0, NULL, 3200, 'test', 'public', 5, 1);

INSERT OR IGNORE INTO community_submissions (
  id, reference_code, public_slug, status, is_published, display_name, description,
  product_id, product_slug_snapshot, product_name_snapshot, rating, city, region,
  country_code, public_location_label, public_latitude, public_longitude,
  location_confirmed_at, consent_version, consented_at, created_at, submitted_at,
  updated_at, approved_at, moderator_account_id, moderator_note, version
) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'DEMO-GOAT-01', 'demo-midnight-rail', 'approved', 1, 'Midnight Rail', 'A temporary invented listing used to prove the V2 map, gallery, detail, reaction, and comment paths before the owner-supplied Wix export arrives.', 'demo-goats-product-hoodie', 'demo-goated-hoodie', 'Demo GOATED Hoodie', 5, 'Toronto', 'Ontario', 'CA', 'Toronto, Ontario, CA', 43.653, -79.383, '2026-08-27T00:00:00.000Z', 'goats-v2-2026-08', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', '2026-08-27T00:05:00.000Z', '2026-08-27T00:10:00.000Z', '2026-08-27T00:10:00.000Z', 'local-demo-seed', 'Temporary local proof record. Safe to delete.', 1),
  ('d0000000-0000-4000-8000-000000000002', 'DEMO-GOAT-02', 'demo-southern-signal', 'approved', 1, 'Southern Signal', 'A second temporary invented listing for clustering, deterministic next and previous navigation, filters, and responsive community cards.', 'demo-goats-product-cap', 'demo-rail-cap', 'Demo Third Rail Cap', 4, 'Sydney', 'New South Wales', 'AU', 'Sydney, New South Wales, AU', -33.869, 151.209, '2026-08-27T00:00:00.000Z', 'goats-v2-2026-08', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', '2026-08-27T00:06:00.000Z', '2026-08-27T00:11:00.000Z', '2026-08-27T00:11:00.000Z', 'local-demo-seed', 'Temporary local proof record. Safe to delete.', 1);

INSERT OR IGNORE INTO community_reactions (submission_id, account_id, value, created_at, updated_at) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'local-demo-account-one', 1, '2026-08-27T00:12:00.000Z', '2026-08-27T00:12:00.000Z'),
  ('d0000000-0000-4000-8000-000000000001', 'local-demo-account-two', -1, '2026-08-27T00:13:00.000Z', '2026-08-27T00:13:00.000Z'),
  ('d0000000-0000-4000-8000-000000000002', 'local-demo-account-one', 1, '2026-08-27T00:14:00.000Z', '2026-08-27T00:14:00.000Z');

INSERT OR IGNORE INTO community_comments (id, submission_id, account_id, author_display_name, body, status, created_at, updated_at) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'local-demo-account-one', 'Demo Commenter', 'Temporary plain-text comment for local moderation and rendering proof.', 'visible', '2026-08-27T00:15:00.000Z', '2026-08-27T00:15:00.000Z');
