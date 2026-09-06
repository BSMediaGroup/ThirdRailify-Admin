import { AuthFailure, jsonResponse, readJsonBody, resolveSession } from "../../_shared/auth-core.js";
import { offerCheckoutAgreement } from "../../_shared/commerce-agreements.js";
import { checkoutCorsHeaders, checkoutErrorResponse, handleOptions, requirePublicOrigin } from "./checkout.js";

export async function onRequest({request,env}) {
  try {
    if (request.method === "OPTIONS") return handleOptions(request,env);
    if (request.method !== "POST") throw new AuthFailure(405,"method_not_allowed","This method is not allowed.",{Allow:"POST, OPTIONS"});
    requirePublicOrigin(request,env);
    const payload = await offerCheckoutAgreement(env,request,await readJsonBody(request),await resolveSession(env,request));
    return jsonResponse(payload,{status:201,headers:checkoutCorsHeaders(request,env)});
  } catch (error) { return checkoutErrorResponse(error,request,env); }
}
