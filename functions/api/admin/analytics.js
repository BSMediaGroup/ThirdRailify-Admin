import { AuthFailure, corsHeaders, errorResponse, jsonResponse, normalizeOrigin, requireAdmin } from "../../_shared/auth-core.js";
import { analyticsReport } from "../../_shared/analytics.js";

export async function onRequest({ request, env }) {
  try {
    if (!new Set(["GET","HEAD"]).has(request.method)) throw new AuthFailure(405,"method_not_allowed","This method is not allowed.",{ Allow:"GET, HEAD" });
    const origin=normalizeOrigin(request.headers.get("origin")); const expected=normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
    if (origin&&origin!==expected) throw new AuthFailure(403,"origin_not_allowed","This request origin is not allowed.");
    await requireAdmin(env,request);
    const payload=await analyticsReport(env,new URL(request.url).searchParams.get("range")||"7d");
    return jsonResponse(request.method==="HEAD"?null:payload,{ headers:{ ...corsHeaders(request,env),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff" } });
  } catch (error) { return errorResponse(error,request,env); }
}
