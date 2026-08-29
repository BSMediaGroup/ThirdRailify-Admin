import { AuthFailure, jsonResponse, readJsonBody } from "../../_shared/auth-core.js";
import { checkoutCorsHeaders, checkoutErrorResponse, handleOptions, requirePublicOrigin } from "./checkout.js";
import { createShippingQuote } from "../../_shared/shipping-core.js";

export async function onRequest({ request, env, data = {} }) {
  try {
    if (request.method === "OPTIONS") return handleOptions(request, env);
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "POST, OPTIONS" });
    requirePublicOrigin(request, env);
    const payload = await createShippingQuote(env, request, await readJsonBody(request), data.shippingFetch || fetch);
    return jsonResponse(payload, { status: 201, headers: checkoutCorsHeaders(request, env) });
  } catch (error) {
    return checkoutErrorResponse(error, request, env);
  }
}
