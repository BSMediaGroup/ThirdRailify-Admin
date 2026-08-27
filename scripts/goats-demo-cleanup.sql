-- LOCAL/TEST ONLY. Removes only records carrying the fixed DEMO identities.
PRAGMA foreign_keys = ON;

DELETE FROM community_submissions WHERE reference_code LIKE 'DEMO-%';
DELETE FROM commerce_products WHERE id IN ('demo-goats-product-hoodie', 'demo-goats-product-cap');
