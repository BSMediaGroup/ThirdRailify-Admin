import assert from "node:assert/strict";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import { changeWheelLifecycle, createWheel, mutateCreatorGrant, mutateWheelAssignment } from "../functions/_shared/wheels-core.js";
import { adminMutateStage, adminStageLibrary, createStage, getStage, listAccessibleWheels, listPublicStages, saveStage } from "../functions/_shared/wheel-stages-core.js";

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

function wheelInput(title, visibility) { return { title, description: "Synthetic Stage test wheel", visibility, lifecycle: "active", config: { themePreset: "third-rail-gold", palette: ["#F3C928", "#B8182F"], pointerAccent: "#F3C928", spinDurationMs: 3000 }, entries: [{ label: `${title} One`, weight: 1, colour: "#F3C928", state: "active" }, { label: `${title} Two`, weight: 2, colour: "#B8182F", state: "active" }] }; }
async function insertAccount(db, id, name, email, role = "user", admin = "none") { const now = new Date().toISOString(); await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,'test')").bind(id,email,name,role,admin,now,now,now).run(); }
