import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";

import { onRequest as workshopRequest } from "../functions/api/workshop/[[path]].js";
import { createSession } from "../functions/_shared/auth-core.js";
import { applyMigration, authEnvironment, cookiePair, jsonRequest } from "./auth-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";

test("Master profile restrictions are validated, audited and compare-and-swap atomically", async (t) => {
  const mf = new Miniflare({
    compatibilityDate: "2026-09-12",
    d1Databases: ["THIRDRAILIFY_AUTH_DB", "LAB_DB"],
    modules: true,
    script: "export default { fetch() { return new Response('test'); } };",
  });
  t.after(() => mf.dispose());
  const authDb = await mf.getD1Database("THIRDRAILIFY_AUTH_DB");
  const labDb = await mf.getD1Database("LAB_DB");
  for (const name of ["0001_auth_foundation.sql", "0002_full_admin_capability_denials.sql", "0003_workshop_access.sql", "0004_workshop_provider_profile_restrictions.sql"]) {
    await applyMigration(authDb, await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  for (const name of ["0001_lab.sql", "0002_provider_vault_stock_usage.sql"]) {
    await applyMigration(labDb, await readFile(new URL(`../../ThirdRailify-Lab/migrations/${name}`, import.meta.url), "utf8"));
  }
  const timestamp = "2026-09-12T00:00:00.000Z";
  const master = { id: "profile-master", email_normalized: "profile-master@example.test", display_name: "Profile Master", role: "admin", admin_level: "master", status: "active", email_verified_at: timestamp, created_at: timestamp, updated_at: timestamp, source: "test" };
  const full = { ...master, id: "profile-full", email_normalized: "profile-full@example.test", display_name: "Profile Full", admin_level: "full" };
  const target = { ...master, id: "profile-target", email_normalized: "profile-target@example.test", display_name: "Profile Target", role: "user", admin_level: "none" };
  for (const row of [master, full, target]) {
    await authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(row.id, row.email_normalized, row.display_name, row.role, row.admin_level, row.status, row.email_verified_at, row.created_at, row.updated_at, row.source).run();
  }
  await labDb.prepare(`INSERT INTO provider_key_profiles(id,provider,label,ciphertext,nonce,key_version,fingerprint,enabled,is_default,verification_status,created_by,updated_by,created_at,updated_at)
    VALUES('pexels-named','pexels','Editorial','ciphertext','nonce',1,'fingerprint',1,0,'verified',?,?,?,?)`)
    .bind(master.id, master.id, timestamp, timestamp).run();
  const env = authEnvironment(authDb, { LAB_DB: labDb, THIRDRAILIFY_ADMIN_ORIGIN: ADMIN_ORIGIN });
  const masterAuth = await createSession(env, new Request(ADMIN_ORIGIN, { headers: { "user-agent": "test" } }), master, ADMIN_ORIGIN);
  const fullAuth = await createSession(env, new Request(ADMIN_ORIGIN, { headers: { "user-agent": "test" } }), full, ADMIN_ORIGIN);

  const read = await call(target.id, "GET", undefined, masterAuth, env);
  assert.equal(read.status, 200);
  const initial = await read.json();
  const pexels = initial.providers.find((item) => item.provider === "pexels");
  assert.deepEqual(pexels.profiles.map((item) => item.id), ["runtime:pexels", "pexels-named"]);
  assert.equal(pexels.policy.revision, 0);

  const first = await call(target.id, "PUT", { provider: "pexels", mode: "selected", profileIds: ["pexels-named"], defaultProfileId: "pexels-named", revision: 0 }, masterAuth, env);
  assert.equal(first.status, 200);
  assert.equal((await authDb.prepare("SELECT count(*) n FROM workshop_provider_profile_audit WHERE account_id=?").bind(target.id).first()).n, 1);

  const [raceA, raceB] = await Promise.all([
    call(target.id, "PUT", { provider: "pexels", mode: "selected", profileIds: ["runtime:pexels"], defaultProfileId: "runtime:pexels", revision: 1 }, masterAuth, env),
    call(target.id, "PUT", { provider: "pexels", mode: "selected", profileIds: ["pexels-named"], defaultProfileId: "pexels-named", revision: 1 }, masterAuth, env),
  ]);
  assert.deepEqual([raceA.status, raceB.status].sort(), [200, 409]);
  const policy = await authDb.prepare("SELECT access_mode,default_profile_id,revision,write_token FROM workshop_provider_profile_policies WHERE account_id=? AND provider='pexels'").bind(target.id).first();
  const grants = await authDb.prepare("SELECT profile_id FROM workshop_provider_profile_grants WHERE account_id=? AND provider='pexels'").bind(target.id).all();
  assert.equal(policy.revision, 2);
  assert.ok(policy.write_token);
  assert.deepEqual(grants.results.map((row) => row.profile_id), [policy.default_profile_id]);
  assert.equal((await authDb.prepare("SELECT count(*) n FROM workshop_provider_profile_audit WHERE account_id=?").bind(target.id).first()).n, 2);

  const stale = await call(target.id, "PUT", { provider: "pexels", mode: "all", profileIds: [], defaultProfileId: null, revision: 1 }, masterAuth, env);
  assert.equal(stale.status, 409);
  const denied = await call(target.id, "GET", undefined, fullAuth, env);
  assert.equal(denied.status, 403);
});

function call(accountId, method, body, auth, env) {
  const request = jsonRequest(`${ADMIN_ORIGIN}/api/workshop/accounts/${accountId}/profiles`, {
    method,
    origin: ADMIN_ORIGIN,
    body,
    cookie: cookiePair(auth.cookie),
    csrfToken: auth.csrfToken,
  });
  return workshopRequest({ request, env });
}
