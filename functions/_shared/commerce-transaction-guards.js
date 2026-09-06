// D1 batch rolls back on a SQL error. A failed predicate must throw inside the
// batch, rather than inspecting a zero-row UPDATE after the batch committed.
export function transactionGuard(db, predicate, bindings = []) {
  return db.prepare(`SELECT CASE WHEN (${predicate}) THEN 1 ELSE json_extract('commerce_transaction_conflict', '$') END AS guard`).bind(...bindings);
}

// Include actual classification/filter evidence, even when an editor retains updated_at.
export const CATALOGUE_AUTHORITY_SQL = `SELECT json_object(
  'provider',(SELECT json_array(status,external_account_id,safe_metadata_json,updated_at) FROM commerce_provider_connections WHERE provider='printful'),
  'collections',(SELECT json_group_array(json_array(id,title,status,visibility,display_order,slug,updated_at)) FROM (SELECT * FROM commerce_collections ORDER BY id)),
  'memberships',(SELECT json_group_array(json_array(product_id,collection_id)) FROM (SELECT * FROM commerce_product_collections ORDER BY product_id,collection_id)),
  'products',(SELECT json_group_array(json_array(id,title,slug,status,visibility,requires_shipping,currency_code,provider_presence,provider_store_id,provider_reconciliation_status,archived_at,target_printful_product_id,safe_metadata_json,is_featured,featured_order,migration_status,updated_at)) FROM (SELECT * FROM commerce_products ORDER BY id)),
  'variants',(SELECT json_group_array(json_object('id',id,'product_id',product_id,'status',status,'visibility',visibility,'is_sellable',is_sellable,'is_ignored',is_ignored,'availability_status',availability_status,'unit_amount',unit_amount,'currency_code',currency_code,'fulfillment_provider',fulfillment_provider,'fulfillment_mapping_status',fulfillment_mapping_status,'provider_presence',provider_presence,'provider_store_id',provider_store_id,'archived_at',archived_at,'target_printful_product_id',target_printful_product_id,'target_printful_sync_variant_id',target_printful_sync_variant_id,'target_catalogue_variant_id',target_catalogue_variant_id,'safe_metadata_json',safe_metadata_json,'updated_at',updated_at)) FROM (SELECT * FROM commerce_product_variants ORDER BY id))
) AS fingerprint`;

export const LAUNCH_AUTHORITY_SQL = `SELECT json_object(
  'catalogue',(${CATALOGUE_AUTHORITY_SQL}),
  'settings',(SELECT json_group_array(json_array(setting_key,value_json,CASE WHEN setting_key='commerce_operations_worker_configured' THEN NULL ELSE updated_at END)) FROM (SELECT * FROM commerce_settings ORDER BY setting_key)),
  'providers',(SELECT json_group_array(json_array(provider,status,environment,integration_mode,external_account_id,country_code,currency_code,safe_metadata_json,updated_at)) FROM (SELECT * FROM commerce_provider_connections WHERE provider IN ('paypal','printful','stripe') ORDER BY provider)),
  'profile',(SELECT json_array(revision,updated_at) FROM commerce_business_profiles WHERE id='primary'),
  'launch',(SELECT json_array(revision,state) FROM commerce_launch_state WHERE id='production'),
  'payment',(SELECT json_array(revision,preferred_provider,stripe_enabled,emergency_paused) FROM commerce_payment_provider_state WHERE id='primary'),
  'templates',(SELECT json_group_array(json_array(template_key,revision,status,enabled,updated_at)) FROM (SELECT * FROM commerce_templates ORDER BY template_key)),
  'markets',(SELECT json_group_array(json_array(country_code,status,strategy,revision)) FROM (SELECT * FROM commerce_shipping_markets ORDER BY country_code)),
  'shippingPolicy',(SELECT json_array(active_ratebook_id,revision) FROM commerce_shipping_policy WHERE id='primary'),
  'shippingWeights',(SELECT json_group_array(json_array(id,revision,weight_mg)) FROM (SELECT * FROM commerce_shipping_weights ORDER BY id)),
  'products',(SELECT json_group_array(json_array(id,updated_at)) FROM (SELECT id,updated_at FROM commerce_products ORDER BY id)),
  'variants',(SELECT json_group_array(json_array(id,updated_at,is_sellable)) FROM (SELECT id,updated_at,is_sellable FROM commerce_product_variants ORDER BY id)),
  'migration',(SELECT json_array(status,phase,step_lease_token,safe_state_json) FROM commerce_catalogue_migrations WHERE id='permanent-printful-2026-08')
) AS fingerprint`;
