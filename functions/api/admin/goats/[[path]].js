import {
  AuthFailure,
  corsHeaders,
  errorResponse,
  jsonResponse,
  normalizeOrigin,
  readJsonBody,
  requireCsrf,
} from "../../../_shared/auth-core.js";
import { requireAdminCapability } from "../../../_shared/admin-capabilities.js";
import {
  adminOverview,
  adminEngagementSettings,
  adminCommunityProducts,
  adminComments,
  adminQueue,
  adminSubmission,
  cleanupExpiredDrafts,
  emailTemplates,
  deleteDemoSubmission,
  dispatchReadyEmails,
  mediaResponse,
  uploadAdminMedia,
  deleteAdminMedia,
  moderateComment,
  resetSubmissionReactions,
  retryEmail,
  transitionSubmission,
  updateEmailTemplate,
  updateSubmission,
  updateAdminEngagementSettings,
} from "../../../_shared/goats-core.js";

const ROUTE_PREFIX = "/api/admin/goats";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    requireAdminOriginWhenPresent(request, env);
    const session = await requireAdminCapability(env, request, request.method === "POST" ? "goats.manage" : "goats.view");
    const path = new URL(request.url).pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET" || request.method === "HEAD") return await read(request, env, path, session);
    if (request.method === "POST") {
      requireAdminOrigin(request, env); await requireCsrf(request, session);
      return await write(request, env, path, session, context.data?.goatsFetch || fetch, context.waitUntil?.bind(context));
    }
    throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET,HEAD,POST" });
  } catch (error) { return errorResponse(error, request, env); }
}

async function read(request, env, path) {
  const url = new URL(request.url);
  if (!path || path === "overview") return response(await adminOverview(env), request, env);
  if (path === "queue") return response(await adminQueue(env, url.searchParams.get("status")), request, env);
  if (path === "templates") return response(await emailTemplates(env), request, env);
  if (path === "comments") return response(await adminComments(env, url.searchParams.get("status")), request, env);
  if (path === "settings") return response(await adminEngagementSettings(env), request, env);
  if (path === "products") return response(await adminCommunityProducts(env), request, env);
  if (path.startsWith("media/")) return mediaResponse(env, path.slice("media/".length), request, { admin: true });
  const match = path.match(/^submissions\/([^/]+)$/);
  if (match) return response(await adminSubmission(env, decodePart(match[1])), request, env);
  throw new AuthFailure(404, "not_found", "The GOATS Admin route was not found.");
}

async function write(request, env, path, session, fetchImpl, waitUntil) {
  const mediaUpload = path.match(/^submissions\/([^/]+)\/media$/);
  if (mediaUpload) {
    const url = new URL(request.url);
    return response(await uploadAdminMedia(env, decodePart(mediaUpload[1]), url.searchParams.get("role"), await request.arrayBuffer(), request.headers.get("content-type"), session.accountId, url.searchParams.get("replace")), request, env);
  }
  const body = await readJsonBody(request);
  const submission = path.match(/^submissions\/([^/]+)$/);
  if (submission) return response(await updateSubmission(env, decodePart(submission[1]), body.version, body, session.accountId), request, env);
  const transition = path.match(/^submissions\/([^/]+)\/(approve|reject|hide|restore)$/);
  if (transition) {
    const result = await transitionSubmission(env, decodePart(transition[1]), body.version, transition[2], body, session.accountId);
    if (waitUntil && new Set(["approve", "reject"]).has(transition[2])) waitUntil(dispatchReadyEmails(env, result.item.id, session.accountId, fetchImpl));
    return response(result, request, env);
  }
  const demoDelete = path.match(/^submissions\/([^/]+)\/delete-demo$/);
  if (demoDelete) return response(await deleteDemoSubmission(env, decodePart(demoDelete[1]), body.version, session.accountId), request, env);
  const mediaDelete = path.match(/^submissions\/([^/]+)\/media\/([^/]+)\/delete$/);
  if (mediaDelete) return response(await deleteAdminMedia(env, decodePart(mediaDelete[1]), decodePart(mediaDelete[2]), session.accountId), request, env);
  const reactionReset = path.match(/^submissions\/([^/]+)\/reactions\/reset$/);
  if (reactionReset) return response(await resetSubmissionReactions(env, decodePart(reactionReset[1]), body.version, session.accountId), request, env);
  const comment = path.match(/^comments\/([^/]+)\/(approve|hide|restore)$/);
  if (comment) return response(await moderateComment(env, decodePart(comment[1]), comment[2], session.accountId), request, env);
  if (path === "settings") return response(await updateAdminEngagementSettings(env, body, session.accountId), request, env);
  const template = path.match(/^templates\/([^/]+)$/);
  if (template) return response(await updateEmailTemplate(env, decodePart(template[1]), body, session.accountId), request, env);
  const email = path.match(/^emails\/([^/]+)\/retry$/);
  if (email) return response(await retryEmail(env, decodePart(email[1]), session.accountId, fetchImpl), request, env);
  if (path === "maintenance/cleanup-drafts") return response(await cleanupExpiredDrafts(env, session.accountId, body.limit), request, env);
  throw new AuthFailure(404, "not_found", "The GOATS Admin action was not found.");
}

function response(payload, request, env) { return jsonResponse(payload, { headers: { ...corsHeaders(request, env), "Cache-Control": "no-store" } }); }
function requireAdminOriginWhenPresent(request, env) { if (request.headers.get("origin")) requireAdminOrigin(request, env); }
function requireAdminOrigin(request, env) { const origin = normalizeOrigin(request.headers.get("origin")); const expected = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN); if (!origin || origin !== expected) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed."); }
function decodePart(value) { try { return decodeURIComponent(value); } catch { return ""; } }
