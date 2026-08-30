import { errorResponse, jsonResponse } from "../../../_shared/auth-core.js";
import { ingestAnalyticsEvent, readAnalyticsBody, verifyAnalyticsIngest } from "../../../_shared/analytics.js";

export async function onRequest({ request, env }) {
  try {
    if (request.method !== "POST") return jsonResponse({ ok:false,error:"method_not_allowed",message:"This method is not allowed." },{ status:405,headers:{ Allow:"POST","Cache-Control":"no-store" } });
    const { body, raw } = await readAnalyticsBody(request);
    await verifyAnalyticsIngest(request,env,raw);
    return jsonResponse(await ingestAnalyticsEvent(env,body),{ headers:{ "Cache-Control":"no-store","X-Content-Type-Options":"nosniff" } });
  } catch (error) { return errorResponse(error,request,env); }
}
