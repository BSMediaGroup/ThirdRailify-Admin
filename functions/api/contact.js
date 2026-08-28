import {
  AuthFailure,
  cleanText,
  corsHeaders,
  enforceRateLimit,
  errorResponse,
  escapeHtml,
  hmacSha256,
  jsonResponse,
  normalizeEmail,
  normalizeOrigin,
  readJsonBody,
  requireAllowedOrigin,
  sendAccountEmail,
  timingSafeEqual,
  verifyTurnstile,
} from "../_shared/auth-core.js";

const CONTACT_ACTION = "thirdrailify-contact";
const TOPICS = new Map([
  ["general", "General enquiry"],
  ["show-media", "Show and media"],
  ["merchandise", "Merchandise"],
  ["accessibility", "Accessibility"],
  ["privacy", "Privacy"],
]);

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method === "OPTIONS") return optionsResponse(request, env);
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "POST, OPTIONS" });
    const origin = requireAllowedOrigin(request, env);
    if (origin !== normalizeOrigin(env?.THIRDRAILIFY_PUBLIC_ORIGIN)) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed.");

    const body = await readJsonBody(request);
    if (cleanText(body.website, 120)) return successResponse(request, env);
    const rateIdentifier = await verifiedRateIdentifier(request, env);
    await enforceRateLimit(env, request, "contact", rateIdentifier);

    const name = cleanText(body.name, 101);
    const email = normalizeEmail(body.email);
    const topic = TOPICS.get(cleanText(body.topic, 40));
    const message = cleanMessage(body.message);
    if (name.length < 2 || name.length > 100) throw new AuthFailure(400, "contact_name_invalid", "Enter a name between 2 and 100 characters.");
    if (!email) throw new AuthFailure(400, "contact_email_invalid", "Enter a valid reply email address.");
    if (!topic) throw new AuthFailure(400, "contact_topic_invalid", "Choose a valid contact topic.");
    if (message.length < 20 || message.length > 4000) throw new AuthFailure(400, "contact_message_invalid", "Enter a message between 20 and 4,000 characters.");
    if (body.consent !== true) throw new AuthFailure(400, "contact_consent_required", "Acknowledge the Privacy Policy before sending.");

    await verifyTurnstile(env, request, body.turnstileToken, CONTACT_ACTION, context.data?.contactFetch || fetch);
    const to = normalizeEmail(env?.CONTACT_TO_EMAIL || env?.MAIL_REPLY_TO);
    const cc = normalizeEmail(env?.CONTACT_CC_EMAIL || env?.ADMIN_EMAIL_2);
    if (!to || !cc) throw new AuthFailure(503, "contact_recipient_not_configured", "Contact delivery is not configured.");

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeTopic = escapeHtml(topic);
    const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");
    await sendAccountEmail(env, {
      to,
      cc: [cc],
      replyTo: email,
      subject: `[Third Railify Contact] ${topic} — ${name}`,
      text: `Third Railify website contact\n\nName: ${name}\nEmail: ${email}\nTopic: ${topic}\n\n${message}`,
      html: `<!doctype html><html><body style="margin:0;background:#080906;color:#fff7dc;font-family:Arial,sans-serif"><div style="max-width:680px;margin:0 auto;padding:36px"><p style="margin:0 0 10px;color:#ffd12f;font:700 12px monospace;letter-spacing:.12em;text-transform:uppercase">Third Railify website contact</p><h1 style="margin:0 0 28px;font-size:30px">${safeTopic}</h1><table style="width:100%;border-collapse:collapse;margin-bottom:26px"><tr><td style="padding:10px;border:1px solid #35351e;color:#a9a99f">Name</td><td style="padding:10px;border:1px solid #35351e">${safeName}</td></tr><tr><td style="padding:10px;border:1px solid #35351e;color:#a9a99f">Reply email</td><td style="padding:10px;border:1px solid #35351e">${safeEmail}</td></tr></table><div style="padding:22px;border-left:3px solid #ffd12f;background:#11120d;line-height:1.6">${safeMessage}</div></div></body></html>`,
    }, context.data?.contactFetch || fetch);
    return successResponse(request, env);
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

async function verifiedRateIdentifier(request, env) {
  const rateKey = cleanText(request.headers.get("X-ThirdRailify-Contact-Rate-Key"), 80);
  const timestampText = cleanText(request.headers.get("X-ThirdRailify-Timestamp"), 24);
  const signature = cleanText(request.headers.get("X-ThirdRailify-Signature"), 160);
  if (!rateKey && !timestampText && !signature) return "public-contact";
  if (!rateKey || !timestampText || !signature) throw new AuthFailure(401, "contact_relay_invalid", "The contact relay could not be verified.");
  const secret = String(env?.THIRDRAILIFY_COMMUNITY_API_SECRET || "");
  if (!secret) throw new AuthFailure(503, "contact_security_not_configured", "Contact delivery is not configured.");
  const timestamp = Number(timestampText);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300) throw new AuthFailure(401, "contact_relay_expired", "The contact relay could not be verified.");
  const expected = await hmacSha256(secret, `${timestampText}\ncontact\n${rateKey}`);
  if (!timingSafeEqual(expected, signature)) throw new AuthFailure(401, "contact_relay_invalid", "The contact relay could not be verified.");
  return `public-contact:${rateKey}`;
}

function cleanMessage(value) {
  const raw = String(value || "").replace(/\r\n?/g, "\n");
  const printable = Array.from(raw, (character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 8 || (codePoint >= 11 && codePoint <= 31) || codePoint === 127 ? " " : character;
  }).join("");
  return printable.replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function successResponse(request, env) {
  return jsonResponse({ ok: true, message: "Your message has been sent to Third Railify." }, { headers: corsHeaders(request, env) });
}

function optionsResponse(request, env) {
  requireAllowedOrigin(request, env);
  return new Response(null, { status: 204, headers: { ...corsHeaders(request, env), "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "600", "Cache-Control": "no-store" } });
}
