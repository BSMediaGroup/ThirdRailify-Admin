import { errorResponse } from "../../../_shared/auth-core.js";
import { gamingMediaResponse } from "../../../_shared/gaming-core.js";

export async function onRequest({ request, env, params }) {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET,HEAD" } });
    return await gamingMediaResponse(env, params.id, request);
  } catch (error) { return errorResponse(error, request, env); }
}
