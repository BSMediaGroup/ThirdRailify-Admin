import assert from "node:assert/strict";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import { changeWheelLifecycle, createWheel, mutateCreatorGrant, mutateWheelAssignment } from "../functions/_shared/wheels-core.js";
import { adminMutateStage, adminStageLibrary, createStage, getStage, listAccessibleWheels, listPublicStages, performStageOfficialSpinAll, saveStage } from "../functions/_shared/wheel-stages-core.js";

test("Stage authority enforces ownership, independent Wheel access, visibility, revisions, and max six", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "stage-test-rate-secret", THIRDRAILIFY_COMMUNITY_API_SECRET: "stage-test-shared-secret" });
  await insertAccount(harness.authDb, "master", "Master Admin", "master@example.test", "admin", "master");
  await insertAccount(harness.authDb, "creator", "Stage Creator", "creator@example.test");
  await insertAccount(harness.authDb, "other", "Other Creator", "other@example.test");
  await insertAccount(harness.authDb, "ordinary", "Ordinary", "ordinary@example.test");
  await mutateCreatorGrant(env, "master", { accountId: "creator", action: "approve", mayCreate: true, maximumOwnedWheels: 20 });
  await mutateCreatorGrant(env, "master", { accountId: "other", action: "approve", mayCreate: true, maximumOwnedWheels: 20 });
  const publicWheel = await createWheel(env, "creator", wheelInput("Public Alpha", "public"));
  const hiddenWheel = await createWheel(env, "other", wheelInput("Private Beta", "hidden"));
  await assert.rejects(createStage(env, "creator", { title: "Private Stage", visibility: "private", wheelSlugs: [publicWheel.wheel.slug, hiddenWheel.wheel.slug] }), (error) => error.code === "stage_wheel_forbidden");
  const hiddenId = (await harness.commerceDb.prepare("SELECT id FROM wheels WHERE public_slug=?").bind(hiddenWheel.wheel.slug).first()).id;
  await mutateWheelAssignment(env, "master", { wheelId: hiddenId, accountId: "creator", role: "spinner", action: "assign" });
  const privateStage = await createStage(env, "creator", { title: "Private Stage", visibility: "private", wheelSlugs: [publicWheel.wheel.slug, hiddenWheel.wheel.slug] });
  assert.equal(privateStage.stage.wheels.length, 2); assert.equal(privateStage.access.isOwner, true);
  await assert.rejects(getStage(env, privateStage.stage.slug, "ordinary"), (error) => error.status === 404);
  await assert.rejects(createStage(env, "creator", { title: "Leaky Stage", visibility: "public", wheelSlugs: [hiddenWheel.wheel.slug] }), (error) => error.code === "public_stage_private_wheel");
  await assert.rejects(createStage(env, "creator", { title: "Too Many", visibility: "private", wheelSlugs: ["a", "b", "c", "d", "e", "f", "g"] }), (error) => error.code === "stage_wheel_count_invalid");
  const publicStage = await createStage(env, "creator", { title: "Public Stage", visibility: "public", wheelSlugs: [publicWheel.wheel.slug] });
  assert.equal((await listPublicStages(env)).items.length, 1);
  await assert.rejects(saveStage(env, "creator", publicStage.stage.slug, { title: "Conflict", visibility: "public", revision: 999, wheelSlugs: [publicWheel.wheel.slug] }), (error) => error.code === "stage_revision_conflict");
  const saved = await saveStage(env, "creator", publicStage.stage.slug, { title: "Public Stage Revised", description: "Revision protected", visibility: "public", revision: publicStage.stage.revision, wheelSlugs: [publicWheel.wheel.slug] });
  assert.equal(saved.stage.revision, 2); assert.equal(saved.stage.title, "Public Stage Revised");
  const lookup = await listAccessibleWheels(env, "creator"); assert.ok(lookup.items.some((item) => item.slug === hiddenWheel.wheel.slug && item.capability === "Official"));
  await mutateWheelAssignment(env, "master", { wheelId: hiddenId, accountId: "creator", role: "spinner", action: "revoke" });
  const afterRevoke = await getStage(env, privateStage.stage.slug, "creator"); assert.equal(afterRevoke.stage.wheels[1].unavailable, true);
  await changeWheelLifecycle(env, "creator", publicWheel.wheel.slug, { action: "hide" });
  assert.equal((await listPublicStages(env)).items.length, 0);
  await assert.rejects(getStage(env, publicStage.stage.slug), (error) => error.code === "stage_unavailable");
  assert.equal((await adminStageLibrary(env)).items.length, 2);
  const privateId = (await harness.commerceDb.prepare("SELECT id FROM wheel_stages WHERE public_slug=?").bind(privateStage.stage.slug).first()).id;
  await adminMutateStage(env, "master", { stageId: privateId, action: "delete", confirmDelete: true });
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheels").first()).count), 2);
});

