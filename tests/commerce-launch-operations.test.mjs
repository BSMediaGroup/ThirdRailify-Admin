import assert from "node:assert/strict";
import test from "node:test";
import { activateCommerceLaunch, applyEligibleVariantSellability, commerceLaunchPlan, pauseCommerceLaunch } from "../functions/_shared/commerce-launch.js";
import { commerceEnvironment, createCommerceDatabases, insertTestProduct, insertTestVariant } from "./commerce-test-helpers.mjs";

test("launch planning and sellability use one exact eligibility predicate", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await insertTestProduct(harness.commerceDb, { targetPrintfulProductId: "9001", migrationStatus: "target_verified", requiresShipping: 1 });
  await insertTestVariant(harness.commerceDb, { isSellable: 0, targetPrintfulProductId: "9001", targetPrintfulSyncVariantId: "7001", targetCatalogueVariantId: "11576", migrationStatus: "target_verified" });
  const env = commerceEnvironment(harness);
  const before = await commerceLaunchPlan(env);
  assert.equal(before.catalogue.eligibleVariants, 1); assert.equal(before.catalogue.eligibleSellableVariants, 0); assert.equal(before.ready, false);
  const [first, second] = await Promise.all([applyEligibleVariantSellability(env, "master"), applyEligibleVariantSellability(env, "master")]);
  assert.equal(first.after.eligible, 1); assert.equal(second.after.eligible, 1);
  const after = await commerceLaunchPlan(env);
  assert.equal(after.catalogue.eligibleSellableVariants, 1); assert.equal(after.catalogue.ineligibleSellableVariants, 0);
  assert.equal((await harness.commerceDb.prepare("SELECT is_sellable FROM commerce_product_variants WHERE id='variant-test-001'").first()).is_sellable, 1);
});

test("activation fails atomically when any hard gate is blocked and pause is revision guarded", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const plan = await commerceLaunchPlan(env);
  await assert.rejects(activateCommerceLaunch(env, { confirmation: "ACTIVATE LIVE COMMERCE", expectedRevision: plan.revision }, "master"), (error) => error.code === "commerce_launch_blocked");
  assert.deepEqual(await harness.commerceDb.prepare("SELECT state,revision FROM commerce_launch_state WHERE id='production'").first(), { state: "preflight", revision: 1 });
  await assert.rejects(pauseCommerceLaunch(env, { confirmation: "PAUSE LIVE COMMERCE", expectedRevision: 99, reason: "test" }, "master"), (error) => error.code === "commerce_launch_revision_conflict");
  const paused = await pauseCommerceLaunch(env, { confirmation: "PAUSE LIVE COMMERCE", expectedRevision: 1, reason: "test emergency pause" }, "master");
  assert.equal(paused.state, "paused"); assert.equal(paused.revision, 2); assert.equal(paused.settings.emergencyPaused, true);
});
