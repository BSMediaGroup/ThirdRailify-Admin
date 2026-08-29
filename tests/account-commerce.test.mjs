import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accountAddressCreate,
  accountAddressDelete,
  accountAddressSetDefault,
  accountAddressUpdate,
  accountCommerceContactUpdate,
  accountCommerceOverview,
  accountOrderDetail,
  accountOrderHistory,
} from "../functions/_shared/account-commerce.js";
import { decryptCommerceSecret, encryptCommerceSecret } from "../functions/_shared/commerce-core.js";
import { hmacSha256 } from "../functions/_shared/auth-core.js";
import { onRequest as accountCommerceRequest } from "../functions/api/account-commerce/[[path]].js";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const PUBLIC_ORIGIN = "https://thirdrailify.pages.dev";
const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const BRIDGE_SECRET = "synthetic-account-commerce-bridge-secret";

const HOME = Object.freeze({
  label: "Home",
  recipientName: "Ada Rail",
  company: "Third Rail Fixture",
  address1: "100 Test Street",
  address2: "Unit 4",
  city: "London",
  region: "ON",
  postalCode: "N6A 1A1",
  countryCode: "CA",
  phone: "+1 519 555 0100",
  isDefault: true,
});

test("Account V2 contact and saved addresses use the existing account customer and encrypted Commerce D1 authority", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_COMMUNITY_API_SECRET: BRIDGE_SECRET });
  await insertAccount(harness.authDb, "account-a", "Ada Account", "ada@example.test");

  const empty = await accountCommerceOverview(env, "account-a");
  assert.equal(empty.linked, false); assert.deepEqual(empty.addresses, []); assert.equal(empty.contact.email, "ada@example.test");

  const created = await accountAddressCreate(env, "account-a", HOME);
  assert.equal(created.linked, true); assert.equal(created.addresses.length, 1); assert.equal(created.addresses[0].isDefault, true);
  assert.equal(created.addresses[0].recipientName, HOME.recipientName); assert.equal(created.addresses[0].externallyVerified, false);
  const customer = await harness.commerceDb.prepare("SELECT * FROM commerce_customers WHERE linked_account_id='account-a'").first();
  const stored = await harness.commerceDb.prepare("SELECT * FROM commerce_saved_addresses WHERE customer_id=?").bind(customer.id).first();
  assert.doesNotMatch(stored.address_ciphertext, /Ada Rail|100 Test Street|N6A 1A1|519 555/);
  assert.doesNotMatch(customer.contact_name_ciphertext, /Ada Account/);
  assert.deepEqual(JSON.parse(await decryptCommerceSecret(env, stored.address_ciphertext, `saved-address:${stored.id}`)), {
    recipientName: HOME.recipientName, company: HOME.company, address1: HOME.address1, address2: HOME.address2,
    city: HOME.city, region: HOME.region, postalCode: HOME.postalCode, countryCode: HOME.countryCode, phone: HOME.phone,
  });

  const contact = await accountCommerceContactUpdate(env, "account-a", { name: "Ada Commerce", phone: "+1 519 555 0101", revision: customer.revision });
  assert.equal(contact.contact.name, "Ada Commerce"); assert.equal(contact.contact.phone, "+1 519 555 0101");
  const updatedCustomer = await harness.commerceDb.prepare("SELECT * FROM commerce_customers WHERE id=?").bind(customer.id).first();
  assert.doesNotMatch(updatedCustomer.contact_phone_ciphertext, /519 555/);
  assert.equal(await decryptCommerceSecret(env, updatedCustomer.contact_phone_ciphertext, `customer:${customer.id}:phone`), "+1 519 555 0101");
  assert.doesNotMatch(JSON.stringify(contact), /ciphertext|fingerprint|A256GCM/i);
});

