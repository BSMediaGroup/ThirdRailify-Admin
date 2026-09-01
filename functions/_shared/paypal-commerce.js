import { AuthFailure, cleanText, enforceRateLimit, nowIso, randomId, verifyTurnstile } from "./auth-core.js";
import { commerceAccessForSession, decryptCommerceSecret, encryptCommerceSecret, requireCommerceDb } from "./commerce-core.js";
import { prepareCheckoutCustomer, validateCheckoutCustomer } from "./commerce-customers.js";
import { authoritativeCartLines, authoritativeSubtotal, normalizeCartItems, normalizeDeliveryRecipient, resolveShippingSelection } from "./shipping-core.js";
import { accountTransactionalMessageStatement } from "./account-messages.js";
import {
  PayPalApiError,
  capturePayPalOrder,
  createPayPalOrder,
  getPayPalOrder,
  minorUnitsToPayPal,
  paypalAmountToMinor,
  paypalBrowserConfiguration,
  paypalCredentials,
  PAYPAL_WEBHOOK_EVENTS,
} from "./paypal-client.js";
import { paypalAcceptanceStatus, paypalTechnicalReadiness, paypalWebhookUrl } from "./paypal-onboarding.js";

const MAX_TOTAL = 2_147_483_647;
const DONATION_MIN = 100;
const DONATION_MAX = 1_000_000;

export async function paypalPublicConfiguration(env) {
  const db = requireCommerceDb(env);
  const [state, settingsResult] = await Promise.all([
    db.prepare("SELECT * FROM commerce_payment_provider_state WHERE id='primary'").first(),
    db.prepare(`SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN (
      'commerce_environment','commerce_emergency_paused','paypal_sandbox_configured','paypal_live_configured',
      'paypal_sandbox_webhook_configured','paypal_live_webhook_configured','paypal_store_checkout_enabled',
      'paypal_live_capture_enabled','paypal_donation_live_capture_enabled','paypal_donations_enabled','preferred_payment_provider','stripe_enabled')`).all(),
  ]);
  const settings = settingsMap(settingsResult);
  const environment = settings.commerce_environment === "production" ? "live" : "sandbox";
  const browser = paypalBrowserConfiguration(env, environment);
  const credentialReady = environment === "live" ? settings.paypal_live_configured === true : settings.paypal_sandbox_configured === true;
  const webhookReady = environment === "live" ? settings.paypal_live_webhook_configured === true : settings.paypal_sandbox_webhook_configured === true;
  const paused = settings.commerce_emergency_paused === true || Number(state?.emergency_paused || 0) === 1;
  return {
    ok: true,
    provider: "paypal",
    preferred: settings.preferred_payment_provider === "paypal" && state?.preferred_provider === "paypal",
    environment,
    currency: "CAD",
    intent: "CAPTURE",
    clientId: credentialReady && browser.clientId ? browser.clientId : null,
    configured: credentialReady,
    webhookConfigured: webhookReady,
    storeCheckoutEnabled: !paused && credentialReady && webhookReady && settings.paypal_store_checkout_enabled === true && (environment !== "live" || settings.paypal_live_capture_enabled === true),
    donationsEnabled: !paused && credentialReady && webhookReady && settings.paypal_donations_enabled === true && (environment !== "live" || settings.paypal_donation_live_capture_enabled === true),
    emergencyPaused: paused,
    stripe: { configured: Number(state?.stripe_configured || 0) === 1, enabled: settings.stripe_enabled === true && Number(state?.stripe_enabled || 0) === 1, preferred: false },
    message: !credentialReady ? "PayPal credentials are not configured." : !webhookReady ? "PayPal webhook verification is not configured." : paused ? "Payments are temporarily paused." : null,
  };
}

export async function createPayPalStorePayment(env, request, input, session, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  const configuration = await requirePayPalConfiguration(env, "store");
  const checkout = validateStoreInput(input, session);
  if (configuration.turnstileRequired) await verifyTurnstile(env, request, input.turnstileToken, "commerce_checkout", fetchImpl);
  await enforceRateLimit(env, request, "paypal-store-create", checkout.checkoutRequestId);
  const requestDigest = await sha256Hex(JSON.stringify({ items: checkout.items, recipient: checkout.recipient, customer: checkout.customer, quoteId: checkout.quoteId, shippingOptionId: checkout.shippingOptionId }));
  let order = await db.prepare("SELECT * FROM commerce_orders WHERE checkout_request_id=? LIMIT 1").bind(checkout.checkoutRequestId).first();
  let lines;
  let shipping;
  if (order) {
    if (order.customer_payment_provider !== "paypal" || order.checkout_request_digest !== requestDigest) throw new AuthFailure(409, "checkout_request_conflict", "This checkout request identifier is already associated with another payment.");
    lines = await loadOrderItems(db, order.id);
    shipping = await loadDelivery(env, db, order.id);
  } else {
    lines = await authoritativeCartLines(db, checkout.items, { gate: "normal", environment: configuration.environment === "live" ? "live" : "test" });
    if (!lines.length || lines.some((line) => !line.requiresShipping)) throw new AuthFailure(409, "paypal_store_cart_invalid", "The store cart is invalid.");
    shipping = await resolveShippingSelection(db, { lines, recipient: checkout.recipient, quoteId: checkout.quoteId, optionId: checkout.shippingOptionId, environment: configuration.environment === "live" ? "live" : "test" });
    const subtotal = authoritativeSubtotal(lines);
    const total = checkedTotal(subtotal, shipping.option.amount, configuration.taxAmount);
    const orderId = `ord_${randomId()}`;
    const customer = await prepareCheckoutCustomer(env, db, checkout.customer);
    const recipientCiphertext = await encryptCommerceSecret(env, JSON.stringify({ ...shipping.recipient, customerContact: { name: checkout.customer.name, email: checkout.customer.email } }), `order-delivery:${orderId}`);
    const timestamp = nowIso();
    await db.batch([
      customer.statement,
      ...(customer.auditStatement ? [customer.auditStatement] : []),
      db.prepare(`INSERT INTO commerce_orders (
        id,customer_payment_provider,payment_status,fulfillment_provider,fulfillment_status,currency_code,
        customer_gross_amount,product_subtotal_amount,shipping_amount,tax_amount,tax_status,tax_reason,
        checkout_request_id,checkout_request_digest,cart_digest,environment,checkout_status,customer_id,
        safe_metadata_json,created_at,updated_at
      ) VALUES (?,'paypal','pending','printful','disabled','CAD',?,?,?,?,?,?,?,?,?,?,'checkout_pending',?,'{}',?,?)`)
        .bind(orderId,total,subtotal,shipping.option.amount,configuration.taxAmount,configuration.taxStatus,configuration.taxReason,checkout.checkoutRequestId,requestDigest,await cartDigest(lines),configuration.environment === "live" ? "live" : "test",customer.id,timestamp,timestamp),
      ...lines.map((line, index) => db.prepare(`INSERT INTO commerce_order_items (
        id,order_id,line_number,product_id,variant_id,product_name,variant_name,sku,option_values_json,
        currency_code,unit_amount,quantity,line_total_amount,requires_shipping,fulfillment_provider,fulfillment_variant_id,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'CAD',?,?,?,?,?,?,?)`).bind(randomId(),orderId,index+1,line.productId,line.variantId,line.productName,line.variantName,line.sku,JSON.stringify(line.optionValues),line.unitAmount,line.quantity,line.lineTotalAmount,1,line.fulfillmentProvider,line.fulfillmentVariantId,timestamp)),
      db.prepare(`INSERT INTO commerce_order_delivery_snapshots (
        order_id,recipient_ciphertext,destination_country_code,destination_region_code,shipping_strategy,provider,
        provider_shipping_method_id,display_shipping_method,shipping_amount,currency_code,source_quote_id,quoted_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'CAD',?,?,?,?)`).bind(orderId,recipientCiphertext,shipping.recipient.countryCode,shipping.recipient.region,shipping.strategy,shipping.provider,shipping.option.providerRateId,shipping.option.name,shipping.option.amount,shipping.quoteId,shipping.quotedAt,timestamp,timestamp),
      ...(customer.accountId ? [accountTransactionalMessageStatement(db, customer.accountId, {
        category:"orders",sourceType:"order.created",sourceId:orderId,title:"Order started",
        preview:"Your Third Railify order has been recorded.",
        body:"Your order is linked to this account. Payment and fulfilment status will remain available in your account order history.",
        actionUrl:`/account/orders/${orderId}`,actionLabel:"View order",
        details:{environment:configuration.environment === "live" ? "live" : "test",amount:total,currencyCode:"CAD"},createdAt:timestamp,
      })] : []),
    ]);
    order = await db.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(orderId).first();
  }
  return createProviderOrderForTarget(env, { target: "store", order, lines, shipping, configuration }, fetchImpl);
}

