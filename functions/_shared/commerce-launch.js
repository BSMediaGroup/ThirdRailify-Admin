import { worldwideShippingMarkets } from "./shipping-core.js";
import { transactionGuard, LAUNCH_AUTHORITY_SQL } from "./commerce-transaction-guards.js";
import { AuthFailure, cleanText, nowIso, randomId } from "./auth-core.js";
import { prepareBusinessProfileMutation, requireCommerceDb, writeCommerceAudit, decryptCommerceSecret } from "./commerce-core.js";
import { paypalCredentials } from "./paypal-client.js";
import { paypalTechnicalReadiness, paypalWebhookUrl } from "./paypal-onboarding.js";

export const LIVE_ACTIVATION_CONFIRMATION = "SAVE, CONFIRM & ENABLE STORE";
export const EMERGENCY_PAUSE_CONFIRMATION = "PAUSE LIVE COMMERCE";
export const LIVE_DONATIONS_CONFIRMATION = "ACTIVATE LIVE PAYPAL DONATIONS";

const ELIGIBLE_VARIANT_PREDICATE = `
  p.status='active' AND p.visibility='public' AND p.requires_shipping=1
  AND p.provider_presence='current' AND v.provider_presence='current'
  AND v.status='active' AND v.visibility='public' AND v.availability_status='active'
  AND v.is_ignored=0 AND v.unit_amount>0 AND v.currency_code='CAD'
  AND v.fulfillment_provider='printful' AND v.fulfillment_mapping_status='mapped'
  AND v.migration_status IN ('target_verified','target_native')
  AND p.migration_status IN ('target_verified','target_native')
  AND v.target_printful_sync_variant_id GLOB '[1-9]*'
  AND v.target_catalogue_variant_id GLOB '[1-9]*'
  AND v.target_printful_product_id IS NOT NULL
  AND p.target_printful_product_id IS NOT NULL
  AND v.target_printful_product_id=p.target_printful_product_id`;

