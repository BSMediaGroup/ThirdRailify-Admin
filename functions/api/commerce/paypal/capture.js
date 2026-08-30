import { AuthFailure, jsonResponse, readJsonBody } from "../../../_shared/auth-core.js";
import { capturePayPalPayment } from "../../../_shared/paypal-commerce.js";
import { checkoutCorsHeaders, checkoutErrorResponse, handleOptions, requirePublicOrigin } from "../checkout.js";

export async function onRequest({request,env,data={}}){try{if(request.method==="OPTIONS")return handleOptions(request,env);if(request.method!=="POST")throw new AuthFailure(405,"method_not_allowed","This method is not allowed.",{Allow:"POST, OPTIONS"});requirePublicOrigin(request,env);const payload=await capturePayPalPayment(env,request,await readJsonBody(request),data.paypalFetch||fetch);return jsonResponse(payload,{headers:checkoutCorsHeaders(request,env)});}catch(error){return checkoutErrorResponse(error,request,env);}}