export async function createPayPalDonationPayment(env, request, input, session, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  const configuration = await requirePayPalConfiguration(env, "donation");
  const donationRequestId = uuid(input?.donationRequestId, "donation_request_id_invalid");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !new Set(["donationRequestId","amountMinor","turnstileToken"]).has(key))) throw new AuthFailure(400, "donation_request_invalid", "The donation request is invalid.");
  const amountMinor = Number(input.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < DONATION_MIN || amountMinor > DONATION_MAX) throw new AuthFailure(400, "donation_amount_invalid", "Choose a donation amount between CA$1 and CA$10,000.");
  if (configuration.turnstileRequired) await verifyTurnstile(env, request, input.turnstileToken, "commerce_donation", fetchImpl);
  await enforceRateLimit(env, request, "paypal-donation-create", donationRequestId);
  const requestDigest = await sha256Hex(JSON.stringify({ amountMinor, currency: "CAD" }));
  let donation = await db.prepare("SELECT * FROM commerce_donations WHERE request_id=?").bind(donationRequestId).first();
  if (donation && donation.request_digest !== requestDigest) throw new AuthFailure(409, "donation_request_conflict", "This donation request identifier is already in use.");
  if (!donation) {
    const timestamp = nowIso();
    const accountContact = session?.accountId && session?.account?.email ? validateCheckoutCustomer({ mode:"account", name:session.account.displayName, email:session.account.email }, session) : null;
    const customer = accountContact ? await prepareCheckoutCustomer(env, db, accountContact) : null;
    const donationId = `don_${randomId()}`;
    await db.batch([
      ...(customer ? [customer.statement, ...(customer.auditStatement ? [customer.auditStatement] : [])] : []),
      db.prepare(`INSERT INTO commerce_donations (id,request_id,request_digest,customer_id,environment,currency_code,amount_minor,status,donor_display_preference,created_at,updated_at)
        VALUES (?,?,?,?,?,'CAD',?,'created','private',?,?)`).bind(donationId,donationRequestId,requestDigest,customer?.id || null,configuration.environment,amountMinor,timestamp,timestamp),
      ...(customer?.accountId ? [accountTransactionalMessageStatement(db, customer.accountId, {
        category:"donations",sourceType:"donation.created",sourceId:donationId,title:"Donation started",
        preview:"Your Third Railify donation has been recorded.",
        body:"Your donation is linked to this account. Its authoritative payment state remains server-controlled.",
        actionUrl:"/account",actionLabel:"View account",
        details:{environment:configuration.environment,amount:amountMinor,currencyCode:"CAD"},createdAt:timestamp,
      })] : []),
    ]);
    donation = await db.prepare("SELECT * FROM commerce_donations WHERE id=?").bind(donationId).first();
  }
  return createProviderOrderForTarget(env, { target: "donation", donation, configuration }, fetchImpl);
}

