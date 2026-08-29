import assert from "node:assert/strict";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import { createWheel, mutateCreatorGrant, mutateWheelAssignment } from "../functions/_shared/wheels-core.js";
import { mediaForWheel, removeWheelMedia, sanitizeWheelMedia, uploadWheelMedia, wheelMediaResponse } from "../functions/_shared/wheel-media.js";
import { onRequest as wheelsRoute } from "../functions/api/wheels/[[path]].js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const SAFE_SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200"><path fill="#f3c928" d="M0 0h1200v1200H0z"/></svg>');
const BAD_SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script></svg>');

test("wheel image validation accepts bounded raster, BMP, and safe SVG while rejecting spoofed or executable content", () => {
  assert.deepEqual(pick(sanitizeWheelMedia(PNG, "image/png", "centre")), { contentType: "image/png", width: 1, height: 1 });
  assert.deepEqual(pick(sanitizeWheelMedia(bmp(12, 8), "image/bmp", "background")), { contentType: "image/bmp", width: 12, height: 8 });
  assert.deepEqual(pick(sanitizeWheelMedia(SAFE_SVG, "image/svg+xml", "centre")), { contentType: "image/svg+xml", width: 1200, height: 1200 });
  assert.throws(() => sanitizeWheelMedia(PNG, "image/jpeg", "centre"), (error) => error.code === "wheel_media_format_invalid");
  assert.throws(() => sanitizeWheelMedia(BAD_SVG, "image/svg+xml", "centre"), (error) => error.code === "wheel_media_svg_unsafe");
  assert.throws(() => sanitizeWheelMedia(new Uint8Array(8 * 1024 * 1024 + 1), "image/png", "background"), (error) => error.code === "wheel_media_too_large");
});

test("the Pages route converts an asynchronous missing-media rejection into a bounded 404", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { AUTH_ENVIRONMENT: "test", THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev" });
  const response = await wheelsRoute({ request: new Request("https://thirdrailify-admin.pages.dev/api/wheels/media/0000000000000000"), env });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: "wheel_media_not_found", message: "The wheel image was not found." });
});

test("owner and editor media writes use opaque R2 metadata, replace safely, protect hidden delivery, and audit removal", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const bucket = memoryBucket(); const env = commerceEnvironment(harness, { THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "media-rate-secret", THIRDRAILIFY_PROFILE_MEDIA: bucket });
  await insertAccount(harness.authDb, "master", "Master", "master@example.test", "admin", "master", "env_master"); await insertAccount(harness.authDb, "owner", "Owner", "owner@example.test"); await insertAccount(harness.authDb, "editor", "Editor", "editor@example.test"); await insertAccount(harness.authDb, "spinner", "Spinner", "spinner@example.test");
  await mutateCreatorGrant(env, "master", { accountId: "owner", action: "approve" }); const created = await createWheel(env, "owner", input()); const wheelRow = await harness.commerceDb.prepare("SELECT id FROM wheels WHERE public_slug = ?").bind(created.wheel.slug).first();
  await mutateWheelAssignment(env, "master", { wheelId: wheelRow.id, accountId: "editor", role: "editor", action: "assign" }); await mutateWheelAssignment(env, "master", { wheelId: wheelRow.id, accountId: "spinner", role: "spinner", action: "assign" });
  await assert.rejects(uploadWheelMedia(env, created.wheel.slug, "centre", "spinner", PNG, "image/png"), (error) => error.code === "wheel_media_forbidden");
  const first = await uploadWheelMedia(env, created.wheel.slug, "centre", "owner", PNG, "image/png"); assert.match(first.asset.url, /^\/api\/wheels\/media\/[a-f0-9-]+$/); assert.equal(JSON.stringify(first).includes("object_key"), false);
  const firstRow = await harness.commerceDb.prepare("SELECT object_key FROM wheel_media_assets WHERE id = ?").bind(first.asset.id).first(); assert.match(firstRow.object_key, /^wheels\//); assert.equal(bucket.objects.has(firstRow.object_key), true);
  const replacement = await uploadWheelMedia(env, created.wheel.slug, "centre", "editor", SAFE_SVG, "image/svg+xml"); assert.notEqual(replacement.asset.id, first.asset.id); assert.equal(bucket.objects.has(firstRow.object_key), false); assert.equal((await harness.commerceDb.prepare("SELECT lifecycle FROM wheel_media_assets WHERE id = ?").bind(first.asset.id).first()).lifecycle, "deleted");
  const publicResponse = await wheelMediaResponse(env, replacement.asset.id, new Request(`https://admin.test/api/wheels/media/${replacement.asset.id}`)); assert.equal(publicResponse.status, 200); assert.equal(publicResponse.headers.get("content-type"), "image/svg+xml"); assert.match(publicResponse.headers.get("content-security-policy"), /sandbox/);
  await harness.commerceDb.prepare("UPDATE wheels SET visibility = 'hidden' WHERE id = ?").bind(wheelRow.id).run(); await assert.rejects(wheelMediaResponse(env, replacement.asset.id, new Request(`https://admin.test/api/wheels/media/${replacement.asset.id}`)), (error) => error.status === 404); assert.equal((await wheelMediaResponse(env, replacement.asset.id, new Request(`https://admin.test/api/wheels/media/${replacement.asset.id}`), "spinner")).status, 200);
  assert.equal((await mediaForWheel(env, wheelRow.id)).centre.id, replacement.asset.id); const removed = await removeWheelMedia(env, created.wheel.slug, "centre", "owner"); assert.equal(removed.removed, true); assert.equal((await mediaForWheel(env, wheelRow.id)).centre, null); assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_audit_events WHERE event_type IN ('wheel_media_uploaded','wheel_media_removed')").first()).count), 3);
});

function pick(value) { return { contentType: value.contentType, width: value.width, height: value.height }; }
function bmp(width, height) { const bytes = new Uint8Array(54 + width * height * 3); bytes[0] = 0x42; bytes[1] = 0x4d; const view = new DataView(bytes.buffer); view.setUint32(2, bytes.length, true); view.setUint32(10, 54, true); view.setUint32(14, 40, true); view.setInt32(18, width, true); view.setInt32(22, height, true); view.setUint16(26, 1, true); view.setUint16(28, 24, true); return bytes; }
function memoryBucket() { const objects = new Map(); return { objects, async put(key, bytes, options) { const value = new Uint8Array(bytes); objects.set(key, { bytes: value, options }); }, async get(key) { const value = objects.get(key); return value ? { body: value.bytes, size: value.bytes.byteLength, httpMetadata: value.options?.httpMetadata } : null; }, async delete(key) { objects.delete(key); } }; }
function input() { return { title: "Media Test Wheel", visibility: "public", lifecycle: "active", config: { themePreset: "third-rail-gold", palette: ["#F3C928", "#B8182F"], pointerAccent: "#F3C928", spinDurationMs: 3000 }, entries: [{ label: "Alpha", weight: 1 }, { label: "Beta", weight: 1 }] }; }
async function insertAccount(db, id, name, email, role = "user", admin = "none", source = "test") { const now = new Date().toISOString(); await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,?)").bind(id,email,name,role,admin,now,now,now,source).run(); }
