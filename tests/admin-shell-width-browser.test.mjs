import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { chromium } from "playwright-core";

const LOCAL_ORIGIN = "http://127.0.0.1:44214";
const ORIGIN = (process.env.ADMIN_SHELL_ORIGIN || LOCAL_ORIGIN).replace(/\/$/, "");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PREVIOUS_NARROW_CAP = 1240;
const ADMIN_PAGE_MAX = 1720;
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1600, height: 900 },
  { width: 1440, height: 900 },
  { width: 1365, height: 768 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

test("Admin page width uses the shared premium-dashboard cap without viewport overflow", async (t) => {
  if (ORIGIN === LOCAL_ORIGIN) {
    const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44214"], { stdio: "ignore" });
    t.after(() => server.kill());
    await waitForServer();
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", respond);
    await page.goto(`${ORIGIN}/customers`);
    await page.getByRole("heading", { level: 1, name: "Customers" }).waitFor();
    await page.getByText("Geometry Fixture", { exact: true }).waitFor();

    const geometry = await shellGeometry(page);
    const expectedWorkspaceWidth = viewport.width > 820 ? viewport.width - geometry.sidebarWidth : viewport.width;
    const expectedMainWidth = Math.min(ADMIN_PAGE_MAX, expectedWorkspaceWidth);
    assert.equal(geometry.pageMax, `${ADMIN_PAGE_MAX}px`, "the global page-width token is the rendered authority");
    assert.ok(Math.abs(geometry.workspaceWidth - expectedWorkspaceWidth) <= 1, `workspace accounts for the unchanged sidebar at ${viewport.width}px: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.mainWidth - expectedMainWidth) <= 1, `main width is fluid up to the shared cap at ${viewport.width}px: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.outerLeftGutter - geometry.outerRightGutter) <= 1, `capped main remains centred at ${viewport.width}px: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.paddingLeft >= 17 && geometry.paddingRight >= 17, `responsive content gutters remain intentional at ${viewport.width}px: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.contentWidth > 0, `content remains usable at ${viewport.width}px: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.hasViewportOverflow, false, `shell has no viewport overflow at ${viewport.width}px`);
    assert.deepEqual(errors, [], `shell has no page errors at ${viewport.width}px`);
    t.diagnostic(`${viewport.width}x${viewport.height} ${JSON.stringify(geometry)}`);

    if (viewport.width === 1920) {
      assert.ok(geometry.mainWidth >= PREVIOUS_NARROW_CAP + 300, `expanded desktop is materially wider than the previous ${PREVIOUS_NARROW_CAP}px cap`);
      assert.ok(geometry.contentWidth >= 1500, `expanded desktop provides materially more usable content width: ${JSON.stringify(geometry)}`);
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await page.waitForTimeout(250);
      const collapsed = await shellGeometry(page);
      assert.ok(Math.abs(collapsed.mainWidth - ADMIN_PAGE_MAX) <= 1, `collapsed-sidebar workspace reaches the ${ADMIN_PAGE_MAX}px ultrawide cap: ${JSON.stringify(collapsed)}`);
      assert.ok(collapsed.outerLeftGutter >= 50 && collapsed.outerRightGutter >= 50, `the capped workspace retains deliberate outer gutters: ${JSON.stringify(collapsed)}`);
      assert.equal(collapsed.hasViewportOverflow, false);
      t.diagnostic(`${viewport.width}x${viewport.height} collapsed ${JSON.stringify(collapsed)}`);
    }
    await context.close();
  }
});

async function shellGeometry(page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector("#admin-sidebar");
    const workspace = document.querySelector(".admin-workspace");
    const main = document.querySelector("#admin-main");
    if (!(sidebar instanceof HTMLElement) || !(workspace instanceof HTMLElement) || !(main instanceof HTMLElement)) throw new Error("Admin shell geometry is unavailable");
    const sidebarBox = sidebar.getBoundingClientRect();
    const workspaceBox = workspace.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    const mainStyle = getComputedStyle(main);
    return {
      viewportWidth: document.documentElement.clientWidth,
      sidebarWidth: sidebarBox.width,
      workspaceWidth: workspaceBox.width,
      mainWidth: mainBox.width,
      contentWidth: mainBox.width - parseFloat(mainStyle.paddingLeft) - parseFloat(mainStyle.paddingRight),
      paddingLeft: parseFloat(mainStyle.paddingLeft),
      paddingRight: parseFloat(mainStyle.paddingRight),
      outerLeftGutter: mainBox.left - workspaceBox.left,
      outerRightGutter: workspaceBox.right - mainBox.right,
      pageMax: getComputedStyle(document.documentElement).getPropertyValue("--admin-page-max").trim(),
      hasViewportOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

async function respond(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (pathname === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "shell-width-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-30T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } });
  if (pathname === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  if (pathname === "/api/admin/commerce/customers") return json(route, customerPayload());
  return json(route, { ok: false, error: "not_found" }, 404);
}

function customerPayload() {
  return {
    ok: true,
    databaseConfigured: true,
    authority: "THIRDRAILIFY_COMMERCE_DB",
    access: { canView: true },
    customers: [{ id: "cst_geometry_fixture", kind: "guest", contact: { name: "Geometry Fixture", email: "geometry@example.test" }, account: null, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", revision: 1, summary: { orderCount: 1, paidOrderCount: 1, liveOrderCount: 0, testOrderCount: 1, livePaidOrderCount: 0, testPaidOrderCount: 1, liveSpendAmount: 0, testSpendAmount: 2500, currencyCode: "CAD", firstOrderAt: "2026-08-30T00:00:00.000Z", lastOrderAt: "2026-08-30T00:00:00.000Z" } }],
    page: 1,
    pageSize: 20,
    totalMatching: 1,
    totalPages: 1,
    startIndex: 1,
    endIndex: 1,
    filters: { page: 1, pageSize: 20, query: "", type: "all", environment: "all", purchase: "any", sort: "latest_order" },
  };
}

function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Admin shell-width browser server did not start.");
}
