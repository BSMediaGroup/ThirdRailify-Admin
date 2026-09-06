// D1 batch rolls back on a SQL error. A failed predicate must throw inside the
// batch, rather than inspecting a zero-row UPDATE after the batch committed.
export function transactionGuard(db, predicate, bindings = []) {
  return db.prepare(`SELECT CASE WHEN (${predicate}) THEN 1 ELSE json_extract('commerce_transaction_conflict', '$') END AS guard`).bind(...bindings);
}

export const LAUNCH_AUTHORITY_SQL = `SELECT json_object(
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
