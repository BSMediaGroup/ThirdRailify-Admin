import {
  AuthFailure,
  cleanText,
  enforceRateLimit,
  errorResponse,
  hmacSha256,
  jsonResponse,
  timingSafeEqual,
  verifyTurnstile,
} from "../../_shared/auth-core.js";
import { adminInboxMessageStatement } from "../../_shared/admin-inbox.js";

const PATHNAME = "/api/gaming/suggestions";
const TURNSTILE_ACTION = "thirdrailify-gaming-suggestion";
const MAX_BODY_BYTES = 8 * 1024;
const encoder = new TextEncoder();

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "POST" });
    requirePublicOrigin(request, env);
    const raw = await readRawJson(request);
    await verifyRelay(request, env, raw);
    const body = parseBody(raw);
    if (cleanText(body.website, 120)) return response({ ok: true, reference: "GAM-RECEIVED" });

    const requestId = requiredRequestId(body.requestId);
    const rateKey = requiredRateKey(body.rateKey);
    const gameTitle = requiredTitle(body.gameTitle);
    const pitch = optionalPitch(body.pitch);
    const steam = normalizeSteamUrl(body.steamUrl);
    const accountId = optionalIdentity(body.accountId, 160);
    const displayName = optionalIdentity(body.displayName, 80);

    await enforceRateLimit(env, request, "gaming_suggestion", rateKey);
    await verifyTurnstile(env, request, body.turnstileToken, TURNSTILE_ACTION, context.data?.gamingFetch || fetch);

    const timestamp = new Date().toISOString();
    const requester = accountId ? `${displayName || "Signed-in account"} (${accountId})` : "Guest request";
    const bodyText = [
      `Game title: ${gameTitle}`,
      `Playback environment: PC via Steam`,
      `Steam Store URL: ${steam.url || "Not provided"}`,
      `Steam App ID: ${steam.appId || "Not provided"}`,
      `Pitch: ${pitch || "Not provided"}`,
      `Requester: ${requester}`,
    ].join("\n");
    const result = await adminInboxMessageStatement(env, {
      category: "gaming",
      sourceType: "gaming_suggestion",
      sourceId: requestId,
      title: `Gaming request: ${gameTitle}`,
      preview: `${displayName || "A guest"} suggested ${gameTitle}.`,
      bodyText,
      actionUrl: null,
      actionLabel: null,
    }, timestamp).run();
    const reference = `GAM-${requestId.slice(0, 8).toUpperCase()}`;
    return response({ ok: true, reference, idempotent: Number(result?.meta?.changes || 0) === 0 });
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

function requirePublicOrigin(request, env) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const expected = normalizeOrigin(env?.THIRDRAILIFY_PUBLIC_ORIGIN);
  if (!origin || origin !== expected) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed.");
}

async function readRawJson(request) {
  if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new AuthFailure(415, "content_type_required", "A JSON request body is required.");
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new AuthFailure(413, "request_too_large", "The request body is too large.");
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_BODY_BYTES) throw new AuthFailure(413, "request_too_large", "The request body is too large.");
  return raw;
}

function parseBody(raw) {
  try {
    const body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body;
  } catch { throw new AuthFailure(400, "invalid_json", "The request body is not valid JSON."); }
}

async function verifyRelay(request, env, raw) {
  const secret = String(env?.THIRDRAILIFY_COMMUNITY_API_SECRET || "");
  const timestamp = String(request.headers.get("x-thirdrailify-timestamp") || "");
  const signature = String(request.headers.get("x-thirdrailify-signature") || "");
  if (!secret || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new AuthFailure(401, "internal_signature_invalid", "The internal request could not be verified.");
  const digest = await digestHex(encoder.encode(raw));
  const expected = await hmacSha256(secret, `${timestamp}\nPOST\n${PATHNAME}\n${digest}`);
  if (!timingSafeEqual(expected, signature)) throw new AuthFailure(401, "internal_signature_invalid", "The internal request could not be verified.");
}

function requiredRequestId(value) {
  const id = cleanText(value, 40).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new AuthFailure(400, "gaming_request_invalid", "The Gaming request is invalid.");
  return id;
}

function requiredRateKey(value) {
  const key = cleanText(value, 80);
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new AuthFailure(401, "internal_signature_invalid", "The internal request could not be verified.");
  return key;
}

function requiredTitle(value) {
  const title = cleanText(value, 121);
  if (title.length < 2 || title.length > 120) throw new AuthFailure(400, "game_title_invalid", "Enter a game title between 2 and 120 characters.");
  rejectMarkup(title);
  return title;
}

function optionalPitch(value) {
  const raw = String(value || "").replace(/\r\n?/g, "\n");
  const pitch = Array.from(raw, (character) => { const code = character.codePointAt(0) || 0; return code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127 ? " " : character; }).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (pitch.length > 1000) throw new AuthFailure(400, "pitch_invalid", "Keep the pitch to 1,000 characters or fewer.");
  rejectMarkup(pitch);
  return pitch;
}

function rejectMarkup(value) {
  if (/<\/?[a-z][^>]*>/i.test(value)) throw new AuthFailure(400, "suggestion_markup_invalid", "Use plain text without HTML or scripts.");
}

function normalizeSteamUrl(value) {
  const source = String(value || "").trim();
  if (!source) return { url: null, appId: null };
  try {
    const url = new URL(source);
    const match = url.pathname.match(/^\/app\/(\d{1,10})(?:\/[A-Za-z0-9_-]+)?\/?$/);
    if (url.protocol !== "https:" || url.hostname !== "store.steampowered.com" || url.username || url.password || url.port || !match) throw new Error("invalid");
    return { url: `https://store.steampowered.com/app/${match[1]}/`, appId: match[1] };
  } catch { throw new AuthFailure(400, "steam_url_invalid", "Use an exact https://store.steampowered.com/app/... URL."); }
}

function optionalIdentity(value, max) { const text = cleanText(value, max); return text || null; }
function response(payload) { return jsonResponse(payload, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function normalizeOrigin(value) { try { const url = new URL(String(value || "")); return url.protocol === "https:" || url.protocol === "http:" && new Set(["localhost", "127.0.0.1"]).has(url.hostname) ? url.origin : ""; } catch { return ""; } }
async function digestHex(bytes) { const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export { MAX_BODY_BYTES, normalizeSteamUrl, verifyRelay };
