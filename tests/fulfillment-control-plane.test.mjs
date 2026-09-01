import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { fulfillmentShippingPayload, preparePrintfulDraftOrder } from "../functions/_shared/commerce-control-plane.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { applySqlBatches, commerceEnvironment, createCommerceDatabases, insertTestProduct, insertTestVariant } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const ACCEPTED_ORDER = "ord_e47b94a4-4252-438b-8ca7-c47470029940";
const ACCEPTED_SESSION = "cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC";
const ACCEPTED_EVENT = "evt_1U9OysB2jGrq9Tn1apdsFgi2";
const master = { accountId: "fulfillment-master", account: { adminLevel: "master" } };

test("Fulfillment & Shipping projects canonical local authority without secrets, provider calls, or mutations", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: "printful-server-secret", PRINTFUL_STORE_ID: "18668025" });
  await seedFulfillmentAuthority(harness.commerceDb);
  const before = await authoritySnapshot(harness.commerceDb);

  const payload = await fulfillmentShippingPayload(env, master);
  const after = await authoritySnapshot(harness.commerceDb);
  assert.deepEqual(after, before);
  assert.equal(payload.databaseConfigured, true); assert.equal(payload.access.capabilities.includes("commerce.view"), true);
  assert.equal(payload.provider.name, "Printful"); assert.equal(payload.provider.configured, true); assert.equal(payload.provider.orderMode, "draft_only"); assert.equal(payload.provider.orderModeConsistent, true);
  assert.equal(payload.safety.checkoutEnabled, false); assert.equal(payload.safety.controlledTestCheckoutEnabled, false); assert.equal(payload.safety.livePaymentCaptureEnabled, false); assert.equal(payload.safety.fulfillmentEnabled, false); assert.equal(payload.safety.providerSubmissionAvailable, false);
  assert.equal(payload.readiness.paymentAuthority.state, "production_disabled"); assert.equal(payload.readiness.production.state, "blocked"); assert.equal(payload.readiness.fulfillment.state, "disabled");
  assert.equal(payload.shipping.customerData.state, "implemented_no_evidence"); assert.deepEqual(payload.shipping.customerData.persistedFields, ["encrypted_recipient", "destination_country", "destination_region", "shipping_method", "shipping_amount", "currency", "source_quote"]);
  assert.equal(payload.shipping.rates.state, "implemented_disabled"); assert.equal(payload.shipping.rates.providerQuotePathImplemented, true); assert.equal(payload.shipping.rates.providerQuoteCalled, false);
  assert.equal(payload.tracking.state, "implemented_no_evidence"); assert.ok(payload.tracking.persistedFields.includes("encrypted_tracking_number")); assert.equal(payload.tracking.shipmentPollingImplemented, true); assert.equal(payload.tracking.providerPollingPerformed, false);
  assert.equal(payload.lifecycle.carrierDeliveryPolling.state, "implemented_scheduled"); assert.equal(payload.lifecycle.reconciliationFallback.automaticPolling, true); assert.equal(payload.lifecycle.reconciliationFallback.schedule, "every_5_minutes");
  assert.equal(payload.mapping.mappedProviderProducts, 1); assert.equal(payload.mapping.mappedProviderVariants, 1); assert.equal(payload.mapping.nonSellableVariants, 1); assert.equal(payload.mapping.potentiallyFulfillableVariants, 0);
  assert.equal(payload.migration.manuallyPaused, true); assert.equal(payload.migration.mutableFromThisRoute, false); assert.equal(payload.evidence.counts.providerOrders, 0); assert.deepEqual(payload.evidence.recent, []);
  assert.equal(payload.draftPreview.eligible, false); assert.equal(payload.draftPreview.item.mappedProviderVariant, "target-variant-authority");
  assert.deepEqual(new Set(payload.draftPreview.blockers.map((item) => item.code)), new Set(["variant_not_sellable", "shipping_strategy_missing", "shipping_method_missing", "fulfillment_disabled"]));
  assert.deepEqual(payload.draftPreview.labels, ["DRAFT PREVIEW", "NO PROVIDER REQUEST", "NOT SUBMITTED"]);
  assert.deepEqual(payload.draftPreview.submission, { available: false, mode: "draft_only", networkRequestMade: false, providerOrderCreated: false, localOrderMutated: false, migrationMutated: false });
  assert.equal(payload.technical.providerCallsOnRead, false); assert.equal(payload.technical.providerCallsOnPreview, false); assert.equal(payload.technical.previewPersists, false);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /printful-server-secret|authorization|bearer|credential_ciphertext|safe_metadata_json|private_address|recipient_email|100 Preview Street|N6A 1A1/i);
});

