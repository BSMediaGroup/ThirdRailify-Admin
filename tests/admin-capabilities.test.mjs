import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ADMIN_CAPABILITIES,
  ADMIN_CAPABILITY_IDS,
  effectiveAdminAccess,
  requireAdminCapability,
} from "../functions/_shared/admin-capabilities.js";
import { createSession, resolveSession, sessionEnvelope } from "../functions/_shared/auth-core.js";
import { onRequest as rolePolicyHandler } from "../functions/api/admin/role-permissions/[[path]].js";
import { onRequest as accountsHandler } from "../functions/api/admin/accounts/[[path]].js";
import { onRequest as analyticsHandler } from "../functions/api/admin/analytics.js";
import { onRequest as wheelsHandler } from "../functions/api/admin/wheels/[[path]].js";
import { authEnvironment, cookiePair, createAuthDatabase, jsonRequest } from "./auth-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";

test("registered capabilities give Full Admin default parity while Master stays immutable and users stay blocked", async (t) => {
  const harness = await createAuthDatabase(); t.after(harness.dispose); const env = authEnvironment(harness.db);
  const { master, full, user } = await seedIdentities(env);
  const normal = ADMIN_CAPABILITIES.filter((item) => !item.masterOnly).map((item) => item.id);
  const masterAccess = await effectiveAdminAccess(env, master.row);
  const fullAccess = await effectiveAdminAccess(env, full.row);
  const userAccess = await effectiveAdminAccess(env, user.row);
  assert.deepEqual(new Set(masterAccess.capabilities), new Set(ADMIN_CAPABILITY_IDS));
  assert.deepEqual(new Set(fullAccess.capabilities), new Set(normal));
  assert.equal(fullAccess.capabilities.includes("role_permissions.view"), true);
  assert.equal(fullAccess.capabilities.includes("role_permissions.manage"), false);
  assert.deepEqual(userAccess.capabilities, []);
  for (const capability of normal) await requireAdminCapability(env, full.session, capability);
  await assert.rejects(requireAdminCapability(env, full.session, "role_permissions.manage"), (error) => error.code === "admin_capability_restricted");
  await assert.rejects(requireAdminCapability(env, full.session, "made.up.capability"), (error) => error.code === "unknown_admin_capability");
});

test("role policy API is readable by Full Admin, mutable only by Master, audited, fresh, and resettable", async (t) => {
  const harness = await createAuthDatabase(); t.after(harness.dispose); const env = authEnvironment(harness.db);
  const { master, full, user } = await seedIdentities(env);

  assert.equal((await invoke(env, master, "OPTIONS")).status, 204);
  assert.equal((await invoke(env, full, "GET")).status, 200);
  assert.equal((await invoke(env, user, "GET")).status, 403);
  assert.equal((await invoke(env, full, "PUT", { targetRole: "full", deniedCapabilities: ["wheels.manage"] })).status, 403);
  assert.equal((await invoke(env, full, "POST", { confirmation: "RESET FULL ADMIN PERMISSIONS" }, "reset")).status, 403);
  assert.equal((await invoke(env, master, "PUT", { targetRole: "full", deniedCapabilities: ["wheels.manage"] }, "", false)).status, 403);
  assert.equal((await invoke(env, master, "PUT", { targetRole: "master", deniedCapabilities: [] })).status, 400);
  assert.equal((await invoke(env, master, "PUT", { targetRole: "full", deniedCapabilities: ["unknown.scope"] })).status, 400);
  assert.equal((await invoke(env, master, "PUT", { targetRole: "full", deniedCapabilities: ["role_permissions.manage"] })).status, 400);

  const savedResponse = await invoke(env, master, "PUT", { targetRole: "full", deniedCapabilities: ["analytics.view", "users.manage", "wheels.manage"] });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.deepEqual(saved.deniedCapabilities, ["analytics.view", "users.manage", "wheels.manage"]);
  assert.equal(saved.capabilities.find((item) => item.id === "wheels.view").effective, true);
  assert.equal(saved.capabilities.find((item) => item.id === "wheels.manage").state, "restricted");
  assert.equal(saved.capabilities.find((item) => item.id === "role_permissions.manage").state, "master_only");

  const freshFull = await resolveSession(env, new Request(`${ADMIN_ORIGIN}/api/auth/session`, { headers: { Cookie: full.cookie } }));
  await requireAdminCapability(env, freshFull, "wheels.view");
  await assert.rejects(requireAdminCapability(env, freshFull, "wheels.manage"), (error) => error.code === "admin_capability_restricted");
  await requireAdminCapability(env, master.session, "wheels.manage");
  const envelope = await sessionEnvelope(env, freshFull);
  assert.equal(envelope.access.capabilities.includes("analytics.view"), false);
  assert.equal(envelope.access.capabilities.includes("role_permissions.view"), true);

  const audit = await harness.db.prepare("SELECT event_type,metadata_json FROM auth_audit WHERE event_type='full_admin_capability_policy_changed' ORDER BY created_at").all();
  assert.equal(audit.results.length, 3);
  assert.equal(audit.results.every((row) => JSON.parse(row.metadata_json).previousEffective === true && JSON.parse(row.metadata_json).newEffective === false), true);

  const resetResponse = await invoke(env, master, "POST", { confirmation: "RESET FULL ADMIN PERMISSIONS" }, "reset");
  assert.equal(resetResponse.status, 200);
  const reset = await resetResponse.json();
  assert.deepEqual(reset.deniedCapabilities, []);
  const restored = await resolveSession(env, new Request(`${ADMIN_ORIGIN}/api/auth/session`, { headers: { Cookie: full.cookie } }));
  await requireAdminCapability(env, restored, "wheels.manage");
});

