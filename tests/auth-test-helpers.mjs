import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const migrationUrls = [
  new URL("../migrations/0001_auth_foundation.sql", import.meta.url),
  new URL("../migrations/0002_full_admin_capability_denials.sql", import.meta.url),
];

export async function createAuthDatabase() {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-01-20",
    d1Databases: ["THIRDRAILIFY_AUTH_DB"],
    modules: true,
    script: "export default { fetch() { return new Response('test'); } };",
  });
  const db = await miniflare.getD1Database("THIRDRAILIFY_AUTH_DB");
  const migrations = await Promise.all(migrationUrls.map((url) => readFile(url, "utf8")));
  for (const migration of migrations) await applyMigration(db, migration);
  return { db, migration: migrations[0], migrations, dispose: () => miniflare.dispose() };
}

export async function applyMigration(db, migration) {
  const statements = migration
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}

export function authEnvironment(db, overrides = {}) {
  return {
    THIRDRAILIFY_AUTH_DB: db,
    THIRDRAILIFY_PUBLIC_ORIGIN: "https://thirdrailify.pages.dev",
    THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev",
    THIRDRAILIFY_AUTH_COOKIE_DOMAIN: "",
    THIRDRAILIFY_TURNSTILE_SITE_KEY: "test-site-key",
    THIRDRAILIFY_TURNSTILE_SECRET_KEY: "test-secret-key",
    THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "test-rate-limit-secret-that-is-not-deployed",
    AUTH_ENVIRONMENT: "test",
    ADMIN_EMAIL_1: "master-one@example.test",
    ADMIN_SECRET_1: "test-master-secret-one",
    ADMIN_EMAIL_2: "master-two@example.test",
    ADMIN_SECRET_2: "test-master-secret-two",
    RESEND_API_KEY: "test-resend-key",
    MAIL_FROM: "Third Railify Test <accounts@example.test>",
    MAIL_REPLY_TO: "reply@example.test",
    DISCORD_CLIENT_ID: "discord-test-client",
    DISCORD_CLIENT_SECRET: "discord-test-secret",
    GOOGLE_CLIENT_ID: "google-test-client",
    GOOGLE_CLIENT_SECRET: "google-test-secret",
    GOOGLE_OAUTH_ENABLED: "true",
    GITHUB_CLIENT_ID: "github-test-client",
    GITHUB_CLIENT_SECRET: "github-test-secret",
    X_OAUTH_CLIENT_ID: "x-test-client",
    X_OAUTH_CLIENT_SECRET: "x-test-secret",
    ...overrides,
  };
}

export function makeAuthFetch(emailMessages = []) {
  return async (input, init = {}) => {
    const url = String(input);
    if (url.includes("turnstile/v0/siteverify")) {
      const body = JSON.parse(String(init.body || "{}"));
      const action = String(body.response || "").replace(/^valid-/, "thirdrailify-");
      return Response.json({
        success: String(body.response || "").startsWith("valid-"),
        hostname: "thirdrailify.pages.dev",
        action,
        "error-codes": String(body.response || "").startsWith("valid-") ? [] : ["invalid-input-response"],
      });
    }
    if (url === "https://api.resend.com/emails") {
      emailMessages.push(JSON.parse(String(init.body || "{}")));
      return Response.json({ id: `email-${emailMessages.length}` });
    }
    if (url.includes("github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "temporary-github-access-token", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: 4242, login: "rail-user", name: "Rail User", email: null, avatar_url: "https://avatars.githubusercontent.com/u/4242" });
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json([{ email: "oauth-user@example.test", primary: true, verified: true }]);
    }
    throw new Error(`Unexpected test fetch: ${url}`);
  };
}

export function jsonRequest(url, { method = "POST", origin, body, cookie, csrfToken } = {}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export function cookiePair(setCookie) {
  return String(setCookie || "").split(";", 1)[0];
}
