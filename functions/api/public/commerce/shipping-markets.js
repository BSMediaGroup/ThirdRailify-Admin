import { AuthFailure, errorResponse, jsonResponse } from "../../../_shared/auth-core.js";
import { publicShippingMarketsPayload } from "../../../_shared/shipping-core.js";

export async function onRequest({ request, env }) {
  try {
    if (request.method !== "GET") throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET" });
    return jsonResponse(await publicShippingMarketsPayload(env));
  } catch (error) {
    return errorResponse(error, request, env);
  }
}
