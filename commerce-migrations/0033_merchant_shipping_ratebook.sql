-- Wix screenshot tariffs supplied by operator on 2026-09-06. Exact CAD cents and milligrams.
-- Legacy shipping_strategy columns retain provider-service semantics for old code.
-- Customer pricing authority is separately versioned; historical rows are untouched.
CREATE TABLE commerce_shipping_ratebooks (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
 body_json TEXT NOT NULL CHECK(json_valid(body_json) AND length(body_json)<100000),
 provenance TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX commerce_shipping_one_draft ON commerce_shipping_ratebooks(status) WHERE status='draft';
CREATE UNIQUE INDEX commerce_shipping_one_published ON commerce_shipping_ratebooks(status) WHERE status='published';
CREATE TABLE commerce_shipping_policy (
 id TEXT PRIMARY KEY CHECK(id='primary'), active_ratebook_id TEXT REFERENCES commerce_shipping_ratebooks(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE commerce_shipping_weights (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES commerce_products(id) ON DELETE RESTRICT,
 variant_id TEXT REFERENCES commerce_product_variants(id) ON DELETE RESTRICT,
 weight_mg INTEGER CHECK(weight_mg IS NULL OR (typeof(weight_mg)='integer' AND weight_mg BETWEEN 1 AND 2147483647)),
 provenance TEXT NOT NULL CHECK(length(provenance) BETWEEN 1 AND 500),
 revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX commerce_shipping_product_default ON commerce_shipping_weights(product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX commerce_shipping_variant_override ON commerce_shipping_weights(variant_id) WHERE variant_id IS NOT NULL;
CREATE TRIGGER commerce_shipping_weight_identity_insert BEFORE INSERT ON commerce_shipping_weights
WHEN NEW.variant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commerce_product_variants WHERE id=NEW.variant_id AND product_id=NEW.product_id)
BEGIN
 SELECT RAISE(ABORT,'shipping_variant_product_mismatch');
END;
CREATE TRIGGER commerce_shipping_weight_identity_update BEFORE UPDATE ON commerce_shipping_weights
WHEN NEW.variant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commerce_product_variants WHERE id=NEW.variant_id AND product_id=NEW.product_id)
BEGIN
 SELECT RAISE(ABORT,'shipping_variant_product_mismatch');
END;
CREATE TRIGGER commerce_shipping_published_immutable BEFORE UPDATE OF body_json,revision ON commerce_shipping_ratebooks
WHEN OLD.status IN ('published','archived')
BEGIN
 SELECT RAISE(ABORT,'published_shipping_ratebook_immutable');
END;
CREATE TABLE commerce_order_shipping_policies (
 order_id TEXT PRIMARY KEY REFERENCES commerce_orders(id) ON DELETE RESTRICT,
 ratebook_id TEXT NOT NULL REFERENCES commerce_shipping_ratebooks(id) ON DELETE RESTRICT,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), provider_cost_amount INTEGER CHECK(provider_cost_amount>=0),
 created_at TEXT NOT NULL
);
CREATE TRIGGER commerce_order_shipping_policy_immutable BEFORE UPDATE ON commerce_order_shipping_policies
BEGIN
 SELECT RAISE(ABORT,'order_shipping_policy_immutable');
END;
INSERT OR IGNORE INTO commerce_shipping_ratebooks(id,revision,status,body_json,provenance,created_at,updated_at)
 VALUES('wix-five-zone-20260906',1,'draft','{"currency":"CAD","exclusions":[],"zones":[{"id":"au","name":"Australia","countries":["AU"],"worldwide":false,"methods":[{"id":"standard","name":"Standard Shipping (AU)","status":"enabled","providerServiceId":"STANDARD","estimatedDelivery":null,"freeShippingSubtotal":null,"bands":[{"lowerMg":0,"upperMg":1100000,"amount":2800},{"lowerMg":1100000,"upperMg":2200000,"amount":3300},{"lowerMg":2200000,"upperMg":4400000,"amount":3900},{"lowerMg":4400000,"upperMg":null,"amount":4401}]}]},{"id":"gb","name":"United Kingdom","countries":["GB"],"worldwide":false,"methods":[{"id":"standard","name":"Standard Shipping (UK)","status":"enabled","providerServiceId":"STANDARD","estimatedDelivery":null,"freeShippingSubtotal":null,"bands":[{"lowerMg":0,"upperMg":1100000,"amount":1700},{"lowerMg":1100000,"upperMg":2200000,"amount":2000},{"lowerMg":2200000,"upperMg":4400000,"amount":2400},{"lowerMg":4400000,"upperMg":null,"amount":2654}]}]},{"id":"us","name":"United States","countries":["US"],"worldwide":false,"methods":[{"id":"standard","name":"Standard Shipping (US)","status":"enabled","providerServiceId":"STANDARD","estimatedDelivery":null,"freeShippingSubtotal":null,"bands":[{"lowerMg":0,"upperMg":1100000,"amount":1500},{"lowerMg":1100000,"upperMg":2200000,"amount":1800},{"lowerMg":2200000,"upperMg":4400000,"amount":2100},{"lowerMg":4400000,"upperMg":null,"amount":2419}]}]},{"id":"ca","name":"Canada","countries":["CA"],"worldwide":false,"methods":[{"id":"standard","name":"Standard Shipping (CA)","status":"enabled","providerServiceId":"STANDARD","estimatedDelivery":null,"freeShippingSubtotal":null,"bands":[{"lowerMg":0,"upperMg":1100000,"amount":2300},{"lowerMg":1100000,"upperMg":2200000,"amount":3000},{"lowerMg":2200000,"upperMg":4400000,"amount":3500},{"lowerMg":4400000,"upperMg":6600000,"amount":4040}]}]},{"id":"worldwide","name":"Worldwide","countries":[],"worldwide":true,"methods":[{"id":"standard","name":"Standard Shipping (Worldwide)","status":"enabled","providerServiceId":"STANDARD","estimatedDelivery":null,"freeShippingSubtotal":null,"bands":[{"lowerMg":0,"upperMg":1100000,"amount":4000},{"lowerMg":1100000,"upperMg":2200000,"amount":5000},{"lowerMg":2200000,"upperMg":4400000,"amount":6000},{"lowerMg":4400000,"upperMg":null,"amount":6703}]}]}]}','Operator-supplied Wix screenshots transcribed in task attachment ca8d266c-95c7-4ca5-b641-d227892d1749; Canada final upper bound 6600 g; subdivision counts unverified','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z');
INSERT OR IGNORE INTO commerce_shipping_policy(id,revision) VALUES('primary',1);
