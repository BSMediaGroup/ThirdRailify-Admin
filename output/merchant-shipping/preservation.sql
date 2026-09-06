SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('shipping_strategy','paypal_store_checkout_enabled','paypal_donations_enabled','preferred_payment_provider','commerce_emergency_paused','commerce_environment','stripe_enabled') ORDER BY setting_key;
SELECT id,environment,customer_gross_amount,product_subtotal_amount,shipping_amount,tax_amount,payment_status,printful_order_id FROM commerce_orders ORDER BY id;
SELECT COUNT(*) n FROM commerce_order_agreements;
SELECT COUNT(*) n FROM commerce_donations;
SELECT COUNT(*) n FROM commerce_email_deliveries;
SELECT id,revision,updated_at FROM commerce_business_profiles ORDER BY id;
