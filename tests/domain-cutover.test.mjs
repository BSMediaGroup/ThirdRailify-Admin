import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { onRequest } from "../functions/_middleware.js";
import { configuredOrigins, safeReturnPath } from "../functions/_shared/auth-core.js";

const env = {
  THIRDRAILIFY_PUBLIC_ORIGIN: "https://thirdrailify.com",
  THIRDRAILIFY_ADMIN_ORIGIN: "https://admin.thirdrailify.com",
  THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE: "true",
};

function context(url, method = "GET") {
  return { request: new Request(url, { method }), env, next: async () => new Response("next") };
}

test("old Admin UI redirects without intercepting API or webhook traffic", async () => {
  const ui = await onRequest(context("https://thirdrailify-admin.pages.dev/commerce/payments?tab=webhooks"));
  assert.equal(ui.status, 301);
  assert.equal(ui.headers.get("location"), "https://admin.thirdrailify.com/commerce/payments?tab=webhooks");
  for (const [url, method] of [["https://thirdrailify-admin.pages.dev/api/auth/session", "GET"], ["https://thirdrailify-admin.pages.dev/api/webhooks/stripe", "POST"]]) {
    const response = await onRequest(context(url, method));
    assert.equal(await response.text(), "next");
  }
});

test("production origins are exact and return paths cannot escape", () => {
  assert.deepEqual([...configuredOrigins(env)].sort(), ["https://admin.thirdrailify.com", "https://thirdrailify.com"]);
  for (const value of ["https://evil.example/", "//evil.example/", "/api/admin/status", "javascript:alert(1)"]) assert.equal(safeReturnPath(value), "/account");
  assert.equal(safeReturnPath("/account/orders?state=open"), "/account/orders?state=open");
});

test("Admin production presentation is canonical and not globally labelled staging", async () => {
  const [shell, wrangler] = await Promise.all([
    readFile(new URL("../src/components/AdminShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /Authenticated control plane/);
  assert.doesNotMatch(shell, /Authenticated staging/);
  assert.match(wrangler, /"THIRDRAILIFY_ADMIN_ORIGIN": "https:\/\/admin\.thirdrailify\.com"/);
  assert.match(wrangler, /"THIRDRAILIFY_PUBLIC_ORIGIN": "https:\/\/thirdrailify\.com"/);
});
