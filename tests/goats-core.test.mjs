import assert from "node:assert/strict";
import test from "node:test";
import { commerceEnvironment, createCommerceDatabases, insertTestProduct } from "./commerce-test-helpers.mjs";
import { onRequest as onAdminGoatsRequest } from "../functions/api/admin/goats/[[path]].js";
import {
  createComment,
  adminComments,
  adminReactions,
  adminSubmission,
  createDraft,
  cleanupExpiredDrafts,
  deleteDemoSubmission,
  finaliseDraft,
  mediaResponse,
  moderateComment,
  moderateReaction,
  mutateReaction,
  publicComments,
  publicListingBySlug,
  publicListings,
  publicMapGeoJson,
  retryEmail,
  sanitizeImage,
  transitionSubmission,
  updateAdminEngagementSettings,
  updateSubmission,
  updateEmailTemplate,
  uploadDraftMedia,
} from "../functions/_shared/goats-core.js";

const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("GOATS moderation API rejects an unauthenticated browser before returning private records", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { AUTH_ENVIRONMENT: "test", THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev", THIRDRAILIFY_PUBLIC_ORIGIN: "https://thirdrailify.pages.dev", THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "rate-secret" });
  const response = await onAdminGoatsRequest({ request: new Request("https://thirdrailify-admin.pages.dev/api/admin/goats/overview", { headers: { Origin: "https://thirdrailify-admin.pages.dev" } }), env, data: {} });
  assert.notEqual(response.status, 200); assert.match(String((await response.json()).error), /unauthenticated|authentication|session|not_configured/);
});

test("image pipeline rejects MIME spoofing and emits a bounded metadata-free PNG", () => {
  assert.throws(() => sanitizeImage(tinyPng, "image/jpeg"), /valid JPG/);
  const safe = sanitizeImage(tinyPng, "image/png");
  assert.equal(safe.contentType, "image/png"); assert.equal(safe.width, 1); assert.equal(safe.height, 1); assert.ok(safe.bytes.byteLength <= tinyPng.byteLength);
  assert.throws(() => sanitizeImage(new Uint8Array(12), "image/png"), /valid JPG/);
  assert.throws(() => sanitizeImage(new Uint8Array(10 * 1024 * 1024 + 1), "image/png"), /10 MB/);
});

