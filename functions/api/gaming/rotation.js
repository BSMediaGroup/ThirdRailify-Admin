import { errorResponse, jsonResponse } from "../../_shared/auth-core.js";
import { publicGamingRotation } from "../../_shared/gaming-core.js";

export async function onRequestGet({ request, env }) {
  try { return jsonResponse(await publicGamingRotation(env), { headers: { "Cache-Control": "public, max-age=60, s-maxage=180, stale-while-revalidate=600" } }); }
  catch (error) { return errorResponse(error, request, env); }
}

export function onRequestHead(context) { return onRequestGet(context).then((response) => new Response(null, response)); }
