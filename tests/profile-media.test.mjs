import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { onRequest as authRequest } from "../functions/api/auth/[[path]].js";
import { onRequest as mediaRequest } from "../functions/u/[[path]].js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { authEnvironment, cookiePair, createAuthDatabase } from "./auth-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const MEDIA_ORIGIN = "https://cdn.thirdrailify.com";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

test("Admin Wrangler preserves the media bucket and explicitly configures preview CDN bindings", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const bindings = config.r2_buckets.filter(({ binding }) => binding === "THIRDRAILIFY_PROFILE_MEDIA");
  assert.deepEqual(bindings, [{ binding: "THIRDRAILIFY_PROFILE_MEDIA", bucket_name: "thirdrailify-profile-media" }]);
  assert.deepEqual(config.env.preview.r2_buckets, bindings);
  assert.equal(config.vars.THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN, MEDIA_ORIGIN);
  assert.equal(config.env.preview.vars.THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN, MEDIA_ORIGIN);
});

test("avatar uploads and remote URLs become immutable Admin-owned media objects", async (t) => {
  const harness = await createAuthDatabase();
  t.after(harness.dispose);
  const bucket = new MemoryBucket();
  const env = authEnvironment(harness.db, {
    THIRDRAILIFY_PROFILE_MEDIA: bucket,
    THIRDRAILIFY_PROFILE_MEDIA_ORIGIN: ADMIN_ORIGIN,
    THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN: MEDIA_ORIGIN,
  });
  await ensureEnvironmentMasters(env);
  const master = await loadAccountByEmail(env, env.ADMIN_EMAIL_1);
  const created = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  const cookie = cookiePair(created.cookie);

  const uploadPayloads = new Map();
  for (const image of [
    { bytes: JPEG, contentType: "image/jpeg", extension: "jpg" },
    { bytes: PNG, contentType: "image/png", extension: "png" },
    { bytes: WEBP, contentType: "image/webp", extension: "webp" },
  ]) {
    const form = new FormData();
    form.set("avatar", new Blob([image.bytes], { type: image.contentType }), `avatar.${image.extension}`);
    const upload = await authRequest({
      request: new Request(`${ADMIN_ORIGIN}/api/auth/avatar`, {
        method: "POST",
        headers: { Origin: ADMIN_ORIGIN, Cookie: cookie, "X-CSRF-Token": created.csrfToken },
        body: form,
      }),
      env,
      data: {},
    });
    assert.equal(upload.status, 200);
    const uploadPayload = await upload.json();
    const contentHash = await digestHex(image.bytes);
    assert.match(uploadPayload.account.avatarUrl, new RegExp(`^https://cdn\\.thirdrailify\\.com/u/[a-f0-9]{20}/avatar/${contentHash}\\.${image.extension}$`));
    assert.doesNotMatch(uploadPayload.account.avatarUrl, /^(?:data|blob):/);
    const objectKey = new URL(uploadPayload.account.avatarUrl).pathname.slice(1);
    assert.equal(bucket.objects.has(objectKey), true);
    assert.equal(bucket.putKeys.includes(objectKey), true);
    const stored = await harness.db.prepare("SELECT avatar_url FROM accounts WHERE id = ?").bind(master.id).first();
    assert.equal(stored.avatar_url, uploadPayload.account.avatarUrl);
    uploadPayloads.set(image.extension, uploadPayload);
  }
  assert.equal(bucket.objects.size, 3);

  const pngPayload = uploadPayloads.get("png");
  const served = await mediaRequest({ request: new Request(pngPayload.account.avatarUrl), env });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);

  const remoteJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x01, 0xff, 0xd9]);
  const urlUpdate = await authRequest({
    request: jsonAvatarRequest(cookie, created.csrfToken, { imageUrl: "https://images.example.test/avatar.jpg" }),
    env,
    data: { authFetch: async () => new Response(remoteJpeg, { headers: { "Content-Type": "image/jpeg", "Content-Length": String(remoteJpeg.byteLength) } }) },
  });
  assert.equal(urlUpdate.status, 200);
  const urlPayload = await urlUpdate.json();
  assert.match(urlPayload.account.avatarUrl, /\/avatar\/[a-f0-9]{64}\.jpg$/);
  assert.equal(urlPayload.account.avatarUrl.includes("images.example.test"), false);
  assert.equal(bucket.objects.size, 4);

  for (const imageUrl of ["data:image/png;base64,AAAA", "blob:https://thirdrailify.pages.dev/unsafe"]) {
    const unsafeUrl = await authRequest({
      request: jsonAvatarRequest(cookie, created.csrfToken, { imageUrl }),
      env,
      data: { authFetch: async () => { throw new Error("unsafe URLs must not be fetched"); } },
    });
    assert.equal(unsafeUrl.status, 400);
    assert.equal((await unsafeUrl.json()).error, "avatar_url_invalid");
  }
});

test("avatar mutation rejects missing CSRF, spoofed image bytes, and missing object storage", async (t) => {
  const harness = await createAuthDatabase();
  t.after(harness.dispose);
  const bucket = new MemoryBucket();
  const env = authEnvironment(harness.db, { THIRDRAILIFY_PROFILE_MEDIA: bucket });
  await ensureEnvironmentMasters(env);
  const master = await loadAccountByEmail(env, env.ADMIN_EMAIL_1);
  const created = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  const cookie = cookiePair(created.cookie);

  const noCsrf = await authRequest({ request: jsonAvatarRequest(cookie, "", { imageUrl: "https://images.example.test/avatar.png" }), env, data: {} });
  assert.equal(noCsrf.status, 403);

  const spoofed = await authRequest({
    request: jsonAvatarRequest(cookie, created.csrfToken, { imageUrl: "https://images.example.test/avatar.png" }),
    env,
    data: { authFetch: async () => new Response("not an image", { headers: { "Content-Type": "image/png" } }) },
  });
  assert.equal(spoofed.status, 415);
  assert.equal((await spoofed.json()).error, "avatar_format_invalid");

  const missingStorage = await authRequest({
    request: jsonAvatarRequest(cookie, created.csrfToken, { imageUrl: "https://images.example.test/avatar.png" }),
    env: { ...env, THIRDRAILIFY_PROFILE_MEDIA: undefined },
    data: { authFetch: async () => { throw new Error("storage failure must occur before fetch"); } },
  });
  assert.equal(missingStorage.status, 503);
  assert.equal((await missingStorage.json()).error, "profile_media_not_configured");
});

function jsonAvatarRequest(cookie, csrfToken, body) {
  const headers = new Headers({ Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" });
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  return new Request(`${ADMIN_ORIGIN}/api/auth/avatar`, { method: "POST", headers, body: JSON.stringify(body) });
}

class MemoryBucket {
  objects = new Map();
  putKeys = [];
  async head(key) { return this.objects.get(key) || null; }
  async put(key, bytes, options = {}) {
    const stored = { bytes: new Uint8Array(bytes), httpMetadata: options.httpMetadata || {}, httpEtag: `"${key.split("/").at(-1)}"` };
    this.objects.set(key, stored);
    this.putKeys.push(key);
    return stored;
  }
  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return { body: new Response(stored.bytes).body, size: stored.bytes.byteLength, httpMetadata: stored.httpMetadata, httpEtag: stored.httpEtag };
  }
  async delete(key) { this.objects.delete(key); }
}

async function digestHex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