test("address ownership, revisions, default uniqueness, bounds, and historical snapshot immutability fail closed", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_COMMUNITY_API_SECRET: BRIDGE_SECRET });
  await insertAccount(harness.authDb, "account-a", "Ada Account", "ada@example.test");
  await insertAccount(harness.authDb, "account-b", "Babbage Account", "babbage@example.test");
  let overview = await accountAddressCreate(env, "account-a", HOME);
  overview = await accountAddressCreate(env, "account-a", { ...HOME, label: "Work", address1: "200 Fixture Avenue", isDefault: false });
  await accountAddressCreate(env, "account-b", { ...HOME, label: "Babbage", recipientName: "Babbage Account" });
  const [home, work] = overview.addresses;
  assert.equal(home.isDefault, true); assert.equal(work.isDefault, false);

  overview = await accountAddressSetDefault(env, "account-a", work.id);
  assert.equal(overview.addresses.filter((address) => address.isDefault).length, 1); assert.equal(overview.addresses[0].id, work.id);
  await assert.rejects(accountAddressUpdate(env, "account-b", work.id, { ...HOME, revision: work.revision }), (error) => error.code === "saved_address_not_found");
  await assert.rejects(accountAddressUpdate(env, "account-a", work.id, { ...HOME, revision: 999 }), (error) => error.code === "address_revision_conflict");
  await assert.rejects(accountAddressCreate(env, "account-a", { ...HOME, accountId: "account-b" }), (error) => error.code === "saved_address_fields_invalid");
  await assert.rejects(accountAddressCreate(env, "account-a", { ...HOME, countryCode: "ZZ" }), (error) => error.code === "delivery_country_invalid");
  await assert.rejects(accountAddressCreate(env, "account-a", { ...HOME, address1: "Injected\nStreet" }), (error) => error.code === "delivery_field_unsafe");

  const customer = await harness.commerceDb.prepare("SELECT id FROM commerce_customers WHERE linked_account_id='account-a'").first();
  await insertHistoricalSnapshot(env, harness.commerceDb, customer.id);
  const before = await harness.commerceDb.prepare("SELECT recipient_ciphertext FROM commerce_order_delivery_snapshots WHERE order_id='ord_history_a'").first();
  overview = await accountAddressDelete(env, "account-a", work.id);
  const after = await harness.commerceDb.prepare("SELECT recipient_ciphertext FROM commerce_order_delivery_snapshots WHERE order_id='ord_history_a'").first();
  assert.equal(after.recipient_ciphertext, before.recipient_ciphertext); assert.equal(overview.addresses.length, 1); assert.equal(overview.addresses[0].isDefault, true);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_saved_addresses WHERE id=?").bind(work.id).first()).count, 0);

  for (let index = 2; index <= 10; index += 1) await accountAddressCreate(env, "account-a", { ...HOME, label: `Address ${index}`, address1: `${index} Fixture Street`, isDefault: false });
  await assert.rejects(accountAddressCreate(env, "account-a", { ...HOME, label: "Overflow", address1: "99 Overflow Street" }), (error) => error.code === "address_limit_reached");
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_saved_addresses WHERE customer_id=?").bind(customer.id).first()).count, 10);
  assert.deepEqual((await harness.commerceDb.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("account order history is linked by customer ID, keeps TEST distinct, and exposes only customer-safe detail", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_COMMUNITY_API_SECRET: BRIDGE_SECRET });
  await insertAccount(harness.authDb, "account-a", "Ada Account", "ada@example.test");
  await insertAccount(harness.authDb, "account-b", "Babbage Account", "babbage@example.test");
  await accountAddressCreate(env, "account-a", HOME); await accountAddressCreate(env, "account-b", { ...HOME, recipientName: "Babbage Account" });
  const customerA = await harness.commerceDb.prepare("SELECT id FROM commerce_customers WHERE linked_account_id='account-a'").first();
  const customerB = await harness.commerceDb.prepare("SELECT id FROM commerce_customers WHERE linked_account_id='account-b'").first();
  await insertOrder(harness.commerceDb, "ord_account_a_test", customerA.id, "test", 3595, "2026-08-29T01:00:00.000Z");
  await insertOrder(harness.commerceDb, "ord_account_b_live", customerB.id, "live", 9995, "2026-08-29T02:00:00.000Z");
  const history = await accountOrderHistory(env, "account-a");
  assert.equal(history.total, 1); assert.equal(history.testCount, 1); assert.equal(history.liveCount, 0); assert.equal(history.orders[0].id, "ord_account_a_test");
  assert.equal(history.orders[0].environment, "test"); assert.equal(history.orders[0].totalAmount, 3595);
  const detail = await accountOrderDetail(env, "account-a", "ord_account_a_test");
  assert.equal(detail.order.items[0].title, "Fixture Product"); assert.equal(detail.order.financial.taxAmount, null);
  assert.equal(detail.order.environment, "test"); assert.doesNotMatch(JSON.stringify(detail), /stripe|webhook|ciphertext|provider_order_id|fingerprint/i);
  await assert.rejects(accountOrderDetail(env, "account-a", "ord_account_b_live"), (error) => error.code === "account_order_not_found");
});

