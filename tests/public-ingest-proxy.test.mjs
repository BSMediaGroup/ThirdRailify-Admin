import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { proxyPublicIngest } from "../functions/_shared/public-ingest-proxy.js";

const secret = "fixture-ingest-secret";

function signedRequest(path, raw, overrides = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex")}`;
  return new Request(`https://admin.thirdrailify.com${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-ThirdRailify-Timestamp": timestamp, "X-ThirdRailify-Signature": signature, ...overrides }, body: raw });
}

function environment(capture) {
  return {
    THIRDRAILIFY_COMMUNITY_INGEST_SECRET: secret,
    THIRDRAILIFY_PUBLIC_STATE: {
      idFromName(name) { capture.singleton = name; return "state-id"; },
      get() { return { async fetch(stateRequest) { capture.request = stateRequest; return Response.json({ persisted: true, reason: "semantic_change", storageWrites: 1 }); } }; },
    },
  };
}

test("Admin machine ingress verifies and writes the signed snapshot to Public state", async () => {
  const raw = '{"schema":"thirdrailify-broadcast-v1","generatedAt":"2026-08-30T00:00:00.000Z","liveNow":[],"upcoming":null}';
  const capture = {};
  const response = await proxyPublicIngest(signedRequest("/api/watch/ingest", raw), environment(capture), "/api/watch/ingest", 64 * 1024);
  assert.equal(response.status, 204);
  assert.equal(capture.singleton, "thirdrailify-public-state");
  assert.equal(new URL(capture.request.url).pathname, "/watch/ingest");
  assert.deepEqual(await capture.request.json(), { snapshot: JSON.parse(raw), checkpointSeconds: 600 });
});

test("Admin machine ingress rejects invalid signatures and oversized bodies", async () => {
  const invalid = signedRequest("/api/watch/ingest", "{}", { "X-ThirdRailify-Signature": `sha256=${"a".repeat(64)}` });
  assert.equal((await proxyPublicIngest(invalid, environment({}), "/api/watch/ingest", 1024)).status, 401);
  const oversized = signedRequest("/api/watch/ingest", "{}", { "Content-Length": "2048" });
  assert.equal((await proxyPublicIngest(oversized, environment({}), "/api/watch/ingest", 1024)).status, 413);
});
