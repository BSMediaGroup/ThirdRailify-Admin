import assert from "node:assert/strict";
import test from "node:test";
import worker from "../media-worker/src/index.js";

const hash = "a".repeat(64);
const bytes = new Uint8Array([137, 80, 78, 71]);

function environment({ row = null } = {}) {
  return {
    MEDIA: {
      async get(key) { return key ? object() : null; },
      async head(key) { return key ? object() : null; },
    },
    COMMERCE_DB: {
      prepare() { return { bind() { return { async first() { return row; } }; } }; },
    },
  };
}

function object() {
  return {
    body: bytes,
    size: bytes.byteLength,
    httpEtag: '"etag"',
    httpMetadata: { contentType: "image/png" },
    writeHttpMetadata(headers) { headers.set("Content-Type", "image/png"); },
  };
}

test("CDN serves only canonical immutable product and avatar keys", async () => {
  for (const path of [`/commerce-media/${hash}.png`, `/u/${"b".repeat(20)}/avatar/${hash}.png`]) {
    const response = await worker.fetch(new Request(`https://cdn.thirdrailify.com${path}`, { headers: { Origin: "https://thirdrailify.com" } }), environment());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://thirdrailify.com");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("ETag"), '"etag"');
  }
  assert.equal((await worker.fetch(new Request("https://cdn.thirdrailify.com/commerce-media/../private.png"), environment())).status, 404);
  assert.equal((await worker.fetch(new Request(`https://cdn.thirdrailify.com/commerce-media/${hash}.png?download=1`), environment())).status, 404);
});

test("CDN returns a bodyless conditional response without an invalid content length", async () => {
  const env = environment();
  env.MEDIA.get = async () => ({ ...object(), size: 123, httpEtag: '"asset"' });
  const response = await worker.fetch(new Request(`https://cdn.thirdrailify.com/commerce-media/${"a".repeat(64)}.png`, { headers: { "If-None-Match": '"asset"' } }), env);
  assert.equal(response.status, 304);
  assert.equal(response.headers.has("Content-Length"), false);
  assert.equal((await worker.fetch(new Request(`https://cdn.thirdrailify.com/commerce-media/${"a".repeat(64)}.png`, { headers: { "If-None-Match": "asset" } }), env)).status, 304);
});

test("CDN gates GOATS, Wheels, and Polls through public D1 state", async () => {
  const goat = `/goats-media/11111111-1111-1111-1111-111111111111`;
  const wheel = `/wheel-media/11111111-1111-1111-1111-111111111111`;
  const poll = `/poll-media/11111111-1111-1111-1111-111111111111`;
  assert.equal((await worker.fetch(new Request(`https://cdn.thirdrailify.com${goat}`), environment())).status, 404);
  assert.equal((await worker.fetch(new Request(`https://cdn.thirdrailify.com${wheel}`), environment())).status, 404);
  assert.equal((await worker.fetch(new Request(`https://cdn.thirdrailify.com${poll}`), environment())).status, 404);
  const row = { object_key: "goats/private/key", content_type: "image/png", byte_size: 4, sha256: hash };
  assert.equal((await worker.fetch(new Request(`https://cdn.thirdrailify.com${goat}`), environment({ row }))).status, 200);
  assert.equal((await worker.fetch(new Request(`https://cdn.thirdrailify.com${wheel}`), environment({ row }))).status, 200);
  assert.equal((await worker.fetch(new Request(`https://cdn.thirdrailify.com${poll}`), environment({ row }))).status, 200);
});

test("CDN preflight is allowlisted and mutation methods fail closed", async () => {
  const allowed = await worker.fetch(new Request("https://cdn.thirdrailify.com/", { method: "OPTIONS", headers: { Origin: "https://preview.thirdrailify.pages.dev", "Access-Control-Request-Method": "GET" } }), environment());
  assert.equal(allowed.status, 204);
  const denied = await worker.fetch(new Request("https://cdn.thirdrailify.com/", { method: "OPTIONS", headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET" } }), environment());
  assert.equal(denied.status, 403);
  assert.equal((await worker.fetch(new Request("https://cdn.thirdrailify.com/", { method: "POST" }), environment())).status, 405);
});
