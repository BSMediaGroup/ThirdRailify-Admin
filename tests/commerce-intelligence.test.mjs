import assert from "node:assert/strict";
import test from "node:test";

import { commerceIntelligenceReport, commerceIntelligenceSchemaState } from "../functions/_shared/commerce-intelligence.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { cookiePair } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const NOW = new Date("2026-08-31T12:00:00.000Z");

test("Commerce Intelligence keeps LIVE financial semantics, currencies, refunds, and incomplete costs truthful", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  await seedFinancialAuthority(harness.commerceDb);
  const report = await commerceIntelligenceReport(commerceEnvironment(harness), { range: "7d", page: "1", pageSize: "20" }, NOW);
  assert.equal(report.environment, "live");
  assert.equal(report.currencies.length, 2);
  const cad = report.currencies.find((entry) => entry.currencyCode === "CAD");
  const usd = report.currencies.find((entry) => entry.currencyCode === "USD");
  assert.equal(cad.metrics.merchandiseSales.value, 21000);
  assert.equal(cad.metrics.donations.value, 4250);
  assert.equal(cad.metrics.customerShipping.value, 1500);
  assert.equal(cad.metrics.taxCollected.value, 1500);
  assert.equal(cad.metrics.grossCollected.value, 28250);
  assert.equal(cad.metrics.refundsReversals.value, 8950);
  assert.equal(cad.metrics.netCollected.value, 19300);
  assert.equal(cad.metrics.knownDirectCosts.value, null);
  assert.equal(cad.metrics.knownDirectCosts.knownValue, 5000);
  assert.equal(cad.metrics.processorFees.value, null);
  assert.equal(cad.metrics.processorFees.knownValue, 350);
  assert.equal(cad.metrics.contributionMargin.value, null);
  assert.equal(cad.metrics.contributionMargin.knownValue, 5650);
  assert.equal(cad.counts.orders, 4);
  assert.equal(cad.counts.donations, 3);
  assert.equal(cad.comparisonComplete, true);
  assert.equal(usd.metrics.grossCollected.value, 7000);
  assert.equal(usd.deltas.grossCollected.direction, "new");
  assert.equal(report.orders.items.some((row) => row.id === "ord-test-paid"), false);
  assert.equal(report.orders.items.some((row) => row.id === "ord-pending"), false);
  assert.equal(report.orders.items.find((row) => row.id === "ord-known-cost").contributionMargin, 5650);
  assert.equal(report.orders.items.find((row) => row.id === "ord-partial-refund").fulfillmentCost, null);
  assert.equal(report.donations.find((entry) => entry.currencyCode === "CAD").net, 2500);
  assert.equal(report.refunds.find((entry) => entry.currencyCode === "CAD").partialOrderRefunds, 1);
  assert.equal(report.refunds.find((entry) => entry.currencyCode === "CAD").fullOrderRefunds, 2);
  assert.equal(report.refunds.find((entry) => entry.currencyCode === "CAD").donationReversals, 1);
  assert.equal(report.coverage.fulfillmentCost.known, 1);
  assert.equal(report.coverage.processorFees.known, 1);
  assert.equal(report.coverage.currencies.join(","), "CAD,USD");
  assert.equal(report.semantics.contributionMargin.includes("not business profit"), true);
  assert.equal(JSON.stringify(report).includes("test@example"), false);
});

test("Commerce Intelligence product aggregation never invents partial-refund allocation or historical cost", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  await seedFinancialAuthority(harness.commerceDb);
  const report = await commerceIntelligenceReport(commerceEnvironment(harness), { range: "7d" }, NOW);
  const known = report.products.find((entry) => entry.productId === "product-known");
  const partial = report.products.find((entry) => entry.productId === "product-partial");
  assert.equal(known.quantity, 2);
  assert.equal(known.grossMerchandise, 10000);
  assert.equal(known.netMerchandise, 10000);
  assert.equal(known.fulfillmentCost, 4000);
  assert.equal(partial.refundedValue, null);
  assert.equal(partial.netMerchandise, null);
  assert.equal(partial.fulfillmentCost, null);
});

test("Commerce Intelligence reports empty periods and incomplete comparison history without synthetic deltas", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  await seedFinancialAuthority(harness.commerceDb);
  const incomplete = await commerceIntelligenceReport(commerceEnvironment(harness), { range: "90d" }, NOW);
  assert.equal(incomplete.currencies.every((entry) => entry.comparisonComplete === false), true);
  assert.equal(incomplete.currencies.every((entry) => entry.deltas.grossCollected.available === false), true);
  const empty = await commerceIntelligenceReport(commerceEnvironment(harness), { range: "24h" }, new Date("2027-08-31T12:00:00.000Z"));
  assert.deepEqual(empty.currencies, []);
  assert.deepEqual(empty.trend, []);
  assert.equal(empty.orders.total, 0);
  assert.deepEqual(empty.products, []);
});

