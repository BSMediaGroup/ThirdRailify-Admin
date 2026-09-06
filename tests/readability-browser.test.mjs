import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { browserFixture } from "./readability-fixtures.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "http://127.0.0.1:44352";

test("product slugs, categories, variant counts and editor captions remain readable without status or identity drift", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44352", "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  t.after(() => server.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(ORIGIN)).ok) break; } catch { /* Local Vite startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  t.after(() => browser.close());
  const fixture = browserFixture(ROOT, "commerce-browser.test.mjs", ORIGIN);
  for (const width of [1440, 390]) {
    const { context, page } = await fixture.fixturePage(browser, width, 900);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${ORIGIN}/products`, { waitUntil: "domcontentloaded" });
    const row = page.locator(".commerce-product-table .commerce-product-row").first();
    await row.waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const label of ["/bleh-tee", "Current · Current", "Apparel", "Price", "1 / 1 public variants", "Storefront", "Fulfillment mapping"]) {
      await typography(row.getByText(label, { exact: true }), 12, /Blinker/);
    }
    await typography(page.getByText("Rows per page", { exact: true }), 11, /Geist Mono/);
    await typography(page.locator(".commerce-product-filters .commerce-field > span").first(), 11, /Geist Mono/);
    assert.equal(await row.locator(".commerce-status-secondary.is-healthy").evaluate((el) => getComputedStyle(el).color), "rgb(121, 201, 157)", "migration status retains its semantic green");
    const identity = await page.locator(".admin-account__trigger strong").evaluate((el) => ({ size: getComputedStyle(el).fontSize, height: el.getBoundingClientRect().height }));
    await page.getByRole("button", { name: "Edit product", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await typography(dialog.locator(".commerce-field > span").first(), 11, /Geist Mono/);
    await typography(dialog.locator(".product-media-primary__details > small").first(), 11, /Geist Mono/);
    assert.ok(await dialog.evaluate((el) => el.getBoundingClientRect().right <= innerWidth + 1), "editor fits the viewport");
    await page.getByRole("button", { name: "Close editor", exact: true }).click();
    assert.deepEqual(await page.locator(".admin-account__trigger strong").evaluate((el) => ({ size: getComputedStyle(el).fontSize, height: el.getBoundingClientRect().height })), identity, "opening the editor does not wrap or resize the account identity");
    const orders = browserFixture(ROOT, "orders-browser.test.mjs", ORIGIN);
    await page.route(/\/api\/admin\/commerce\/orders(?:\/|\?|$)/, (route) => {
      const url = new URL(route.request().url());
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(url.pathname.endsWith("/orders") ? orders.orders(url) : orders.detail()) });
    });
    await page.goto(`${ORIGIN}/orders`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^View order / }).first().click();
    const order = page.getByRole("dialog");
    await order.waitFor().catch(async (error) => { throw new Error(`${error.message}\nPage errors: ${errors.join("; ")}\n${await page.locator("main").innerText()}`); });
    await page.evaluate(() => document.fonts.ready);
    await typography(order.locator("dt").first(), 12, /Blinker/);
    assert.ok(await order.evaluate((el) => el.scrollWidth <= el.clientWidth), "order secondary details fit without clipping");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

async function typography(locator, expected, family) {
  const result = await locator.evaluate((el) => {
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    return { size: parseFloat(style.fontSize), family: style.fontFamily, width: box.width, height: box.height, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  assert.equal(result.size, expected);
  assert.match(result.family, family);
  assert.ok(result.width > 0 && result.height >= expected);
  assert.ok(result.scrollHeight <= result.clientHeight + 1, "corrected metadata is not vertically clipped");
}
