SELECT name,applied_at FROM d1_migrations WHERE name='0033_merchant_shipping_ratebook.sql';
SELECT id,revision,status,body_json,provenance FROM commerce_shipping_ratebooks ORDER BY id;
SELECT * FROM commerce_shipping_policy;
PRAGMA foreign_key_check;
SELECT name,type FROM sqlite_master WHERE name LIKE 'commerce_shipping_%' OR name LIKE 'commerce_order_shipping_%' ORDER BY name;
SELECT p.id productId,p.title productName,p.checkout_environment environment,v.id variantId,v.sku,v.size_label,v.color_label,COALESCE(vw.weight_mg,pw.weight_mg) weightMg FROM commerce_products p JOIN commerce_product_variants v ON v.product_id=p.id LEFT JOIN commerce_shipping_weights pw ON pw.product_id=p.id AND pw.variant_id IS NULL LEFT JOIN commerce_shipping_weights vw ON vw.variant_id=v.id WHERE p.status='active' AND p.visibility='public' AND p.requires_shipping=1 AND p.provider_presence='current' AND v.provider_presence='current' AND v.status='active' AND v.visibility='public' AND v.is_sellable=1 AND v.availability_status='active' AND v.fulfillment_provider='printful' AND v.fulfillment_mapping_status='mapped' ORDER BY p.title,v.id;