test("denied domain capabilities block direct APIs and forged client capability input", async (t) => {
  const harness = await createAuthDatabase(); t.after(harness.dispose); const env = authEnvironment(harness.db);
  const { master, full } = await seedIdentities(env);
  const policy = await invoke(env, master, "PUT", { targetRole: "full", deniedCapabilities: ["analytics.view", "users.manage", "wheels.manage"] });
  assert.equal(policy.status, 200);

  const analytics = await analyticsHandler({ request: new Request(`${ADMIN_ORIGIN}/api/admin/analytics`, { headers: { Cookie: full.cookie } }), env });
  assert.equal(analytics.status, 403);
  assert.equal((await analytics.json()).error, "admin_capability_restricted");

  const accountMutation = jsonRequest(`${ADMIN_ORIGIN}/api/admin/accounts/policy-user/disable`, { method: "POST", origin: ADMIN_ORIGIN, cookie: full.cookie, csrfToken: full.csrfToken, body: { capabilities: ["users.manage"] } });
  const accountResponse = await accountsHandler({ request: accountMutation, env });
  assert.equal(accountResponse.status, 403);
  assert.equal((await accountResponse.json()).error, "admin_capability_restricted");

  const wheelMutation = jsonRequest(`${ADMIN_ORIGIN}/api/admin/wheels/controls`, { method: "POST", origin: ADMIN_ORIGIN, cookie: full.cookie, csrfToken: full.csrfToken, body: { wheelId: "forged", action: "archive", capabilities: ["wheels.manage"] } });
  const wheelResponse = await wheelsHandler({ request: wheelMutation, env });
  assert.equal(wheelResponse.status, 403);
  assert.equal((await wheelResponse.json()).error, "admin_capability_restricted");
});

test("Admin routes and client identifiers remain covered by the canonical server registry", async () => {
  const [navigation, clientCapabilities, app, banner, analytics, inbox, goats, wheels, accounts, watch, status, commerce] = await Promise.all([
    readFile(new URL("../src/config/navigation.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/auth/capabilities.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    ...["banner.js", "analytics.js", "inbox/[[path]].js", "goats/[[path]].js", "wheels/[[path]].js", "accounts/[[path]].js", "watch.js", "status.js", "commerce/[[path]].js"].map((path) => readFile(new URL(`../functions/api/admin/${path}`, import.meta.url), "utf8")),
  ]);
  const serverIds = new Set(ADMIN_CAPABILITY_IDS);
  const clientIds = new Set([...clientCapabilities.matchAll(/"([a-z_]+(?:\.[a-z_]+)+)"/g)].map((match) => match[1]));
  assert.deepEqual(clientIds, serverIds, "client presentation identifiers must match the server registry exactly");
  const navPaths = new Set([...navigation.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]));
  for (const path of navPaths) assert.match(clientCapabilities, new RegExp(`"${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `${path} needs a route policy`);
  for (const source of [banner, analytics, inbox, goats, wheels, accounts, watch, status]) assert.match(source, /requireAdminCapability/, "every non-Commerce Admin API must use the canonical guard");
  assert.match(commerce, /requireCommerceCapability/);
  assert.match(app, /AdminCapabilityBoundary/);
});

async function seedIdentities(env) {
  const master = await seedIdentity(env, "policy-master", "Policy Master", "master");
  const full = await seedIdentity(env, "policy-full", "Policy Full", "full");
  const user = await seedIdentity(env, "policy-user", "Policy User", "none", "user");
  return { master, full, user };
}

async function seedIdentity(env, id, displayName, adminLevel, role = "admin") {
  const timestamp = new Date().toISOString();
  await env.THIRDRAILIFY_AUTH_DB.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,'test')")
    .bind(id, `${id}@example.test`, displayName, role, adminLevel, timestamp, timestamp, timestamp).run();
  const row = await env.THIRDRAILIFY_AUTH_DB.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
  const created = await createSession(env, new Request(ADMIN_ORIGIN), row, ADMIN_ORIGIN);
  return { row: created.account, session: { ...created.session, account: created.account }, cookie: cookiePair(created.cookie), csrfToken: created.csrfToken };
}

async function invoke(env, identity, method, body, suffix = "", includeCsrf = true) {
  const url = `${ADMIN_ORIGIN}/api/admin/role-permissions${suffix ? `/${suffix}` : ""}`;
  const request = method === "GET" ? new Request(url, { headers: { Cookie: identity.cookie } }) : jsonRequest(url, { method, origin: ADMIN_ORIGIN, cookie: identity.cookie, csrfToken: includeCsrf ? identity.csrfToken : undefined, body });
  return rolePolicyHandler({ request, env });
}
