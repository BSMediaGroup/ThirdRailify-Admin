import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { applyMigration, authEnvironment } from "./auth-test-helpers.mjs";

const authMigrationUrl = new URL("../migrations/0001_auth_foundation.sql", import.meta.url);
const commerceMigrationUrl = new URL("../commerce-migrations/0001_commerce_control_plane.sql", import.meta.url);

export const TEST_COMMERCE_KEY = "ERERERERERERERERERERERERERERERERERERERERERE";

export async function createCommerceDatabases() {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-08-11",
    d1Databases: ["THIRDRAILIFY_AUTH_DB", "THIRDRAILIFY_COMMERCE_DB"],
    modules: true,
    script: "export default { fetch() { return new Response('test'); } };",
  });
  const authDb = await miniflare.getD1Database("THIRDRAILIFY_AUTH_DB");
  const commerceDb = await miniflare.getD1Database("THIRDRAILIFY_COMMERCE_DB");
  const [authMigration, commerceMigration] = await Promise.all([readFile(authMigrationUrl, "utf8"), readFile(commerceMigrationUrl, "utf8")]);
  await applyMigration(authDb, authMigration);
  await applyMigration(commerceDb, commerceMigration);
  return { authDb, commerceDb, commerceMigration, dispose: () => miniflare.dispose() };
}

export function commerceEnvironment(harness, overrides = {}) {
  return authEnvironment(harness.authDb, {
    THIRDRAILIFY_COMMERCE_DB: harness.commerceDb,
    THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY: TEST_COMMERCE_KEY,
    ...overrides,
  });
}
