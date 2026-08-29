import assert from "node:assert/strict";
import test from "node:test";
import { commerceOrderDetailPayload, createStripeCheckoutSession } from "../functions/_shared/checkout-core.js";
import { customerDetailPayload, customerListPayload, prepareCheckoutCustomer, validateCheckoutCustomer } from "../functions/_shared/commerce-customers.js";
import { accountDetailPayload, accountsPayload } from "../functions/api/admin/accounts/[[path]].js";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases, enableTestCheckout, insertTestProduct } from "./commerce-test-helpers.mjs";

const ORIGIN = "https://thirdrailify.pages.dev";
const adminSession = { accountId: "admin", account: { id: "admin", adminLevel: "master", role: "admin", status: "active" } };

test("customer migration keeps legacy orders nullable and enforces restrictive one-account relationships", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  await harness.commerceDb.prepare("INSERT INTO commerce_orders (id,created_at,updated_at) VALUES ('ord_legacy','now','now')").run();
  assert.equal((await harness.commerceDb.prepare("SELECT customer_id FROM commerce_orders WHERE id='ord_legacy'").first()).customer_id, null);
  const account = validateCheckoutCustomer({ mode: "account", name: "Account Buyer", email: "buyer@example.test" }, { accountId: "account-1" });
  const first = await prepareCheckoutCustomer(env, harness.commerceDb, account);
  await harness.commerceDb.batch([first.statement, ...(first.auditStatement ? [first.auditStatement] : [])]);
  await assert.rejects(harness.commerceDb.prepare(`INSERT INTO commerce_customers
    (id,customer_kind,linked_account_id,contact_name_ciphertext,contact_email_ciphertext,contact_email_fingerprint,created_at,updated_at)
    SELECT 'cst_11111111-1111-4111-8111-111111111111','account',linked_account_id,contact_name_ciphertext,contact_email_ciphertext,contact_email_fingerprint,'now','now'
    FROM commerce_customers WHERE id=?`).bind(first.id).run());
  await harness.commerceDb.prepare("INSERT INTO commerce_orders (id,customer_id,created_at,updated_at) VALUES ('ord_linked',?,'now','now')").bind(first.id).run();
  await assert.rejects(harness.commerceDb.prepare("DELETE FROM commerce_customers WHERE id=?").bind(first.id).run());
  const fk = await harness.commerceDb.prepare("PRAGMA foreign_key_check").all(); assert.deepEqual(fk.results, []);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM wheels").first()).count, 0);
});

test("guest exact email reuse remains separate from authenticated account linkage", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const guest = validateCheckoutCustomer({ mode: "guest", name: "Guest Buyer", email: "GUEST@EXAMPLE.TEST" }, null);
  const first = await prepareCheckoutCustomer(env, harness.commerceDb, guest); await harness.commerceDb.batch([first.statement]);
  const reused = await prepareCheckoutCustomer(env, harness.commerceDb, { ...guest, name: "Guest Buyer Updated" }); await harness.commerceDb.batch([reused.statement]);
  assert.equal(reused.id, first.id); assert.equal(reused.created, false);
  const account = validateCheckoutCustomer({ mode: "account", name: "Guest Buyer", email: "guest@example.test" }, { accountId: "account-1" });
  const linked = await prepareCheckoutCustomer(env, harness.commerceDb, account); await harness.commerceDb.batch([linked.statement]);
  assert.notEqual(linked.id, first.id);
  const linkedAgain = await prepareCheckoutCustomer(env, harness.commerceDb, { ...account, name: "Updated checkout name" }); await harness.commerceDb.batch([linkedAgain.statement]);
  assert.equal(linkedAgain.id, linked.id); assert.equal(linkedAgain.created, false);
  const rows = await harness.commerceDb.prepare("SELECT id,customer_kind,linked_account_id FROM commerce_customers ORDER BY customer_kind").all();
  assert.deepEqual(rows.results.map((row) => [row.customer_kind, row.linked_account_id]), [["account", "account-1"], ["guest", null]]);
  assert.throws(() => validateCheckoutCustomer({ mode: "account", name: "Spoof", email: "spoof@example.test" }, null), (error) => error.code === "checkout_account_session_required");
  assert.throws(() => validateCheckoutCustomer({ mode: "guest", name: "Signed in", email: "signed@example.test" }, { accountId: "account-2" }), (error) => error.code === "checkout_account_mode_required");
  assert.throws(() => validateCheckoutCustomer({ mode: "guest", name: "Guest", email: "invalid" }, null), (error) => error.code === "checkout_customer_email_invalid");
});