export async function commerceLaunchPlan(env) {
  const db = requireCommerceDb(env);
  const authorityBefore = (await db.prepare(LAUNCH_AUTHORITY_SQL).first()).fingerprint;
  const [settingsResult, providersResult, launch, marketsResult, migration, counts, templates, jobs, printfulDeliveries, business, agreementSchema] = await Promise.all([
    db.prepare("SELECT setting_key,value_json FROM commerce_settings").all(),
    db.prepare("SELECT provider,status,environment,integration_mode,external_account_id,country_code,currency_code,safe_metadata_json,last_synchronized_at FROM commerce_provider_connections WHERE provider IN ('paypal','stripe','printful')").all(),
    db.prepare("SELECT * FROM commerce_launch_state WHERE id='production'").first(),
    db.prepare("SELECT country_code,display_name,status,strategy,revision FROM commerce_shipping_markets ORDER BY country_code").all(),
    db.prepare("SELECT status,phase,step_lease_token,safe_state_json FROM commerce_catalogue_migrations WHERE id='permanent-printful-2026-08'").first(),
    db.prepare(`SELECT
      COUNT(*) total_variants,
      SUM(CASE WHEN v.is_sellable=1 THEN 1 ELSE 0 END) sellable_variants,
      SUM(CASE WHEN ${ELIGIBLE_VARIANT_PREDICATE} THEN 1 ELSE 0 END) eligible_variants,
      SUM(CASE WHEN v.is_sellable=1 AND ${ELIGIBLE_VARIANT_PREDICATE} THEN 1 ELSE 0 END) eligible_sellable_variants,
      SUM(CASE WHEN v.is_sellable=1 AND NOT (${ELIGIBLE_VARIANT_PREDICATE}) THEN 1 ELSE 0 END) ineligible_sellable_variants,
      SUM(CASE WHEN NOT (${ELIGIBLE_VARIANT_PREDICATE}) THEN 1 ELSE 0 END) blocked_variants
      FROM commerce_product_variants v JOIN commerce_products p ON p.id=v.product_id`).first(),
    db.prepare("SELECT * FROM commerce_templates").all(),
    db.prepare("SELECT state,COUNT(*) count FROM commerce_operation_jobs GROUP BY state").all(),
    db.prepare("SELECT COUNT(*) count FROM commerce_provider_webhook_events WHERE provider='printful' AND processing_status='processed'").first(),
    db.prepare("SELECT revision,trading_name,country_code,currency_code,public_contact_email,support_email,legal_business_name_ciphertext,private_phone_ciphertext,private_address_ciphertext,owner_attested_revision,owner_attested_at,transaction_disclosure_authorized_revision,transaction_disclosure_authorized_at FROM commerce_business_profiles WHERE id='primary'").first(),
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commerce_order_agreements'").first(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, null)]));
  const providers = Object.fromEntries((providersResult?.results || []).map((row) => [row.provider, { ...row, metadata: json(row.safe_metadata_json, {}) }]));
  const paypal = providers.paypal || null;
  const printful = providers.printful || null;
  const paypalLive = paypalCredentials(env, "live");
  const paypalLiveTechnical = paypalTechnicalReadiness({ credentials: paypalLive, metadata: paypal?.metadata?.live, configured: settings.paypal_live_configured === true, webhookConfigured: settings.paypal_live_webhook_configured === true });
  const markets = marketsResult?.results || [];
  const activeMarkets = markets.filter((market) => market.status === "active" && market.strategy === "printful_dynamic");
  const migrationState = json(migration?.safe_state_json, {});
  const emailTemplates = (templates?.results || []).filter((t) => t.template_kind === "email");
  const configuredEmailTemplates = emailTemplates.filter((template) => template.status === "ready" && Number(template.enabled) === 1).length;
  const requiredCustomerTemplates = ["order_confirmation"];
  const requiredTemplatesReady = requiredCustomerTemplates.every((key) => (templates?.results || []).some((template) => template.template_key === key && template.status === "ready" && Number(template.enabled) === 1));
  const allLifecycleTemplatesReady = emailTemplates.length === 7 && configuredEmailTemplates === 7;
  const orderConfirmationDeliveryReady = settings.resend_domain_verified === true && Boolean(env?.RESEND_API_KEY && env?.MAIL_FROM) && requiredTemplatesReady;
  let merchantDecryptable = false;
  try {
    const [name, phone, address] = await Promise.all([
      decryptCommerceSecret(env, business?.legal_business_name_ciphertext, "business:legal-name"),
      decryptCommerceSecret(env, business?.private_phone_ciphertext, "business:private-phone"),
      decryptCommerceSecret(env, business?.private_address_ciphertext, "business:private-address"),
    ]);
    merchantDecryptable = Boolean(name?.trim() && phone?.trim() && Object.values(JSON.parse(address)).some((value) => typeof value === "string" && value.trim()));
  } catch { /* Safe configured-state projection; never log the encrypted payload. */ }
  const receiptReady = (templates?.results || []).some((t) => t.template_key === "payment_receipt" && t.status === "ready" && Number(t.enabled) === 1);
  const hardGates = [
    gate("merchant_identity", merchantDecryptable && Boolean(cleanText(business?.trading_name, 160) && business?.country_code === "CA" && business?.currency_code === "CAD" && cleanText(business?.support_email || business?.public_contact_email, 254) && business?.private_phone_ciphertext && business?.private_address_ciphertext && business?.legal_business_name_ciphertext), "Required transaction-disclosure facts are stored encrypted as operator-entered data. No address or telephone-format validator claims legal or real-world verification."),
    gate("transaction_disclosure_checkout", Boolean(agreementSchema?.name) && Number(settings.commerce_agreement_schema_version) >= 1, "The scoped pre-agreement disclosure and immutable accepted-agreement schema are installed; activation enables the transaction-only projection atomically."),
    gate("paypal_preferred", settings.preferred_payment_provider === "paypal" && settings.stripe_enabled === false && paypal?.integration_mode === "direct_merchant", "PayPal is preferred and Stripe is retained but disabled."),
    gate("paypal_live_credential", paypalLiveTechnical.credentialsConfigured && paypalLiveTechnical.oauthVerified, "Distinct server-only PayPal LIVE credentials authenticated successfully against the LIVE OAuth endpoint."),
    gate("paypal_live_account", paypal?.status === "connected" && paypal?.environment === "live" && paypal?.integration_mode === "direct_merchant" && paypal?.country_code === "CA" && String(paypal?.currency_code || "").toUpperCase() === "CAD", "The configured PayPal connection is the Canadian CAD direct merchant app; no stronger merchant-onboarding claim is inferred."),
    gate("paypal_live_webhook", paypalLiveTechnical.webhookReadbackVerified, "The exact PayPal LIVE webhook URL and event set were read back and its identifier is stored as a server secret."),
    gate("tax_policy", settings.tax_calculation_provider === "not_collecting", "An explicit server-authoritative tax policy is configured without inventing registrations."),
    gate("printful_store", printful?.status === "connected" && printful?.integration_mode === "fulfillment" && String(printful?.external_account_id || "") === "18668025" && printful?.metadata?.api_configured === true && hasPrintfulSecret(env), "The native Printful target store 18668025 is verified."),
    gate("catalogue", Number(counts?.eligible_variants || 0) > 0 && Number(counts?.eligible_sellable_variants || 0) === Number(counts?.eligible_variants || 0) && Number(counts?.ineligible_sellable_variants || 0) === 0, "Every eligible target-verified variant is sellable and blocked variants remain unavailable."),
    gate("catalogue_migration_terminal", new Set(["completed", "completed_with_blocked_products"]).has(migration?.status) && migration?.phase === "completed" && !migration?.step_lease_token && new Set(["completed", "completed_with_blocked_products"]).has(migrationState.finalStatus || migration?.status), "The permanent catalogue migration is terminal with no active lease and remains outside the launch workflow."),
    gate("shipping", settings.shipping_strategy === "printful_dynamic" && worldwideShippingMarkets().every(market => activeMarkets.some(active => active.country_code === market.countryCode)), "Worldwide shipping destinations are configured; server-issued Printful rates determine product and destination availability."),
    gate("customer_documents", receiptReady, "The branded receipt renderer is ready; accepted agreements are retained with completed orders. Tax invoices are not applicable under not_collecting."),
    gate("operations_worker", settings.commerce_operations_worker_configured === true, "The scheduled Commerce Operations Worker and D1 job authority are configured."),
    gate("order_confirmation_delivery", orderConfirmationDeliveryReady, "Resend and the order-confirmation template are ready. Global Customer Sending is enabled atomically with the store."),
    gate("emergency_pause_clear", settings.commerce_emergency_paused !== true, "Emergency pause is clear."),
  ];
  const advisories = [
    gate("shipment_email", settings.resend_domain_verified === true && configuredEmailTemplates >= 2, "Shipment notification delivery is ready. It is useful post-purchase communication, not payment or fulfillment authority."),
    gate("printful_v2_webhook", settings.printful_v2_webhook_configured === true && hasPrintfulWebhookSecrets(env) && (settings.printful_v2_signed_delivery_verified === true || Number(printfulDeliveries?.count || 0) > 0), "Incoming Printful webhooks remain fail-closed without verified signing-secret custody and real signed-delivery evidence. Scheduled authenticated order reconciliation supplies the production lifecycle authority."),
    gate("printful_signed_delivery", settings.printful_v2_signed_delivery_verified === true || Number(printfulDeliveries?.count || 0) > 0, "At least one real signed Printful delivery has been processed. Absence is reported as no delivery evidence yet."),
  ];
  const ready = hardGates.every((entry) => entry.ready);
  const plan = {
    ok: true,
    authority: "Commerce D1",
    state: launch?.state || "preflight",
    activatedAt: launch?.activated_at || null,
    activatedBy: launch?.state === "active" ? launch?.updated_by_actor || null : null,
    revision: Number(launch?.revision || 1),
    ready,
    hardGates,
    advisories,
    settings: {
      printfulOrderMode: settings.printful_order_mode,
      environment: settings.commerce_environment,
      taxPolicy: settings.tax_calculation_provider,
      shippingStrategy: settings.shipping_strategy,
      checkoutEnabled: settings.checkout_enabled === true,
      liveCaptureEnabled: settings.live_payment_capture_enabled === true,
      fulfillmentEnabled: settings.fulfillment_submission_enabled === true,
      transactionalEmailEnabled: settings.transactional_email_enabled === true,
      internetAgreementDisclosureEnabled: settings.internet_agreement_disclosure_enabled === true,
      customerDocumentAccessEnabled: settings.customer_document_access_enabled === true,
      stripeTaxEnabled: settings.stripe_tax_enabled === true,
      preferredPaymentProvider: settings.preferred_payment_provider || "paypal",
      paypalStoreCheckoutEnabled: settings.paypal_store_checkout_enabled === true,
      paypalDonationsEnabled: settings.paypal_donations_enabled === true,
      paypalLiveCaptureEnabled: settings.paypal_live_capture_enabled === true,
      stripeEnabled: settings.stripe_enabled === true,
      emergencyPaused: settings.commerce_emergency_paused === true,
    },
    business: { revision: Number(business?.revision || 0), tradingName: business?.trading_name || "", legalNameConfigured: Boolean(business?.legal_business_name_ciphertext), phoneConfigured: Boolean(business?.private_phone_ciphertext), addressConfigured: Boolean(business?.private_address_ciphertext), ownerConfirmed: Number(business?.owner_attested_revision || 0) === Number(business?.revision || 0), disclosureAuthorized: Number(business?.transaction_disclosure_authorized_revision || 0) === Number(business?.revision || 0), ownerAttestedAt: business?.owner_attested_at || null, disclosureAuthorizedAt: business?.transaction_disclosure_authorized_at || null },
    customerSending: { providerConfigured: Boolean(env?.RESEND_API_KEY && env?.MAIL_FROM), domainVerified: settings.resend_domain_verified === true, configuredTemplates: configuredEmailTemplates, totalTemplates:emailTemplates.length,requiredTemplatesReady,allLifecycleTemplatesReady,globallyEnabled: settings.transactional_email_enabled === true },
    catalogue: {
      totalVariants: number(counts?.total_variants),
      eligibleVariants: number(counts?.eligible_variants),
      sellableVariants: number(counts?.sellable_variants),
      eligibleSellableVariants: number(counts?.eligible_sellable_variants),
      ineligibleSellableVariants: number(counts?.ineligible_sellable_variants),
      blockedVariants: number(counts?.blocked_variants),
    },
    shippingMarkets: markets.map((market) => ({ countryCode: market.country_code, displayName: market.display_name, status: market.status, strategy: market.strategy, revision: Number(market.revision) })),
    jobs: Object.fromEntries((jobs?.results || []).map((row) => [row.state, number(row.count)])),
    checkedAt: nowIso(),
  };
  const authorityAfter = (await db.prepare(LAUNCH_AUTHORITY_SQL).first()).fingerprint;
  if (authorityBefore !== authorityAfter) throw new AuthFailure(409, "commerce_readiness_changed", "Commerce configuration changed while reading readiness. Reload the current plan.");
  plan.digest = await sha256Hex(authorityAfter);
  Object.defineProperty(plan, "authorityFingerprint", { value: authorityAfter, enumerable: false });
  return plan;
}

export async function applyEligibleVariantSellability(env, actorAccountId = null) {
  const db = requireCommerceDb(env);
  const before = await eligibilityCounts(db);
  const timestamp = nowIso();
  const [enabled, disabled] = await db.batch([
    db.prepare(`UPDATE commerce_product_variants AS v SET is_sellable=1,updated_at=?
      WHERE is_sellable=0 AND EXISTS (SELECT 1 FROM commerce_products p WHERE p.id=v.product_id AND ${ELIGIBLE_VARIANT_PREDICATE})`).bind(timestamp),
    db.prepare(`UPDATE commerce_product_variants AS v SET is_sellable=0,updated_at=?
      WHERE is_sellable=1 AND NOT EXISTS (SELECT 1 FROM commerce_products p WHERE p.id=v.product_id AND ${ELIGIBLE_VARIANT_PREDICATE})`).bind(timestamp),
  ]);
  const after = await eligibilityCounts(db);
  await writeCommerceAudit(env, { actorAccountId, action: "commerce.catalogue_sellability_applied", targetType: "commerce_product_variants", targetId: "eligible-production-catalogue", result: "success", metadata: { before, after, enabled: changes(enabled), disabled: changes(disabled) } });
  return { ok: true, before, after, enabled: changes(enabled), disabled: changes(disabled) };
}

export async function paypalDonationLaunchPlan(env) {
  const db = requireCommerceDb(env);
  const [settingsResult, provider, state, sandboxDonationAcceptance] = await Promise.all([
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('preferred_payment_provider','stripe_enabled','paypal_live_configured','paypal_live_webhook_configured','paypal_live_capture_enabled','paypal_donation_live_capture_enabled','paypal_donations_enabled','paypal_store_checkout_enabled','commerce_emergency_paused')").all(),
    db.prepare("SELECT status,environment,integration_mode,country_code,currency_code,safe_metadata_json FROM commerce_provider_connections WHERE provider='paypal'").first(),
    db.prepare("SELECT * FROM commerce_payment_provider_state WHERE id='primary'").first(),
    db.prepare("SELECT COUNT(*) count FROM commerce_donations WHERE environment='sandbox' AND status='completed'").first(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, null)]));
  const metadata = json(provider?.safe_metadata_json, {});
  const credentials = paypalCredentials(env, "live");
  const technical = paypalTechnicalReadiness({ credentials, metadata: metadata.live, configured: settings.paypal_live_configured === true, webhookConfigured: settings.paypal_live_webhook_configured === true });
  let canonicalWebhookUrl = null;
  try { canonicalWebhookUrl = paypalWebhookUrl(env); } catch {}
  const hardGates = [
    gate("paypal_preferred", settings.preferred_payment_provider === "paypal" && settings.stripe_enabled === false && state?.preferred_provider === "paypal" && Number(state?.stripe_enabled || 0) === 0, "PayPal is preferred and Stripe is retained but disabled."),
    gate("paypal_live_oauth", technical.credentialsConfigured && technical.oauthVerified, "PayPal LIVE credentials authenticated successfully against the LIVE OAuth endpoint."),
    gate("paypal_live_webhook", technical.webhookReadbackVerified && metadata.live?.webhook_url === canonicalWebhookUrl, "The exact LIVE webhook URL and seven-event set were read back."),
    gate("paypal_sandbox_donation_acceptance", Number(sandboxDonationAcceptance?.count || 0) > 0, "A completed Sandbox donation proves the donation-specific local-first create and capture architecture."),
    gate("paypal_direct_merchant", provider?.status === "connected" && provider?.environment === "live" && provider?.integration_mode === "direct_merchant" && provider?.country_code === "CA" && String(provider?.currency_code || "").toUpperCase() === "CAD", "The configured connection is the Canadian CAD direct merchant app."),
    gate("emergency_pause_clear", settings.commerce_emergency_paused !== true && Number(state?.emergency_paused || 0) === 0, "Emergency pause is clear."),
  ];
  return {
    ok: true,
    authority: "Commerce D1 + Admin runtime secrets",
    target: "donations",
    revision: Number(state?.revision || 1),
    ready: hardGates.every((entry) => entry.ready),
    hardGates,
    excludedDependencies: ["catalogue", "shipping", "printful", "fulfillment", "transactional_email"],
    settings: { donationsEnabled: settings.paypal_donations_enabled === true, storeCheckoutEnabled: settings.paypal_store_checkout_enabled === true, storeLiveCaptureEnabled: settings.paypal_live_capture_enabled === true, donationLiveCaptureEnabled: settings.paypal_donation_live_capture_enabled === true, stripeEnabled: settings.stripe_enabled === true },
    checkedAt: nowIso(),
  };
}

export async function activatePayPalDonations(env, input, actorAccountId) {
  requireTransitionInput(input, LIVE_DONATIONS_CONFIRMATION);
  const plan = await paypalDonationLaunchPlan(env);
  if (Number(input.expectedRevision) !== plan.revision) throw new AuthFailure(409, "commerce_launch_revision_conflict", "The PayPal provider state changed. Review the donation plan before activation.");
  if (!plan.ready) throw new AuthFailure(409, "paypal_donations_launch_blocked", "Live PayPal donations cannot activate while a hard gate is blocked.");
  const db = requireCommerceDb(env);
  const timestamp = nowIso();
  const updates = await db.batch([
    setting(db, "preferred_payment_provider", "paypal", timestamp, actorAccountId),
    setting(db, "stripe_enabled", false, timestamp, actorAccountId),
    setting(db, "commerce_environment", "production", timestamp, actorAccountId),
    setting(db, "paypal_live_configured", true, timestamp, actorAccountId),
    setting(db, "paypal_live_webhook_configured", true, timestamp, actorAccountId),
    setting(db, "paypal_donation_live_capture_enabled", true, timestamp, actorAccountId),
    setting(db, "paypal_donations_enabled", true, timestamp, actorAccountId),
    setting(db, "commerce_emergency_paused", false, timestamp, actorAccountId),
    db.prepare(`UPDATE commerce_payment_provider_state SET preferred_provider='paypal',stripe_enabled=0,paypal_live_configured=1,
      paypal_live_capture_enabled=0,paypal_donations_enabled=1,emergency_paused=0,revision=revision+1,
      transition_reason='Authorized independent PayPal LIVE donation activation.',updated_by_actor=?,updated_at=? WHERE id='primary' AND revision=?`).bind(cleanText(actorAccountId,160)||"deployment-cli",timestamp,plan.revision),
    db.prepare(`UPDATE commerce_provider_connections SET status='connected',environment='live',safe_metadata_json=json_set(safe_metadata_json,
      '$.preferred',json('true'),'$.donations_enabled',json('true'),'$.donation_live_capture_enabled',json('true'),'$.store_live_capture_enabled',json('false'),'$.live_capture_enabled',json('false')),updated_at=? WHERE provider='paypal'`).bind(timestamp),
    db.prepare("INSERT INTO commerce_audit (id,actor_account_id,action,target_type,target_id,result,metadata_json,created_at) VALUES (?,?,?,?,?,'success',?,?)")
      .bind(randomId(), cleanText(actorAccountId,160)||null, "commerce.paypal_donations_activated", "commerce_payment_provider_state", "primary", JSON.stringify({ revision: plan.revision + 1, storeCheckoutEnabled: false, stripeEnabled: false }), timestamp),
  ]);
  if (changes(updates[8]) !== 1) throw new AuthFailure(409, "commerce_launch_revision_conflict", "The PayPal provider state changed during donation activation.");
  return paypalDonationLaunchPlan(env);
}

export const STORE_ACTIVATION_SETTINGS = Object.freeze({
  checkout_enabled: true,
  live_payment_capture_enabled: true,
  fulfillment_submission_enabled: true,
  transactional_email_enabled: true,
  internet_agreement_disclosure_enabled: true,
  customer_document_access_enabled: true,
  commerce_environment: "production",
  preferred_payment_provider: "paypal",
  printful_order_mode: "draft_then_confirm",
  paypal_store_checkout_enabled: true,
  paypal_live_capture_enabled: true,
  stripe_enabled: false,
  stripe_tax_enabled: false,
});

export async function activateCommerceLaunch(env, input, actorSession) {
  requireTransitionInput(input, LIVE_ACTIVATION_CONFIRMATION);
  const session = typeof actorSession === "string" ? { accountId: actorSession } : actorSession;
  const actorAccountId = cleanText(session?.accountId, 160);
  if (!actorAccountId) throw new AuthFailure(403, "commerce_actor_required", "An authenticated owner is required.");
  const db = requireCommerceDb(env);
  const plan = await commerceLaunchPlan(env);
  const persistedLaunch = await db.prepare("SELECT last_plan_digest,last_plan_json FROM commerce_launch_state WHERE id='production'").first();
  const requestDigest = await sha256Hex(JSON.stringify({actorAccountId,businessProfileRevision:input.businessProfileRevision,profile:input.profile||null}));
  const sameRequest = json(persistedLaunch?.last_plan_json,{}).requestDigest === requestDigest;
  if (plan.state === "active" && (!input.profile || sameRequest) && plan.business.ownerConfirmed && plan.business.disclosureAuthorized
      && (Number(input.businessProfileRevision) === plan.business.revision || sameRequest)
      && (input.expectedDigest === plan.digest || input.expectedDigest === persistedLaunch?.last_plan_digest)) {
    await verifyActivationReadback(db, plan.business.revision);
    return { ...plan, activationResult: { before: plan.settings, after: plan.settings, activatedAt: plan.activatedAt, actorAccountId: plan.activatedBy, idempotent: true } };
  }
  if (Number(input.expectedRevision) !== plan.revision || input.expectedDigest !== plan.digest) throw new AuthFailure(409, "commerce_launch_revision_conflict", "Readiness changed. Reload the current plan before confirming.");
  const timestamp = nowIso();
  const profileMutation = input.profile ? await prepareBusinessProfileMutation(env, session, input.profile, { attest: true, timestamp }) : null;
  if (Number(input.businessProfileRevision) !== (profileMutation?.currentRevision ?? plan.business.revision)) throw new AuthFailure(409, "commerce_business_revision_conflict", "The business profile changed. Review the current merchant facts.");
  if (!plan.hardGates.every((entry) => entry.ready || (entry.id === "merchant_identity" && profileMutation?.merchantComplete))) throw new AuthFailure(409, "commerce_launch_blocked", "A required launch dependency is unavailable. Review the current hard gates.");
  const profileTargetRevision = profileMutation?.nextRevision ?? plan.business.revision;
  const nextRevision = plan.revision + 1;
  const afterBooleans = { ...plan.settings, checkoutEnabled:true, liveCaptureEnabled:true, fulfillmentEnabled:true, transactionalEmailEnabled:true, internetAgreementDisclosureEnabled:true, customerDocumentAccessEnabled:true, paypalStoreCheckoutEnabled:true, paypalLiveCaptureEnabled:true, stripeEnabled:false, stripeTaxEnabled:false };
  const audit = { readinessRevision:plan.digest, revision:nextRevision, businessProfileRevision:profileTargetRevision,
    before: booleanSettings(plan.settings), after: booleanSettings(afterBooleans) };
  try {
    await db.batch([
      transactionGuard(db, `(${LAUNCH_AUTHORITY_SQL}) = ?`, [plan.authorityFingerprint]),
      profileMutation?.statement || db.prepare(`UPDATE commerce_business_profiles SET owner_attested_revision=revision,owner_attested_at=?,owner_attested_by_account_id=?,transaction_disclosure_authorized_revision=revision,transaction_disclosure_authorized_at=? WHERE id='primary' AND revision=?`).bind(timestamp,actorAccountId,timestamp,plan.business.revision),
      transactionGuard(db, "changes()=1"),
      ...Object.entries(STORE_ACTIVATION_SETTINGS).map(([key,value]) => setting(db,key,value,timestamp,actorAccountId)),
      setting(db,"commerce_launch_revision",nextRevision,timestamp,actorAccountId),
      db.prepare("UPDATE commerce_payment_provider_state SET preferred_provider='paypal',stripe_enabled=0,paypal_live_configured=1,paypal_store_checkout_enabled=1,paypal_live_capture_enabled=1,revision=revision+1,transition_reason='Owner authorized production store.',updated_by_actor=?,updated_at=? WHERE id='primary' AND emergency_paused=0").bind(actorAccountId,timestamp),
      transactionGuard(db, "changes()=1"),
      db.prepare("UPDATE commerce_provider_connections SET safe_metadata_json=json_set(safe_metadata_json,'$.preferred',json('true'),'$.store_checkout_enabled',json('true'),'$.store_live_capture_enabled',json('true'),'$.live_capture_enabled',json('true')),updated_at=? WHERE provider='paypal'").bind(timestamp),
      db.prepare("UPDATE commerce_provider_connections SET environment='live',safe_metadata_json=json_set(safe_metadata_json,'$.fulfillment_enabled',json('true'),'$.order_mode','draft_then_confirm'),updated_at=? WHERE provider='printful'").bind(timestamp),
      db.prepare("UPDATE commerce_products SET checkout_environment='live',updated_at=? WHERE status='active' AND visibility='public'").bind(timestamp),
      db.prepare("UPDATE commerce_launch_state SET state='active',revision=?,last_plan_digest=?,last_plan_json=?,activated_at=?,paused_at=NULL,pause_reason=NULL,updated_by_actor=?,updated_at=? WHERE id='production' AND revision=?").bind(nextRevision,plan.digest,JSON.stringify({before:plan.settings,after:afterBooleans,requestDigest}),timestamp,actorAccountId,timestamp,plan.revision),
      transactionGuard(db, "changes()=1"),
      db.prepare("INSERT INTO commerce_audit (id,actor_account_id,action,target_type,target_id,result,metadata_json,created_at) VALUES (?,?, 'commerce.production_activated','commerce_launch_state','production','success',?,?)").bind(randomId(),actorAccountId,JSON.stringify(audit),timestamp),
    ]);
  } catch (error) {
    if (/commerce_transaction_conflict|malformed JSON/i.test(String(error?.message))) throw new AuthFailure(409,"commerce_launch_revision_conflict","Commerce changed during activation; every activation write was rolled back. Reload and review.");
    const failure=new AuthFailure(503,"commerce_activation_write_failed","Activation could not be saved; the transaction was rolled back.");
    failure.cause=error;
    throw failure;
  }
  await verifyActivationReadback(db, profileTargetRevision);
  const activated = await commerceLaunchPlan(env);
  return { ...activated, activationResult:{before:plan.settings,after:activated.settings,activatedAt:timestamp,actorAccountId,businessProfileRevision:profileTargetRevision,profileSaved:Boolean(profileMutation),idempotent:false} };
}

async function verifyActivationReadback(db, revision) {
  const rows = await db.prepare("SELECT setting_key,value_json FROM commerce_settings").all();
  const settings = Object.fromEntries(rows.results.map((r)=>[r.setting_key,json(r.value_json,null)]));
  const profile = await db.prepare("SELECT revision,owner_attested_revision,transaction_disclosure_authorized_revision FROM commerce_business_profiles WHERE id='primary'").first();
  const state = await db.prepare("SELECT preferred_provider,stripe_enabled,paypal_store_checkout_enabled,paypal_live_capture_enabled,emergency_paused FROM commerce_payment_provider_state WHERE id='primary'").first();
  if (!Object.entries(STORE_ACTIVATION_SETTINGS).every(([key,value])=>settings[key]===value)
      || settings.commerce_emergency_paused === true || settings.tax_calculation_provider !== "not_collecting" || settings.shipping_strategy !== "printful_dynamic"
      || Number(profile?.revision)!==revision || Number(profile?.owner_attested_revision)!==revision || Number(profile?.transaction_disclosure_authorized_revision)!==revision
      || state?.preferred_provider!=="paypal" || Number(state?.stripe_enabled)!==0 || Number(state?.paypal_store_checkout_enabled)!==1 || Number(state?.paypal_live_capture_enabled)!==1 || Number(state?.emergency_paused)!==0) {
    throw new AuthFailure(503,"commerce_activation_readback_failed","Persisted activation readback differs. Refresh store status before retrying.");
  }
}
function booleanSettings(settings) { return Object.fromEntries(Object.entries(settings).filter(([,value])=>typeof value==="boolean")); }

export async function pauseCommerceLaunch(env, input, actorAccountId) {
  requireTransitionInput(input, EMERGENCY_PAUSE_CONFIRMATION, true);
  const db = requireCommerceDb(env);
  const current = await db.prepare("SELECT revision FROM commerce_launch_state WHERE id='production'").first();
  const revision = Number(current?.revision || 1);
  if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== revision) throw new AuthFailure(409, "commerce_launch_revision_conflict", "The launch state changed. Review before pausing.");
  const timestamp = nowIso();
  const nextRevision = revision + 1;
  const reason = cleanText(input.reason, 300) || "Emergency pause requested by an authorized operator.";
  const updates = await db.batch([
    transactionGuard(db, "EXISTS (SELECT 1 FROM commerce_launch_state WHERE id='production' AND revision=?)", [revision]),
    setting(db, "checkout_enabled", false, timestamp, actorAccountId),
    setting(db, "live_payment_capture_enabled", false, timestamp, actorAccountId),
    setting(db, "fulfillment_submission_enabled", false, timestamp, actorAccountId),
    setting(db, "commerce_emergency_paused", true, timestamp, actorAccountId),
    setting(db, "commerce_launch_revision", nextRevision, timestamp, actorAccountId),
    setting(db, "paypal_store_checkout_enabled", false, timestamp, actorAccountId),
    setting(db, "paypal_live_capture_enabled", false, timestamp, actorAccountId),
    setting(db, "stripe_enabled", false, timestamp, actorAccountId),
    db.prepare(`UPDATE commerce_payment_provider_state SET stripe_enabled=0,paypal_store_checkout_enabled=0,paypal_live_capture_enabled=0,
      emergency_paused=1,revision=revision+1,transition_reason=?,updated_by_actor=?,updated_at=? WHERE id='primary'`).bind(reason,cleanText(actorAccountId,160)||"deployment-cli",timestamp),
    db.prepare("UPDATE commerce_provider_connections SET safe_metadata_json=json_set(safe_metadata_json,'$.store_checkout_enabled',json('false'),'$.store_live_capture_enabled',json('false'),'$.live_capture_enabled',json('false')),updated_at=? WHERE provider='paypal'").bind(timestamp),
    db.prepare("UPDATE commerce_provider_connections SET safe_metadata_json=json_set(safe_metadata_json,'$.fulfillment_enabled',json('false')),updated_at=? WHERE provider='printful'").bind(timestamp),
    db.prepare("UPDATE commerce_launch_state SET state='paused',revision=?,paused_at=?,pause_reason=?,updated_by_actor=?,updated_at=? WHERE id='production' AND revision=?")
      .bind(nextRevision, timestamp, reason, cleanText(actorAccountId, 160) || "deployment-cli", timestamp, revision),
    db.prepare("INSERT INTO commerce_audit (id,actor_account_id,action,target_type,target_id,result,metadata_json,created_at) VALUES (?,?,?,?,?,'success',?,?)")
      .bind(randomId(), cleanText(actorAccountId, 160) || null, "commerce.emergency_paused", "commerce_launch_state", "production", JSON.stringify({ revision: nextRevision, reason }), timestamp),
  ]);
  if (changes(updates[12]) !== 1) throw new AuthFailure(409, "commerce_launch_revision_conflict", "The launch state changed during the emergency pause.");
  return commerceLaunchPlan(env);
}

