const REPLAY_WINDOW_SECONDS = 300;
const STATE_SINGLETON_NAME = "thirdrailify-public-state";

export async function proxyPublicIngest(request, env, pathname, maximumBytes) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  const contentType = String(request.headers.get("Content-Type") || "");
  if (!contentType.toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > maximumBytes) return json({ error: "payload_too_large" }, 413);
  const body = new Uint8Array(await request.arrayBuffer());
  if (!body.byteLength || body.byteLength > maximumBytes) return json({ error: "payload_too_large" }, 413);
  const timestamp = request.headers.get("X-ThirdRailify-Timestamp") || "";
  const signature = request.headers.get("X-ThirdRailify-Signature") || "";
  const signatureState = await validateSignature(body, timestamp, signature, env?.THIRDRAILIFY_COMMUNITY_INGEST_SECRET);
  if (signatureState === "unconfigured") return json({ error: "public_ingest_not_configured" }, 503);
  if (signatureState !== "valid") return json({ error: `invalid_signature_${signatureState}` }, 401);

  let snapshot;
  try { snapshot = JSON.parse(new TextDecoder().decode(body)); }
  catch { return json({ error: "invalid_json" }, 400); }
  const active = Array.isArray(snapshot?.liveNow) && snapshot.liveNow.length > 0 || Boolean(snapshot?.upcoming);
  const checkpointSeconds = pathname === "/api/watch/ingest" ? active ? 150 : 600 : 600;
  const statePath = pathname === "/api/watch/ingest" ? "/watch/ingest" : "/snapshot/community";
  try {
    const namespace = env?.THIRDRAILIFY_PUBLIC_STATE;
    if (!namespace) return json({ error: "public_ingest_not_configured" }, 503);
    const id = namespace.idFromName(STATE_SINGLETON_NAME);
    const upstream = await namespace.get(id).fetch(new Request(`https://thirdrailify-state.internal${statePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot, checkpointSeconds }),
    }));
    if (upstream.status === 400) return json({ error: "invalid_snapshot" }, 400);
    if (!upstream.ok) return json({ error: "public_ingest_unavailable" }, 503);
    const result = await upstream.json();
    return new Response(null, { status: 204, headers: {
      "Cache-Control": "no-store",
      "X-ThirdRailify-Persisted": String(result.persisted === true),
      "X-ThirdRailify-Persist-Reason": String(result.reason || "unknown"),
      "X-ThirdRailify-DO-Writes": String(Number(result.storageWrites || 0)),
      "X-ThirdRailify-KV-Writes": "0",
    } });
  } catch { return json({ error: "public_ingest_unavailable" }, 503); }
}

async function validateSignature(body, timestamp, signature, secret) {
  if (typeof secret !== "string" || !secret) return "unconfigured";
  if (!/^\d{10}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return "malformed";
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > REPLAY_WINDOW_SECONDS) return "stale";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix); signed.set(body, prefix.byteLength);
  const signatureBytes = Uint8Array.from(signature.slice(7).match(/../g), (value) => Number.parseInt(value, 16));
  return await crypto.subtle.verify("HMAC", key, signatureBytes, signed) ? "valid" : "mismatch";
}

function json(value, status, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...extra } });
}