test("guest and account checkout bind Customers server-side and reject forged identity fields", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "sk_test_customerFixture123", STRIPE_WEBHOOK_SECRET: "whsec_customer_fixture" });
  await enableTestCheckout(harness.commerceDb); await insertTestProduct(harness.commerceDb, { requiresShipping: 0, unitAmount: 2500 });
  await insertAccount(harness.authDb, "account-1", "Account Buyer", "account@example.test");
  const stripe = (id) => async (_url, init) => { const form = new URLSearchParams(init.body); const orderId = form.get("metadata[order_id]"); return Response.json({ id, object: "checkout.session", livemode: false, mode: "payment", currency: "cad", amount_total: 2500, client_reference_id: orderId, metadata: { order_id: orderId, checkout_request_id: form.get("metadata[checkout_request_id]") }, url: `https://checkout.stripe.com/c/pay/${id}` }); };
  const base = { items: [{ productId: "product-test-001", quantity: 1 }] };
  const guest = await createStripeCheckoutSession(env, request(), { ...base, checkoutRequestId: "11111111-1111-4111-8111-111111111111", customer: { mode: "guest", name: "Guest Buyer", email: "guest@example.test" } }, stripe("cs_test_customer_guest"), { session: null });
  const session = { accountId: "account-1", account: { id: "account-1", displayName: "Account Buyer", email: "account@example.test", emailVerified: true } };
  const account = await createStripeCheckoutSession(env, request(), { ...base, checkoutRequestId: "22222222-2222-4222-8222-222222222222", customer: { mode: "account", name: "Checkout Recipient", email: "delivery@example.test" } }, stripe("cs_test_customer_account"), { session });
  const orders = await harness.commerceDb.prepare("SELECT id,customer_id FROM commerce_orders ORDER BY id").all(); assert.equal(orders.results.every((row) => row.customer_id), true); assert.notEqual(orders.results[0].customer_id, orders.results[1].customer_id);
  const linked = await harness.commerceDb.prepare("SELECT customer_kind,linked_account_id FROM commerce_customers WHERE id=(SELECT customer_id FROM commerce_orders WHERE id=?)").bind(account.orderId).first(); assert.deepEqual(linked, { customer_kind: "account", linked_account_id: "account-1" });
  const unlinked = await harness.commerceDb.prepare("SELECT customer_kind,linked_account_id FROM commerce_customers WHERE id=(SELECT customer_id FROM commerce_orders WHERE id=?)").bind(guest.orderId).first(); assert.deepEqual(unlinked, { customer_kind: "guest", linked_account_id: null });
  await assert.rejects(createStripeCheckoutSession(env, request(), { ...base, checkoutRequestId: "33333333-3333-4333-8333-333333333333", accountId: "account-1", customer: { mode: "guest", name: "Forged", email: "forged@example.test" } }, stripe("cs_test_forged"), { session: null }), (error) => error.code === "checkout_request_fields_invalid");
  await assert.rejects(createStripeCheckoutSession(env, request(), { ...base, checkoutRequestId: "44444444-4444-4444-8444-444444444444", customerId: orders.results[0].customer_id, customer: { mode: "guest", name: "Forged", email: "forged@example.test" } }, stripe("cs_test_forged_2"), { session: null }), (error) => error.code === "checkout_request_fields_invalid");
});