test("Commerce Intelligence rejects unsupported ranges, pagination, and incomplete schema explicitly", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  await assert.rejects(commerceIntelligenceReport(env, { range: "all" }, NOW), (error) => error.status === 400 && error.code === "commerce_intelligence_range_invalid");
  await assert.rejects(commerceIntelligenceReport(env, { pageSize: "500" }, NOW), (error) => error.status === 400 && error.code === "commerce_intelligence_page_size_invalid");
  const old = await createCommerceDatabases({ commerceMigrationCount: 20 });
  t.after(old.dispose);
  const state = await commerceIntelligenceSchemaState(old.commerceDb);
  assert.equal(state.compatible, false);
  assert.equal(state.tables.commerce_donations.tablePresent, false);
  await assert.rejects(commerceIntelligenceReport(commerceEnvironment(old), { range: "30d" }, NOW), (error) => error.status === 503 && error.code === "commerce_intelligence_migration_required");
});

test("Commerce Intelligence API requires Admin access and returns private bounded reports", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  await seedFinancialAuthority(harness.commerceDb);
  const env = commerceEnvironment(harness);
  const anonymous = await commerceRequest({ request: new Request(`${ADMIN_ORIGIN}/api/admin/commerce/analytics?range=7d`), env, data: {} });
  assert.equal(anonymous.status, 401);
  const cookie = await adminCookie(env);
  const malformed = await commerceRequest({ request: new Request(`${ADMIN_ORIGIN}/api/admin/commerce/analytics?range=all`, { headers: { Cookie: cookie } }), env, data: {} });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "commerce_intelligence_range_invalid");
  const response = await commerceRequest({ request: new Request(`${ADMIN_ORIGIN}/api/admin/commerce/analytics?range=7d&page=1&pageSize=20`, { headers: { Cookie: cookie } }), env, data: {} });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal((await response.json()).orders.pageSize, 20);
});