async function createProviderOrderForTarget(env, context, fetchImpl) {
  const db = requireCommerceDb(env);
  const targetId = context.target === "store" ? context.order.id : context.donation.id;
  let attempt = await db.prepare(`SELECT * FROM commerce_payment_attempts WHERE provider='paypal' AND ${context.target === "store" ? "commerce_order_id" : "donation_id"}=? ORDER BY created_at DESC LIMIT 1`).bind(targetId).first();
  if (attempt?.provider_order_id) return safeCreateResponse(context.target, targetId, attempt);
  const body = context.target === "store" ? storeOrderBody(context) : donationOrderBody(context);
  const bodyDigest = await sha256Hex(JSON.stringify(body));
  const timestamp = nowIso();
  if (!attempt) {
    const attemptId = `pat_${randomId()}`;
    const idempotencyKey = `paypal-create-${await sha256Hex(`${context.target}:${targetId}:${bodyDigest}`)}`;
    await db.prepare(`INSERT INTO commerce_payment_attempts (
      id,commerce_order_id,donation_id,provider,environment,idempotency_key,currency_code,amount_minor,
      provider_status,normalized_state,create_request_digest,created_at,updated_at
    ) VALUES (?,?,?,'paypal',?,?,'CAD',?,'CREATED','created',?,?,?)`).bind(attemptId,context.target === "store" ? targetId : null,context.target === "donation" ? targetId : null,context.configuration.environment,idempotencyKey,context.target === "store" ? Number(context.order.customer_gross_amount) : Number(context.donation.amount_minor),bodyDigest,timestamp,timestamp).run();
    attempt = await db.prepare("SELECT * FROM commerce_payment_attempts WHERE id=?").bind(attemptId).first();
  } else if (attempt.create_request_digest !== bodyDigest) {
    throw new AuthFailure(409, "paypal_attempt_digest_conflict", "The existing PayPal payment attempt does not match this request.");
  }
  try {
    const result = await createPayPalOrder(env, context.configuration.environment, body, attempt.idempotency_key, fetchImpl);
    const normalized = normalizePayPalOrder(result.body);
    validatePayPalOrder(normalized, attempt, targetId, { allowCreated: true, expectedMerchantId: context.configuration.expectedMerchantId });
    const responseDigest = await sha256Hex(JSON.stringify(result.body));
    await db.prepare(`UPDATE commerce_payment_attempts SET provider_order_id=?,provider_status=?,normalized_state='created',create_response_digest=?,paypal_debug_id=?,revision=revision+1,updated_at=? WHERE id=? AND provider_order_id IS NULL`)
      .bind(normalized.id,normalized.status,responseDigest,result.debugId,timestamp,attempt.id).run();
    if (context.target === "store") await db.prepare("UPDATE commerce_orders SET checkout_status='checkout_created',checkout_created_at=COALESCE(checkout_created_at,?),updated_at=? WHERE id=? AND payment_status='pending'").bind(timestamp,timestamp,targetId).run();
    attempt = await db.prepare("SELECT * FROM commerce_payment_attempts WHERE id=?").bind(attempt.id).first();
    return safeCreateResponse(context.target,targetId,attempt);
  } catch (error) {
    if (error instanceof PayPalApiError && error.retryable) {
      const recovered = await reconcileAmbiguousCreate(env, context.configuration.environment, attempt, targetId, fetchImpl);
      if (recovered) return safeCreateResponse(context.target,targetId,recovered);
    }
    await recordPayPalDiagnostic(db,error,"paypal_order_create",attempt.create_request_digest);
    await db.prepare("UPDATE commerce_payment_attempts SET safe_error_code=?,paypal_debug_id=?,failed_at=?,revision=revision+1,updated_at=? WHERE id=? AND provider_order_id IS NULL")
      .bind(safeErrorCode(error),error?.debugId || null,timestamp,timestamp,attempt.id).run();
    throw error;
  }
}

export async function capturePayPalPayment(env, request, input, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input,"attemptId")) throw new AuthFailure(400,"paypal_capture_request_invalid","The PayPal capture request is invalid.");
  const attemptId = localId(input.attemptId,"paypal_attempt_id_invalid","pat_");
  await enforceRateLimit(env,request,"paypal-capture",attemptId);
  let attempt = await db.prepare("SELECT * FROM commerce_payment_attempts WHERE id=? AND provider='paypal'").bind(attemptId).first();
  if (!attempt || !attempt.provider_order_id) throw new AuthFailure(404,"paypal_attempt_not_found","The PayPal payment attempt was not found.");
  const configuration = await requirePayPalConfiguration(env,attempt.donation_id ? "donation" : "store",attempt.environment);
  if (attempt.normalized_state === "completed") return paymentStatusResponse(attempt);
  const targetId = attempt.commerce_order_id || attempt.donation_id;
  const current = await getPayPalOrder(env,attempt.environment,attempt.provider_order_id,fetchImpl);
  const currentOrder = normalizePayPalOrder(current.body);
  validatePayPalOrder(currentOrder,attempt,targetId,{ expectedMerchantId: configuration.expectedMerchantId });
  if (currentOrder.status === "COMPLETED") return finalizeCompletedPayment(env,attempt,currentOrder,current.debugId,"capture_reconciliation");
  if (currentOrder.status !== "APPROVED") throw new AuthFailure(409,"paypal_order_not_approved","The PayPal order has not been approved for capture.");
  const requestDigest = await sha256Hex(`${attempt.id}\n${attempt.provider_order_id}\ncapture`);
  const requestId = `paypal-capture-${requestDigest}`;
  await db.prepare("UPDATE commerce_payment_attempts SET capture_request_digest=?,approved_at=COALESCE(approved_at,?),provider_status='APPROVED',normalized_state='approved',revision=revision+1,updated_at=? WHERE id=?").bind(requestDigest,nowIso(),nowIso(),attempt.id).run();
  try {
    const result = await capturePayPalOrder(env,attempt.environment,attempt.provider_order_id,requestId,fetchImpl);
    const captured = normalizePayPalOrder(result.body);
    validatePayPalOrder(captured,attempt,targetId,{ expectedMerchantId: configuration.expectedMerchantId });
    return captured.status === "COMPLETED" ? finalizeCompletedPayment(env,attempt,captured,result.debugId,"server_capture") : finalizeNonCompletedPayment(env,attempt,captured,result.debugId);
  } catch (error) {
    if (error instanceof PayPalApiError && error.retryable) {
      const reconciled = await getPayPalOrder(env,attempt.environment,attempt.provider_order_id,fetchImpl);
      const order = normalizePayPalOrder(reconciled.body);
      validatePayPalOrder(order,attempt,targetId,{ expectedMerchantId: configuration.expectedMerchantId });
      if (order.status === "COMPLETED") return finalizeCompletedPayment(env,attempt,order,reconciled.debugId,"capture_timeout_reconciliation");
    }
    await recordPayPalDiagnostic(db,error,"paypal_order_capture",requestDigest);
    throw error;
  }
}

