import { AuthFailure, enforceRateLimit, errorResponse, jsonResponse, nowIso } from "../../_shared/auth-core.js";
import { requireCommerceDb } from "../../_shared/commerce-core.js";
import { paypalCredentials, PAYPAL_WEBHOOK_EVENTS, verifyPayPalWebhook } from "../../_shared/paypal-client.js";
import { reduceVerifiedPayPalEvent } from "../../_shared/paypal-commerce.js";

const MAX_BODY_BYTES = 1024 * 1024;
const TOLERANCE_MS = 5 * 60 * 1000;
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function onRequest({ request, env, data = {} }) {
  try {
    if (request.method !== "POST") throw new AuthFailure(405,"method_not_allowed","This method is not allowed.",{Allow:"POST"});
    return await handlePayPalWebhook(request,env,data.paypalFetch||fetch);
  } catch (error) {
    if(error instanceof AuthFailure)return errorResponse(error,request,env);
    return jsonResponse({ok:false,error:"paypal_webhook_unavailable",message:"PayPal webhook delivery is temporarily unavailable."},{status:500});
  }
}

export async function handlePayPalWebhook(request,env,fetchImpl=fetch,now=Date.now()) {
  requireCommerceDb(env);
  if(!/^application\/json(?:\s*;|$)/i.test(String(request.headers.get("content-type")||""))) throw new AuthFailure(415,"content_type_invalid","PayPal webhooks require application/json.");
  const headers=requiredHeaders(request);
  const transmittedAt=Date.parse(headers.transmissionTime);
  if(!Number.isFinite(transmittedAt)||Math.abs(now-transmittedAt)>TOLERANCE_MS) throw new AuthFailure(400,"paypal_transmission_time_invalid","The PayPal transmission timestamp is outside the accepted window.");
  await enforceRateLimit(env,request,"paypal-webhook",headers.transmissionId);
  const rawBytes=await readBoundedBody(request);
  let rawText,event;
  try{rawText=decoder.decode(rawBytes);event=JSON.parse(rawText);}catch{throw new AuthFailure(400,"paypal_event_invalid","The PayPal event payload is invalid.");}
  const normalized=normalizeEvent(event);
  const environment=webhookEnvironment(headers.certUrl);
  const credentials=paypalCredentials(env,environment);
  const simulator=credentials.webhookId==="WEBHOOK_ID"&&String(env?.PAYPAL_ALLOW_SIMULATOR_WEBHOOKS||"").toLowerCase()==="true";
  if(!credentials.webhookId) throw new AuthFailure(503,"paypal_webhook_not_configured",`PayPal ${environment.toUpperCase()} webhook verification is not configured.`);
  if(!simulator){
    await verifyPayPalWebhook(env,environment,{auth_algo:headers.authAlgo,cert_url:headers.certUrl,transmission_id:headers.transmissionId,transmission_sig:headers.transmissionSignature,transmission_time:headers.transmissionTime,webhook_id:credentials.webhookId},rawText,fetchImpl);
  }
  const receivedAt=nowIso(now); const payloadSha256=await sha256Hex(rawBytes);
  const result=await reduceVerifiedPayPalEvent(env,normalized,{environment:simulator?"simulator":environment,transmissionId:headers.transmissionId,payloadSha256,receivedAt});
  return jsonResponse({ok:true,received:true,duplicate:result.duplicate,eventId:normalized.id,result:result.result});
}

export function normalizeEvent(event){
  if(!event||typeof event!=="object"||Array.isArray(event))throw new AuthFailure(400,"paypal_event_invalid","The PayPal event envelope is invalid.");
  const id=safeId(event.id,80),type=String(event.event_type||"");
  if(!id||!PAYPAL_WEBHOOK_EVENTS.includes(type))throw new AuthFailure(400,"paypal_event_type_invalid","The PayPal event type is not accepted.");
  const createTime=String(event.create_time||""); if(createTime&&!Number.isFinite(Date.parse(createTime)))throw new AuthFailure(400,"paypal_event_time_invalid","The PayPal event time is invalid.");
  const resource=event.resource&&typeof event.resource==="object"&&!Array.isArray(event.resource)?event.resource:{};
  const captureEvent=type.startsWith("PAYMENT.CAPTURE.");
  const orderId=safeId(captureEvent?resource.supplementary_data?.related_ids?.order_id:resource.id,80);
  const captureId=captureEvent?safeId(resource.id,80):null;
  const value=captureEvent?String(resource.amount?.value||""):""; const amount=/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value)?Number(value.split(".")[0])*100+Number(value.split(".")[1]):null;
  if(!orderId||(captureEvent&&(!captureId||!Number.isSafeInteger(amount)||String(resource.amount?.currency_code||"").toUpperCase()!=="CAD")))throw new AuthFailure(400,"paypal_event_resource_invalid","The PayPal event resource is invalid.");
  return{id,type,createTime:createTime||null,orderId,captureId,amount:Number.isSafeInteger(amount)?amount:null,currency:captureEvent?String(resource.amount?.currency_code||"").toUpperCase():null,merchantId:safeId(resource.payee?.merchant_id,80)};
}

function requiredHeaders(request){const fields={transmissionId:header(request,"paypal-transmission-id",80),transmissionTime:header(request,"paypal-transmission-time",100),transmissionSignature:header(request,"paypal-transmission-sig",500),certUrl:header(request,"paypal-cert-url",500),authAlgo:header(request,"paypal-auth-algo",100)};if(Object.values(fields).some((value)=>!value))throw new AuthFailure(400,"paypal_headers_required","Required PayPal transmission headers are missing.");if(!/^[A-Za-z0-9]+$/.test(fields.authAlgo))throw new AuthFailure(400,"paypal_auth_algorithm_invalid","The PayPal authentication algorithm is invalid.");return fields;}
function header(request,name,max){const value=String(request.headers.get(name)||"").trim();return value&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value:"";}
function webhookEnvironment(certUrl){let url;try{url=new URL(certUrl);}catch{throw new AuthFailure(400,"paypal_certificate_url_invalid","The PayPal certificate URL is invalid.");}const host=url.hostname.toLowerCase();if(url.protocol!=="https:"||url.username||url.password||(host!=="paypal.com"&&!host.endsWith(".paypal.com")))throw new AuthFailure(400,"paypal_certificate_url_invalid","The PayPal certificate URL is invalid.");return host.includes("sandbox")?"sandbox":"live";}
async function readBoundedBody(request){const declared=Number(request.headers.get("content-length")||0);if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES)throw new AuthFailure(413,"request_too_large","The request body is too large.");if(!request.body)return new Uint8Array();const reader=request.body.getReader(),chunks=[];let total=0;while(true){const{done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BODY_BYTES){await reader.cancel();throw new AuthFailure(413,"request_too_large","The request body is too large.");}chunks.push(value);}const body=new Uint8Array(total);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}return body;}
function safeId(value,max){const text=String(value||"").trim();return text&&text.length<=max&&/^[A-Za-z0-9_-]+$/.test(text)?text:null;}
async function sha256Hex(bytes){const digest=await crypto.subtle.digest("SHA-256",bytes);return[...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");}