test("0015 applies additively after the existing sequence and preserves templates and commerce rows", async (t) => {
  const harness = await createCommerceDatabases({ commerceMigrationCount: 14 }); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { PRINTFUL_STORE_ID: "18668025" });
  await harness.commerceDb.prepare("INSERT INTO commerce_orders(id,payment_status,fulfillment_status,currency_code,customer_gross_amount,environment,checkout_status,created_at,updated_at) VALUES('ord-before-0015','pending','disabled','CAD',0,'test','checkout_pending','2026-08-29T00:00:00Z','2026-08-29T00:00:00Z')").run();
  const templatesBefore = Number((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_templates").first()).count);
  await applySqlBatches(harness.commerceDb, harness.commerceMigrations[14]);
  const tables = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('commerce_shipping_quotes','commerce_order_delivery_snapshots') ORDER BY name").all();
  assert.deepEqual(tables.results.map((row) => row.name), ["commerce_order_delivery_snapshots", "commerce_shipping_quotes"]);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_templates").first()).count), templatesBefore);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_orders WHERE id='ord-before-0015'").first()).count), 1);
  const payload = await fulfillmentShippingPayload(env, master);
  assert.equal(payload.shipping.schema.state, "ready"); assert.equal(payload.shipping.schema.quoteTable, true); assert.equal(payload.shipping.schema.deliverySnapshotTable, true);
});

test("pure Printful draft preparation succeeds structurally only with complete internal authority and fails closed deterministically", () => {
  const candidate = {
    productId: "product-authority", productTitle: "Authoritative product", productStatus: "active", productVisibility: "public", productTargetId: "target-product-authority", productMigrationStatus: "target_verified",
    variantId: "variant-authority", variantLabel: "M / Black", variantStatus: "active", variantVisibility: "public", sellable: true, availability: "active", requiresShipping: true,
    provider: "printful", mappingStatus: "mapped", targetProductId: "target-product-authority", targetVariantId: "target-variant-authority", variantMigrationStatus: "target_verified",
  };
  const recipient = { source: "synthetic_fixture", name: "Preview customer", address1: "Synthetic address", city: "London", postalCode: "N6A 1A1", countryCode: "CA" };
  const base = { reference: "DRAFT-TEST", environment: "test", paymentStatus: "synthetic_fixture", quantity: 1, candidate, recipient, shippingStrategy: "printful_dynamic", shippingMethod: "Standard delivery", providerShippingMethodId: "STANDARD", fulfillmentEnabled: true, orderMode: "draft_only", providerMode: "draft_only", requireSellable: true, previewOnly: true };
  const valid = preparePrintfulDraftOrder(base);
  assert.equal(valid.eligible, true); assert.deepEqual(valid.blockers, []); assert.equal(valid.safePayloadPreview.items[0].providerVariantId, "target-variant-authority"); assert.equal(valid.submission.available, false);

  const cases = [
    ["quantity_invalid", { quantity: 0 }], ["recipient_incomplete", { recipient: { source: "synthetic_fixture", countryCode: "CA" } }],
    ["provider_mapping_missing", { candidate: { ...candidate, targetVariantId: null } }], ["provider_unsupported", { candidate: { ...candidate, provider: "manual" } }],
    ["provider_mapping_ambiguous", { candidate: { ...candidate, targetProductId: "different-target" } }],
    ["printful_mode_contradictory", { providerMode: "disabled" }], ["live_order_mode_rejected", { orderMode: "live", providerMode: "live" }],
    ["live_preview_rejected", { environment: "live" }], ["payment_not_confirmed", { paymentStatus: "pending" }],
    ["product_variant_missing", { candidate: null }], ["shipping_strategy_missing", { shippingStrategy: "unconfigured" }], ["shipping_method_missing", { providerShippingMethodId: "" }], ["fulfillment_disabled", { fulfillmentEnabled: false }],
  ];
  for (const [expectedCode, override] of cases) {
    const result = preparePrintfulDraftOrder({ ...base, ...override });
    assert.equal(result.eligible, false, expectedCode); assert.ok(result.blockers.some((item) => item.code === expectedCode), expectedCode);
    assert.equal(result.submission.networkRequestMade, false); assert.equal(result.submission.providerOrderCreated, false);
  }
});

