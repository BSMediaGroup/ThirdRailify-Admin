import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44209";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const capabilities = [
  ["overview.view", "overview", "View Overview"], ["analytics.view", "analytics", "View audience analytics"],
  ["inbox.view", "inbox", "View Admin Inbox"], ["inbox.manage", "inbox", "Manage Admin Inbox"],
  ["watch.view", "watch", "View Watch archive"], ["watch.manage", "watch", "Manage Watch archive"],
  ["content.view", "content", "View site content"], ["content.manage", "content", "Manage site content"],
  ["commerce.view", "commerce", "View shop and commerce"], ["commerce.catalogue.manage", "commerce", "Manage products and collections"],
  ["commerce.business.manage", "commerce", "Manage business and tax"], ["commerce.payments.manage", "commerce", "Manage payments"],
  ["commerce.integrations.manage", "commerce", "Manage commerce integrations"], ["commerce.templates.manage", "commerce", "Manage customer documents and emails"],
  ["commerce.operations.manage", "commerce", "Manage commerce operations"], ["wheels.view", "wheels", "View Wheels"],
  ["wheels.manage", "wheels", "Manage Wheels"], ["media.view", "media", "View media"],
  ["goats.view", "goats", "View GOATS"], ["goats.manage", "goats", "Manage GOATS"],
  ["membership.view", "membership", "View VIP and membership"],
  ["users.view", "users", "View users and access"], ["users.manage", "users", "Manage users and access"],
  ["integrations.view", "integrations", "View integrations"],
  ["settings.view", "settings", "View settings"], ["settings.manage", "settings", "Manage settings"],
  ["role_permissions.view", "role_permissions", "View role permissions"], ["role_permissions.manage", "role_permissions", "Manage role permissions"],
];
const groups = [...new Set(capabilities.map((item) => item[1]))].map((id) => ({ id, label: id === "role_permissions" ? "Role Permissions & Scopes" : id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), description: `Effective ${id.replaceAll("_", " ")} authority.` }));
const allIds = capabilities.map((item) => item[0]);