export async function processPayPalRecoveryJob(env, job, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  let webhookEvent = null;
  let attempt = null;
  if (job?.job_kind === "paypal_webhook_recover") {
    webhookEvent = await db.prepare("SELECT * FROM commerce_paypal_webhook_events WHERE environment=? AND payload_sha256=? AND processing_status='unresolved'").bind(job.environment,job.payload_digest).first();
    if (!webhookEvent) return {ok:true,status:"already_resolved"};
    attempt = webhookEvent.provider_order_id
      ? await db.prepare("SELECT * FROM commerce_payment_attempts WHERE provider='paypal' AND provider_order_id=?").bind(webhookEvent.provider_order_id).first()
      : await db.prepare("SELECT * FROM commerce_payment_attempts WHERE provider='paypal' AND provider_capture_id=?").bind(webhookEvent.provider_capture_id).first();
    if (!attempt) throw new AuthFailure(503,"paypal_attempt_still_unresolved","The verified PayPal event is waiting for its local payment attempt.");
  } else {
    const attemptId = localId(job?.payment_attempt_id,"paypal_attempt_id_invalid","pat_");
    attempt = await db.prepare("SELECT * FROM commerce_payment_attempts WHERE id=? AND provider='paypal'").bind(attemptId).first();
  }
  if (!attempt?.provider_order_id) throw new AuthFailure(409,"paypal_attempt_not_found","The PayPal payment attempt was not found.");
  const finish = async (result) => { if (webhookEvent) await db.prepare("UPDATE commerce_paypal_webhook_events SET processing_status='processed',result_code='recovered',processed_at=? WHERE provider_event_id=? AND processing_status='unresolved'").bind(nowIso(),webhookEvent.provider_event_id).run(); return result; };
  if (["completed","failed","refunded","reversed","canceled"].includes(attempt.normalized_state)) return finish(paymentStatusResponse(attempt));
  const target = attempt.donation_id ? "donation" : "store";
  const configuration = await requirePayPalConfiguration(env,target,attempt.environment,{ allowDisabled:true });
  const current = await getPayPalOrder(env,attempt.environment,attempt.provider_order_id,fetchImpl);
  const order = normalizePayPalOrder(current.body);
  const targetId = attempt.commerce_order_id || attempt.donation_id;
  validatePayPalOrder(order,attempt,targetId,{ allowCreated:true,expectedMerchantId:configuration.expectedMerchantId });
  if (order.status === "COMPLETED") return finish(await finalizeCompletedPayment(env,attempt,order,current.debugId,"worker_reconciliation"));
  if ((job.job_kind === "paypal_capture_recover" || job.job_kind === "paypal_webhook_recover") && order.status === "APPROVED") {
    await requirePayPalConfiguration(env,target,attempt.environment);
    const requestDigest = await sha256Hex(`${attempt.id}\n${attempt.provider_order_id}\ncapture`);
    const result = await capturePayPalOrder(env,attempt.environment,attempt.provider_order_id,`paypal-capture-${requestDigest}`,fetchImpl);
    const captured = normalizePayPalOrder(result.body);
    validatePayPalOrder(captured,attempt,targetId,{ expectedMerchantId:configuration.expectedMerchantId });
    return finish(captured.status === "COMPLETED" ? await finalizeCompletedPayment(env,attempt,captured,result.debugId,"worker_capture_recovery") : await finalizeNonCompletedPayment(env,attempt,captured,result.debugId));
  }
  if (["CREATED","APPROVED","PAYER_ACTION_REQUIRED"].includes(order.status) || order.captureStatus === "PENDING") throw new AuthFailure(503,"paypal_payment_still_pending","PayPal has not reached a terminal payment state.");
  return finish(await finalizeNonCompletedPayment(env,attempt,order,current.debugId));
}

