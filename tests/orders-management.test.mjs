import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { commerceOrderDetailPayload, commerceOrdersPayload } from "../functions/_shared/checkout-core.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases, insertTestProduct } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const master = { accountId: "master-admin", account: { adminLevel: "master" } };

test("order list is filter-first, deterministically paginated, and excludes TEST value from live summaries", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const statements = [];
  let expectedLiveGross = 0;
  let expectedLiveNet = 0;
  for (let index = 0; index < 105; index += 1) {
    const environment = index < 30 ? "test" : "live";
    const payment = index % 11 === 0 ? "refunded" : index % 3 === 0 ? "pending" : "paid";
    const fulfillment = index % 5 === 0 ? "draft" : "disabled";
    const total = index === 0 ? 999_900 : 1_000 + index;
    const refund = payment === "refunded" ? Math.min(500, total) : 0;
    if (environment === "live" && ["paid", "refunded", "partially_refunded"].includes(payment)) { expectedLiveGross += total; expectedLiveNet += total - refund; }
    statements.push(harness.commerceDb.prepare(
      `INSERT INTO commerce_orders (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,refund_amount,
        stripe_payment_intent_id,environment,checkout_status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(`ord-list-${String(index).padStart(3, "0")}`, payment, fulfillment, "CAD", total, refund, index === 77 ? "pi_searchneedle_77" : `pi_fixture_${index}`, environment, "checkout_created", `2026-08-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`, `2026-08-${String((index % 28) + 1).padStart(2, "0")}T12:00:01.000Z`));
  }
  for (let offset = 0; offset < statements.length; offset += 50) await harness.commerceDb.batch(statements.slice(offset, offset + 50));

  for (const pageSize of [20, 50, 75, 100]) {
    const payload = await commerceOrdersPayload(env, master, { pageSize });
    assert.equal(payload.pageSize, pageSize); assert.equal(payload.orders.length, Math.min(pageSize, 105));
  }
  await assert.rejects(commerceOrdersPayload(env, master, { pageSize: 101 }), /page size/i);
  const stale = await commerceOrdersPayload(env, master, { page: 999, pageSize: 20 });
  assert.equal(stale.page, 6); assert.equal(stale.startIndex, 101); assert.equal(stale.endIndex, 105);
  const filtered = await commerceOrdersPayload(env, master, { environment: "test", page: 2, pageSize: 20 });
  assert.equal(filtered.totalMatching, 30); assert.equal(filtered.orders.length, 10); assert.ok(filtered.orders.every((order) => order.test));
  const searched = await commerceOrdersPayload(env, master, { query: "searchneedle" });
  assert.deepEqual(searched.orders.map((order) => order.id), ["ord-list-077"]);
  const paid = await commerceOrdersPayload(env, master, { payment: "paid", sort: "highest_total", pageSize: 100 });
  assert.ok(paid.orders.every((order) => order.paymentStatus === "paid"));
  assert.ok(paid.orders.every((order, index, rows) => index === 0 || rows[index - 1].totalAmount >= order.totalAmount));
  const summary = await commerceOrdersPayload(env, master, { pageSize: 20 });
  assert.equal(summary.summary.liveGrossAmount, expectedLiveGross); assert.equal(summary.summary.liveNetAmount, expectedLiveNet);
  assert.ok(summary.summary.liveGrossAmount < 999_900); assert.equal("items" in summary.orders[0], false); assert.equal("customer" in summary.orders[0], false);
});

test("single-order detail preserves immutable history through catalogue changes and projects documents, delivery, webhook, audit, and ordered timeline", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  await insertTestProduct(harness.commerceDb, { id: "product-historical", slug: "historical", title: "Current title must not replace snapshot" });
  await harness.commerceDb.batch([
    harness.commerceDb.prepare(
      `INSERT INTO commerce_orders (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,refund_amount,
        stripe_checkout_session_id,stripe_payment_intent_id,environment,checkout_status,checkout_request_id,
        checkout_created_at,payment_confirmed_at,created_at,updated_at)
       VALUES ('ord-detail-001','paid','disabled','CAD',2500,500,'cs_test_detail001','pi_detail001','test','checkout_created',
        '11111111-1111-4111-8111-111111111111','2026-08-29T00:01:00.000Z','2026-08-29T00:03:00.000Z','2026-08-29T00:00:00.000Z','2026-08-29T00:03:00.000Z')`),
    harness.commerceDb.prepare(
      `INSERT INTO commerce_order_items (id,order_id,line_number,product_id,product_name,option_values_json,currency_code,
        unit_amount,quantity,line_total_amount,requires_shipping,created_at)
       VALUES ('line-detail-001','ord-detail-001',1,'product-historical','Immutable historical title','{"Size":"M"}','CAD',2500,1,2500,1,'2026-08-29T00:00:00.000Z')`),
    harness.commerceDb.prepare(
      `INSERT INTO commerce_webhook_events (provider,provider_event_id,event_type,event_created_at,received_at,livemode,
        related_object_id,related_object_type,processing_status,processed_at,result_code)
       VALUES ('stripe','evt_detail001','checkout.session.completed',1787961720,'2026-08-29T00:02:01.000Z',0,
        'cs_test_detail001','checkout.session','processed','2026-08-29T00:03:00.000Z','payment_confirmed')`),
    harness.commerceDb.prepare(
      `INSERT INTO commerce_order_documents (id,order_id,document_type,display_reference,environment,status,template_key,
        template_revision,snapshot_json,created_at,updated_at)
       VALUES ('doc-detail-001','ord-detail-001','receipt','ord-detail-001','test','preview','payment_receipt',1,'{}','2026-08-29T00:04:00.000Z','2026-08-29T00:04:00.000Z')`),
    harness.commerceDb.prepare(
      `INSERT INTO commerce_email_deliveries (id,delivery_key,template_key,template_revision,order_id,event_key,recipient_email,
        purpose,status,created_at,updated_at)
       VALUES ('mail-detail-001',?,'order_confirmation',1,'ord-detail-001','payment_confirmed','customer@example.test',
        'transactional','pending','2026-08-29T00:05:00.000Z','2026-08-29T00:05:00.000Z')`).bind("a".repeat(64)),
    harness.commerceDb.prepare(
      `INSERT INTO commerce_audit (id,actor_account_id,action,target_type,target_id,result,created_at)
       VALUES ('audit-detail-001','master-admin','order_reviewed','commerce_order','ord-detail-001','success','2026-08-29T00:06:00.000Z')`),
  ]);
  await harness.commerceDb.prepare("UPDATE commerce_products SET title = 'Renamed current catalogue title', safe_metadata_json = '{}' WHERE id = 'product-historical'").run();

  const payload = await commerceOrderDetailPayload(env, master, "ord-detail-001");
  assert.equal(payload.order.test, true); assert.equal(payload.order.customer.available, false);
  assert.equal(payload.order.items[0].productName, "Immutable historical title"); assert.equal(payload.order.items[0].imageUrl, null);
  assert.deepEqual(payload.order.financial, { subtotalAmount: 2500, discountAmount: null, shippingAmount: null, taxAmount: null, totalAmount: 2500, refundAmount: 500, netAmount: 2000, currencyCode: "CAD" });
  assert.equal(payload.order.documents.length, 1); assert.equal(payload.order.deliveries.length, 1); assert.equal(payload.order.webhooks.length, 1); assert.equal(payload.order.audit.length, 1);
  assert.deepEqual(payload.order.timeline.map((entry) => entry.timestamp), [...payload.order.timeline.map((entry) => entry.timestamp)].sort());
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /recipient_email|customer@example|authorization|secret|credential|payload_sha256|snapshot_json/i);
  assert.equal(payload.order.fulfillment.submissionEnabled, false); assert.equal(payload.order.fulfillment.orderMode, "draft_only");
});

test("order read routes reject unauthenticated and insufficient callers and never invoke providers", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  let providerCalls = 0;
  const data = { commerceFetch: () => { providerCalls += 1; throw new Error("provider read must not run"); } };
  const anonymous = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/orders`, { method: "GET", origin: ADMIN_ORIGIN }), env, data });
  assert.equal(anonymous.status, 401);
  await ensureEnvironmentMasters(env);
  const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES ('ordinary-order-user','ordinary-order@example.test','Ordinary','user','none','active',?,?,?,'test')").bind(now, now, now).run();
  const ordinary = await loadAccountByEmail(env, "ordinary-order@example.test");
  const session = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), ordinary, ADMIN_ORIGIN);
  const forbidden = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/orders`, { method: "GET", origin: ADMIN_ORIGIN, cookie: cookiePair(session.cookie) }), env, data });
  assert.equal(forbidden.status, 403); assert.equal(providerCalls, 0);
});
