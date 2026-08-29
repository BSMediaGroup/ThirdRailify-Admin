import {
  AuthFailure,
  jsonResponse,
  normalizeOrigin,
  readJsonBody,
  resolveSession,
} from "../../_shared/auth-core.js";
import { createStripeCheckoutSession } from "../../_shared/checkout-core.js";
import { requireCommerceDb } from "../../_shared/commerce-core.js";

export async function onRequest(context) {
  const { request, env, data = {} } = context;
  try {
    if (request.method === "OPTIONS") return handleOptions(request, env);
    if (request.method !== "POST") {
      throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "POST, OPTIONS" });
    }
    return await handleCheckoutPost(request, env, data.checkoutFetch || fetch);
  } catch (error) {
    return checkoutErrorResponse(error, request, env);
  }
}

export async function handleCheckoutPost(request, env, fetchImpl = fetch) {
  requirePublicOrigin(request, env);
  requireCommerceDb(env);
  const body = await readJsonBody(request);
  const session = await resolveSession(env, request);
  const payload = await createStripeCheckoutSession(env, request, body, fetchImpl, { session });
  return jsonResponse(payload, { status: 201, headers: checkoutCorsHeaders(request, env) });
}

function handleOptions(request, env) {
  requirePublicOrigin(request, env);
  return new Response(null, {
    status: 204,
    headers: {
      ...checkoutCorsHeaders(request, env),
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function requirePublicOrigin(request, env) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const publicOrigin = normalizeOrigin(env?.THIRDRAILIFY_PUBLIC_ORIGIN);
  if (!origin || !publicOrigin || origin !== publicOrigin) {
    throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed.");
  }
  return origin;
}

function checkoutCorsHeaders(request, env) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const publicOrigin = normalizeOrigin(env?.THIRDRAILIFY_PUBLIC_ORIGIN);
  if (!origin || origin !== publicOrigin) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

function checkoutErrorResponse(error, request, env) {
  if (error instanceof AuthFailure) {
    return jsonResponse(
      { ok: false, error: error.code, message: error.message },
      { status: error.status, headers: { ...checkoutCorsHeaders(request, env), ...error.headers } },
    );
  }
  return jsonResponse(
    { ok: false, error: "checkout_unavailable", message: "Checkout is temporarily unavailable." },
    { status: 500, headers: checkoutCorsHeaders(request, env) },
  );
}

export { checkoutCorsHeaders, checkoutErrorResponse, handleOptions, requirePublicOrigin };