export async function reduceVerifiedPayPalEvent(env, normalized, evidence) {
  const db = requireCommerceDb(env);
  const existing = await db.prepare("SELECT provider_event_id,result_code FROM commerce_paypal_webhook_events WHERE provider_event_id=?").bind(normalized.id).first();
  if (existing) return { duplicate:true,result:existing.result_code };
  const attempt = await findAttemptForEvent(db,normalized);
  let resultCode = attempt ? "recorded" : "payment_attempt_unresolved";
  if (attempt && evidence.environment !== "simulator") {
    if (normalized.type === "CHECKOUT.ORDER.APPROVED") {
      await updateAttemptState(db,attempt,"APPROVED","approved",normalized.createTime);
      await enqueuePayPalJob(db,"paypal_capture_recover",attempt,`${normalized.id}:capture-recover`,evidence.payloadSha256);
      resultCode = "approval_recorded";
    } else if (normalized.type === "PAYMENT.CAPTURE.COMPLETED") {
      const configuration = await requirePayPalConfiguration(env,attempt.donation_id ? "donation" : "store",attempt.environment,{ allowDisabled:true });
      validateEventAmount(normalized,attempt,configuration.expectedMerchantId);
      await finalizeCompletedPayment(env,attempt,eventAsOrder(normalized,attempt),evidence.debugId,"verified_webhook");
      resultCode = "payment_confirmed";
    } else if (normalized.type === "PAYMENT.CAPTURE.PENDING") {
      validateEventAmount(normalized,attempt,null); await updateAttemptState(db,attempt,"PENDING","pending",normalized.createTime); await enqueuePayPalJob(db,"paypal_pending_reconcile",attempt,`${normalized.id}:pending`,evidence.payloadSha256); resultCode="payment_pending";
    } else if (normalized.type === "PAYMENT.CAPTURE.REFUNDED") {
      const configuration = await requirePayPalConfiguration(env,attempt.donation_id ? "donation" : "store",attempt.environment,{ allowDisabled:true });
      validateEventAmount(normalized,attempt,configuration.expectedMerchantId);
      await transitionTerminalState(db,attempt,"REFUNDED","refunded",normalized.createTime); resultCode="payment_refunded";
    } else if (normalized.type === "PAYMENT.CAPTURE.REVERSED" || normalized.type === "CHECKOUT.PAYMENT-APPROVAL.REVERSED") {
      if (normalized.type === "PAYMENT.CAPTURE.REVERSED") { const configuration = await requirePayPalConfiguration(env,attempt.donation_id ? "donation" : "store",attempt.environment,{ allowDisabled:true }); validateEventAmount(normalized,attempt,configuration.expectedMerchantId); }
      await transitionTerminalState(db,attempt,"REVERSED","reversed",normalized.createTime); resultCode="payment_reversed";
    } else if (normalized.type === "PAYMENT.CAPTURE.DECLINED") {
      const configuration = await requirePayPalConfiguration(env,attempt.donation_id ? "donation" : "store",attempt.environment,{ allowDisabled:true });
      validateEventAmount(normalized,attempt,configuration.expectedMerchantId);
      await transitionTerminalState(db,attempt,"DECLINED","failed",normalized.createTime); resultCode="payment_declined";
    }
  } else if (evidence.environment === "simulator") resultCode="simulator_no_authority";
  await db.prepare(`INSERT INTO commerce_paypal_webhook_events (
    provider_event_id,environment,event_type,provider_order_id,provider_capture_id,amount_minor,currency_code,merchant_id,transmission_id,payload_sha256,
    verification_status,processing_status,result_code,occurred_at,received_at,processed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(normalized.id,evidence.environment,normalized.type,normalized.orderId,normalized.captureId,normalized.amount,normalized.currency,normalized.merchantId,evidence.transmissionId,evidence.payloadSha256,evidence.environment === "simulator" ? "simulator" : "verified",attempt ? "processed" : "unresolved",resultCode,normalized.createTime,evidence.receivedAt,evidence.receivedAt).run();
  if (!attempt && evidence.environment !== "simulator") await enqueueUnresolvedPayPalWebhook(db,normalized,evidence);
  return { duplicate:false,result:resultCode };
}

export async function paypalPaymentStatusPayload(env, rawAttemptId) {
  const db=requireCommerceDb(env); const attemptId=localId(rawAttemptId,"paypal_attempt_id_invalid","pat_");
  const attempt=await db.prepare("SELECT id,commerce_order_id,donation_id,environment,currency_code,amount_minor,normalized_state,updated_at FROM commerce_payment_attempts WHERE id=? AND provider='paypal'").bind(attemptId).first();
  if(!attempt) throw new AuthFailure(404,"paypal_payment_not_found","The PayPal payment was not found.");
  return {ok:true,payment:{reference:attempt.id,kind:attempt.donation_id?"donation":"store",orderReference:attempt.commerce_order_id||null,donationReference:attempt.donation_id||null,environment:attempt.environment,currency:attempt.currency_code,amount:Number(attempt.amount_minor),status:attempt.normalized_state,updatedAt:attempt.updated_at}};
}

export async function paypalAdminPayload(env, session) {
  const access=await commerceAccessForSession(env,session); const db=requireCommerceDb(env);
  const [state,provider,settingsResult,attempts,donations,webhooks,diagnostics]=await Promise.all([
    db.prepare("SELECT * FROM commerce_payment_provider_state WHERE id='primary'").first(),
    db.prepare("SELECT status,environment,safe_metadata_json,last_synchronized_at FROM commerce_provider_connections WHERE provider='paypal'").first(),
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key LIKE 'paypal_%' OR setting_key IN ('preferred_payment_provider','stripe_enabled','commerce_emergency_paused')").all(),
    db.prepare("SELECT environment,CASE WHEN donation_id IS NOT NULL THEN 'donation' ELSE 'store' END kind,normalized_state,COUNT(*) count FROM commerce_payment_attempts WHERE provider='paypal' GROUP BY environment,kind,normalized_state").all(),
    db.prepare("SELECT environment,status,COUNT(*) count,COALESCE(SUM(CASE WHEN status='completed' THEN amount_minor ELSE 0 END),0) amount FROM commerce_donations GROUP BY environment,status").all(),
    db.prepare("SELECT environment,event_type,received_at,result_code FROM commerce_paypal_webhook_events WHERE verification_status='verified' ORDER BY received_at DESC LIMIT 20").all(),
    db.prepare("SELECT operation_kind,http_status,provider_code,provider_reason,request_id,retryable,occurred_at FROM commerce_provider_diagnostics WHERE provider='paypal' ORDER BY occurred_at DESC LIMIT 20").all(),
  ]);
  const settings=settingsMap(settingsResult); const metadata=parseJson(provider?.safe_metadata_json,{});
  const sandboxCredentials=paypalCredentials(env,"sandbox"),liveCredentials=paypalCredentials(env,"live");
  const attemptRows=attempts?.results||[];
  const sandboxReadiness=paypalTechnicalReadiness({credentials:sandboxCredentials,metadata:metadata.sandbox,configured:settings.paypal_sandbox_configured===true,webhookConfigured:settings.paypal_sandbox_webhook_configured===true});
  const liveReadiness=paypalTechnicalReadiness({credentials:liveCredentials,metadata:metadata.live,configured:settings.paypal_live_configured===true,webhookConfigured:settings.paypal_live_webhook_configured===true});
  let webhookUrl=null; try{webhookUrl=paypalWebhookUrl(env);}catch{}
  return {ok:true,access,state:{preferredProvider:state?.preferred_provider||"paypal",revision:Number(state?.revision||1),stripeConfigured:Boolean(state?.stripe_configured),stripeEnabled:Boolean(state?.stripe_enabled),emergencyPaused:Boolean(state?.emergency_paused),reason:state?.transition_reason,updatedAt:state?.updated_at},provider:{status:provider?.status||"unavailable",environment:provider?.environment||"live",preferred:true,metadata,lastSynchronizedAt:provider?.last_synchronized_at||null},credentials:{sandbox:{clientIdConfigured:Boolean(sandboxCredentials.clientId),clientSecretConfigured:Boolean(sandboxCredentials.clientSecret),webhookIdConfigured:Boolean(sandboxCredentials.webhookId),expectedMerchantIdConfigured:Boolean(sandboxCredentials.expectedMerchantId),oauthVerified:sandboxReadiness.oauthVerified,webhookReadbackVerified:sandboxReadiness.webhookReadbackVerified,storeAcceptance:paypalAcceptanceStatus(attemptRows,"sandbox","store"),donationAcceptance:paypalAcceptanceStatus(attemptRows,"sandbox","donation")},live:{clientIdConfigured:Boolean(liveCredentials.clientId),clientSecretConfigured:Boolean(liveCredentials.clientSecret),webhookIdConfigured:Boolean(liveCredentials.webhookId),expectedMerchantIdConfigured:Boolean(liveCredentials.expectedMerchantId),oauthVerified:liveReadiness.oauthVerified,webhookReadbackVerified:liveReadiness.webhookReadbackVerified,storeAcceptance:paypalAcceptanceStatus(attemptRows,"live","store"),donationAcceptance:paypalAcceptanceStatus(attemptRows,"live","donation")}},settings,attempts:attemptRows,donations:donations?.results||[],webhooks:webhooks?.results||[],diagnostics:diagnostics?.results||[],subscribedEvents:PAYPAL_WEBHOOK_EVENTS,webhookUrl,setupCommand:"npm run commerce:paypal -- status"};
}

async function requirePayPalConfiguration(env,target,forcedEnvironment=null,options={}) {
  const db=requireCommerceDb(env); const [state,settingsResult]=await Promise.all([db.prepare("SELECT * FROM commerce_payment_provider_state WHERE id='primary'").first(),db.prepare("SELECT setting_key,value_json FROM commerce_settings").all()]);
  const settings=settingsMap(settingsResult); const environment=forcedEnvironment || (settings.commerce_environment === "production" ? "live" : "sandbox");
  if(!new Set(["sandbox","live"]).has(environment)) throw new AuthFailure(503,"paypal_environment_invalid","The PayPal environment is invalid.");
  const creds=paypalCredentials(env,environment); const configured=environment==="live"?settings.paypal_live_configured===true:settings.paypal_sandbox_configured===true; const webhook=environment==="live"?settings.paypal_live_webhook_configured===true:settings.paypal_sandbox_webhook_configured===true;
  if(state?.preferred_provider!=="paypal"||settings.preferred_payment_provider!=="paypal") throw new AuthFailure(409,"paypal_not_preferred","PayPal is not the preferred payment provider.");
  if(!options.allowDisabled){ if(settings.commerce_emergency_paused===true||Number(state?.emergency_paused||0)===1) throw new AuthFailure(409,"commerce_emergency_paused","Payments are temporarily paused."); const enabled=target==="store"?settings.paypal_store_checkout_enabled===true:settings.paypal_donations_enabled===true; if(!enabled) throw new AuthFailure(409,target==="store"?"checkout_disabled":"donations_disabled",target==="store"?"Store checkout is not enabled.":"Donations are not enabled."); }
  if(!configured||!creds.configured) throw new AuthFailure(503,"paypal_credentials_unavailable",`PayPal ${environment.toUpperCase()} credentials are not configured.`);
  if(!webhook) throw new AuthFailure(503,"paypal_webhook_not_configured",`PayPal ${environment.toUpperCase()} webhook verification is not configured.`);
  const liveCaptureEnabled=target==="store"?settings.paypal_live_capture_enabled===true:settings.paypal_donation_live_capture_enabled===true;
  if(environment==="live"&&!liveCaptureEnabled&&!options.allowDisabled) throw new AuthFailure(409,target==="store"?"paypal_store_live_capture_disabled":"paypal_donation_live_capture_disabled",target==="store"?"PayPal LIVE store capture is not enabled.":"PayPal LIVE donation capture is not enabled.");
  let taxStatus="not_calculated",taxReason=null,taxAmount=0;
  if(target==="store") { if(settings.tax_calculation_provider!=="not_collecting") throw new AuthFailure(409,"commerce_tax_policy_unresolved","The store tax policy is not configured for PayPal checkout."); taxStatus="not_collecting"; taxReason="configured_not_collecting"; }
  return {environment,expectedMerchantId:creds.expectedMerchantId||null,turnstileRequired:settings.checkout_turnstile_required===true,taxStatus,taxReason,taxAmount};
}

function validateStoreInput(input,session){if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some((k)=>!new Set(["checkoutRequestId","items","recipient","quoteId","shippingOptionId","turnstileToken","customer"]).has(k))) throw new AuthFailure(400,"checkout_request_invalid","The checkout request is invalid."); return {checkoutRequestId:uuid(input.checkoutRequestId,"checkout_request_id_invalid"),items:normalizeCartItems(input.items),recipient:normalizeDeliveryRecipient(input.recipient),quoteId:cleanText(input.quoteId,80),shippingOptionId:cleanText(input.shippingOptionId,40),customer:validateCheckoutCustomer(input.customer,session)};}
function storeOrderBody({order,lines,shipping,configuration}){const subtotal=Number(order.product_subtotal_amount),shippingAmount=Number(order.shipping_amount),tax=Number(order.tax_amount),total=Number(order.customer_gross_amount);return {intent:"CAPTURE",payment_source:{paypal:{experience_context:{payment_method_preference:"IMMEDIATE_PAYMENT_REQUIRED",shipping_preference:"SET_PROVIDED_ADDRESS",user_action:"PAY_NOW",brand_name:"Third Railify Official"}}},purchase_units:[{reference_id:order.id,custom_id:order.id,invoice_id:`TR-${order.id.slice(-32)}`,description:"Third Railify store purchase",amount:{currency_code:"CAD",value:minorUnitsToPayPal(total),breakdown:{item_total:{currency_code:"CAD",value:minorUnitsToPayPal(subtotal)},shipping:{currency_code:"CAD",value:minorUnitsToPayPal(shippingAmount)},tax_total:{currency_code:"CAD",value:minorUnitsToPayPal(tax)}}},items:lines.map((line)=>({name:cleanText(line.productName,127),description:cleanText(line.variantName,127)||undefined,sku:cleanText(line.sku,127)||undefined,unit_amount:{currency_code:"CAD",value:minorUnitsToPayPal(line.unitAmount)},quantity:String(line.quantity),category:"PHYSICAL_GOODS"})),shipping:{name:{full_name:shipping.recipient.recipientName},address:{address_line_1:shipping.recipient.address1,address_line_2:shipping.recipient.address2||undefined,admin_area_2:shipping.recipient.city,admin_area_1:shipping.recipient.region,postal_code:shipping.recipient.postalCode,country_code:shipping.recipient.countryCode}}}]};}
function donationOrderBody({donation}){return {intent:"CAPTURE",payment_source:{paypal:{experience_context:{payment_method_preference:"IMMEDIATE_PAYMENT_REQUIRED",shipping_preference:"NO_SHIPPING",user_action:"PAY_NOW",brand_name:"Third Railify Official"}}},purchase_units:[{reference_id:donation.id,custom_id:donation.id,invoice_id:`DON-${donation.id.slice(-32)}`,description:"One-time support for Third Railify",amount:{currency_code:"CAD",value:minorUnitsToPayPal(Number(donation.amount_minor))}}]};}

function normalizePayPalOrder(value){const unit=Array.isArray(value?.purchase_units)&&value.purchase_units.length===1?value.purchase_units[0]:null;const captures=unit?.payments?.captures;const capture=Array.isArray(captures)&&captures.length?captures[0]:null;return {id:safeProviderId(value?.id),intent:cleanText(value?.intent,20).toUpperCase(),status:cleanText(value?.status,40).toUpperCase(),referenceId:cleanText(unit?.reference_id,160),customId:cleanText(unit?.custom_id,160),invoiceId:cleanText(unit?.invoice_id,127),amount:paypalAmountToMinor(unit?.amount?.value),currency:cleanText(unit?.amount?.currency_code,3).toUpperCase(),payeeMerchantId:safeProviderId(unit?.payee?.merchant_id),captureId:safeProviderId(capture?.id),captureStatus:cleanText(capture?.status,40).toUpperCase(),captureAmount:paypalAmountToMinor(capture?.amount?.value),captureCurrency:cleanText(capture?.amount?.currency_code,3).toUpperCase()};}
function validatePayPalOrder(order,attempt,targetId,{allowCreated=false,expectedMerchantId=null}={}){if(!order.id||order.id!==attempt.provider_order_id&&attempt.provider_order_id||order.intent!=="CAPTURE"||order.referenceId!==targetId||order.customId!==targetId||order.currency!=="CAD"||order.amount!==Number(attempt.amount_minor)) throw new AuthFailure(502,"paypal_order_evidence_invalid","PayPal order evidence did not match the local payment authority."); if(expectedMerchantId&&order.payeeMerchantId!==expectedMerchantId) throw new AuthFailure(502,"paypal_merchant_mismatch","PayPal merchant evidence did not match the configured merchant."); if(!allowCreated&&order.status==="CREATED") throw new AuthFailure(409,"paypal_order_not_approved","The PayPal order has not been approved."); if(order.status==="COMPLETED"&&(order.captureStatus!=="COMPLETED"||order.captureAmount!==Number(attempt.amount_minor)||order.captureCurrency!=="CAD"||!order.captureId)) throw new AuthFailure(502,"paypal_capture_evidence_invalid","PayPal capture evidence did not match the local payment authority.");}
async function finalizeCompletedPayment(env, attempt, order, debugId, source) {
  const db = requireCommerceDb(env);
  const timestamp = nowIso();
  const responseDigest = await sha256Hex(JSON.stringify(order));
  const statements = [
    db.prepare(`UPDATE commerce_payment_attempts
      SET provider_capture_id=COALESCE(provider_capture_id,?),provider_status='COMPLETED',normalized_state='completed',
          capture_response_digest=?,paypal_debug_id=?,captured_at=COALESCE(captured_at,?),revision=revision+1,updated_at=?
      WHERE id=? AND normalized_state NOT IN ('refunded','reversed')`)
      .bind(order.captureId,responseDigest,debugId||null,timestamp,timestamp,attempt.id),
  ];
  if (attempt.commerce_order_id) {
    statements.push(db.prepare(`UPDATE commerce_orders
      SET payment_status='paid',fulfillment_status=CASE WHEN environment='live' THEN 'pending' ELSE fulfillment_status END,
          payment_confirmed_at=COALESCE(payment_confirmed_at,?),updated_at=?
      WHERE id=? AND customer_payment_provider='paypal' AND payment_status='pending'`)
      .bind(timestamp,timestamp,attempt.commerce_order_id));
    if (attempt.environment === "live") {
      statements.push(db.prepare(`INSERT OR IGNORE INTO commerce_operation_jobs
        (id,job_kind,event_key,order_id,payment_attempt_id,environment,payload_digest,state,next_attempt_at,created_at,updated_at)
        VALUES (?,'fulfillment_submit',?,?,?,'live',?,'pending',?,?,?)`)
        .bind(`coj_${randomId()}`,`${attempt.id}:fulfillment`,attempt.commerce_order_id,attempt.id,responseDigest,timestamp,timestamp,timestamp));
    }
  } else {
    statements.push(db.prepare(`UPDATE commerce_donations
      SET status='completed',completed_at=COALESCE(completed_at,?),revision=revision+1,updated_at=?
      WHERE id=? AND status NOT IN ('refunded','reversed')`).bind(timestamp,timestamp,attempt.donation_id));
  }
  await db.batch(statements);
  return {ok:true,attemptId:attempt.id,kind:attempt.donation_id?"donation":"store",reference:attempt.donation_id||attempt.commerce_order_id,status:"completed",source};
}
async function finalizeNonCompletedPayment(env,attempt,order,debugId){const db=requireCommerceDb(env);const state=order.captureStatus==="PENDING"||order.status==="PAYER_ACTION_REQUIRED"?"pending":"failed";const timestamp=nowIso();await db.prepare(`UPDATE commerce_payment_attempts SET provider_capture_id=COALESCE(provider_capture_id,?),provider_status=?,normalized_state=?,paypal_debug_id=?,pending_at=CASE WHEN ?='pending' THEN COALESCE(pending_at,?) ELSE pending_at END,failed_at=CASE WHEN ?='failed' THEN COALESCE(failed_at,?) ELSE failed_at END,revision=revision+1,updated_at=? WHERE id=?`).bind(order.captureId||null,order.captureStatus||order.status,state,debugId||null,state,timestamp,state,timestamp,timestamp,attempt.id).run();return {ok:true,attemptId:attempt.id,kind:attempt.donation_id?"donation":"store",reference:attempt.donation_id||attempt.commerce_order_id,status:state};}
async function transitionTerminalState(db,attempt,providerStatus,state,at){const timestamp=at||nowIso();const postCompletion=state==="refunded"||state==="reversed";const attemptGuard=postCompletion?"normalized_state NOT IN ('refunded','reversed')":"normalized_state NOT IN ('completed','refunded','reversed')";await db.prepare(`UPDATE commerce_payment_attempts SET provider_status=?,normalized_state=?,${state}_at=COALESCE(${state}_at,?),revision=revision+1,updated_at=? WHERE id=? AND ${attemptGuard}`).bind(providerStatus,state,timestamp,timestamp,attempt.id).run();if(attempt.donation_id){const donationGuard=postCompletion?"status NOT IN ('refunded','reversed')":"status NOT IN ('completed','refunded','reversed')";await db.prepare(`UPDATE commerce_donations SET status=?,${state}_at=COALESCE(${state}_at,?),revision=revision+1,updated_at=? WHERE id=? AND ${donationGuard}`).bind(state,timestamp,timestamp,attempt.donation_id).run();}if(attempt.commerce_order_id){if(state==="failed")await db.prepare("UPDATE commerce_orders SET payment_status='failed',payment_failed_at=COALESCE(payment_failed_at,?),updated_at=? WHERE id=? AND payment_status='pending'").bind(timestamp,timestamp,attempt.commerce_order_id).run();if(state==="refunded")await db.prepare("UPDATE commerce_orders SET payment_status='refunded',refund_amount=customer_gross_amount,updated_at=? WHERE id=? AND payment_status='paid'").bind(timestamp,attempt.commerce_order_id).run();if(state==="reversed")await db.prepare("UPDATE commerce_orders SET payment_status='disputed',updated_at=? WHERE id=? AND payment_status IN ('paid','refunded')").bind(timestamp,attempt.commerce_order_id).run();}}
async function updateAttemptState(db,attempt,providerStatus,state,at){const timestamp=at||nowIso();const column=state==="approved"?"approved_at":"pending_at";await db.prepare(`UPDATE commerce_payment_attempts SET provider_status=?,normalized_state=?,${column}=COALESCE(${column},?),revision=revision+1,updated_at=? WHERE id=? AND normalized_state NOT IN ('completed','refunded','reversed')`).bind(providerStatus,state,timestamp,timestamp,attempt.id).run();if(attempt.donation_id)await db.prepare("UPDATE commerce_donations SET status=?,approved_at=CASE WHEN ?='approved' THEN COALESCE(approved_at,?) ELSE approved_at END,revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('completed','refunded','reversed')").bind(state,state,timestamp,timestamp,attempt.donation_id).run();}
async function enqueuePayPalJob(db,kind,attempt,eventKey,digest){const timestamp=nowIso();await db.prepare(`INSERT OR IGNORE INTO commerce_operation_jobs (id,job_kind,event_key,order_id,donation_id,payment_attempt_id,environment,payload_digest,state,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)`).bind(`coj_${randomId()}`,kind,eventKey,attempt.commerce_order_id,attempt.donation_id,attempt.id,attempt.environment,digest,timestamp,timestamp,timestamp).run();}
async function enqueueUnresolvedPayPalWebhook(db,event,evidence){const timestamp=nowIso();await db.prepare(`INSERT OR IGNORE INTO commerce_operation_jobs (id,job_kind,event_key,environment,payload_digest,state,next_attempt_at,created_at,updated_at) VALUES (?,'paypal_webhook_recover',?,?,?,'pending',?,?,?)`).bind(`coj_${randomId()}`,`${event.id}:recover`,evidence.environment,evidence.payloadSha256,timestamp,timestamp,timestamp).run();}
async function findAttemptForEvent(db,event){if(event.orderId)return db.prepare("SELECT * FROM commerce_payment_attempts WHERE provider='paypal' AND provider_order_id=?").bind(event.orderId).first();if(event.captureId)return db.prepare("SELECT * FROM commerce_payment_attempts WHERE provider='paypal' AND provider_capture_id=?").bind(event.captureId).first();return null;}
function validateEventAmount(event,attempt,merchant){if(event.currency!=="CAD"||event.amount!==Number(attempt.amount_minor))throw new AuthFailure(502,"paypal_webhook_amount_mismatch","PayPal webhook payment evidence did not match the local amount.");if(merchant&&event.merchantId!==merchant)throw new AuthFailure(502,"paypal_merchant_mismatch","PayPal webhook merchant evidence did not match the configured merchant.");}
function eventAsOrder(event,attempt){return {captureId:event.captureId,captureStatus:"COMPLETED",captureAmount:event.amount,captureCurrency:event.currency,status:"COMPLETED",id:attempt.provider_order_id,amount:Number(attempt.amount_minor),currency:"CAD",intent:"CAPTURE",referenceId:attempt.commerce_order_id||attempt.donation_id,customId:attempt.commerce_order_id||attempt.donation_id};}
async function reconcileAmbiguousCreate(){return null;}
async function recordPayPalDiagnostic(db,error,operation,digest){const safe=error instanceof PayPalApiError?error:{httpStatus:null,providerCode:safeErrorCode(error),providerReason:"PayPal operation failed.",debugId:null,retryable:false};await db.prepare("INSERT INTO commerce_provider_diagnostics(id,provider,operation_kind,http_status,provider_code,provider_reason,request_id,payload_digest,retryable,occurred_at) VALUES (?,'paypal',?,?,?,?,?,?,?,?)").bind(`cpd_${randomId()}`,operation,safe.httpStatus,safe.providerCode,cleanText(safe.providerReason,300),safe.debugId,digest,safe.retryable?1:0,nowIso()).run();}
async function loadOrderItems(db,id){const result=await db.prepare("SELECT product_id,variant_id,product_name,variant_name,sku,option_values_json,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,fulfillment_provider,fulfillment_variant_id FROM commerce_order_items WHERE order_id=? ORDER BY line_number").bind(id).all();return(result?.results||[]).map((r)=>({productId:r.product_id,variantId:r.variant_id,productName:r.product_name,variantName:r.variant_name,sku:r.sku,optionValues:parseJson(r.option_values_json,{}),currencyCode:r.currency_code,unitAmount:Number(r.unit_amount),quantity:Number(r.quantity),lineTotalAmount:Number(r.line_total_amount),requiresShipping:r.requires_shipping===1,fulfillmentProvider:r.fulfillment_provider,fulfillmentVariantId:r.fulfillment_variant_id}));}
async function loadDelivery(env,db,id){const r=await db.prepare("SELECT recipient_ciphertext,source_quote_id,quoted_at,shipping_strategy,provider,provider_shipping_method_id,display_shipping_method,shipping_amount,currency_code FROM commerce_order_delivery_snapshots WHERE order_id=?").bind(id).first();if(!r)return null;const recipient=parseJson(await decryptCommerceSecret(env,r.recipient_ciphertext,`order-delivery:${id}`),null);if(!recipient)throw new AuthFailure(503,"checkout_delivery_unavailable","The immutable delivery snapshot could not be read.");return{quoteId:r.source_quote_id,quotedAt:r.quoted_at,strategy:r.shipping_strategy,provider:r.provider,option:{providerRateId:r.provider_shipping_method_id,name:r.display_shipping_method,amount:Number(r.shipping_amount),currency:r.currency_code},recipient};}
function safeCreateResponse(target,targetId,attempt){return{ok:true,provider:"paypal",attemptId:attempt.id,orderId:attempt.provider_order_id,target,reference:targetId,environment:attempt.environment,currency:"CAD",amount:Number(attempt.amount_minor)};}
function paymentStatusResponse(attempt){return{ok:true,attemptId:attempt.id,kind:attempt.donation_id?"donation":"store",reference:attempt.donation_id||attempt.commerce_order_id,status:attempt.normalized_state};}
function checkedTotal(...parts){const total=parts.reduce((sum,value)=>sum+Number(value||0),0);if(!Number.isSafeInteger(total)||total<=0||total>MAX_TOTAL)throw new AuthFailure(409,"checkout_total_invalid","The authoritative total is invalid.");return total;}
function localId(value,code,prefix){const id=cleanText(value,80);if(!id.startsWith(prefix)||!new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(id))throw new AuthFailure(400,code,"The local payment identifier is invalid.");return id;}
function uuid(value,code){const id=String(value||"").trim().toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))throw new AuthFailure(400,code,"A valid request UUID is required.");return id;}
function safeProviderId(value){const id=cleanText(value,80);return/^[A-Za-z0-9_-]+$/.test(id)?id:null;}
function safeErrorCode(error){const code=cleanText(error?.code||error?.providerCode||"paypal_unavailable",100);return/^[A-Za-z0-9_.-]+$/.test(code)?code:"paypal_unavailable";}
function settingsMap(result){return Object.fromEntries((result?.results||[]).map((r)=>[r.setting_key,parseJson(r.value_json,null)]));}
function parseJson(value,fallback=null){try{return JSON.parse(String(value??""));}catch{return fallback;}}
async function cartDigest(lines){return sha256Hex(JSON.stringify(lines.map((l)=>({productId:l.productId,variantId:l.variantId,unitAmount:l.unitAmount,quantity:l.quantity,lineTotalAmount:l.lineTotalAmount,fulfillmentProvider:l.fulfillmentProvider,fulfillmentVariantId:l.fulfillmentVariantId}))));}
async function sha256Hex(value){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value)));return[...new Uint8Array(digest)].map((b)=>b.toString(16).padStart(2,"0")).join("");}
