-- One-time, fail-closed closure for the first genuine Stripe TEST acceptance.
-- This artifact intentionally changes only the temporary checkout gate, its selectors,
-- the temporary variant sellability/markers, and bounded commerce audit evidence.

UPDATE commerce_settings
SET value_json = 'false', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by_account_id = NULL
WHERE setting_key = 'stripe_test_checkout_enabled' AND value_json = 'true'
  AND EXISTS (
    SELECT 1 FROM commerce_orders
    WHERE id = 'ord_e47b94a4-4252-438b-8ca7-c47470029940'
      AND environment = 'test' AND currency_code = 'CAD' AND customer_gross_amount = 1500
      AND payment_status = 'paid' AND payment_confirmed_at IS NOT NULL
      AND fulfillment_status = 'disabled' AND printful_order_id IS NULL
      AND stripe_checkout_session_id = 'cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC'
  )
  AND EXISTS (
    SELECT 1 FROM commerce_webhook_events
    WHERE provider = 'stripe' AND provider_event_id = 'evt_1U9OysB2jGrq9Tn1apdsFgi2'
      AND event_type = 'checkout.session.completed' AND livemode = 0
      AND related_object_type = 'checkout.session'
      AND related_object_id = 'cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC'
      AND processing_status = 'processed' AND result_code = 'payment_confirmed'
      AND payload_sha256 IS NOT NULL AND length(payload_sha256) = 64
  );

DELETE FROM commerce_settings
WHERE setting_key IN ('stripe_test_checkout_product_id', 'stripe_test_checkout_variant_id')
  AND EXISTS (SELECT 1 FROM commerce_settings WHERE setting_key = 'stripe_test_checkout_enabled' AND value_json = 'false')
  AND EXISTS (
    SELECT 1 FROM commerce_orders
    WHERE id = 'ord_e47b94a4-4252-438b-8ca7-c47470029940'
      AND payment_status = 'paid'
      AND stripe_checkout_session_id = 'cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC'
  );

UPDATE commerce_product_variants
SET is_sellable = 0,
    safe_metadata_json = json_remove(safe_metadata_json, '$.testSellable', '$.acceptanceCandidate', '$.acceptancePurpose'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'variant-5019554081' AND product_id = 'product-397267935'
  AND unit_amount = 1500 AND currency_code = 'CAD'
  AND EXISTS (
    SELECT 1 FROM commerce_orders
    WHERE id = 'ord_e47b94a4-4252-438b-8ca7-c47470029940'
      AND payment_status = 'paid' AND fulfillment_status = 'disabled'
      AND stripe_checkout_session_id = 'cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC'
  )
  AND 1 = (
    SELECT COUNT(*) FROM commerce_order_items
    WHERE order_id = 'ord_e47b94a4-4252-438b-8ca7-c47470029940'
  )
  AND EXISTS (
    SELECT 1 FROM commerce_order_items
    WHERE order_id = 'ord_e47b94a4-4252-438b-8ca7-c47470029940'
      AND product_id = 'product-397267935' AND variant_id = 'variant-5019554081'
      AND quantity = 1 AND unit_amount = 1500 AND line_total_amount = 1500 AND currency_code = 'CAD'
  );

INSERT OR IGNORE INTO commerce_audit (id, actor_account_id, action, target_type, target_id, result, metadata_json, created_at)
SELECT 'stripe-test-acceptance-2026-08-completed', NULL, 'stripe.acceptance_completed', 'commerce_order',
       'ord_e47b94a4-4252-438b-8ca7-c47470029940', 'success',
       '{"environment":"test","sessionId":"cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC","eventId":"evt_1U9OysB2jGrq9Tn1apdsFgi2","amount":1500,"currency":"CAD","fulfillment":"disabled"}',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1 FROM commerce_webhook_events
  WHERE provider_event_id = 'evt_1U9OysB2jGrq9Tn1apdsFgi2' AND processing_status = 'processed' AND result_code = 'payment_confirmed'
);

INSERT OR IGNORE INTO commerce_audit (id, actor_account_id, action, target_type, target_id, result, metadata_json, created_at)
SELECT 'stripe-test-acceptance-2026-08-gate-closed', NULL, 'stripe.test_gate_closed', 'commerce_setting',
       'stripe_test_checkout_enabled', 'success',
       '{"enabled":false,"normalCheckout":false,"livePayments":false,"fulfillment":false,"selectorsRemoved":true}',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM commerce_settings WHERE setting_key = 'stripe_test_checkout_enabled' AND value_json = 'false')
  AND NOT EXISTS (SELECT 1 FROM commerce_settings WHERE setting_key IN ('stripe_test_checkout_product_id', 'stripe_test_checkout_variant_id'));

INSERT OR IGNORE INTO commerce_audit (id, actor_account_id, action, target_type, target_id, result, metadata_json, created_at)
SELECT 'stripe-test-acceptance-2026-08-variant-restored', NULL, 'commerce.acceptance_variant_restored', 'commerce_product_variant',
       'variant-5019554081', 'success',
       '{"productId":"product-397267935","sellable":false,"acceptanceMarkersRemoved":true,"priceAndMappingsPreserved":true}',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1 FROM commerce_product_variants
  WHERE id = 'variant-5019554081' AND product_id = 'product-397267935' AND is_sellable = 0
    AND unit_amount = 1500 AND currency_code = 'CAD'
    AND json_type(safe_metadata_json, '$.testSellable') IS NULL
    AND json_type(safe_metadata_json, '$.acceptanceCandidate') IS NULL
    AND json_type(safe_metadata_json, '$.acceptancePurpose') IS NULL
);
