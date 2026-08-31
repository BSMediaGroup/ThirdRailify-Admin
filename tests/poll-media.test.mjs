import assert from "node:assert/strict";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import { changePollLifecycle, createPoll, getPublicPoll, mutatePollCreatorGrant } from "../functions/_shared/polls-core.js";
import { pollMediaResponse, removePollMedia, uploadPollMedia } from "../functions/_shared/poll-media.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));

test("Poll banner and option media remain owner-scoped, optional, projected, and publicly gated", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const bucket = memoryBucket();
  const env = commerceEnvironment(harness, { THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "poll-media-rate-secret", THIRDRAILIFY_PROFILE_MEDIA: bucket, THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN: "https://cdn.thirdrailify.com" });
  await account(harness.authDb, "master", "Master", "admin", "master"); await account(harness.authDb, "owner", "Owner"); await account(harness.authDb, "intruder", "Intruder");
  await mutatePollCreatorGrant(env, "master", { accountId: "owner", action: "approve" });
  const created = await createPoll(env, "owner", input()); const optionId = created.poll.options[0].id;
  await assert.rejects(uploadPollMedia(env, created.poll.slug, "banner", "", "intruder", PNG, "image/png"), (error) => error.code === "poll_owner_required");
  const banner = await uploadPollMedia(env, created.poll.slug, "banner", "", "owner", PNG, "image/png", "cover.png");
  const option = await uploadPollMedia(env, created.poll.slug, "option", optionId, "owner", PNG, "image/png", "choice.png");
  const draft = (await getPublicPoll(env, created.poll.slug, "owner", true)).poll;
  assert.equal(draft.media.banner.id, banner.asset.id); assert.equal(draft.options[0].image.id, option.asset.id); assert.equal(draft.options[1].image, null);
  assert.match(draft.media.banner.url, /^\/api\/polls\/media\//); assert.equal(JSON.stringify(draft).includes("object_key"), false);
  await assert.rejects(pollMediaResponse(env, banner.asset.id, new Request("https://admin.test/api/polls/media/x")), (error) => error.status === 404);
  const opened = await changePollLifecycle(env, "owner", draft.slug, { revision: draft.revision, action: "open" });
  const publicPoll = (await getPublicPoll(env, opened.poll.slug)).poll; assert.match(publicPoll.media.banner.url, /^https:\/\/cdn\.thirdrailify\.com\/poll-media\//);
  assert.equal((await pollMediaResponse(env, banner.asset.id, new Request("https://admin.test/api/polls/media/x"))).status, 200);
  await removePollMedia(env, opened.poll.slug, "option", optionId, "owner"); const removed = (await getPublicPoll(env, opened.poll.slug)).poll; assert.equal(removed.options[0].image, null); assert.equal(bucket.objects.size, 1);
  await assert.rejects(uploadPollMedia(env, opened.poll.slug, "banner", "", "owner", new TextEncoder().encode("not an image"), "image/png"), (error) => error.code === "poll_media_format_invalid");
});

function input() { return { title: "Poll media fixture", description: "Optional images", webVotingMode: "anyone", rumbleEnabled: false, theme: { accent: "#8f6cff" }, options: [{ label: "Image option", trigger: "1" }, { label: "Text only", trigger: "2" }] }; }
async function account(db, id, name, role = "user", adminLevel = "none") { const now = new Date().toISOString(); await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,'test')").bind(id, `${id}@example.test`, name, role, adminLevel, now, now, now).run(); }
function memoryBucket() { const objects = new Map(); return { objects, async put(key, bytes, options) { objects.set(key, { bytes: new Uint8Array(bytes), options }); }, async get(key) { const value = objects.get(key); return value ? { body: value.bytes, size: value.bytes.byteLength, httpMetadata: value.options?.httpMetadata } : null; }, async delete(key) { objects.delete(key); } }; }
