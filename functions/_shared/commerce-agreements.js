import { transactionGuard } from "./commerce-transaction-guards.js";
import { COMMERCE_POLICIES } from "./commerce-policy-snapshot.js";
import { AuthFailure, cleanText, enforceRateLimit, nowIso, randomId } from "./auth-core.js";
import { decryptCommerceSecret, encryptCommerceSecret, requireCommerceDb } from "./commerce-core.js";
import { validateCheckoutCustomer } from "./commerce-customers.js";
import { authoritativeCartLines, authoritativeSubtotal, normalizeCartItems, normalizeDeliveryRecipient, resolveShippingSelection } from "./shipping-core.js";

const DISCLOSURE_THRESHOLD_MINOR = 5000;
const OFFER_TTL_MS = 15 * 60 * 1000;
const AGREEMENT_VERSION = 1;

export async function offerCheckoutAgreement(env, request, input, session) {
  const db = requireCommerceDb(env);
  const checkout = validateAgreementInput(input, session);
  await enforceRateLimit(env, request, "commerce-agreement", session?.accountId || request.headers.get("CF-Connecting-IP") || "guest");
  const [settingsResult, profile] = await Promise.all([
    db.prepare(`SELECT setting_key,value_json,updated_at FROM commerce_settings WHERE setting_key IN (
      'commerce_environment','commerce_emergency_paused','paypal_store_checkout_enabled','paypal_live_capture_enabled',
      'internet_agreement_disclosure_enabled','tax_calculation_provider','shipping_strategy')`).all(),
    db.prepare("SELECT * FROM commerce_business_profiles WHERE id='primary'").first(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, { value: parseJson(row.value_json, null), updatedAt: row.updated_at }]));
  requireAgreementConfiguration(settings, profile);
  const lines = await authoritativeCartLines(db, checkout.items, { gate: "normal", environment: "live" });
  if (!lines.length || lines.some((line) => !line.requiresShipping)) throw new AuthFailure(409, "agreement_cart_invalid", "The agreement cart is invalid.");
  const shipping = await resolveShippingSelection(db, { lines, recipient: checkout.recipient, quoteId: checkout.quoteId, optionId: checkout.shippingOptionId, environment: "live" });
  const subtotal = authoritativeSubtotal(lines);
  const total = checkedTotal(subtotal, shipping.option.amount);
  const agreementId = `agr_${randomId()}`;
  const offeredAt = nowIso();
  const quoteExpiry = Date.parse(String(shipping.expiresAt || shipping.quotedAt || ""));
  const expiresAt = new Date(Math.min(Date.now() + OFFER_TTL_MS, Number.isFinite(quoteExpiry) && quoteExpiry > Date.now() ? quoteExpiry : Date.now() + OFFER_TTL_MS)).toISOString();
  const [legalName, phone, addressValue] = await Promise.all([
    decryptRequired(env, profile.legal_business_name_ciphertext, "business:legal-name", "agreement_legal_name_unavailable"),
    decryptRequired(env, profile.private_phone_ciphertext, "business:private-phone", "agreement_phone_unavailable"),
    decryptRequired(env, profile.private_address_ciphertext, "business:private-address", "agreement_address_unavailable"),
  ]);
  const address = parseJson(addressValue, null);
  if (!address || typeof address !== "object" || Array.isArray(address)) throw new AuthFailure(503, "agreement_address_unavailable", "The encrypted merchant address is unavailable.");
  const requestDigest = await checkoutAgreementRequestDigest(checkout);
  const snapshot = {
    version: AGREEMENT_VERSION,
    agreementId,
    environment: "live",
    qualifyingInternetAgreement: total > DISCLOSURE_THRESHOLD_MINOR,
    disclosureThresholdMinor: DISCLOSURE_THRESHOLD_MINOR,
    businessProfileRevision: Number(profile.revision),
    taxPolicyRevision: settings.tax_calculation_provider.updatedAt || "not_collecting",
    consumer: { mode: checkout.customer.mode, name: checkout.customer.name, email: checkout.customer.email, accountId: checkout.customer.mode === "account" ? session?.accountId || null : null },
    merchant: {
      legalName: cleanOperatorText(legalName, 240),
      tradingName: cleanOperatorText(profile.trading_name, 160),
      phone: cleanOperatorText(phone, 80),
      address: cleanAddress(address),
      supportEmail: cleanText(profile.support_email || profile.public_contact_email, 254),
      website: cleanText(profile.website_url, 500),
    },
    items: lines.map((line) => ({ productId: line.productId, variantId: line.variantId, name: line.productName, description: line.description || line.productName, variant: line.variantName || null, options: line.optionValues, unitAmount: line.unitAmount, quantity: line.quantity, lineTotalAmount: line.lineTotalAmount })),
    totals: { productSubtotalAmount: subtotal, shippingAmount: shipping.option.amount, taxAmount: 0, totalAmount: total, currency: "CAD" },
    tax: { policy: "not_collecting", statement: "Tax is not being collected under the merchant's configured policy." },
    shipping: { methodId: shipping.option.providerRateId, method: shipping.option.name, pricingPolicy: shipping.option.merchantPolicy || null, delivery: shipping.option.estimatedDelivery ? {text:shipping.option.estimatedDelivery} : shipping.option.merchantPolicy ? null : {minDays:shipping.option.minDeliveryDays,maxDays:shipping.option.maxDeliveryDays,minDate:shipping.option.minDeliveryDate,maxDate:shipping.option.maxDeliveryDate}, destination: shipping.recipient, destinationCountryCode: shipping.recipient.countryCode },
    payment: { provider: "PayPal", currency: "CAD", terms: "Payment is requested through PayPal after this agreement is accepted. No payment is created by reviewing or declining it." },
    fulfillment: { provider: "Printful", method: shipping.option.name, statement: "Fulfillment starts only after authoritative completed payment evidence." },
    policies: { terms:COMMERCE_POLICIES.terms, privacy:COMMERCE_POLICIES.privacy, returns:COMMERCE_POLICIES.refunds },
    additionalCharges: "Third Railify charges the itemized CAD total. Your bank or payment provider may apply its own currency conversion fees. Customs duties or brokerage charges, if imposed on a cross-border shipment, are external charges whose amount is not known at review.",
    tradeIn: "No trade-in arrangement.",
    conditions: ["Review and correct customer, delivery, item, shipping, and total details before accepting.", "Returns, cancellations, refunds, and other restrictions follow the linked policies and non-waivable consumer rights."],
    offeredAt,
    expiresAt,
  };
  const snapshotJson = JSON.stringify(snapshot);
  const snapshotDigest = await sha256Hex(snapshotJson);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const ciphertext = await encryptCommerceSecret(env, snapshotJson, `checkout-agreement:${agreementId}`);
  const write = await db.prepare(`INSERT INTO commerce_order_agreements (
      id,checkout_request_id,environment,business_profile_revision,tax_policy_revision,request_digest,
      snapshot_ciphertext,snapshot_digest,acceptance_token_hash,status,qualifying_internet_agreement,
      offered_at,expires_at,created_at
    ) VALUES (?,?,'live',?,?,?,?,?,?,'offered',?,?,?,?)
    ON CONFLICT(checkout_request_id) DO UPDATE SET
      id=excluded.id,environment=excluded.environment,business_profile_revision=excluded.business_profile_revision,
      tax_policy_revision=excluded.tax_policy_revision,request_digest=excluded.request_digest,
      snapshot_ciphertext=excluded.snapshot_ciphertext,snapshot_digest=excluded.snapshot_digest,
      acceptance_token_hash=excluded.acceptance_token_hash,qualifying_internet_agreement=excluded.qualifying_internet_agreement,
      offered_at=excluded.offered_at,expires_at=excluded.expires_at,created_at=excluded.created_at
    WHERE commerce_order_agreements.status='offered'`)
    .bind(agreementId,checkout.checkoutRequestId,Number(profile.revision),snapshot.taxPolicyRevision,requestDigest,ciphertext,snapshotDigest,tokenHash,snapshot.qualifyingInternetAgreement?1:0,offeredAt,expiresAt,offeredAt).run();
  if (Number(write?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "agreement_request_conflict", "This checkout request already has an accepted agreement.");
  return { ok: true, agreement: publicAgreement(snapshot), acceptanceToken: token };
}

export async function prepareAgreementAcceptance(env, checkout, orderId, customerId, lines, shipping) {
  if (checkout.agreementAccepted !== true) throw new AuthFailure(409, "agreement_acceptance_required", "Accept the reviewed internet agreement before PayPal order creation.");
  const db = requireCommerceDb(env);
  const agreementId = localId(checkout.agreementId, "agreement_id_invalid", "agr_");
  const token = String(checkout.agreementToken || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthFailure(400, "agreement_token_invalid", "The agreement acceptance token is invalid.");
  const [agreement, profile] = await Promise.all([
    db.prepare("SELECT * FROM commerce_order_agreements WHERE id=? AND checkout_request_id=?").bind(agreementId, checkout.checkoutRequestId).first(),
    db.prepare("SELECT revision,owner_attested_revision,transaction_disclosure_authorized_revision FROM commerce_business_profiles WHERE id='primary'").first(),
  ]);
  if (!agreement || agreement.status !== "offered") throw new AuthFailure(409, "agreement_offer_unavailable", "Review a current agreement before PayPal order creation.");
  if (Date.parse(agreement.expires_at) <= Date.now()) throw new AuthFailure(409, "agreement_offer_expired", "The agreement review expired. Request a current review.");
  if (agreement.acceptance_token_hash !== await sha256Hex(token)) throw new AuthFailure(403, "agreement_token_invalid", "The agreement acceptance token is invalid.");
  const requestDigest = await checkoutAgreementRequestDigest(checkout);
  if (agreement.request_digest !== requestDigest) throw new AuthFailure(409, "agreement_checkout_changed", "Checkout details changed after agreement review. Review the current agreement again.");
  const revision = Number(profile?.revision || 0);
  if (Number(agreement.business_profile_revision) !== revision || Number(profile?.owner_attested_revision) !== revision || Number(profile?.transaction_disclosure_authorized_revision) !== revision) throw new AuthFailure(409, "agreement_profile_revision_stale", "Merchant disclosure authority changed. Review a current agreement.");
  const snapshot = JSON.parse(await decryptCommerceSecret(env,agreement.snapshot_ciphertext,`checkout-agreement:${agreement.id}`));
  const taxSetting = await db.prepare("SELECT value_json,updated_at FROM commerce_settings WHERE setting_key='tax_calculation_provider'").first();
  if (taxSetting?.value_json !== '"not_collecting"' || taxSetting.updated_at !== agreement.tax_policy_revision) throw new AuthFailure(409,"agreement_policy_changed","Tax policy changed. Review the current agreement.");
  if (lines && (snapshot.totals.productSubtotalAmount !== authoritativeSubtotal(lines) || snapshot.totals.shippingAmount !== shipping.option.amount
      || JSON.stringify(snapshot.items.map((i)=>[i.productId,i.variantId,i.quantity,i.unitAmount])) !== JSON.stringify(lines.map((i)=>[i.productId,i.variantId,i.quantity,i.unitAmount])))) throw new AuthFailure(409,"agreement_prices_changed","Prices changed after review. Request a current agreement.");
  return {
    agreementId,
    guard: transactionGuard(db,"EXISTS (SELECT 1 FROM commerce_order_agreements a JOIN commerce_business_profiles b ON b.id='primary' WHERE a.id=? AND a.status='offered' AND a.expires_at>? AND a.business_profile_revision=b.revision AND b.owner_attested_revision=b.revision AND b.transaction_disclosure_authorized_revision=b.revision) AND EXISTS (SELECT 1 FROM commerce_settings WHERE setting_key='internet_agreement_disclosure_enabled' AND value_json='true') AND EXISTS (SELECT 1 FROM commerce_settings WHERE setting_key='tax_calculation_provider' AND value_json='\"not_collecting\"' AND updated_at=?)", [agreementId,nowIso(),taxSetting.updated_at]),
    statement: db.prepare("UPDATE commerce_order_agreements SET order_id=?,customer_id=?,status='accepted',accepted_at=? WHERE id=? AND status='offered' AND order_id IS NULL")
      .bind(orderId, customerId, nowIso(), agreementId),
  };
}

export async function acceptedAgreementAppendix(env, orderId) {
  const row = await requireCommerceDb(env).prepare("SELECT id,snapshot_ciphertext,snapshot_digest,accepted_at FROM commerce_order_agreements WHERE order_id=? AND status='accepted'").bind(orderId).first();
  if (!row) throw new AuthFailure(503, "order_agreement_unavailable", "The accepted internet agreement snapshot is unavailable.");
  const plaintext = await decryptCommerceSecret(env, row.snapshot_ciphertext, `checkout-agreement:${row.id}`);
  if (await sha256Hex(plaintext) !== row.snapshot_digest) throw new AuthFailure(503, "order_agreement_invalid", "The accepted internet agreement snapshot failed integrity validation.");
  const snapshot = parseJson(plaintext, null);
  if (!snapshot) throw new AuthFailure(503, "order_agreement_invalid", "The accepted internet agreement snapshot is invalid.");
  const lines = agreementTextLines(snapshot, row.accepted_at);
  return { snapshot, text: lines.join("\n"), html: `<section aria-label="Accepted internet agreement"><h2>Accepted internet agreement</h2>${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</section>` };
}

export async function checkoutAgreementRequestDigest(checkout) {
  return sha256Hex(JSON.stringify({ items: checkout.items, recipient: checkout.recipient, customer: checkout.customer, quoteId: checkout.quoteId, shippingOptionId: checkout.shippingOptionId }));
}

function validateAgreementInput(input, session) {
  const allowed = new Set(["checkoutRequestId","items","recipient","quoteId","shippingOptionId","customer"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) throw new AuthFailure(400, "agreement_request_invalid", "The agreement request is invalid.");
  return { checkoutRequestId: uuid(input.checkoutRequestId,"checkout_request_id_invalid"),items:normalizeCartItems(input.items),recipient:normalizeDeliveryRecipient(input.recipient),quoteId:cleanText(input.quoteId,80),shippingOptionId:cleanText(input.shippingOptionId,40),customer:validateCheckoutCustomer(input.customer,session) };
}

function requireAgreementConfiguration(settings, profile) {
  if (settings.commerce_environment?.value !== "production" || settings.commerce_emergency_paused?.value === true || settings.paypal_store_checkout_enabled?.value !== true || settings.paypal_live_capture_enabled?.value !== true || settings.internet_agreement_disclosure_enabled?.value !== true) throw new AuthFailure(409, "agreement_disclosure_unavailable", "Transaction disclosure is unavailable until the production store is active.");
  if (settings.tax_calculation_provider?.value !== "not_collecting" || !["printful_dynamic", "merchant_weight_bands"].includes(settings.shipping_strategy?.value)) throw new AuthFailure(409, "agreement_policy_unavailable", "The checkout tax or shipping policy is unavailable.");
  const revision = Number(profile?.revision || 0);
  if (!revision || Number(profile?.owner_attested_revision) !== revision || Number(profile?.transaction_disclosure_authorized_revision) !== revision || !profile?.legal_business_name_ciphertext || !profile?.private_phone_ciphertext || !profile?.private_address_ciphertext) throw new AuthFailure(409, "agreement_merchant_authority_unavailable", "Current merchant facts are not owner-confirmed and authorized for transaction disclosure.");
}

function publicAgreement(snapshot) {
  return { id:snapshot.agreementId,version:snapshot.version,environment:snapshot.environment,qualifyingInternetAgreement:snapshot.qualifyingInternetAgreement,disclosureThresholdMinor:snapshot.disclosureThresholdMinor,businessProfileRevision:snapshot.businessProfileRevision,merchant:{tradingName:snapshot.merchant.tradingName,supportEmail:snapshot.merchant.supportEmail,website:snapshot.merchant.website},items:snapshot.items,totals:snapshot.totals,tax:snapshot.tax,shipping:snapshot.shipping,payment:snapshot.payment,fulfillment:snapshot.fulfillment,policies:snapshot.policies,conditions:snapshot.conditions,additionalCharges:snapshot.additionalCharges,tradeIn:snapshot.tradeIn,consumer:snapshot.consumer,offeredAt:snapshot.offeredAt,expiresAt:snapshot.expiresAt };
}
function agreementTextLines(s, acceptedAt) {
  const money=(n)=>`${(n/100).toFixed(2)} CAD`;
  const lines=[`Accepted: ${acceptedAt}`,`Agreement: ${s.agreementId}`,`Consumer: ${s.consumer.name}`,`Supplier: ${s.merchant.tradingName}`];
  if(s.qualifyingInternetAgreement) lines.push(`Legal supplier: ${s.merchant.legalName}`,`Supplier telephone: ${s.merchant.phone}`,`Business premises: ${Object.values(s.merchant.address||{}).filter(Boolean).join(", ")}`);
  lines.push(`Contact: ${s.merchant.supportEmail}`, ...s.items.map(i=>`${i.name} / ${i.variant||""}: ${i.description||i.name}; ${i.quantity} at ${money(i.unitAmount)} = ${money(i.lineTotalAmount)}`),
    `Products: ${money(s.totals.productSubtotalAmount)}`,`Shipping (${s.shipping.method}): ${money(s.totals.shippingAmount)}`,`Delivery destination: ${Object.values(s.shipping.destination||{}).filter(Boolean).join(", ")}`,
    `Delivery estimate: ${s.shipping.delivery ? JSON.stringify(s.shipping.delivery) : "Not supplied"} (estimated, not guaranteed)`,
    `Tax: ${money(s.totals.taxAmount)} - ${s.tax.statement}`,`Total: ${money(s.totals.totalAmount)}`,s.payment.terms,s.fulfillment.statement,s.additionalCharges,s.tradeIn,...s.conditions);
  for(const policy of Object.values(s.policies)) {
    lines.push(`${policy.title} (${policy.version}) - https://thirdrailify.com${policy.url}`);
    for(const section of policy.sections||[]) lines.push(section.title,...(section.paragraphs||[]),...(section.bullets||[]),...(section.note?[section.note]:[]),...(section.table?.rows||[]).map(row=>row.join(" | ")));
  }
  return lines;
}
function cleanAddress(value) {
  const result={};
  for(const key of ["line1","line2","city","province","postalCode","country"]) {
    const text=value?.[key];
    result[key]=text ? cleanOperatorText(text,key.startsWith("line")?180:key==="postalCode"?64:120) : "";
  }
  if(!Object.values(result).some(Boolean)) throw new AuthFailure(503,"agreement_address_unavailable","The encrypted merchant address is empty.");
  return result;
}
function cleanOperatorText(value,maximum){const text=String(value??"").trim();if(!text||text.length>maximum||/[\u0000-\u001f\u007f]/u.test(text))throw new AuthFailure(503,"agreement_merchant_value_invalid","A required merchant agreement value is invalid.");return text;}
async function decryptRequired(env,value,purpose,code){if(!value)throw new AuthFailure(409,code,"A required encrypted merchant value is unavailable.");return decryptCommerceSecret(env,value,purpose);}
function checkedTotal(...parts){const total=parts.reduce((sum,value)=>sum+Number(value||0),0);if(!Number.isSafeInteger(total)||total<=0||total>2_147_483_647)throw new AuthFailure(409,"checkout_total_invalid","The authoritative total is invalid.");return total;}
function localId(value,code,prefix){const id=cleanText(value,80);if(!id.startsWith(prefix)||!new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(id))throw new AuthFailure(400,code,"The local agreement identifier is invalid.");return id;}
function uuid(value,code){const id=String(value||"").trim().toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))throw new AuthFailure(400,code,"A valid request UUID is required.");return id;}
function parseJson(value,fallback=null){try{return JSON.parse(String(value??""));}catch{return fallback;}}
function randomToken(){const bytes=crypto.getRandomValues(new Uint8Array(32));let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");}
async function sha256Hex(value){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value)));return[...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");}
function escapeHtml(value){return String(value||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");}