test("guest draft finalisation stays private until validated approval, then projects no private fields", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const product = await insertTestProduct(harness.commerceDb);
  const bucket = memoryBucket();
  const env = commerceEnvironment(harness, { AUTH_ENVIRONMENT: "test", THIRDRAILIFY_PUBLIC_ORIGIN: "https://thirdrailify.pages.dev", THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev", THIRDRAILIFY_TURNSTILE_SECRET_KEY: "test-secret", THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "rate-secret", THIRDRAILIFY_COMMUNITY_API_SECRET: "api-secret", THIRDRAILIFY_PROFILE_MEDIA: bucket, ADMIN_EMAIL_1: "admin@example.test", MAIL_REPLY_TO: "info@thirdrailify.com" });
  const request = new Request("https://thirdrailify-admin.pages.dev/api/goats/internal/drafts", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.10" }, body: "{}" });
  const draft = await createDraft(env, request, { turnstileToken: "token", website: "" }, { rateKey: "guest-key", fetchImpl: async () => Response.json({ success: true, action: "goat_submission", hostname: "thirdrailify-admin.pages.dev" }) });
  await uploadDraftMedia(env, draft.draftToken, "main", 0, tinyPng, "image/png", { rateKey: "guest-key" });
  const finalised = await finaliseDraft(env, draft.draftToken, { email: "private@example.test", displayName: "Test Goat", description: "A sufficiently long and truthful temporary community story.", city: "Toronto", region: "Ontario", countryCode: "CA", productId: product.id, rating: 5, consent: true, consentVersion: "goats-v2-2026-08" }, { rateKey: "guest-key" });
  assert.equal(finalised.status, "pending"); assert.equal((await publicListings(env)).items.length, 0);
  const queuedBeforeRetry = Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM community_email_outbox").first()).count);
  await assert.rejects(finaliseDraft(env, draft.draftToken, { email: "private@example.test" }, { rateKey: "guest-key" }), /draft is invalid|expired/i);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM community_email_outbox").first()).count), queuedBeforeRetry);
  const pending = await harness.commerceDb.prepare("SELECT * FROM community_submissions WHERE reference_code = ?").bind(finalised.reference).first();
  const pendingMedia = await harness.commerceDb.prepare("SELECT id FROM community_media WHERE submission_id = ? AND role = 'main'").bind(pending.id).first();
  await assert.rejects(mediaResponse(env, pendingMedia.id, new Request(`https://thirdrailify-admin.pages.dev/api/goats/media/${pendingMedia.id}`)), /not found/i);
  assert.equal((await mediaResponse(env, pendingMedia.id, new Request(`https://thirdrailify-admin.pages.dev/api/admin/goats/media/${pendingMedia.id}`), { admin: true })).status, 200);
  await assert.rejects(transitionSubmission(env, pending.id, pending.version, "approve", {}, "master-admin"), /coordinates|location/i);
  await harness.commerceDb.prepare("UPDATE community_submissions SET public_latitude = 43.653, public_longitude = -79.383, location_confirmed_at = 'now' WHERE id = ?").bind(pending.id).run();
  const approved = await transitionSubmission(env, pending.id, pending.version, "approve", {}, "master-admin");
  assert.equal(approved.item.status, "approved");
  await assert.rejects(transitionSubmission(env, pending.id, pending.version, "approve", {}, "master-admin"), /changed|transition/i);
  assert.equal((await mediaResponse(env, pendingMedia.id, new Request(`https://thirdrailify-admin.pages.dev/api/goats/media/${pendingMedia.id}`))).status, 200);
  const hidden = await transitionSubmission(env, pending.id, approved.item.version, "hide", {}, "master-admin"); await assert.rejects(publicListingBySlug(env, pending.public_slug), /not found/i);
  const restored = await transitionSubmission(env, pending.id, hidden.item.version, "restore", {}, "master-admin"); assert.equal(restored.item.published, true);
  const listing = await publicListingBySlug(env, pending.public_slug);
  assert.equal(listing.item.displayName, "Test Goat"); assert.equal(JSON.stringify(listing).includes("private@example.test"), false); assert.equal(JSON.stringify(listing).includes("object_key"), false); assert.equal(JSON.stringify(listing).includes("moderator"), false);
  const gallery = await publicListings(env); assert.deepEqual(gallery.facets.countries, [{ code: "CA", count: 1 }]);
  const geo = await publicMapGeoJson(env); assert.equal(geo.features.length, 1); assert.deepEqual(geo.features[0].geometry.coordinates, [-79.383, 43.653]); assert.equal(JSON.stringify(geo).includes("private@example.test"), false);
  await assert.rejects(mutateReaction(env, pending.public_slug, "", 1, { rateKey: "anonymous" }), /required field|authentication/i);
  const reactions = await mutateReaction(env, pending.public_slug, "account-1", 1, { rateKey: "account-1" }); assert.deepEqual({ likes: reactions.likes, current: reactions.currentReaction }, { likes: 1, current: 1 });
  const toggled = await mutateReaction(env, pending.public_slug, "account-1", 1, { rateKey: "account-1" }); assert.deepEqual({ likes: toggled.likes, current: toggled.currentReaction }, { likes: 0, current: 0 });
  const switchedStart = await mutateReaction(env, pending.public_slug, "account-1", 1, { rateKey: "account-1" }); assert.equal(switchedStart.likes, 1);
  const switched = await mutateReaction(env, pending.public_slug, "account-1", -1, { rateKey: "account-1" }); assert.deepEqual({ likes: switched.likes, dislikes: switched.dislikes, current: switched.currentReaction }, { likes: 0, dislikes: 1, current: -1 });
  const comment = await createComment(env, pending.public_slug, { accountId: "account-1", displayName: "Commenter", avatarUrl: null }, "Plain text only <script>alert(1)</script>", { rateKey: "account-1" });
  assert.equal(comment.item.body, "Plain text only <script>alert(1)</script>");
  assert.equal((await publicComments(env, pending.public_slug)).items.length, 1);
  await moderateComment(env, comment.item.id, false, "master-admin"); assert.equal((await publicComments(env, pending.public_slug)).items.length, 0);
  await moderateComment(env, comment.item.id, true, "master-admin"); assert.equal((await publicComments(env, pending.public_slug)).items.length, 1);
  await assert.rejects(deleteDemoSubmission(env, pending.id, restored.item.version, "master-admin"), /demo listings/i);

  await assert.rejects(updateEmailTemplate(env, "goat_submission_received", { subject: "Bad\nHeader", htmlBody: "<p>Okay</p>", textBody: "Okay", status: "ready" }, "master-admin"), /line breaks/i);
  await updateEmailTemplate(env, "goat_submission_received", { subject: "Received {{submission_reference}}", htmlBody: "<p>Hello {{display_name}}</p>", textBody: "Hello {{display_name}}", status: "ready" }, "master-admin");
  const outbox = await harness.commerceDb.prepare("SELECT id FROM community_email_outbox WHERE template_key = 'goat_submission_received'").first();
  await harness.commerceDb.prepare("UPDATE community_email_outbox SET variables_json = json_set(variables_json, '$.display_name', '<script>alert(1)</script>') WHERE id = ?").bind(outbox.id).run();
  let sends = 0;
  const sent = await retryEmail({ ...env, THIRDRAILIFY_ADMIN_ORIGIN: "https://admin.example.test", RESEND_API_KEY: "test-key", MAIL_FROM: "Test <test@example.test>" }, outbox.id, "master-admin", async (_url, init) => { sends += 1; const body = JSON.parse(init.body); assert.equal(body.to[0], "private@example.test"); assert.equal(body.subject.includes(finalised.reference), true); assert.match(body.html, /^<!doctype html>/); assert.match(body.html, /THIRD RAILIFY OFFICIAL/); assert.match(body.html, /GOATS in the Wild/); assert.match(body.html, /Submission received/); assert.match(body.html, /font-family:'American Captain'/); assert.match(body.html, /font-family:'Blinker'/); assert.match(body.html, /font-family:'Geist Mono'/); assert.match(body.html, /https:\/\/admin\.example\.test\/email-assets\/american-captain\.ttf/); assert.match(body.html, /https:\/\/admin\.example\.test\/email-assets\/trzapcolorcon\.svg/); assert.equal(body.html.includes("<script>"), false); assert.equal(body.html.includes("&lt;script&gt;"), true); return Response.json({ id: "email-test" }); });
  assert.equal(sent.status, "sent");
  const duplicate = await retryEmail({ ...env, RESEND_API_KEY: "test-key", MAIL_FROM: "Test <test@example.test>" }, outbox.id, "master-admin", async () => { sends += 1; return Response.json({ id: "unexpected" }); });
  assert.equal(duplicate.duplicate, true); assert.equal(sends, 1);
});

test("collision-safe finalisation, product validation, draft expiry, and gallery limit fail safely", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const product = await insertTestProduct(harness.commerceDb); const bucket = memoryBucket();
  const env = commerceEnvironment(harness, { AUTH_ENVIRONMENT: "test", THIRDRAILIFY_PUBLIC_ORIGIN: "https://thirdrailify.pages.dev", THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev", THIRDRAILIFY_TURNSTILE_SECRET_KEY: "test-secret", THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "rate-secret", THIRDRAILIFY_COMMUNITY_API_SECRET: "api-secret", THIRDRAILIFY_PROFILE_MEDIA: bucket, ADMIN_EMAIL_1: "admin@example.test" });
  await assert.rejects(createDraft(env, new Request("https://thirdrailify-admin.pages.dev/api/goats/internal/drafts", { method: "POST", body: "{}" }), { turnstileToken: "bad", website: "" }, { rateKey: "captcha-fail", fetchImpl: async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }) }), /verification|human/i);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM community_submissions").first()).count), 0);
  const makeDraft = async (rateKey) => {
    const request = new Request("https://thirdrailify-admin.pages.dev/api/goats/internal/drafts", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.11" }, body: "{}" });
    const draft = await createDraft(env, request, { turnstileToken: "token", website: "" }, { rateKey, fetchImpl: async () => Response.json({ success: true, action: "goat_submission", hostname: "thirdrailify-admin.pages.dev" }) });
    await uploadDraftMedia(env, draft.draftToken, "main", 0, tinyPng, "image/png", { rateKey }); return draft;
  };
  const input = { email: "goat@example.test", displayName: "Same Name", description: "A sufficiently long collision-safe community story.", city: "Sydney", countryCode: "AU", productId: product.id, rating: 4, consent: true, consentVersion: "goats-v2-2026-08" };
  const first = await makeDraft("collision-1"); await finaliseDraft(env, first.draftToken, input, { rateKey: "collision-1" });
  const second = await makeDraft("collision-2"); await assert.rejects(finaliseDraft(env, second.draftToken, { ...input, productId: "not-a-product" }, { rateKey: "collision-2" }), /product/i); await finaliseDraft(env, second.draftToken, input, { rateKey: "collision-2" });
  const slugs = await harness.commerceDb.prepare("SELECT public_slug FROM community_submissions WHERE status = 'pending' ORDER BY public_slug").all(); assert.deepEqual(slugs.results.map((row) => row.public_slug), ["same-name", "same-name-2"]);
  const rejectedRow = await harness.commerceDb.prepare("SELECT id, version FROM community_submissions WHERE public_slug = 'same-name-2'").first(); await transitionSubmission(env, rejectedRow.id, rejectedRow.version, "reject", { rejectionReason: "Please submit a clearer main image.", moderatorNote: "Private note must never enter email variables." }, "master-admin");
  const rejectedEmail = await harness.commerceDb.prepare("SELECT variables_json FROM community_email_outbox WHERE submission_id = ? AND template_key = 'goat_submission_rejected'").bind(rejectedRow.id).first(); assert.equal(JSON.parse(rejectedEmail.variables_json).rejection_reason, "Please submit a clearer main image."); assert.equal(rejectedEmail.variables_json.includes("Private note"), false);
  const expiring = await makeDraft("expiry"); await harness.commerceDb.prepare("UPDATE community_submissions SET draft_expires_at = '2000-01-01T00:00:00.000Z' WHERE draft_token_hash IS NOT NULL").run(); await assert.rejects(uploadDraftMedia(env, expiring.draftToken, "gallery", 0, tinyPng, "image/png", { rateKey: "expiry" }), /expired|invalid/i); const cleanup = await cleanupExpiredDrafts(env, "master-admin", 10); assert.equal(cleanup.deletedDrafts, 1); assert.equal(cleanup.deletedObjects, 1);
  const galleryDraft = await makeDraft("gallery"); for (let index = 0; index < 5; index += 1) await uploadDraftMedia(env, galleryDraft.draftToken, "gallery", index, tinyPng, "image/png", { rateKey: `gallery-${index}` }); await assert.rejects(uploadDraftMedia(env, galleryDraft.draftToken, "gallery", 4, tinyPng, "image/png", { rateKey: "gallery-over" }), /five/i);
});

test("global and per-listing interaction rules queue, approve, disable, and keep approved listings editable", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "rate-secret" });
  const id = "22222222-2222-4222-a222-222222222222";
  await harness.commerceDb.prepare(`INSERT INTO community_submissions (
    id, reference_code, public_slug, status, is_published, display_name, description, city, country_code,
    public_location_label, public_latitude, public_longitude, created_at, submitted_at, updated_at, approved_at
  ) VALUES (?, 'GOAT-MODES', 'goat-modes', 'approved', 1, 'Mode Goat', 'Editable approved story', 'Toronto', 'CA', 'Toronto, CA', 43.65, -79.38, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`).bind(id).run();
  await updateAdminEngagementSettings(env, { comments: "moderated", reactions: "moderated" }, "master-admin");

  const comment = await createComment(env, "goat-modes", { accountId: "account-1", displayName: "Member" }, "Please approve this", { rateKey: "comment-mode" });
  assert.equal(comment.pendingApproval, true); assert.equal(comment.item, null); assert.equal((await publicComments(env, "goat-modes")).total, 0);
  const pendingComments = await adminComments(env, "pending"); assert.equal(pendingComments.items.length, 1);
  await moderateComment(env, pendingComments.items[0].id, "approve", "master-admin"); assert.equal((await publicComments(env, "goat-modes")).total, 1);

  const reaction = await mutateReaction(env, "goat-modes", "account-1", 1, { rateKey: "reaction-mode" });
  assert.equal(reaction.pendingApproval, true); assert.equal(reaction.likes, 0);
  const pendingReactions = await adminReactions(env, "pending"); assert.equal(pendingReactions.items.length, 1);
  await moderateReaction(env, id, "account-1", "approve", "master-admin"); assert.equal((await publicListingBySlug(env, "goat-modes")).item.counts.likes, 1);

  const detail = await adminSubmission(env, id);
  const edited = await updateSubmission(env, id, detail.item.version, { displayName: "Mode Goat Edited", description: "Approved content remains editable after publication.", slug: "goat-modes", city: "Toronto", region: "Ontario", countryCode: "CA", latitude: 43.65, longitude: -79.38, commentMode: "disabled", reactionMode: "disabled" }, "master-admin");
  assert.equal(edited.item.status, "approved"); assert.equal(edited.item.description, "Approved content remains editable after publication.");
  await assert.rejects(createComment(env, "goat-modes", { accountId: "account-2", displayName: "Member" }, "Disabled", { rateKey: "comment-disabled" }), /disabled/i);
  await assert.rejects(mutateReaction(env, "goat-modes", "account-2", 1, { rateKey: "reaction-disabled" }), /disabled/i);
});

function memoryBucket() {
  const values = new Map();
  return { async put(key, bytes, options) { values.set(key, { bytes: new Uint8Array(bytes), options }); }, async get(key) { const value = values.get(key); return value ? { body: value.bytes, httpMetadata: value.options.httpMetadata, httpEtag: `\"${key}\"` } : null; }, async delete(key) { values.delete(key); } };
}
