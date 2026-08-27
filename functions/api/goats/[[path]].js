import { AuthFailure, errorResponse, jsonResponse } from "../../_shared/auth-core.js";
import {
  createComment,
  createDraft,
  deleteComment,
  dispatchReadyEmails,
  finaliseDraft,
  mediaResponse,
  mutateReaction,
  publicComments,
  publicCommunityConfig,
  publicListingBySlug,
  publicListings,
  publicMapGeoJson,
  publicProducts,
  uploadDraftMedia,
  verifyInternalRequest,
} from "../../_shared/goats-core.js";

const ROUTE_PREFIX = "/api/goats";
const PUBLIC_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=900";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    const path = new URL(request.url).pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET" || request.method === "HEAD") return await handleRead(request, env, path);
    if (request.method === "POST" || request.method === "DELETE") return await handleInternal(request, env, path, context.data?.goatsFetch || fetch, context.waitUntil?.bind(context));
    throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET,HEAD,POST,DELETE" });
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

async function handleRead(request, env, path) {
  const url = new URL(request.url);
  if (path === "config") return cached(await publicCommunityConfig(env), PUBLIC_CACHE);
  if (path === "products") return cached(await publicProducts(env), PUBLIC_CACHE);
  if (!path || path === "listings") return cached(await publicListings(env, queryInput(url)), PUBLIC_CACHE);
  if (path === "map") return cached(await publicMapGeoJson(env, queryInput(url)), PUBLIC_CACHE);
  if (path.startsWith("media/")) return mediaResponse(env, path.slice("media/".length), request);
  const commentMatch = path.match(/^listings\/([^/]+)\/comments$/);
  if (commentMatch) {
    const accountId = clean(request.headers.get("x-thirdrailify-account-id"), 160);
    return cached(await publicComments(env, decodePart(commentMatch[1]), { ...queryInput(url), accountId }), accountId ? "private, no-store" : PUBLIC_CACHE);
  }
  const listingMatch = path.match(/^listings\/([^/]+)$/);
  if (listingMatch) {
    const accountId = clean(request.headers.get("x-thirdrailify-account-id"), 160);
    return cached(await publicListingBySlug(env, decodePart(listingMatch[1]), accountId), accountId ? "private, no-store" : PUBLIC_CACHE);
  }
  throw new AuthFailure(404, "not_found", "The GOATS route was not found.");
}

async function handleInternal(request, env, path, fetchImpl, waitUntil) {
  if (!path.startsWith("internal/")) throw new AuthFailure(404, "not_found", "The GOATS route was not found.");
  const contentType = String(request.headers.get("content-type") || "");
  if (path === "internal/drafts/media") {
    const bytes = await request.arrayBuffer();
    await verifyInternalRequest(request, env, bytes);
    const payload = await uploadDraftMedia(
      env,
      request.headers.get("x-goats-draft-token"),
      request.headers.get("x-goats-media-role"),
      request.headers.get("x-goats-media-order"),
      bytes,
      contentType,
      { rateKey: request.headers.get("x-goats-rate-key") },
    );
    return noStore(payload);
  }
  if (!contentType.toLowerCase().startsWith("application/json")) throw new AuthFailure(415, "content_type_invalid", "JSON is required.");
  const rawBody = await request.text();
  await verifyInternalRequest(request, env, rawBody);
  if (rawBody.length > 64 * 1024) throw new AuthFailure(413, "request_too_large", "The request is too large.");
  let body;
  try { body = JSON.parse(rawBody || "{}"); } catch { throw new AuthFailure(400, "invalid_json", "The request body is invalid."); }
  const actorContext = { accountId: clean(body.accountId, 160), rateKey: clean(body.rateKey, 160), fetchImpl };
  if (request.method === "POST" && path === "internal/drafts") {
    const headers = new Headers(request.headers); if (body.clientIp) headers.set("CF-Connecting-IP", clean(body.clientIp, 80));
    return noStore(await createDraft(env, new Request(request.url, { method: "POST", headers, body: rawBody }), body, actorContext));
  }
  if (request.method === "POST" && path === "internal/drafts/finalise") {
    const result = await finaliseDraft(env, body.draftToken, body, actorContext);
    const row = await env.THIRDRAILIFY_COMMERCE_DB.prepare("SELECT id FROM community_submissions WHERE reference_code = ?").bind(result.reference).first();
    if (row?.id && waitUntil) waitUntil(dispatchReadyEmails(env, row.id, null, fetchImpl));
    return noStore(result);
  }
  const reaction = path.match(/^internal\/listings\/([^/]+)\/reaction$/);
  if (request.method === "POST" && reaction) return noStore(await mutateReaction(env, decodePart(reaction[1]), body.accountId, body.value, actorContext));
  const comments = path.match(/^internal\/listings\/([^/]+)\/comments$/);
  if (request.method === "POST" && comments) return noStore(await createComment(env, decodePart(comments[1]), body, body.body, actorContext));
  const comment = path.match(/^internal\/comments\/([^/]+)$/);
  if (request.method === "DELETE" && comment) return noStore(await deleteComment(env, decodePart(comment[1]), body.accountId));
  throw new AuthFailure(404, "not_found", "The GOATS action was not found.");
}

function queryInput(url) {
  return { page: url.searchParams.get("page"), pageSize: url.searchParams.get("pageSize"), search: url.searchParams.get("search"), product: url.searchParams.get("product"), country: url.searchParams.get("country"), rating: url.searchParams.get("rating"), sort: url.searchParams.get("sort") };
}

function cached(payload, cacheControl) {
  return jsonResponse(payload, { headers: { "Cache-Control": cacheControl, ETag: `W/\"${simpleHash(JSON.stringify(payload))}\"`, "X-Content-Type-Options": "nosniff" } });
}
function noStore(payload) { return jsonResponse(payload, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function clean(value, max) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max); }
function decodePart(value) { try { return decodeURIComponent(value); } catch { return ""; } }
function simpleHash(value) { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619); return (hash >>> 0).toString(16); }

export { handleInternal, handleRead };