test("Role Permissions & Scopes is editable by Master and inspectable read-only by Full Admin", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44209"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());

  let denied = [];
  const writes = [];
  const masterContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const masterPage = await masterContext.newPage();
  await masterPage.route("**/api/**", (route) => fixture(route, "master", denied, (next, method) => { denied = next; writes.push({ method, denied: [...next] }); }));
  await masterPage.goto(`${ORIGIN}/settings`);
  await masterPage.getByRole("heading", { level: 2, name: "Role Permissions & Scopes" }).waitFor();
  assert.equal(await masterPage.locator(".permission-group").count(), groups.length);
  const wheelsManage = masterPage.locator('input[aria-label^="Manage Wheels:"]');
  assert.equal(await wheelsManage.isEnabled(), true);
  assert.equal(await wheelsManage.isChecked(), true);
  const immutable = masterPage.locator('input[aria-label^="Manage role permissions:"]');
  assert.equal(await immutable.isDisabled(), true);
  assert.match(await immutable.getAttribute("aria-label"), /Master only/);
  await wheelsManage.click();
  await masterPage.getByText("Unsaved permission changes", { exact: true }).waitFor();
  await masterPage.getByRole("button", { name: "Apply policy" }).click();
  await masterPage.getByText("Full Admin permission policy saved.", { exact: true }).waitFor();
  assert.deepEqual(writes[0], { method: "PUT", denied: ["wheels.manage"] });
  assert.match(await wheelsManage.getAttribute("aria-label"), /Restricted/);
  masterPage.once("dialog", (dialog) => dialog.accept());
  await masterPage.getByRole("button", { name: "Reset to defaults" }).click();
  await masterPage.getByText("Full Admin default access restored.", { exact: true }).waitFor();
  assert.deepEqual(writes[1], { method: "POST", denied: [] });
  assert.equal(await masterPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await masterContext.close();

  denied = ["analytics.view", "settings.manage", "users.manage", "wheels.manage"];
  const fullContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const fullPage = await fullContext.newPage();
  await fullPage.route("**/api/**", (route) => fixture(route, "full", denied, () => { throw new Error("Full Admin attempted a policy mutation"); }));
  await fullPage.goto(`${ORIGIN}/settings`);
  await fullPage.getByRole("heading", { level: 2, name: "Role Permissions & Scopes" }).waitFor();
  assert.equal(await fullPage.getByText("Permission policy is managed by Master Admin.", { exact: true }).count(), 1);
  assert.equal(await fullPage.locator(".permission-row input:not(:disabled)").count(), 0);
  assert.equal(await fullPage.getByRole("button", { name: "Apply policy" }).count(), 0);
  assert.equal(await fullPage.getByRole("button", { name: "Reset to defaults" }).count(), 0);
  assert.equal(await fullPage.locator('.permission-state.is-restricted').count(), 4);
  assert.equal(await fullPage.getByText("Read-only access", { exact: true }).count(), 1, "settings.manage denial leaves Settings and policy inspection available");
  await fullPage.goto(`${ORIGIN}/analytics`);
  await fullPage.getByRole("heading", { level: 1, name: "Access restricted" }).waitFor();
  assert.equal(await fullPage.locator('.primary-nav a[href="/analytics"]').count(), 0, "analytics.view denial removes the destination from navigation");
  await fullPage.goto(`${ORIGIN}/access`);
  await fullPage.locator(".capability-readonly-callout strong", { hasText: "Read-only access" }).waitFor();
  assert.equal(await fullPage.locator(".capability-readonly-surface:disabled").count(), 1, "users.manage denial keeps the account workspace read-only");
  await fullPage.goto(`${ORIGIN}/wheels`);
  await fullPage.locator(".capability-readonly-callout strong", { hasText: "Read-only access" }).waitFor();
  assert.equal(await fullPage.locator(".capability-readonly-surface:disabled").count(), 1, "wheels.manage denial keeps Wheels inspectable and disables its controls");
  assert.equal(await fullPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await fullContext.close();
});

async function fixture(route, role, denied, write) {
  const request = route.request(); const pathname = new URL(request.url()).pathname;
  if (pathname === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.com", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (pathname === "/api/auth/session") return json(route, session(role, denied));
  if (pathname === "/api/admin/role-permissions") {
    if (request.method() === "PUT") { const body = request.postDataJSON(); write(body.deniedCapabilities, "PUT"); return json(route, policy(role, body.deniedCapabilities)); }
    return json(route, policy(role, denied));
  }
  if (pathname === "/api/admin/role-permissions/reset") { write([], "POST"); return json(route, policy(role, [])); }
  if (pathname === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  return json(route, { ok: false, error: "fixture_unavailable", message: "Settings authority unavailable in this focused test." }, 503);
}

function session(role, denied = []) {
  const master = role === "master";
  const effective = master ? allIds : allIds.filter((id) => id !== "role_permissions.manage" && !denied.includes(id));
  return { ok: true, authenticated: true, csrfToken: "policy-csrf", access: { isAdmin: true, isMasterAdmin: master, capabilities: effective }, account: { id: role, email: `${role}@example.test`, displayName: master ? "Master Admin" : "Full Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: role, status: "active", emailVerified: true, createdAt: "2026-08-31T00:00:00Z", lastLoginAt: null, source: "test", locked: master } };
}

function policy(role, denied) {
  const master = role === "master";
  return { ok: true, targetRole: "full", access: session(role, denied).access, groups, deniedCapabilities: denied, restrictedCount: denied.length, canManage: master, checkedAt: "2026-08-31T00:00:00Z", capabilities: capabilities.map(([id, group, label]) => { const masterOnly = id === "role_permissions.manage"; const mutable = !id.startsWith("role_permissions."); const restricted = denied.includes(id); return { id, group, label, description: `${label} through server-owned authority.`, mutable, masterOnly, effective: !masterOnly && !restricted, state: masterOnly ? "master_only" : !mutable ? "required" : restricted ? "restricted" : "default" }; }) };
}

function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Role-policy browser server did not start."); }
