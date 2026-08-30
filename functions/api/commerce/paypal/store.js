import { AuthFailure, readJsonBody, resolveSession } from "../../../_shared/auth-core.js";
import { createPayPalStorePayment } from "../../../_shared/paypal-commerce.js";
import { checkoutCorsHeaders, checkoutErrorResponse, handleOptions, requirePublicOrigin } from "../checkout.js";
import { jsonResponse } from "../../../_shared/auth-core.js";

export async function onRequest({request,env,data={}}){try{if(request.method==="OPTIONS")return handleOptions(request,env);if(request.method!=="POST")throw new AuthFailure(405,"method_not_allowed","This method is not allowed.",{Allow:"POST, OPTIONS"});requirePublicOrigin(request,env);const payload=await createPayPalStorePayment(env,request,await readJsonBody(request),await resolveSession(env,request),data.paypalFetch||fetch);return jsonResponse(payload,{status:201,headers:checkoutCorsHeaders(request,env)});}catch(error){return checkoutErrorResponse(error,request,env);}}

