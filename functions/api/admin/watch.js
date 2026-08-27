import {
  AuthFailure,
  errorResponse,
  hmacSha256,
  jsonResponse,
  normalizeOrigin,
  readJsonBody,
  requireCsrf,
  requireMasterAdmin,
  enforceRateLimit,
  writeAudit,
} from "../../_shared/auth-core.js";

const PUBLIC_PATH = "/api/watch/manage";
const ACTIONS = new Set(["read", "show", "hide", "show_all", "hide_all"]);
const EPISODE_ID = /^ep_[a-f0-9]{64}$/;

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "POST" });
    requireAdminOrigin(request, env);
    const session = await requireMasterAdmin(env, request);
    await requireCsrf(request, session);
    const body = await readJsonBody(request);
    validateAction(body);
    await enforceRateLimit(env, request, "watch", session.accountId);
    const result = await callPublicWatch(env, body, context.data?.watchFetch || fetch);
    if (body.action !== "read") {
      await writeAudit(env, {
        actorAccountId: session.accountId,
        eventType: `watch_archive_${body.action}`,
        result: "success",
        metadata: { episodeId: body.episodeId || null },
      });
    }
    return jsonResponse(result, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error, request, env); }
}

function validateAction(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !ACTIONS.has(body.action)) throw new AuthFailure(400, "watch_action_invalid", "Choose a supported Watch action.");
  const keys = Object.keys(body);
  const individual = body.action === "show" || body.action === "hide";
  if (individual) {
    if (keys.length !== 2 || !keys.includes("episodeId") || !EPISODE_ID.test(String(body.episodeId || ""))) throw new AuthFailure(400, "episode_id_invalid", "The episode identifier is invalid.");
  } else if (keys.length !== 1) throw new AuthFailure(400, "watch_action_invalid", "This Watch action does not accept an episode identifier.");
}

async function callPublicWatch(env, body, fetchImpl) {
  const secret = String(env?.THIRDRAILIFY_COMMUNITY_API_SECRET || "");
  const publicOrigin = configuredPublicOrigin(env);
  if (!secret) throw new AuthFailure(503, "watch_management_not_configured", "Watch archive management is not configured.");
  const read = body.action === "read";
  const method = read ? "GET" : "POST";
  const raw = read ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = await digestHex(new TextEncoder().encode(raw));
  const signature = await hmacSha256(secret, `${timestamp}\n${method}\n${PUBLIC_PATH}\n${digest}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetchImpl(`${publicOrigin}${PUBLIC_PATH}`, {
      method,
      headers: new Headers({
        Accept: "application/json",
        ...(!read ? { "Content-Type": "application/json" } : {}),
        "X-ThirdRailify-Timestamp": timestamp,
        "X-ThirdRailify-Signature": signature,
      }),
      ...(!read ? { body: raw } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    console.error(`watch management fetch failed type=${error?.constructor?.name || "Error"}`);
    throw new AuthFailure(503, "watch_management_unavailable", "The Watch archive service is temporarily unavailable.");
  }
  finally { clearTimeout(timeout); }
  const text = await response.text();
  if (text.length > 256 * 1024) throw new AuthFailure(502, "watch_management_invalid", "The Watch archive service returned an invalid response.");
  let payload;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!response.ok || !payload?.ok) {
    console.error(`watch management upstream rejected status=${response.status} code=${safeUpstreamCode(payload?.error)}`);
    const status = response.status === 404 && payload?.error === "episode_not_found" ? 404 : response.status >= 500 ? 503 : 502;
    throw new AuthFailure(status, payload?.error === "episode_not_found" ? "episode_not_found" : "watch_management_unavailable", payload?.error === "episode_not_found" ? "The retained episode was not found." : "The Watch archive service is temporarily unavailable.");
  }
  return payload;
}

function safeUpstreamCode(value) {
  const code = String(value || "unknown");
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : "invalid";
}

function configuredPublicOrigin(env) {
  const raw = String(env?.THIRDRAILIFY_PUBLIC_ORIGIN || "");
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid");
    return url.origin;
  } catch {
    throw new AuthFailure(503, "watch_management_not_configured", "Watch archive management is not configured.");
  }
}

function requireAdminOrigin(request, env) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const expected = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  if (!origin || origin !== expected) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed.");
}

async function digestHex(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { callPublicWatch, configuredPublicOrigin, validateAction };
