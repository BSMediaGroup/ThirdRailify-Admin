import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const adminOrigin = String(process.env.THIRDRAILIFY_ADMIN_ORIGIN || "https://admin.thirdrailify.com").replace(/\/$/, "");
const publicOrigin = String(process.env.THIRDRAILIFY_PUBLIC_ORIGIN || "https://thirdrailify.com").replace(/\/$/, "");
const sessionId = "cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC";

const statusResponse = await fetch(`${publicOrigin}/api/commerce/order-status?session_id=${sessionId}`);
const status = await statusResponse.json();
assert.equal(statusResponse.status, 200);
assert.deepEqual(status.order, {
  reference: "ord_e47b94a4-4252-438b-8ca7-c47470029940",
  paymentStatus: "paid",
  orderStatus: "checkout_created",
  fulfillmentStatus: "disabled",
  amount: 1500,
  currency: "CAD",
});

const normalCheckoutResponse = await fetch(`${adminOrigin}/api/commerce/checkout`, {
  method: "POST",
  headers: { Origin: publicOrigin, "Content-Type": "application/json" },
  body: JSON.stringify({
    checkoutRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    items: [{ productId: "product-397267935", variantId: "variant-5019554081", quantity: 1 }],
  }),
});
const normalCheckout = await normalCheckoutResponse.json();
assert.equal(normalCheckoutResponse.status, 409);
assert.equal(normalCheckout.error, "checkout_disabled");

const controlledResponse = await fetch(`${adminOrigin}/api/admin/commerce/test-checkout`, {
  method: "POST",
  headers: { Origin: adminOrigin, "Content-Type": "application/json" },
  body: JSON.stringify({
    checkoutRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    productId: "product-397267935",
    variantId: "variant-5019554081",
    quantity: 1,
  }),
});
const controlled = await controlledResponse.json();
assert.equal(controlledResponse.status, 401);
assert.equal(controlled.error, "unauthenticated");

const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${publicOrigin}/checkout/success?session_id=${sessionId}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Payment confirmed" }).waitFor();
  const successOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(successOverflow, false);
  assert.match(await page.locator(".checkout-result").innerText(), /Payment\s+Confirmed/i);
  assert.match(await page.locator(".checkout-result").innerText(), /Fulfillment\s+Disabled \/ not started/i);

  assert.deepEqual(pageErrors, []);

  process.stdout.write(`${JSON.stringify({
    historicalStatus: status.order,
    normalCheckoutAttempt: { status: normalCheckoutResponse.status, error: normalCheckout.error },
    controlledUnauthenticatedAttempt: { status: controlledResponse.status, error: controlled.error },
    successPage: { heading: "Payment confirmed", overflow: successOverflow },
    pageErrors,
    consoleErrors,
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
