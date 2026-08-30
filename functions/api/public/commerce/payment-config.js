import { AuthFailure, errorResponse, jsonResponse } from "../../../_shared/auth-core.js";
import { paypalPublicConfiguration } from "../../../_shared/paypal-commerce.js";

export async function onRequest({request,env}){try{if(request.method!=="GET")throw new AuthFailure(405,"method_not_allowed","This method is not allowed.",{Allow:"GET"});return jsonResponse(await paypalPublicConfiguration(env),{headers:{"Cache-Control":"no-store"}});}catch(error){return errorResponse(error,request,env);}}

