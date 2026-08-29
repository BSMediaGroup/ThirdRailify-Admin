import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import {
  createWheel,getPublicWheel,listPublicWheels,mutateCreatorGrant,mutateWheelAssignment,participantSnapshotHash,performOfficialSpin,saveWheel,secureBoundedInteger,validateConfig,voidOfficialResult,
} from "../functions/_shared/wheels-core.js";

test("V1.7 custom palette and fireworks config normalize without schema changes", () => {
  const single = validateConfig({ themePreset: "custom", palette: ["#112233"], pointerAccent: "#abcdef", fireworksEnabled: false, spinDurationMs: 6500, winnerMessageTemplate: "Signal locked: {winner}" });
  assert.equal(single.themePreset, "custom"); assert.deepEqual(single.palette, ["#112233"]); assert.equal(single.pointerAccent, "#ABCDEF"); assert.equal(single.fireworksEnabled, false);
  assert.equal(validateConfig({ ...single, fireworksEnabled: true }).fireworksEnabled, true); assert.equal(validateConfig({ ...single, fireworksEnabled: "invalid" }).fireworksEnabled, true); assert.equal(validateConfig({ ...single, fireworksEnabled: undefined }).fireworksEnabled, true);
  assert.throws(() => validateConfig({ ...single, palette: [] }), (error) => error.code === "wheel_palette_invalid");
  assert.throws(() => validateConfig({ ...single, palette: Array(6).fill("#112233") }), (error) => error.code === "wheel_palette_invalid");
  assert.throws(() => validateConfig({ ...single, palette: ["#112233", "var(--gold)"] }), (error) => error.code === "wheel_palette_invalid");
  assert.throws(() => validateConfig({ ...single, pointerAccent: "transparent" }), (error) => error.code === "wheel_pointer_invalid");
  const legacy = validateConfig({ themePreset: "third-rail-gold", palette: ["#F3C928", "#B8182F"], pointerAccent: "#F3C928", spinDurationMs: 6500, winnerMessageTemplate: "Signal locked: {winner}" }); assert.equal(legacy.fireworksEnabled, true); assert.equal(legacy.themePreset, "third-rail-gold");
});

test("secure bounded integers use rejection sampling and weighted snapshot hashes are stable", async () => {
  let calls = 0; const values = [0xffffffff, 2];
  const selected = secureBoundedInteger(3, (array) => { array[0] = values[calls++]; return array; });
  assert.equal(selected, 2); assert.equal(calls, 2);
  const entries = [{ id: "b", label: "Beta", order: 1, weight: 2, colour: null, state: "active" }, { id: "a", label: "Alpha", order: 0, weight: 1, colour: "#FFFFFF", state: "active" }, { id: "h", label: "Hidden", order: 2, weight: 99, colour: null, state: "hidden" }];
  assert.equal(await participantSnapshotHash(entries), await participantSnapshotHash([...entries].reverse()));
  const routes = JSON.parse(await readFile(new URL("../public/_routes.json", import.meta.url), "utf8")); assert.ok(routes.include.includes("/api/wheels")); assert.ok(routes.include.includes("/api/wheels/*"));
});

