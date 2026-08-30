import assert from "node:assert/strict";
import test from "node:test";
import {
  accountInboxMessages,
  mutateAccountInbox,
} from "../functions/_shared/account-commerce.js";
import {
  ANALYTICS_REQUIRED_COLUMNS,
  analyticsReport,
  analyticsSchemaState,
  delta,
  ingestAnalyticsEvent,
  normalizePublicPath,
  periodStarts,
} from "../functions/_shared/analytics.js";
import {
  createSession,
  ensureEnvironmentMasters,
  loadAccountByEmail,
} from "../functions/_shared/auth-core.js";
import {
  adminInboxMessages,
  mutateAdminInboxMessages,
} from "../functions/_shared/admin-inbox.js";
import { onRequest as analyticsRead } from "../functions/api/admin/analytics.js";
import {
  commerceEnvironment,
  createCommerceDatabases,
} from "./commerce-test-helpers.mjs";
import { cookiePair } from "./auth-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";

test("migration 0024 persists privacy-minimized idempotent events and valid comparison boundaries", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  const env = commerceEnvironment(harness, {
    THIRDRAILIFY_ANALYTICS_INGEST_SECRET: "fixture-secret",
  });
  const now = new Date("2026-08-30T12:00:00.000Z");
  const event = {
    id: "event_1234567890abcdef",
    eventType: "page_view",
    occurredAt: "2026-08-30T11:00:00.000Z",
    sessionId: "session_1234567890abcdef",
    path: "/watch?unsafe=1",
    pageType: "watch",
    referrerHost: "search.example",
    sourceCategory: "search",
    countryCode: "AU",
    countryName: "Australia",
    regionCode: "NSW",
    regionName: "New South Wales",
    city: "Sydney",
    latitude: -33.86,
    longitude: 151.21,
    deviceClass: "mobile",
    browserFamily: "Safari",
    platformFamily: "iOS",
    visitorClass: "guest",
    metadata: { campaignSource: "fixture" },
  };
  assert.equal((await ingestAnalyticsEvent(env, event)).accepted, true);
  assert.equal((await ingestAnalyticsEvent(env, event)).accepted, false);
  const stored = await harness.commerceDb
    .prepare("SELECT * FROM analytics_events")
    .first();
  assert.equal(stored.public_path, "/watch");
  assert.equal(stored.latitude, -33.9);
  assert.doesNotMatch(JSON.stringify(stored), /ip|email|cookie|authorization/i);
  assert.deepEqual(await analyticsSchemaState(harness.commerceDb), { compatible: true, tablePresent: true, missingColumns: [] });
  const indexes = (await harness.commerceDb.prepare("PRAGMA index_list('analytics_events')").all()).results.map((row) => row.name);
  for (const index of ["idx_analytics_events_occurred", "idx_analytics_events_session", "idx_analytics_events_path", "idx_analytics_events_geo"]) assert.ok(indexes.includes(index));
  await harness.commerceDb.prepare(`INSERT INTO commerce_orders
    (id,environment,checkout_status,payment_status,fulfillment_status,currency_code,customer_gross_amount,refund_amount,created_at,updated_at)
    VALUES('ord_analytics_live','live','checkout_created','partially_refunded','fulfilled','CAD',10000,1200,'2026-08-30T10:00:00.000Z','2026-08-30T10:00:00.000Z')`).run();
  await harness.commerceDb.prepare(`INSERT INTO commerce_donations
    (id,request_id,request_digest,environment,currency_code,amount_minor,status,created_at,updated_at)
    VALUES(?,?,?,'live','CAD',2500,'completed','2026-08-30T10:30:00.000Z','2026-08-30T10:30:00.000Z')`)
    .bind(`don_${"a".repeat(40)}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "b".repeat(64)).run();
  const report = await analyticsReport(env, "24h", now);
  assert.equal(report.windows["24h"].views, 1);
  assert.equal(report.windows["24h"].sessions, 1);
  assert.equal(report.windows["24h"].comparisonComplete, false);
  assert.equal(report.geography[0].city, "Sydney");
  assert.equal("sessionId" in report.geography[0], false);
  assert.deepEqual(report.revenue.currencies[0].windows["24h"], { merchandise: 10000, donations: 2500, gross: 12500, refunded: 1200, net: 11300 });
  assert.equal(report.revenue.profitAvailable, false);
  assert.deepEqual(periodStarts(now), {
    current24: "2026-08-29T12:00:00.000Z",
    previous24: "2026-08-28T12:00:00.000Z",
    current7: "2026-08-23T12:00:00.000Z",
    previous7: "2026-08-16T12:00:00.000Z",
    current30: "2026-07-31T12:00:00.000Z",
    previous30: "2026-07-01T12:00:00.000Z",
    current90: "2026-06-01T12:00:00.000Z",
    previous90: "2026-03-03T12:00:00.000Z",
  });
  assert.deepEqual(delta(5, 0, true), {
    available: true,
    value: null,
    direction: "new",
  });
  assert.equal(delta(0, 0, true).value, 0);
  assert.equal(delta(5, 2, false).available, false);
  assert.equal(
    normalizePublicPath("/shop/item?token=unsafe#fragment"),
    "/shop/item",
  );
  assert.throws(
    () => normalizePublicPath("/api/private"),
    (error) => error.code === "analytics_path_invalid",
  );
});

test("account and Admin inbox controls are recipient-scoped, reversible, bulk-capable, and soft-delete", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  await insertAccount(harness.authDb, "account-fixture");
  await harness.commerceDb
    .prepare(
      "INSERT INTO account_inbox_messages(id,account_id,category,source_type,source_id,title,preview,body_text,action_url,action_label,detail_json,created_at) VALUES('message_1234567890abcdef','account-fixture','orders','order','ord_fixture','Order update','Your order changed.','The complete customer-safe order status is now available.','/account/orders/ord_fixture','View order','{\"status\":\"paid\"}','2026-08-30T10:00:00.000Z')",
    )
    .run();
  let inbox = await accountInboxMessages(env, "account-fixture");
  assert.equal(inbox.unread, 1);
  assert.equal(inbox.items[0].details.status, "paid");
  await mutateAccountInbox(env, "account-fixture", {
    ids: [inbox.items[0].id],
    action: "read",
  });
  inbox = await accountInboxMessages(env, "account-fixture");
  assert.equal(inbox.unread, 0);
  await mutateAccountInbox(env, "account-fixture", {
    ids: [inbox.items[0].id],
    action: "unread",
  });
  assert.equal((await accountInboxMessages(env, "account-fixture")).unread, 1);
  await mutateAccountInbox(env, "account-fixture", {
    ids: [inbox.items[0].id],
    action: "delete",
  });
  assert.equal((await accountInboxMessages(env, "account-fixture")).total, 0);
  const admin = (await adminInboxMessages(env, "admin-fixture")).items[0];
  if (admin) {
    await mutateAdminInboxMessages(env, "admin-fixture", {
      ids: [admin.id],
      action: "read",
    });
    assert.equal(
      (await adminInboxMessages(env, "admin-fixture")).items[0].unread,
      false,
    );
    await mutateAdminInboxMessages(env, "admin-fixture", {
      ids: [admin.id],
      action: "unread",
    });
    assert.equal(
      (await adminInboxMessages(env, "admin-fixture")).items[0].unread,
      true,
    );
    await mutateAdminInboxMessages(env, "admin-fixture", {
      ids: [admin.id],
      action: "delete",
    });
    assert.equal(
      (await adminInboxMessages(env, "admin-fixture")).items.some(
        (item) => item.id === admin.id,
      ),
      false,
    );
  }
  assert.deepEqual(
    (await harness.commerceDb.prepare("PRAGMA foreign_key_check").all())
      .results,
    [],
  );
});

test("analytics read endpoint remains unavailable without an authenticated Admin session", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const response = await analyticsRead({
    request: new Request(
      "https://thirdrailify-admin.pages.dev/api/admin/analytics?range=7d",
    ),
    env,
  });
  assert.equal(response.status, 401);
});

test("analytics schema one migration behind returns an explicit migration-required response instead of false zero traffic", async (t) => {
  const harness = await createCommerceDatabases({ commerceMigrationCount: 23 });
  t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const schema = await analyticsSchemaState(harness.commerceDb);
  assert.equal(schema.compatible, false);
  assert.equal(schema.tablePresent, false);
  assert.deepEqual(schema.missingColumns, ANALYTICS_REQUIRED_COLUMNS);
  await assert.rejects(analyticsReport(env, "7d"), (error) => error.status === 503 && error.code === "analytics_migration_required");
  const cookie = await adminCookie(env);
  const response = await analyticsRead({ request: new Request(`${ADMIN_ORIGIN}/api/admin/analytics?range=7d`, { headers: { Cookie: cookie } }), env });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "analytics_migration_required", message: "Analytics database migration required." });
});

test("analytics compatibility rejects a present table with a missing required column before report queries", async (t) => {
  const harness = await createCommerceDatabases({ commerceMigrationCount: 23 });
  t.after(harness.dispose);
  const columns = ANALYTICS_REQUIRED_COLUMNS.filter((column) => column !== "visitor_class");
  await harness.commerceDb.prepare(`CREATE TABLE analytics_events (${columns.map((column) => `${column} TEXT`).join(",")})`).run();
  const state = await analyticsSchemaState(harness.commerceDb);
  assert.equal(state.tablePresent, true);
  assert.deepEqual(state.missingColumns, ["visitor_class"]);
  await assert.rejects(analyticsReport(commerceEnvironment(harness), "7d"), (error) => error.code === "analytics_migration_required");
});

test("empty compatible analytics storage is a truthful zero-event report and malformed ranges are rejected", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const report = await analyticsReport(env, "24h", new Date("2026-08-30T12:00:00.000Z"));
  assert.equal(report.coverage.totalEvents, 0);
  assert.equal(report.windows["24h"].views, 0);
  assert.equal(report.revenue.available, true);
  await assert.rejects(analyticsReport(env, "lifetime"), (error) => error.status === 400 && error.code === "analytics_range_invalid");
  const cookie = await adminCookie(env);
  const response = await analyticsRead({ request: new Request(`${ADMIN_ORIGIN}/api/admin/analytics?range=lifetime`, { headers: { Cookie: cookie } }), env });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "analytics_range_invalid");
});

test("commerce revenue failure remains isolated from audience reporting", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(harness.dispose);
  const db = harness.commerceDb;
  const failingCommerceDb = {
    prepare(sql) {
      if (/FROM commerce_(?:orders|donations)/.test(String(sql))) return { bind() { return this; }, all() { return Promise.reject(new Error("fixture commerce reporting failure")); } };
      return db.prepare(sql);
    },
  };
  const report = await analyticsReport(commerceEnvironment(harness, { THIRDRAILIFY_COMMERCE_DB: failingCommerceDb }), "7d", new Date("2026-08-30T12:00:00.000Z"));
  assert.equal(report.ok, true);
  assert.equal(report.coverage.totalEvents, 0);
  assert.equal(report.revenue.available, false);
  assert.equal(report.revenue.currencies.length, 0);
});

async function insertAccount(db, id) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES(?,?,?,'user','none','active',?,?,?,'test')",
    )
    .bind(id, `${id}@example.test`, "Inbox Fixture", now, now, now)
    .run();
}

async function adminCookie(env) {
  await ensureEnvironmentMasters(env);
  const account = await loadAccountByEmail(env, env.ADMIN_EMAIL_1);
  const session = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), account, ADMIN_ORIGIN);
  return cookiePair(session.cookie);
}