test("customer and Account projections keep TEST and LIVE aggregates separate without N+1 correlation", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness);
  await insertAccount(harness.authDb, "admin", "Master Admin", "admin@example.test", "admin", "master");
  await insertAccount(harness.authDb, "account-1", "Account Buyer", "account@example.test");
  const prepared = await prepareCheckoutCustomer(env, harness.commerceDb, validateCheckoutCustomer({ mode: "account", name: "Buyer", email: "buyer@example.test" }, { accountId: "account-1" })); await harness.commerceDb.batch([prepared.statement]);
  await harness.commerceDb.batch([
    harness.commerceDb.prepare("INSERT INTO commerce_orders (id,customer_id,environment,payment_status,customer_gross_amount,created_at,updated_at) VALUES ('ord_live',?,'live','paid',10000,'2026-08-01','2026-08-01')").bind(prepared.id),
    harness.commerceDb.prepare("INSERT INTO commerce_orders (id,customer_id,environment,payment_status,customer_gross_amount,created_at,updated_at) VALUES ('ord_test',?,'test','paid',90000,'2026-08-02','2026-08-02')").bind(prepared.id),
    harness.commerceDb.prepare("INSERT INTO commerce_orders (id,environment,payment_status,customer_gross_amount,created_at,updated_at) VALUES ('ord_legacy','test','paid',500,'2026-07-01','2026-07-01')"),
  ]);
  const list = await customerListPayload(env, adminSession, { environment: "all", purchase: "paid", sort: "highest_live_spend" });
  assert.equal(list.customers.length, 1); assert.equal(list.customers[0].summary.liveSpendAmount, 10000); assert.equal(list.customers[0].summary.testSpendAmount, 90000); assert.equal(list.customers[0].summary.livePaidOrderCount, 1); assert.equal(list.customers[0].summary.testPaidOrderCount, 1);
  const filtered = await customerListPayload(env, adminSession, { page: 1, pageSize: 20, query: "buyer@example.test", type: "account", environment: "test", purchase: "paid", sort: "most_orders" });
  assert.equal(filtered.totalMatching, 1); assert.equal(filtered.totalPages, 1); assert.equal(filtered.startIndex, 1); assert.equal(filtered.endIndex, 1); assert.equal(filtered.customers[0].id, prepared.id);
  const detail = await customerDetailPayload(env, adminSession, prepared.id); assert.equal(detail.customer.orders.length, 2); assert.equal(detail.customer.orders.every((order) => order.id !== "ord_legacy"), true);
  const accounts = await accountsPayload(env, adminSession); const buyer = accounts.accounts.find((value) => value.id === "account-1"); assert.equal(buyer.customer.id, prepared.id); assert.equal(buyer.customer.orderCount, 2);
  const noPurchase = accounts.accounts.find((value) => value.id === "admin"); assert.equal(noPurchase.customer, null);
  await harness.authDb.prepare("INSERT INTO sessions (id,account_id,token_hash,csrf_token_hash,created_at,expires_at,last_seen_at,source_origin) VALUES ('session-safe','account-1','token-hash-not-projected','csrf-hash-not-projected','2026-08-01','2099-08-01','2026-08-02','https://thirdrailify-admin.pages.dev')").run();
  const accountDetail = await accountDetailPayload(env, adminSession, "account-1"); assert.equal(accountDetail.account.customer.id, prepared.id); assert.equal(accountDetail.sessions.length, 1); assert.equal("tokenHash" in accountDetail.sessions[0], false); assert.doesNotMatch(JSON.stringify(accountDetail), /token-hash-not-projected|csrf-hash-not-projected/);
  const linkedOrder = await commerceOrderDetailPayload(env, adminSession, "ord_live"); assert.equal(linkedOrder.order.customer.linked, true); assert.equal(linkedOrder.order.customer.kind, "account");
  const legacyOrder = await commerceOrderDetailPayload(env, adminSession, "ord_legacy"); assert.equal(legacyOrder.order.customer.legacy, true); assert.equal(legacyOrder.order.customer.linked, false);
  const anonymous = await commerceRequest({ request: jsonRequest("https://thirdrailify-admin.pages.dev/api/admin/commerce/customers", { method: "GET", origin: "https://thirdrailify-admin.pages.dev" }), env, data: {} }); assert.equal(anonymous.status, 401);
  assert.doesNotMatch(JSON.stringify(list), /ciphertext|contact_email_fingerprint|A256GCM|recipient_ciphertext/i);
});

function request() { return new Request("https://thirdrailify-admin.pages.dev/api/commerce/checkout", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" } }); }
async function insertAccount(db, id, displayName, email, role = "user", adminLevel = "none") { const now = new Date().toISOString(); await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,'test')").bind(id,email,displayName,role,adminLevel,now,now,now).run(); }