test("Fulfillment reports migration_required when 0015 tables are absent without impersonating an account outage", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: "unused-server-secret", PRINTFUL_STORE_ID: "18668025" });
  await harness.commerceDb.prepare("DROP TABLE commerce_order_delivery_snapshots").run();
  await harness.commerceDb.prepare("DROP TABLE commerce_shipping_quotes").run();
  await seedFulfillmentAuthority(harness.commerceDb);

  const payload = await fulfillmentShippingPayload(env, master);
  assert.equal(payload.ok, true); assert.equal(payload.shipping.schema.state, "migration_required");
  assert.equal(payload.shipping.schema.migration, "0015_checkout_shipping_foundation.sql");
  assert.equal(payload.shipping.schema.quoteTable, false); assert.equal(payload.shipping.schema.deliverySnapshotTable, false);
  assert.equal(payload.shipping.customerData.state, "migration_required"); assert.equal(payload.shipping.rates.state, "migration_required");
  assert.equal(payload.readiness.customerShippingData.state, "migration_required");
  assert.equal(payload.provider.orderMode, "draft_only"); assert.equal(payload.safety.fulfillmentEnabled, false);
  assert.deepEqual(payload.evidence.counts.testShippingSnapshots, 0); assert.deepEqual(payload.evidence.counts.liveShippingSnapshots, 0);

  const session = await authenticatedMaster(env);
  const response = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/fulfillment`, { method: "GET", origin: ADMIN_ORIGIN, cookie: session.cookie }), env, data: {} });
  assert.equal(response.status, 200); assert.equal((await response.json()).shipping.schema.state, "migration_required");
});

test("authenticated fulfillment route requires commerce.view, ignores browser provider IDs, and remains read-only", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: "unused-server-secret", PRINTFUL_STORE_ID: "18668025" });
  await seedFulfillmentAuthority(harness.commerceDb);
  const url = `${ADMIN_ORIGIN}/api/admin/commerce/fulfillment?providerVariantId=browser-forged-id`;
  const anonymous = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: ADMIN_ORIGIN }), env, data: {} });
  assert.equal(anonymous.status, 401);
  const session = await authenticatedMaster(env); let providerCalls = 0; const before = await authoritySnapshot(harness.commerceDb);
  const response = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: ADMIN_ORIGIN, cookie: session.cookie }), env, data: { commerceFetch: async () => { providerCalls += 1; throw new Error("provider call forbidden"); } } });
  assert.equal(response.status, 200); const payload = await response.json();
  assert.equal(payload.draftPreview.item.mappedProviderVariant, "target-variant-authority"); assert.doesNotMatch(JSON.stringify(payload), /browser-forged-id|unused-server-secret/);
  assert.equal(providerCalls, 0); assert.deepEqual(await authoritySnapshot(harness.commerceDb), before);
  const wrongOrigin = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: "https://evil.example", cookie: session.cookie }), env, data: {} }); assert.equal(wrongOrigin.status, 403);
});

async function seedFulfillmentAuthority(db) {
  await insertTestProduct(db, { id: "product-authority", slug: "product-authority", title: "Authoritative product", targetPrintfulProductId: "target-product-authority", migrationStatus: "target_verified" });
  await insertTestVariant(db, { id: "variant-authority", productId: "product-authority", targetPrintfulProductId: "target-product-authority", targetPrintfulSyncVariantId: "target-variant-authority", migrationStatus: "target_verified", isSellable: 0 });
  const printful = await db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider='printful'").first();
  await db.batch([
    db.prepare("UPDATE commerce_provider_connections SET status='connected',environment='staging',integration_mode='fulfillment',external_account_id='18668025',safe_metadata_json=?,last_synchronized_at='2026-08-28T00:00:00Z' WHERE provider='printful'").bind(JSON.stringify({ ...JSON.parse(printful.safe_metadata_json), api_configured: true, credential_configured: true, mode: "draft_only", order_mode: "draft_only", store_type: "native", oauth_scopes: ["orders", "sync_products"], product_write_authority: true, file_manage_authority: true, order_manage_authority: true, webhook_manage_authority: true, fulfillment_enabled: false, last_verified_at: "2026-08-28T00:00:00Z" })),
    db.prepare("INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at) VALUES('printful_api_configured','true','safe','now') ON CONFLICT(setting_key) DO UPDATE SET value_json='true'"),
    db.prepare("INSERT INTO commerce_catalogue_migrations(id,status,phase,products_verified,variants_mapped,provider_request_count,provider_failures,safe_state_json,updated_at) VALUES('permanent-printful-2026-08','waiting','source_files',12,238,419,36,?,'2026-08-28T00:00:00Z')").bind(JSON.stringify({ manualPause: true, blockedProducts: [{ id: "blocked-1" }, { id: "blocked-2" }] })),
    db.prepare("INSERT INTO commerce_orders(id,payment_status,fulfillment_status,currency_code,customer_gross_amount,stripe_checkout_session_id,environment,checkout_status,created_at,updated_at) VALUES(?,'paid','disabled','CAD',1500,?,'test','checkout_created','2026-08-28T00:00:00Z','2026-08-28T00:01:00Z')").bind(ACCEPTED_ORDER, ACCEPTED_SESSION),
    db.prepare("INSERT INTO commerce_webhook_events(provider,provider_event_id,event_type,event_created_at,received_at,livemode,related_object_id,related_object_type,processing_status,processed_at,result_code) VALUES('stripe',?,'checkout.session.completed',1780000000,'2026-08-28T00:01:00Z',0,?,'checkout_session','processed','2026-08-28T00:01:00Z','payment_confirmed')").bind(ACCEPTED_EVENT, ACCEPTED_SESSION),
  ]);
}

async function authenticatedMaster(env) { await ensureEnvironmentMasters(env); const account = await loadAccountByEmail(env, "master-one@example.test"); const session = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), account, ADMIN_ORIGIN); return { cookie: cookiePair(session.cookie) }; }
async function authoritySnapshot(db) { const names = ["commerce_orders", "commerce_order_items", "commerce_audit", "commerce_catalogue_migrations", "commerce_email_deliveries", "commerce_order_documents"]; const result = {}; for (const name of names) result[name] = Number((await db.prepare(`SELECT COUNT(*) count FROM ${name}`).first()).count); const migration = await db.prepare("SELECT status,phase,products_verified,variants_mapped,provider_request_count,provider_failures,safe_state_json FROM commerce_catalogue_migrations WHERE id='permanent-printful-2026-08'").first(); result.migration = migration; return result; }