function requireTransitionInput(input, confirmation, reasonAllowed = false) {
  const allowed = new Set(["confirmation", "expectedRevision", ...(reasonAllowed ? ["reason"] : ["expectedDigest","businessProfileRevision","ownerAttestation","transactionDisclosureAuthorization","productionEnvironment","profile"])]);
  const authorizationMissing = confirmation === LIVE_ACTIVATION_CONFIRMATION && (input?.ownerAttestation !== true || input?.transactionDisclosureAuthorization !== true || input?.productionEnvironment !== "production" || !Number.isSafeInteger(Number(input?.businessProfileRevision)) || !/^[a-f0-9]{64}$/.test(String(input?.expectedDigest || "")));
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key)) || input.confirmation !== confirmation || authorizationMissing) {
    throw new AuthFailure(400, "commerce_launch_confirmation_required", reasonAllowed ? `Type ${confirmation} exactly to continue.` : "Explicit owner attestation and production transaction-disclosure authorization are required.");
  }
}

async function eligibilityCounts(db) {
  const row = await db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN ${ELIGIBLE_VARIANT_PREDICATE} THEN 1 ELSE 0 END) eligible,
    SUM(CASE WHEN v.is_sellable=1 THEN 1 ELSE 0 END) sellable
    FROM commerce_product_variants v JOIN commerce_products p ON p.id=v.product_id`).first();
  return { total: number(row?.total), eligible: number(row?.eligible), sellable: number(row?.sellable) };
}

function setting(db, key, value, timestamp, actor) {
  return db.prepare("INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at,updated_by_account_id) VALUES(?,?,'safe',?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,classification='safe',updated_at=excluded.updated_at,updated_by_account_id=excluded.updated_by_account_id")
    .bind(key, JSON.stringify(value), timestamp, cleanText(actor, 160) || null);
}

function gate(id, ready, detail) { return { id, ready: Boolean(ready), state: ready ? "ready" : "blocked", detail }; }
function hasPrintfulSecret(env) { const value = String(env?.PRINTFUL_API_TOKEN || "").trim(); return value.length >= 16 && value.length <= 4096; }
function hasPrintfulWebhookSecrets(env) { const publicKey = String(env?.PRINTFUL_WEBHOOK_V2_PUBLIC_KEY || "").trim(); const secret = String(env?.PRINTFUL_WEBHOOK_V2_SECRET_HEX || "").trim(); return /^[A-Za-z0-9+/_=-]{4,512}$/.test(publicKey) && /^[0-9a-fA-F]{64,1024}$/.test(secret) && secret.length % 2 === 0; }
function transactionDisclosureAddressPresent(value) { const address = json(value, null); return Boolean(address && typeof address === "object" && !Array.isArray(address) && cleanText(address.line1, 160) && cleanText(address.city, 120) && cleanText(address.province, 120) && cleanText(address.postalCode, 64) && cleanText(address.country, 120)); }
function changes(result) { return Number(result?.meta?.changes || 0); }
function number(value) { const result = Number(value); return Number.isSafeInteger(result) && result >= 0 ? result : 0; }
function json(value, fallback) { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }
async function sha256Hex(value) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
