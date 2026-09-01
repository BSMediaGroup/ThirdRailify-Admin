import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44222";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACTS = path.resolve(".artifacts/runtime-health-v2");

test("runtime pulse states, transitions, reduced motion, and responsive geometry remain truthful", async (t) => {
  await mkdir(ARTIFACTS, { recursive: true });
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44222"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());

  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }]) {
    await captureInitial(browser, viewport, "healthy", [runtime({ heartbeatAt: iso(0) })], "healthy", "rgb(85, 243, 160)");
    await captureInitial(browser, viewport, "catching-up", [runtime({ heartbeatAt: iso(0), pollLeaseActive: true, backlogMayBeTruncated: true })], "catching_up", "rgb(243, 201, 40)");
    await captureInitial(browser, viewport, "warning", [runtime({ heartbeatAt: iso(0), appliedRevision: 2 })], "warning", "rgb(255, 174, 66)");
    await captureInitial(browser, viewport, "offline", [runtime({ heartbeatAt: iso(0), state: "offline", ageSeconds: 240 })], "offline", "rgb(217, 66, 85)");

    const recovery = await openSequence(browser, viewport, [
      runtime({ heartbeatAt: iso(0), discordConnected: false }),
      runtime({ heartbeatAt: iso(1), discordConnected: true }),
    ]);
    await refresh(recovery);
    await expectTone(recovery.page, "recovering", "rgb(184, 150, 255)");
    await recovery.page.screenshot({ path: path.join(ARTIFACTS, `recovering-${viewport.width}x${viewport.height}.png`), fullPage: true });
    await recovery.context.close();

    const degradation = await openSequence(browser, viewport, [
      runtime({ heartbeatAt: iso(0), discordConnected: false }),
      runtime({ heartbeatAt: iso(240), discordConnected: false }),
    ]);
    await refresh(degradation);
    await expectTone(degradation.page, "degraded", "rgb(255, 101, 79)");
    assert.equal(await degradation.page.locator(".bot-heartbeat").getAttribute("data-heartbeat-state"), "healthy");
    assert.equal(await degradation.page.locator(".bot-heartbeat").getAttribute("data-provider-state"), "degraded");
    await degradation.page.screenshot({ path: path.join(ARTIFACTS, `degraded-discord-${viewport.width}x${viewport.height}.png`), fullPage: true });
    await degradation.context.close();
  }

  for (const viewport of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
    for (const [name, payload, tone] of [
      ["healthy", runtime({ heartbeatAt: iso(0) }), "healthy"],
      ["catching-up", runtime({ heartbeatAt: iso(0), pollLeaseActive: true, backlogMayBeTruncated: true }), "catching_up"],
    ]) {
      const opened = await openSequence(browser, viewport, [payload]);
      await expectTone(opened.page, tone);
      await assertGeometry(opened.page, viewport);
      await opened.page.screenshot({ path: path.join(ARTIFACTS, `${name}-${viewport.width}x${viewport.height}.png`), fullPage: true });
      await opened.context.close();
    }
    const stuck = await openSequence(browser, viewport, Array.from({ length: 6 }, (_, index) => runtime({ heartbeatAt: iso(index * 15), pollLeaseActive: true, errorCode: "TimeoutError", backoffSeconds: 30 })));
    for (let index = 1; index < 6; index += 1) await refresh(stuck);
    await expectTone(stuck.page, "degraded"); await assertGeometry(stuck.page, viewport);
    await stuck.page.screenshot({ path: path.join(ARTIFACTS, `degraded-${viewport.width}x${viewport.height}.png`), fullPage: true });
    await stuck.context.close();
  }

  await captureInitial(browser, { width: 768, height: 1024 }, "healthy", [runtime({ heartbeatAt: iso(0) })], "healthy", "rgb(85, 243, 160)");

  const burst = await openSequence(browser, { width: 1365, height: 768 }, [
    runtime({ heartbeatAt: iso(0), pollLeaseActive: true }),
    runtime({ heartbeatAt: iso(15), pollLeaseActive: true, backlogMayBeTruncated: true }),
    runtime({ heartbeatAt: iso(30), pollLeaseActive: true }),
  ]);
  await burst.page.locator(".bot-heartbeat").evaluate((node) => { node.dataset.identityProof = "same-node"; });
  await refresh(burst); await expectTone(burst.page, "catching_up");
  assert.equal(await burst.page.locator(".bot-heartbeat").getAttribute("data-identity-proof"), "same-node");
  await burst.page.screenshot({ path: path.join(ARTIFACTS, "short-poll-burst-catching-up-1365x768.png"), fullPage: true });
  await refresh(burst); await expectTone(burst.page, "healthy");
  assert.equal(await burst.page.locator(".bot-heartbeat").getAttribute("data-identity-proof"), "same-node");
  await burst.page.screenshot({ path: path.join(ARTIFACTS, "backlog-drained-healthy-1365x768.png"), fullPage: true });
  await burst.context.close();

  const restored = await openSequence(browser, { width: 1600, height: 900 }, [
    runtime({ heartbeatAt: iso(0), discordConnected: false }),
    runtime({ heartbeatAt: iso(240), discordConnected: false }),
    runtime({ heartbeatAt: iso(241), discordConnected: true }),
    runtime({ heartbeatAt: iso(256), discordConnected: true }),
  ]);
  await restored.page.locator(".bot-heartbeat").evaluate((node) => { node.dataset.identityProof = "same-node"; });
  await refresh(restored); await expectTone(restored.page, "degraded");
  await refresh(restored); await expectTone(restored.page, "recovering");
  await refresh(restored); await expectTone(restored.page, "healthy");
  assert.equal(await restored.page.locator(".bot-heartbeat").getAttribute("data-identity-proof"), "same-node");
  await restored.context.close();

  const reduced = await openSequence(browser, { width: 1024, height: 768 }, [runtime({ heartbeatAt: iso(0), pollLeaseActive: true, backlogMayBeTruncated: true })], "reduce");
  assert.equal(await reduced.page.locator(".bot-heartbeat__trace").evaluate((node) => getComputedStyle(node).animationName), "none");
  assert.equal(await reduced.page.locator(".bot-heartbeat__sweep").evaluate((node) => getComputedStyle(node).display), "none");
  assert.equal(await reduced.page.locator(".bot-heartbeat").getAttribute("data-heartbeat-tone"), "catching_up");
  await reduced.context.close();
});

