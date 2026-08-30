const ALLOWED_ORIGIN = /^(?:https:\/\/(?:admin\.)?thirdrailify\.com|https:\/\/(?:[a-z0-9-]+\.)?thirdrailify(?:-admin)?\.pages\.dev)$/i;
const PRODUCT = /^\/commerce-media\/([a-f0-9]{64}\.(?:jpg|png|webp))$/;
const AVATAR = /^\/(u\/[a-f0-9]{20}\/avatar\/[a-f0-9]{64}\.(?:jpg|png|webp))$/;
const GOAT = /^\/goats-media\/([a-f0-9-]{36})$/;
const WHEEL = /^\/wheel-media\/([a-f0-9-]{16,80})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return preflight(request);
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method Not Allowed", { Allow: "GET, HEAD, OPTIONS" });
    if (url.search || url.hash) return plain(404, "Not Found");

    let key;
    let metadata;
    const product = url.pathname.match(PRODUCT);
    const avatar = url.pathname.match(AVATAR);
    const goat = url.pathname.match(GOAT);
    const wheel = url.pathname.match(WHEEL);
    if (product) key = `commerce/catalogue/${product[1]}`;
    else if (avatar) key = avatar[1];
    else if (goat) {
      metadata = await env.COMMERCE_DB.prepare(`SELECT m.object_key, m.content_type, m.byte_size, m.sha256
        FROM community_media m JOIN community_submissions s ON s.id = m.submission_id
        WHERE m.id = ? AND m.processing_state = 'ready' AND s.status = 'approved' AND s.is_published = 1 LIMIT 1`).bind(goat[1]).first();
      key = metadata?.object_key;
    } else if (wheel) {
      metadata = await env.COMMERCE_DB.prepare(`SELECT a.object_key, a.content_type, a.byte_size, a.sha256
        FROM wheel_media_assets a JOIN wheels w ON w.id = a.wheel_id
        WHERE a.id = ? AND a.lifecycle = 'active' AND w.lifecycle = 'active' AND w.visibility = 'public' LIMIT 1`).bind(wheel[1]).first();
      key = metadata?.object_key;
    }
    if (!key) return plain(404, "Not Found");

    const object = request.method === "HEAD"
      ? await env.MEDIA.head(key)
      : await env.MEDIA.get(key);
    if (!object) return plain(404, "Not Found");
    const headers = assetHeaders(request, object, metadata);
    if (request.method !== "HEAD" && etagMatches(request.headers.get("If-None-Match"), headers.get("ETag"))) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
  },
};

function etagMatches(condition, etag) {
  if (!condition || !etag) return false;
  const normalizedEtag = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  return condition.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//, "").replace(/^"|"$/g, "") === normalizedEtag;
  });
}

function assetHeaders(request, object, metadata) {
  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Content-Type", metadata?.content_type || headers.get("Content-Type") || "application/octet-stream");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Vary", "Origin");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  else if (metadata?.sha256) headers.set("ETag", `\"${metadata.sha256}\"`);
  if (Number.isFinite(object.size ?? Number(metadata?.byte_size))) headers.set("Content-Length", String(object.size ?? metadata.byte_size));
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGIN.test(origin)) headers.set("Access-Control-Allow-Origin", origin);
  if (headers.get("Content-Type") === "image/svg+xml") headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  return headers;
}

function preflight(request) {
  const origin = request.headers.get("Origin") || "";
  const method = request.headers.get("Access-Control-Request-Method") || "";
  if (!ALLOWED_ORIGIN.test(origin) || !new Set(["GET", "HEAD"]).has(method)) return plain(403, "Forbidden");
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Max-Age": "86400", Vary: "Origin, Access-Control-Request-Method" } });
}

function plain(status, message, extra = {}) {
  return new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", ...extra } });
}