async function seedFinancialAuthority(db) {
  await db.batch([
    db.prepare("INSERT INTO commerce_products (id,source_provider,slug,title,currency_code,status,safe_metadata_json,created_at,updated_at) VALUES ('product-known','manual','product-known','Known product','CAD','active','{}','2026-08-30T10:00:00.000Z','2026-08-30T10:00:00.000Z')"),
    db.prepare("INSERT INTO commerce_products (id,source_provider,slug,title,currency_code,status,safe_metadata_json,created_at,updated_at) VALUES ('product-partial','manual','product-partial','Partial product','CAD','active','{}','2026-08-29T10:00:00.000Z','2026-08-29T10:00:00.000Z')"),
    db.prepare("INSERT INTO commerce_product_variants (id,product_id,local_variant_key,unit_amount,created_at,updated_at) VALUES ('variant-known','product-known','known',5000,'2026-08-30T10:00:00.000Z','2026-08-30T10:00:00.000Z')"),
    db.prepare("INSERT INTO commerce_product_variants (id,product_id,local_variant_key,unit_amount,created_at,updated_at) VALUES ('variant-partial','product-partial','partial',5000,'2026-08-29T10:00:00.000Z','2026-08-29T10:00:00.000Z')"),
    order(db, { id: "ord-known-cost", status: "paid", currency: "CAD", gross: 12000, subtotal: 10000, shipping: 1000, tax: 1000, fee: 350, productCost: 4000, shippingCost: 800, providerTax: 200, printfulId: "70001", capturedAt: "2026-08-30T10:00:00.000Z" }),
    order(db, { id: "ord-partial-refund", status: "partially_refunded", currency: "CAD", gross: 6000, subtotal: 5000, shipping: 500, tax: 500, refund: 1200, capturedAt: "2026-08-29T10:00:00.000Z" }),
    order(db, { id: "ord-reversed", provider: "paypal", status: "disputed", currency: "CAD", gross: 4000, subtotal: 4000, fee: 999, capturedAt: "2026-08-28T10:00:00.000Z" }),
    order(db, { id: "ord-full-refund", status: "refunded", currency: "CAD", gross: 2000, subtotal: 2000, refund: 2000, capturedAt: "2026-08-28T09:00:00.000Z" }),
    order(db, { id: "ord-usd", status: "paid", currency: "USD", gross: 7000, subtotal: 7000, capturedAt: "2026-08-27T10:00:00.000Z" }),
    order(db, { id: "ord-prior", status: "paid", currency: "CAD", gross: 5000, subtotal: 5000, capturedAt: "2026-08-20T10:00:00.000Z" }),
    order(db, { id: "ord-coverage", status: "paid", currency: "CAD", gross: 1000, subtotal: 1000, capturedAt: "2026-08-16T10:00:00.000Z" }),
    order(db, { id: "ord-test-paid", status: "paid", environment: "test", currency: "CAD", gross: 99999, subtotal: 99999, capturedAt: "2026-08-30T10:00:00.000Z" }),
    order(db, { id: "ord-pending", status: "pending", currency: "CAD", gross: 3000, subtotal: 3000, capturedAt: "2026-08-30T10:00:00.000Z" }),
    order(db, { id: "ord-failed", status: "failed", currency: "CAD", gross: 3000, subtotal: 3000, capturedAt: "2026-08-30T10:00:00.000Z" }),
    order(db, { id: "ord-canceled", status: "canceled", currency: "CAD", gross: 3000, subtotal: 3000, capturedAt: "2026-08-30T10:00:00.000Z" }),
    db.prepare(`INSERT INTO commerce_order_items (id,order_id,line_number,product_id,variant_id,product_name,variant_name,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,created_at)
      VALUES ('item-known','ord-known-cost',1,'product-known','variant-known','Known product','Black / XL','CAD',5000,2,10000,1,'2026-08-30T10:00:00.000Z')`),
    db.prepare(`INSERT INTO commerce_order_items (id,order_id,line_number,product_id,variant_id,product_name,variant_name,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,created_at)
      VALUES ('item-partial','ord-partial-refund',1,'product-partial','variant-partial','Partial product','Standard','CAD',5000,1,5000,1,'2026-08-29T10:00:00.000Z')`),
    donation(db, { id: `don_${"a".repeat(40)}`, request: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", amount: 2500, status: "completed", completedAt: "2026-08-30T11:00:00.000Z" }),
    donation(db, { id: `don_${"b".repeat(40)}`, request: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", amount: 1000, status: "refunded", completedAt: "2026-08-29T11:00:00.000Z", refundedAt: "2026-08-30T11:00:00.000Z" }),
    donation(db, { id: `don_${"d".repeat(40)}`, request: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", amount: 750, status: "reversed", completedAt: "2026-08-29T10:30:00.000Z", reversedAt: "2026-08-30T10:45:00.000Z" }),
    donation(db, { id: `don_${"c".repeat(40)}`, request: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", amount: 9000, status: "completed", environment: "sandbox", completedAt: "2026-08-30T11:00:00.000Z" }),
    db.prepare(`INSERT INTO commerce_payment_attempts (id,commerce_order_id,provider,environment,provider_order_id,provider_capture_id,idempotency_key,currency_code,amount_minor,provider_status,normalized_state,create_request_digest,reversed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'2026-08-30T10:30:00.000Z','2026-08-28T10:00:00.000Z','2026-08-30T10:30:00.000Z')`).bind(`pat_${"d".repeat(40)}`, "ord-reversed", "paypal", "live", "PAYPAL-REVERSED", "CAPTURE-REVERSED", "commerce-intelligence-reversed-order", "CAD", 4000, "REVERSED", "reversed", "e".repeat(64)),
    db.prepare(`INSERT INTO commerce_payment_attempts (id,commerce_order_id,provider,environment,provider_order_id,provider_capture_id,idempotency_key,currency_code,amount_minor,provider_status,normalized_state,create_request_digest,reversed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'2026-08-29T10:30:00.000Z','2026-08-28T10:00:00.000Z','2026-08-29T10:30:00.000Z')`).bind(`pat_${"f".repeat(40)}`, "ord-reversed", "paypal", "live", "PAYPAL-OLDER", "CAPTURE-OLDER", "commerce-intelligence-older-reversal", "CAD", 2500, "REVERSED", "reversed", "a".repeat(64)),
  ]);
}

function order(db, { id, provider = "stripe", status, environment = "live", currency, gross, subtotal, shipping = 0, tax = 0, refund = 0, fee = 0, productCost = 0, shippingCost = 0, providerTax = 0, printfulId = null, capturedAt }) {
  return db.prepare(`INSERT INTO commerce_orders (id,customer_payment_provider,payment_status,fulfillment_status,currency_code,customer_gross_amount,stripe_fee_amount,refund_amount,printful_product_cost_amount,printful_shipping_cost_amount,printful_tax_amount,printful_refund_credit_amount,printful_order_id,environment,checkout_status,product_subtotal_amount,shipping_amount,tax_amount,payment_confirmed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, provider, status, "disabled", currency, gross, fee, refund, productCost, shippingCost, providerTax, 0, printfulId, environment, "checkout_created", subtotal, shipping, tax, capturedAt, capturedAt, capturedAt);
}

function donation(db, { id, request, amount, status, environment = "live", completedAt, refundedAt = null, reversedAt = null }) {
  return db.prepare(`INSERT INTO commerce_donations (id,request_id,request_digest,environment,currency_code,amount_minor,status,completed_at,refunded_at,reversed_at,created_at,updated_at)
    VALUES (?,?,? ,?,'CAD',?,?,?,?,?,?,?)`).bind(id, request, id.slice(-40).padEnd(64, "f"), environment, amount, status, completedAt, refundedAt, reversedAt, completedAt, reversedAt || refundedAt || completedAt);
}

async function adminCookie(env) {
  await ensureEnvironmentMasters(env);
  const account = await loadAccountByEmail(env, env.ADMIN_EMAIL_1);
  const session = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), account, ADMIN_ORIGIN);
  return cookiePair(session.cookie);
}