async function captureInitial(browser, viewport, name, sequence, tone, color) {
  const opened = await openSequence(browser, viewport, sequence);
  await expectTone(opened.page, tone, color); await assertGeometry(opened.page, viewport);
  await opened.page.screenshot({ path: path.join(ARTIFACTS, `${name}-${viewport.width}x${viewport.height}.png`), fullPage: true });
  await opened.context.close();
}
async function openSequence(browser, viewport, sequence, reducedMotion = "no-preference") {
  let index = 0;
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage(); const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => respond(route, sequence[Math.min(index, sequence.length - 1)]));
  await page.goto(`${ORIGIN}/automations`); await page.getByRole("heading", { level: 1, name: "Automations" }).waitFor();
  assert.deepEqual(errors, []);
  return { context, page, advance: () => { index = Math.min(index + 1, sequence.length - 1); } };
}
async function respond(route, automation) {
  const requestPath = new URL(route.request().url()).pathname;
  if (requestPath === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: false, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: ORIGIN, adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (requestPath === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "health-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master", providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: iso(0), source: "test", locked: true } });
  if (requestPath === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { total: 0, goats: { total: 0 } } });
  if (requestPath === "/api/admin/automations") return json(route, automation);
  if (requestPath === "/api/admin/polls") return json(route, { ok: true, items: [], count: 0 });
  if (requestPath === "/api/admin/wheels" || requestPath === "/api/admin/wheels/stages") return json(route, { ok: true, items: [] });
  return json(route, { ok: false, error: "not_found" }, 404);
}
function runtime(overrides = {}) { return { ok: true, config: { desiredRevision: 3, desiredState: { rumble: { enabled: true, intervalSeconds: 120, pollIntervalSeconds: 15 } }, updatedAt: iso(0) }, runtime: { state: "online", botVersion: "1.1.0", heartbeatAt: iso(0), ageSeconds: 5, appliedRevision: 3, desiredRevision: 3, discordConnected: true, configSyncState: "synchronized", rumbleConfigured: true, providerState: "live", pollLeaseActive: false, pollingIntervalSeconds: 15, backlogMayBeTruncated: false, backoffSeconds: 0, ...overrides }, activePoll: null, deferred: { processControl: true, generalTriggerStudio: true, rants: true, wheelExecution: true }, activity: [] }; }
async function refresh(opened) { opened.advance(); const response = opened.page.waitForResponse((item) => new URL(item.url()).pathname === "/api/admin/automations"); await opened.page.getByRole("button", { name: "Refresh status" }).click(); await response; await opened.page.waitForTimeout(40); }
async function expectTone(page, tone, color) { const card = page.locator(".bot-heartbeat"); await card.waitFor(); assert.equal(await card.getAttribute("data-heartbeat-tone"), tone); if (color) { await page.waitForTimeout(900); assert.equal(await card.locator(".bot-heartbeat__identity strong").evaluate((node) => getComputedStyle(node).color), color); } }
async function assertGeometry(page, viewport) { const card = page.locator(".bot-heartbeat"); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `no page overflow at ${viewport.width}x${viewport.height}`); assert.equal(await card.locator(".bot-heartbeat__telemetry").evaluate((node) => node.getBoundingClientRect().right <= document.documentElement.clientWidth + 1), true, `metrics fit at ${viewport.width}x${viewport.height}`); assert.equal(await card.locator(".bot-heartbeat__signal svg").evaluate((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.right <= document.documentElement.clientWidth + 1; }), true, `pulse graph fits at ${viewport.width}x${viewport.height}`); }
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
function iso(offsetSeconds) { return new Date(Date.UTC(2026, 8, 1, 6, 0, offsetSeconds)).toISOString(); }
async function waitForServer() { for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite starts. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Vite runtime-health test server did not start."); }