test("the Admin internal route requires exact origin, a timely HMAC signature, and ignores unsigned owner claims", async (t) => {
  const routes = JSON.parse(readFileSync(new URL("../public/_routes.json", import.meta.url), "utf8"));
  assert.ok(routes.include.includes("/api/account-commerce/*"));
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_COMMUNITY_API_SECRET: BRIDGE_SECRET });
  await insertAccount(harness.authDb, "account-a", "Ada Account", "ada@example.test");
  const raw = JSON.stringify({ accountId: "account-a", input: {} });
  const unsigned = await accountCommerceRequest({ request: new Request(`${ADMIN_ORIGIN}/api/account-commerce/internal/overview`, { method: "POST", headers: { Origin: PUBLIC_ORIGIN, "Content-Type": "application/json" }, body: raw }), env });
  assert.equal(unsigned.status, 401);
  const signed = await signedInternalRequest("overview", raw);
  const response = await accountCommerceRequest({ request: signed, env });
  assert.equal(response.status, 200); assert.equal((await response.json()).linked, false);
  const wrongOrigin = await signedInternalRequest("overview", raw, "https://attacker.example");
  assert.equal((await accountCommerceRequest({ request: wrongOrigin, env })).status, 403);
});

async function insertAccount(db, id, displayName, email) {
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,'user','none','active',?,?,?,'test')")
    .bind(id, email, displayName, now, now, now).run();
}

async function insertHistoricalSnapshot(env, db, customerId) {
  await db.prepare("INSERT INTO commerce_orders (id,customer_id,environment,created_at,updated_at) VALUES ('ord_history_a',?,'test','2026-08-29','2026-08-29')").bind(customerId).run();
  await db.prepare(`INSERT INTO commerce_shipping_quotes
    (id,environment,cart_fingerprint,recipient_fingerprint,currency_code,shipping_strategy,provider,rate_options_json,created_at,expires_at)
    VALUES ('shq_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','test',? ,? ,'CAD','none',NULL,'[]','2026-08-29','2099-08-29')`)
    .bind("a".repeat(64), "b".repeat(64)).run();
  const snapshot = await encryptCommerceSecret(env, JSON.stringify({ name: HOME.recipientName, address1: HOME.address1, address2: HOME.address2, city: HOME.city, region: HOME.region, postalCode: HOME.postalCode, countryCode: HOME.countryCode, phone: HOME.phone }), "order-delivery:ord_history_a");
  await db.prepare(`INSERT INTO commerce_order_delivery_snapshots
    (order_id,recipient_ciphertext,destination_country_code,destination_region_code,shipping_strategy,provider,display_shipping_method,shipping_amount,currency_code,source_quote_id,quoted_at,created_at,updated_at)
    VALUES ('ord_history_a',?,'CA','ON','none',NULL,'No shipping required',0,'CAD','shq_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-29','2026-08-29','2026-08-29')`).bind(snapshot).run();
}

async function insertOrder(db, id, customerId, environment, amount, createdAt) {
  await db.prepare(`INSERT INTO commerce_products
    (id,source_provider,slug,title,currency_code,status,safe_metadata_json,created_at,updated_at)
    VALUES ('product-account-fixture','manual','account-fixture','Fixture Product','CAD','active','{}','2026-08-29','2026-08-29')
    ON CONFLICT(id) DO NOTHING`).run();
  await db.prepare(`INSERT INTO commerce_orders
    (id,customer_id,environment,checkout_status,payment_status,fulfillment_status,currency_code,customer_gross_amount,created_at,updated_at)
    VALUES (?,? ,? ,'checkout_created','paid','disabled','CAD',?,?,?)`).bind(id, customerId, environment, amount, createdAt, createdAt).run();
  await db.prepare(`INSERT INTO commerce_order_items
    (id,order_id,line_number,product_id,product_name,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,created_at)
    VALUES (?,?,1,'product-account-fixture','Fixture Product','CAD',?,1,?,0,?)`).bind(`item_${id}`, id, amount, amount, createdAt).run();
}

async function signedInternalRequest(route, raw, origin = PUBLIC_ORIGIN) {
  const pathname = `/api/account-commerce/internal/${route}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const signature = await hmacSha256(BRIDGE_SECRET, `${timestamp}\nPOST\n${pathname}\n${digest}`);
  return new Request(`${ADMIN_ORIGIN}${pathname}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-ThirdRailify-Timestamp": timestamp, "X-ThirdRailify-Signature": signature }, body: raw });
}
