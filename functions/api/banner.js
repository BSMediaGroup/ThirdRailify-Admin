import { errorResponse, jsonResponse } from "../_shared/auth-core.js";
import { publicBannerProjection, readBannerSettings } from "../_shared/banner-core.js";

export async function onRequestGet({ request, env }) {
  try {
    return jsonResponse(publicBannerProjection(await readBannerSettings(env)), { headers: { "Cache-Control": "public, max-age=60, s-maxage=180, stale-while-revalidate=600", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error, request, env); }
}

export async function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return jsonResponse({ ok: false, error: "method_not_allowed", message: "This method is not allowed." }, { status: 405, headers: { Allow: "GET" } });
}
