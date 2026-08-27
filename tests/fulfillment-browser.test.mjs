import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { chromium } from "playwright-core";

const PREVIEW_ORIGIN = "http://127.0.0.1:4174";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const VIEWPORTS = [390, 768, 1440];
const STATES = ["ready", "running", "success", "failure"];

test("fulfillment operator states render responsively with deliberate downloads", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "4174"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForPreview();
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(() => browser.close());

  for (const width of VIEWPORTS) {
    for (const state of STATES) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 }, acceptDownloads: true });
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (message) => {
        if (message.type() === "error" && !/^Failed to load resource: the server responded with a status of 502/.test(message.text())) consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message));
      let releaseRunning;
      const runningGate = new Promise((resolve) => { releaseRunning = resolve; });
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/auth/config") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authConfig()) });
        if (url.pathname === "/api/auth/session") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session()) });
        if (url.pathname === "/api/admin/commerce/overview") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overview()) });
        if (url.pathname === "/api/admin/commerce/printful/catalogue/snapshot") {
          const body = JSON.parse(route.request().postData() || "{}");
          if (state === "failure" && body.phase === "begin") return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: "printful_source_products_unavailable", message: "Printful legacy source product enumeration failed safely (HTTP 503)." }) });
          if (state === "running" && body.phase === "begin") await runningGate;
          if (body.phase === "begin") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(manifest()) });
          if (body.phase === "assemble") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot()) });
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "not_found" }) });
      });

      await page.goto(`${PREVIEW_ORIGIN}/commerce/fulfillment`);
      await page.getByRole("heading", { level: 1, name: "Fulfillment integrations" }).waitFor();
      assert.equal(await page.locator("h1").count(), 1, `${state} at ${width}px has one H1`);
      assert.equal(await page.getByText("16847493", { exact: true }).count(), 1);
      assert.equal(await page.getByText("18668025", { exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${state} at ${width}px has no horizontal overflow`);
      assert.doesNotMatch(await page.locator("body").innerText(), /opaque-wix-reader-token|opaque-target-token|Authorization:\s*Bearer/i);

      const runButton = page.getByRole("button", { name: "Run read-only catalogue snapshot" });
      if (state === "ready") {
        await runButton.waitFor();
        assert.equal(await runButton.isEnabled(), true);
        await page.getByText("Ready to run", { exact: true }).last().waitFor();
      } else if (state === "running") {
        await runButton.click();
        await page.getByText("Reading source and target catalogues…", { exact: true }).waitFor();
        await page.getByText("Verifying both Store IDs and enumerating catalogue pages…", { exact: true }).waitFor();
        releaseRunning();
      } else if (state === "failure") {
        await runButton.click();
        await page.getByText("Catalogue snapshot failed", { exact: true }).waitFor();
        await page.getByText("Printful legacy source product enumeration failed safely (HTTP 503).", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Retry read-only snapshot" }).waitFor();
      } else {
        await runButton.click();
        await page.getByText("Snapshot completed", { exact: true }).waitFor();
        const downloads = [
          ["Download Wix source snapshot", "printful-wix-source.snapshot.json"],
          ["Download API target snapshot", "printful-api-target.snapshot.json"],
          ["Download Public catalogue snapshot", "public-wix-catalog.snapshot.json"],
          ["Download reconciliation snapshot", "catalogue-reconciliation.json"],
        ];
        for (const [label, filename] of downloads) {
          const downloadPromise = page.waitForEvent("download");
          await page.getByRole("button", { name: label }).click();
          assert.equal((await downloadPromise).suggestedFilename(), filename);
        }
      }
      assert.deepEqual(consoleErrors, [], `${state} at ${width}px has no console errors`);
      await context.close();
    }
  }
});

async function waitForPreview() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(PREVIEW_ORIGIN)).ok) return; }
    catch { /* Preview is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vite preview did not start.");
}

function authConfig() {
  return { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: "https://thirdrailify-admin.pages.dev", environment: "test", cookieMode: "host-only" };
}

function session() {
  return { ok: true, authenticated: true, csrfToken: "browser-fixture-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-28T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } };
}

function overview() {
  return {
    ok: true, databaseConfigured: true, encryptionConfigured: true, stripeSecretConfigured: true, printfulSecretConfigured: true,
    printfulCatalogueSnapshot: { available: true, configurationReady: true, actionPath: "/api/admin/commerce/printful/catalogue/snapshot", sourceTargetDistinct: true, source: { id: "16847493", name: "Third Railify Official", type: "wix" }, target: { id: "18668025", name: "Third Railify API", type: "native" } },
    access: { isMasterAdmin: true, capabilities: ["commerce.view", "commerce.integrations.manage"] },
    posture: { checkout: "disabled", livePaymentCapture: "disabled", fulfillmentSubmission: "disabled" },
    providers: [{ provider: "printful", label: "Printful", status: "connected", credentialCustody: "environment_secret", integrationMode: "fulfillment", environment: "staging", externalAccountId: "18668025", currencyCode: "CAD", apiConfigured: true, metadata: { storeName: "Third Railify API", storeType: "native", productCount: 1 } }],
    business: {}, completeness: { businessProfile: "setup_required", tax: "setup_required", templates: "pending" }, counts: { products: 0, orders: 0, templates: 5 }, checkedAt: "2026-08-28T00:00:00.000Z",
  };
}

function manifest() {
  return { ok: true, phase: "manifest", schemaVersion: 1, correlationId: "browser-fixture", manifest: { correlationId: "browser-fixture", expiresAt: "2099-01-01T00:00:00.000Z", source: { store: { id: "16847493", name: "Third Railify Official", type: "wix" }, summaries: [] }, target: { store: { id: "18668025", name: "Third Railify API", type: "native" }, summaries: [] } }, signature: "signed-browser-fixture-evidence-value", chunkSizes: { products: 12, files: 20 } };
}

function counts(products, variants) {
  return { products, variants, synced: variants, ignored: 0, ignoredProducts: 0, unavailable: 0, missingPrices: 0, malformedPrices: 0, malformedOrMissingPrices: 0, missingFiles: 0, variantsWithoutFiles: 0 };
}

function snapshot() {
  return {
    ok: true, schemaVersion: 1, correlationId: "browser-fixture", endpointsUsed: ["GET /stores"],
    source: { role: "legacy_wix_source", store: { id: "16847493", name: "Third Railify Official", type: "wix" }, counts: counts(2, 3), products: [] },
    target: { role: "permanent_api_target", store: { id: "18668025", name: "Third Railify API", type: "native" }, counts: counts(1, 1), products: [] },
    publicCatalogue: { schemaVersion: 1, source: { repository: "ThirdRailify", file: "src/data/wixSnapshot.ts", totalProductsReportedByLegacyAudit: 49, productsRepresentedInCurrentPublicSnapshot: 8 }, products: [] },
    reconciliation: { schemaVersion: 1, counts: { publicProducts: 8, printfulBackedMatches: 2, nonPrintful: 0, unresolved: 6, sourceOnly: 0, priceConflicts: 0, variantConflicts: 0, fileConflicts: 0, plannedTargetCreates: 1, manualDecisions: 6 }, matrix: [], targetDispositions: [], plannedTargetPayloads: [] },
    downloadFilenames: { source: "printful-wix-source.snapshot.json", target: "printful-api-target.snapshot.json", publicCatalogue: "public-wix-catalog.snapshot.json", reconciliation: "catalogue-reconciliation.json" },
    safety: { providerMethods: ["GET"], sourceCredential: "PRINTFUL_WIX_SOURCE_TOKEN", targetCredential: "PRINTFUL_API_TOKEN", tokensIncluded: false, customerOrOrderDataIncluded: false },
  };
}
