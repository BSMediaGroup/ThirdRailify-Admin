import { AuthFailure, jsonResponse } from "../../../_shared/auth-core.js";
import { publicOrderStatusPayload } from "../../../_shared/checkout-core.js";

export async function onRequestGet({ request, env }) {
  try {
    const sessionId = new URL(request.url).searchParams.get("session_id");
    return jsonResponse(await publicOrderStatusPayload(env, sessionId), { status: 200 });
  } catch (error) {
    if (error instanceof AuthFailure) {
      return jsonResponse({ ok: false, error: error.code, message: error.message }, { status: error.status });
    }
    return jsonResponse({ ok: false, error: "checkout_status_unavailable", message: "Checkout status is temporarily unavailable." }, { status: 500 });
  }
}
