import { errorResponse, jsonResponse } from "../../_shared/auth-core.js";
import { customerDocumentByToken } from "../../_shared/commerce-control-plane.js";

export async function onRequestGet({ request, env }) {
  try {
    const token = new URL(request.url).searchParams.get("token");
    const payload = await customerDocumentByToken(env, token);
    return jsonResponse(payload, { headers: { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } });
  } catch (error) {
    return errorResponse(error, request, env);
  }
}
