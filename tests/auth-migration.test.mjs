import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration, createAuthDatabase } from "./auth-test-helpers.mjs";

test("auth migration creates the complete schema and is repeat-safe", async (t) => {
  const harness = await createAuthDatabase();
  t.after(harness.dispose);

  for (const migration of harness.migrations) await applyMigration(harness.db, migration);
  const tableResult = await harness.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
    .all();
  const names = tableResult.results.map((row) => row.name);
  assert.deepEqual(names, [
    "accounts",
    "admin_role_capability_denials",
    "auth_audit",
    "auth_handoffs",
    "auth_identities",
    "auth_rate_limits",
    "email_verification_tokens",
    "oauth_transactions",
    "password_credentials",
    "password_reset_tokens",
    "sessions",
  ]);

  const sessionForeignKeys = await harness.db.prepare("PRAGMA foreign_key_list(sessions)").all();
  assert.equal(sessionForeignKeys.results.some((row) => row.table === "accounts" && row.from === "account_id"), true);
});

test("auth schema enforces normalized-email uniqueness and identity foreign keys", async (t) => {
  const harness = await createAuthDatabase();
  t.after(harness.dispose);
  const now = new Date().toISOString();
  const insert = harness.db.prepare(
    `INSERT INTO accounts (
       id, email_normalized, display_name, role, admin_level, status, created_at, updated_at, source
     ) VALUES (?, ?, ?, 'user', 'none', 'active', ?, ?, 'test')`,
  );
  await insert.bind("account-one", "unique@example.test", "One", now, now).run();
  await assert.rejects(insert.bind("account-two", "unique@example.test", "Two", now, now).run());

  await harness.db
    .prepare(
      `INSERT INTO auth_identities (
         id, account_id, provider, provider_subject, provider_email_verified, created_at, updated_at
       ) VALUES ('identity-one', 'account-one', 'github', 'subject-one', 1, ?, ?)`,
    )
    .bind(now, now)
    .run();
  await harness.db.prepare("DELETE FROM accounts WHERE id = 'account-one'").run();
  const identity = await harness.db.prepare("SELECT id FROM auth_identities WHERE id = 'identity-one'").first();
  assert.equal(identity, null);
});
