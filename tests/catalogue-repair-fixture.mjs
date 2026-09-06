import { createCommerceDatabases, commerceEnvironment, insertTestProduct, insertTestVariant } from './commerce-test-helpers.mjs';
import { updateBusinessProfile } from '../functions/_shared/commerce-core.js';
import { worldwideShippingMarkets } from '../functions/_shared/shipping-core.js';
import { PAYPAL_WEBHOOK_EVENTS } from '../functions/_shared/paypal-client.js';
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from '../functions/_shared/auth-core.js';
import { cookiePair, jsonRequest } from './auth-test-helpers.mjs';
import { onRequest } from '../functions/api/admin/commerce/[[path]].js';

export const ORIGIN = 'https://admin.thirdrailify.com';
export async function catalogueFixture(t) {
  const h = await createCommerceDatabases(); t.after(h.dispose); const db = h.commerceDb;
  const env = commerceEnvironment(h, { PRINTFUL_STORE_ID: '18668025', THIRDRAILIFY_ADMIN_ORIGIN: ORIGIN, THIRDRAILIFY_PUBLIC_ORIGIN: 'https://thirdrailify.com', PAYPAL_LIVE_CLIENT_ID: 'fixture-client', PAYPAL_LIVE_CLIENT_SECRET: 'fixture-secret', PAYPAL_LIVE_WEBHOOK_ID: 'WH-FIXTURE', PRINTFUL_API_TOKEN: 'fixture-never-called', RESEND_API_KEY: 'fixture-never-called', MAIL_FROM: 'alerts@example.test' });
  await ensureEnvironmentMasters(env); const account = await loadAccountByEmail(env, env.ADMIN_EMAIL_1);
  const made = await createSession(env, new Request(ORIGIN, { headers: { Origin: ORIGIN } }), account, ORIGIN);
  const cookie = cookiePair(made.cookie), session = { accountId: account.id, account: { adminLevel: 'master' } };
  await updateBusinessProfile(env, session, { revision: 1, tradingName: 'Catalogue Fixture', legalBusinessName: 'Synthetic Owner', supportEmail: 'support@example.test', privatePhone: 'Synthetic phone', privateAddress: { line1: 'Synthetic address' } });
  for (let i = 0; i < 26; i++) {
    await insertTestProduct(db, { id: `repair-product-${i}`, slug: `repair-product-${i}`, title: `Repair product ${String(i).padStart(2, '0')}`, targetPrintfulProductId: String(9000 + i), isFeatured: i === 1 ? 1 : 0, featuredOrder: i === 1 ? 10 : null });
    await insertTestVariant(db, { id: `repair-variant-${i}`, productId: `repair-product-${i}`, localVariantKey: `key-${i}`, isSellable: [1,3,4,7,25].includes(i) ? 1 : 0, targetPrintfulProductId: String(9000 + i), targetPrintfulSyncVariantId: String(7000 + i), targetCatalogueVariantId: String(1000 + i) });
  }
  await db.batch([
    db.prepare("UPDATE commerce_products SET provider_presence='current',provider_store_id='18668025',provider_reconciliation_status='current',safe_metadata_json=json_set(safe_metadata_json,'$.publicImage','https://example.test/fixture.png'),checkout_environment='live'"),
    db.prepare("UPDATE commerce_product_variants SET provider_presence='current',provider_store_id='18668025'"),
    db.prepare("UPDATE commerce_products SET visibility='private' WHERE id='repair-product-2'"),
    db.prepare("UPDATE commerce_product_variants SET target_catalogue_variant_id=NULL WHERE id='repair-variant-3'"),
    db.prepare("UPDATE commerce_product_variants SET provider_store_id='wrong' WHERE id='repair-variant-4'"),
    db.prepare("UPDATE commerce_product_variants SET unit_amount=25.5 WHERE id='repair-variant-5'"),
    db.prepare("UPDATE commerce_product_variants SET provider_store_id=NULL WHERE id='repair-variant-7'"),
    db.prepare("UPDATE commerce_product_variants SET target_printful_sync_variant_id='88garbage' WHERE id='repair-variant-8'"),
    db.prepare("UPDATE commerce_products SET provider_presence='provider_missing',archived_at='fixture' WHERE id='repair-product-25'"),
    db.prepare("UPDATE commerce_product_variants SET provider_presence='provider_missing',archived_at='fixture' WHERE id='repair-variant-25'"),
    db.prepare("UPDATE commerce_provider_connections SET status='connected',integration_mode='fulfillment',external_account_id='18668025',safe_metadata_json=? WHERE provider='printful'").bind(JSON.stringify({ api_configured: true })),
    db.prepare("UPDATE commerce_provider_connections SET status='connected',environment='live',integration_mode='direct_merchant',country_code='CA',currency_code='CAD',safe_metadata_json=? WHERE provider='paypal'").bind(JSON.stringify({ live: { oauth_verified: true, webhook_configured: true, webhook_readback_verified: true, webhook_events: PAYPAL_WEBHOOK_EVENTS } })),
    db.prepare("UPDATE commerce_templates SET status='ready',enabled=CASE WHEN template_key IN ('order_confirmation','payment_receipt') THEN 1 ELSE 0 END"),
    db.prepare("INSERT INTO commerce_catalogue_migrations(id,status,phase,safe_state_json,updated_at) VALUES ('permanent-printful-2026-08','completed','completed','{}','fixture') ON CONFLICT(id) DO UPDATE SET status='completed',phase='completed',step_lease_token=NULL,safe_state_json='{}'"),
    ...Object.entries({ commerce_environment: 'production', preferred_payment_provider: 'paypal', stripe_enabled: false, stripe_tax_enabled: false, paypal_live_configured: true, paypal_live_webhook_configured: true, commerce_operations_worker_configured: true, resend_domain_verified: true, shipping_strategy: 'printful_dynamic', tax_calculation_provider: 'not_collecting', commerce_emergency_paused: false }).map(([k,v]) => db.prepare("INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at) VALUES (?,?,'safe','fixture') ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json").bind(k, JSON.stringify(v))),
    ...worldwideShippingMarkets().map(m => db.prepare("INSERT OR IGNORE INTO commerce_shipping_markets(country_code,display_name,status,strategy,created_at,updated_at) VALUES (?,?,'active','printful_dynamic','fixture','fixture')").bind(m.countryCode,m.displayName)),
  ]);
  const send = (path, body, overrides = {}) => onRequest({ env, request: jsonRequest(`${ORIGIN}/api/admin/commerce/${path}`, { method: body === undefined ? 'GET' : 'POST', origin: ORIGIN, cookie, csrfToken: made.csrfToken, body, ...overrides }), data: { commerceFetch: () => { throw new Error('External commerce call forbidden'); } } });
  return { h, db, env, made, cookie, session, account, send };
}