test("creator grants, per-wheel roles, hidden projection, revision saves, and official idempotency are enforced", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness, { THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "wheel-test-rate-secret", THIRDRAILIFY_COMMUNITY_API_SECRET: "wheel-test-shared-secret" });
  await insertAccount(harness.authDb, "master", "Master Admin", "master@example.test", "admin", "master", "env_master");
  await insertAccount(harness.authDb, "creator", "Approved Creator", "creator@example.test");
  await insertAccount(harness.authDb, "spinner", "Approved Spinner", "spinner@example.test");
  await insertAccount(harness.authDb, "ordinary", "Ordinary Account", "ordinary@example.test");
  await assert.rejects(createWheel(env, "ordinary", wheelInput()), (error) => error.code === "creator_approval_required");
  await mutateCreatorGrant(env, "master", { accountId: "creator", action: "approve", mayCreate: true, maximumOwnedWheels: 4 });
  const created = await createWheel(env, "creator", wheelInput()); assert.equal(created.wheel.entries.length, 3); assert.equal(created.access.role, "owner");
  const hiddenInput = wheelInput(); hiddenInput.entries = hiddenInput.entries.map((entry, index) => ({ ...entry, id: `20000000-0000-4000-8000-00000000000${index + 1}` }));
  const hidden = await createWheel(env, "creator", { ...hiddenInput, title: "Hidden Test Wheel", visibility: "hidden" });
  assert.equal((await listPublicWheels(env)).items.length, 1);
  await assert.rejects(getPublicWheel(env, hidden.wheel.slug, "ordinary"), (error) => error.status === 404);
  await mutateWheelAssignment(env, "master", { wheelId: created.wheel.slug ? (await harness.commerceDb.prepare("SELECT id FROM wheels WHERE public_slug = ?").bind(created.wheel.slug).first()).id : "", accountId: "spinner", role: "spinner", action: "assign" });
  await assert.rejects(saveWheel(env, "spinner", created.wheel.slug, { ...wheelInput(), revision: created.wheel.revision }), (error) => error.code === "wheel_edit_forbidden");
  const official = await performOfficialSpin(env, "spinner", created.wheel.slug, { revision: created.wheel.revision, idempotencyKey: "official-idempotency-key-0001" });
  assert.ok(created.wheel.entries.some((entry) => entry.id === official.spin.winningEntryId));
  const repeated = await performOfficialSpin(env, "spinner", created.wheel.slug, { revision: created.wheel.revision, idempotencyKey: "official-idempotency-key-0001" });
  assert.equal(repeated.spin.id, official.spin.id); assert.equal(repeated.idempotent, true);
  await assert.rejects(performOfficialSpin(env, "spinner", created.wheel.slug, { revision: created.wheel.revision, idempotencyKey: "official-idempotency-key-0002", winningEntryId: created.wheel.entries[0].id }), (error) => error.code === "client_winner_forbidden");
  const edited = await saveWheel(env, "creator", created.wheel.slug, { ...wheelInput(), title: "Revised wheel", revision: created.wheel.revision, entries: created.wheel.entries.map((entry) => ({ ...entry, label: `Changed ${entry.label}` })) });
  assert.equal(edited.wheel.revision, created.wheel.revision + 1);
  const stored = await harness.commerceDb.prepare("SELECT winning_label_snapshot FROM wheel_official_spins WHERE id = ?").bind(official.spin.id).first(); assert.equal(stored.winning_label_snapshot, official.spin.winningLabel);
  await assert.rejects(saveWheel(env, "creator", created.wheel.slug, { ...wheelInput(), revision: created.wheel.revision }), (error) => error.code === "wheel_revision_conflict");
  const afterConflict = await getPublicWheel(env, created.wheel.slug, "creator"); assert.equal(afterConflict.wheel.title, "Revised wheel"); assert.equal(afterConflict.wheel.entries.every((entry) => entry.label.startsWith("Changed ")), true);
  await voidOfficialResult(env, "master", { spinId: official.spin.id, reason: "Synthetic test result" });
  await assert.rejects(voidOfficialResult(env, "master", { spinId: official.spin.id, reason: "Duplicate void attempt" }), (error) => error.code === "result_void_unavailable");
  const voided = await harness.commerceDb.prepare("SELECT winning_entry_id, winning_label_snapshot, winning_weight_snapshot, voided_at FROM wheel_official_spins WHERE id = ?").bind(official.spin.id).first();
  assert.deepEqual({ id: voided.winning_entry_id, label: voided.winning_label_snapshot, weight: voided.winning_weight_snapshot }, { id: official.spin.winningEntryId, label: official.spin.winningLabel, weight: official.spin.winningWeight }); assert.ok(voided.voided_at);
  const voidAudits = await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_audit_events WHERE event_type = 'official_spin_voided'").first(); assert.equal(voidAudits.count, 1);
  const rateCategories = await harness.commerceDb.prepare("SELECT category FROM wheel_rate_limits ORDER BY category").all(); assert.ok(rateCategories.results.some((row) => row.category === "admin_grant")); assert.ok(rateCategories.results.some((row) => row.category === "admin_assignment")); assert.ok(rateCategories.results.some((row) => row.category === "admin_void"));
});

function wheelInput() { return { title: "Rail Test Draw", description: "Synthetic test wheel", visibility: "public", lifecycle: "active", config: { themePreset: "third-rail-gold", palette: ["#F3C928", "#B8182F"], pointerAccent: "#F3C928", spinDurationMs: 3000 }, entries: [{ id: "10000000-0000-4000-8000-000000000001", label: "Alpha", weight: 1, colour: "#F3C928", state: "active" }, { id: "10000000-0000-4000-8000-000000000002", label: "Beta", weight: 2, colour: "#B8182F", state: "active" }, { id: "10000000-0000-4000-8000-000000000003", label: "Beta", weight: 1, colour: null, state: "active" }] }; }
async function insertAccount(db, id, name, email, role = "user", admin = "none", source = "test") { const now = new Date().toISOString(); await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,?)").bind(id,email,name,role,admin,now,now,now,source).run(); }