test("Official All is atomic, ordered, server-selected, and batch-idempotent across six ordinary Wheel results", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "stage-spin-all-rate-secret", THIRDRAILIFY_COMMUNITY_API_SECRET: "stage-spin-all-shared-secret" });
  await insertAccount(harness.authDb, "master", "Master Admin", "master@example.test", "admin", "master"); await insertAccount(harness.authDb, "creator", "Stage Creator", "creator@example.test");
  await mutateCreatorGrant(env, "master", { accountId: "creator", action: "approve", mayCreate: true, maximumOwnedWheels: 20 });
  const wheels = [];
  for (let index = 0; index < 6; index += 1) wheels.push(await createWheel(env, "creator", wheelInput(`Official ${index + 1}`, "public")));
  const created = await createStage(env, "creator", { title: "Official Six", visibility: "public", wheelSlugs: wheels.map(({ wheel }) => wheel.slug) });
  const input = { stageRevision: created.stage.revision, batchKey: "11111111-2222-4333-8444-555555555555", wheels: created.stage.wheels.map(({ wheel }) => ({ slug: wheel.slug, revision: wheel.revision })) };
  const fourthId = (await harness.commerceDb.prepare("SELECT id FROM wheels WHERE public_slug=?").bind(input.wheels[3].slug).first()).id;
  await harness.commerceDb.prepare("UPDATE wheels SET official_spinning_locked=1 WHERE id=?").bind(fourthId).run();
  await assert.rejects(performStageOfficialSpinAll(env, "creator", created.stage.slug, input), (error) => error.code === "stage_spin_all_preflight_failed" && error.issues.some((issue) => issue.code === "official_spin_locked"));
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_official_spins").first()).count), 0, "locked Wheel rolls the whole batch back before writes");
  await harness.commerceDb.prepare("UPDATE wheels SET official_spinning_locked=0 WHERE id=?").bind(fourthId).run();
  const stale = { ...input, batchKey: "21111111-2222-4333-8444-555555555555", wheels: input.wheels.map((wheel, index) => index === 1 ? { ...wheel, revision: wheel.revision + 1 } : wheel) };
  await assert.rejects(performStageOfficialSpinAll(env, "creator", created.stage.slug, stale), (error) => error.code === "stage_spin_all_preflight_failed" && error.issues.some((issue) => issue.code === "wheel_revision_conflict"));
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_official_spins").first()).count), 0, "stale revision creates zero results");
  const fifthId = (await harness.commerceDb.prepare("SELECT id FROM wheels WHERE public_slug=?").bind(input.wheels[4].slug).first()).id;
  await harness.commerceDb.prepare("UPDATE wheel_access SET active=0 WHERE wheel_id=? AND account_id='creator'").bind(fifthId).run();
  const denied = { ...input, batchKey: "31111111-2222-4333-8444-555555555555" };
  await assert.rejects(performStageOfficialSpinAll(env, "creator", created.stage.slug, denied), (error) => error.code === "stage_spin_all_preflight_failed" && error.issues.some((issue) => issue.code === "official_spin_forbidden"));
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_official_spins").first()).count), 0, "permission denial creates zero results");
  await harness.commerceDb.prepare("UPDATE wheel_access SET active=1 WHERE wheel_id=? AND account_id='creator'").bind(fifthId).run();
  const official = await performStageOfficialSpinAll(env, "creator", created.stage.slug, input);
  assert.equal(official.results.length, 6); assert.deepEqual(official.results.map((result) => result.position), [0, 1, 2, 3, 4, 5]); assert.equal(official.results.every((result) => result.spin.animationPlan.landingFraction > 0 && result.spin.animationPlan.landingFraction < 1), true);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_official_spins").first()).count), 6); assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_audit_events WHERE event_type='official_spin_recorded'").first()).count), 6);
  const repeated = await performStageOfficialSpinAll(env, "creator", created.stage.slug, input); assert.equal(repeated.idempotent, true); assert.deepEqual(repeated.results.map((result) => ({ id: result.spin.id, plan: result.spin.animationPlan })), official.results.map((result) => ({ id: result.spin.id, plan: result.spin.animationPlan })));
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_official_spins").first()).count), 6, "retry inserts zero new results");
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'stage%result%'").first()).count), 0, "no Stage-result table exists");
});

function wheelInput(title, visibility) { return { title, description: "Synthetic Stage test wheel", visibility, lifecycle: "active", config: { themePreset: "third-rail-gold", palette: ["#F3C928", "#B8182F"], pointerAccent: "#F3C928", spinDurationMs: 3000 }, entries: [{ label: `${title} One`, weight: 1, colour: "#F3C928", state: "active" }, { label: `${title} Two`, weight: 2, colour: "#B8182F", state: "active" }] }; }
async function insertAccount(db, id, name, email, role = "user", admin = "none") { const now = new Date().toISOString(); await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,'test')").bind(id,email,name,role,admin,now,now,now).run(); }
