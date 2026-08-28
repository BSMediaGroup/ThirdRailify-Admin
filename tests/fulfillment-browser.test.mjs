import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { chromium } from "playwright-core";

const PREVIEW_ORIGIN = "http://127.0.0.1:4174";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("a running Printful migration remains checkpointed until an explicit authenticated continuation", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "4174"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForPreview();
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(() => browser.close());

  for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    let continuationCalls = 0;
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/auth/config") return json(route, authConfig());
      if (path === "/api/auth/session") return json(route, session());
      if (path === "/api/admin/commerce/overview") return json(route, overview());
      if (path === "/api/admin/commerce/printful/catalogue/migration") return json(route, migration("running"));
      if (path === "/api/admin/commerce/printful/catalogue/migrate") {
        continuationCalls += 1;
        assert.equal(request.method(), "POST");
        assert.equal(request.headers()["x-csrf-token"], "browser-fixture-csrf");
        assert.deepEqual(JSON.parse(request.postData() || "{}"), { action: "continue_permanent_printful_migration" });
        return json(route, migration("completed_with_blocked_products"));
      }
      return json(route, { ok: false, error: "not_found" }, 404);
    });

    await page.goto(`${PREVIEW_ORIGIN}/commerce/fulfillment`);
    await page.getByRole("heading", { level: 1, name: "Fulfillment integrations" }).waitFor();
    const button = page.getByRole("button", { name: "CONTINUE PERMANENT PRINTFUL MIGRATION FROM CHECKPOINT" });
    await button.waitFor();
    await page.waitForTimeout(300);
    assert.equal(continuationCalls, 0, "opening the checkpoint page must not resume provider writes");
    assert.equal(await page.getByText("PERMANENT MIGRATION — CHECKPOINTED", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await button.click();
    await page.getByText("CATALOGUE MIGRATED WITH BLOCKED PRODUCTS RECORDED", { exact: true }).waitFor();
    assert.equal(continuationCalls, 1);
    assert.equal(await page.getByRole("button", { name: /PERMANENT PRINTFUL MIGRATION/ }).count(), 0, "terminal migrations expose no misleading continuation control");
    assert.deepEqual(consoleErrors, []);
    await context.close();
  }
});

async function waitForPreview() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(PREVIEW_ORIGIN)).ok) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vite preview did not start.");
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function authConfig() {
  return { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: "https://thirdrailify-admin.pages.dev", environment: "test", cookieMode: "host-only" };
}

function session() {
  return { ok: true, authenticated: true, csrfToken: "browser-fixture-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-28T00:00:00.000Z", source: "test", locked: true } };
}

function overview() {
  return { ok: true, databaseConfigured: true, encryptionConfigured: true, stripeSecretConfigured: true, printfulSecretConfigured: true, access: { isMasterAdmin: true, capabilities: ["commerce.view", "commerce.integrations.manage"] }, posture: { checkout: "disabled", livePaymentCapture: "disabled", fulfillmentSubmission: "disabled" }, providers: [], business: {}, completeness: {}, counts: {}, checkedAt: "2026-08-28T00:00:00.000Z" };
}

function migration(status) {
  const complete = status === "completed_with_blocked_products";
  return {
    ok: true,
    migration: { id: "permanent-printful-2026-08", status, phase: complete ? "completed" : "source_files", currentProduct: complete ? null : { id: "product-400904088", title: "Third Railify™ | Throw Blanket", legacySourceProductId: "400904088", migrationStatus: "resolving_files" }, fileProgress: complete ? null : { resolved: 0, total: 3 }, completedProducts: complete ? 36 : 10, processedProducts: complete ? 49 : 23, remainingProducts: complete ? 0 : 26, totalProducts: 49, productsCreated: complete ? 36 : 10, productsAdopted: 0, variantsMapped: complete ? 1000 : 185, providerFailures: 21, providerRequestCount: 409, providerState: complete ? "completed" : "ready", retryAt: null, lastError: null, canResume: false, checkpointState: complete ? "verified" : "checkpointed", scopes: ["file_library", "orders", "sync_products", "webhooks"], targetVerified: true, sourceVerified: true, blockedProducts: Array.from({ length: 13 }, (_, index) => ({ productId: `blocked-${index}` })) },
    catalogue: { plannedProductCreates: 49, targetNativeKeeps: 1, eligibleVariants: 1317, deferredVariants: 5, d1Products: 50, d1Variants: 1323, verifiedProducts: complete ? 36 : 10, mappedVariants: complete ? 1000 : 185, blockedProducts: 13, fileMappings: { unique: 29, originalExact: 0, targetExisting: 0, printfulPreviewRehydrated: 29, unresolved: 13 } },
    safety: { checkoutEnabled: false, livePaymentCaptureEnabled: false, fulfillmentEnabled: false, printfulOrderMode: "draft_only", commerceOrders: 0, prohibitedCommerceOrders: 0, wixSourceReadOnly: true, failClosed: true, printfulOrdersCreated: 0, printfulWebhooksMutated: 0 },
  };
}
