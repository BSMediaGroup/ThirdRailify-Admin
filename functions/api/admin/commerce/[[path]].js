import {
  AuthFailure,
  corsHeaders,
  enforceRateLimit,
  errorResponse,
  jsonResponse,
  normalizeOrigin,
  readJsonBody,
  requireAdmin,
  requireCsrf,
  requireMasterAdmin,
  writeAudit,
} from "../../../_shared/auth-core.js";
import {
  archiveCollection,
  bulkUpdateCollections,
  bulkUpdateMerchandisingProducts,
  collectionDetailPayload,
  collectionListPayload,
  collectionProductsListPayload,
  collectionsPayload,
  collectionOptionsPayload,
  commerceOverview,
  createCollection,
  deleteCollection,
  grantCommerceCapability,
  merchandisingProductsPayload,
  merchandisingProductListPayload,
  merchandisingProductPayload,
  permissionGrantsPayload,
  requireCommerceCapability,
  revokeCommerceCapability,
  templatesPayload,
  updateBusinessProfile,
  updateCollection,
  updateCollectionOrder,
  updateCollectionMemberships,
  updateCollectionProducts,
  updateFeaturedProducts,
  updateMerchandisingProduct,
  updateMerchandisingVariant,
  updateProductCollections,
  updateTemplate,
  verifyPrintfulStore,
  verifyStripeAccount,
} from "../../../_shared/commerce-core.js";
import {
  assemblePrintfulCatalogueSnapshot,
  beginPrintfulCatalogueSnapshot,
  discoverLegacyPrintfulSource,
  readPrintfulCatalogueFileChunk,
  readPrintfulCatalogueProductChunk,
} from "../../../_shared/printful-catalogue.js";
import { reconcileCatalogues } from "../../../_shared/catalogue-reconciliation.js";
import { PUBLIC_WIX_CATALOGUE } from "../../../_shared/public-wix-catalogue.js";
import { commerceOrderDetailPayload, commerceOrdersPayload, createStripeCheckoutSession } from "../../../_shared/checkout-core.js";
import { customerDetailPayload, customerListPayload } from "../../../_shared/commerce-customers.js";
import { commerceMediaLimits, ingestCommerceProductMedia, uploadCommerceProductMedia } from "../../../_shared/commerce-media.js";
import {
  businessInformationPayload,
  createStoredPrintfulDraftOrder,
  createTaxRegistration,
  customerEmailsControlPlanePayload,
  fulfillmentShippingPayload,
  issueOrderDocumentAccess,
  orderDocumentPreviewPayload,
  paymentsControlPlanePayload,
  productionReadinessPayload,
  sendTestTemplateEmail,
  taxRegistrationsPayload,
  templatePreviewPayload,
  updateTaxRegistration,
} from "../../../_shared/commerce-control-plane.js";
import {
  permanentMigrationPayload,
  resumeManuallyPausedPermanentPrintfulMigration,
  runPermanentPrintfulMigrationStep,
} from "../../../_shared/printful-migration.js";

const ROUTE_PREFIX = "/api/admin/commerce";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method === "OPTIONS") return handleOptions(request, env);
    const path = new URL(request.url).pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET") return await handleGet(request, env, path);
    if (request.method === "POST") return await handlePost(request, env, path, context.data?.commerceFetch || fetch, context.data?.schedulerRuntime || {});
    throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET, POST, OPTIONS" });
  } catch (error) {
    return errorResponse(error, request, env);
  }
}

async function handleGet(request, env, path) {
  requireAdminOriginWhenPresent(request, env);
  const session = await requireAdmin(env, request);
  let payload;
  if (!path || path === "overview") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await commerceOverview(env, session);
    if (payload.databaseConfigured) payload.readiness = await productionReadinessPayload(env, session);
  } else if (path === "business") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await businessInformationPayload(env, session);
  } else if (path === "templates") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await templatesPayload(env, session);
  } else if (path === "emails") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await customerEmailsControlPlanePayload(env, session);
  } else if (path === "tax") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await taxRegistrationsPayload(env, session);
  } else if (path === "readiness") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await productionReadinessPayload(env, session);
  } else if (path === "payments") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await paymentsControlPlanePayload(env, session);
  } else if (path === "fulfillment") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await fulfillmentShippingPayload(env, session);
  } else if (path === "products/list") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await merchandisingProductListPayload(env, session, Object.fromEntries(new URL(request.url).searchParams));
  } else if (path === "products") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await merchandisingProductsPayload(env, session);
  } else if (path === "collections/options") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await collectionOptionsPayload(env, session);
  } else if (path === "collections/list") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await collectionListPayload(env, session, Object.fromEntries(new URL(request.url).searchParams));
  } else if (/^collections\/[^/]+\/products\/list$/.test(path)) {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await collectionProductsListPayload(env, session, decodePathPart(path.split("/")[1]), Object.fromEntries(new URL(request.url).searchParams));
  } else if (path === "collections") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await collectionsPayload(env, session);
  } else if (/^collections\/[^/]+$/.test(path)) {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await collectionDetailPayload(env, session, decodePathPart(path.split("/")[1]));
  } else if (path.startsWith("products/")) {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await merchandisingProductPayload(env, session, decodePathPart(path.slice("products/".length)));
  } else if (path === "orders") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await commerceOrdersPayload(env, session, Object.fromEntries(new URL(request.url).searchParams));
  } else if (/^orders\/[^/]+$/.test(path)) {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await commerceOrderDetailPayload(env, session, decodePathPart(path.split("/")[1]));
  } else if (path === "customers") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await customerListPayload(env, session, Object.fromEntries(new URL(request.url).searchParams));
  } else if (/^customers\/[^/]+$/.test(path)) {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await customerDetailPayload(env, session, decodePathPart(path.split("/")[1]), Object.fromEntries(new URL(request.url).searchParams));
  } else if (path === "media/config") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = commerceMediaLimits();
  } else if (/^orders\/[^/]+\/documents\/(receipt|invoice)$/.test(path)) {
    await requireCommerceCapability(env, session, "commerce.view");
    const [, orderId, , documentType] = path.split("/");
    payload = await orderDocumentPreviewPayload(env, session, decodePathPart(orderId), documentType);
  } else if (path === "printful/catalogue/migration") {
    await requireMasterAdmin(env, request);
    payload = await permanentMigrationPayload(env);
  } else if (path === "permissions") {
    await requireMasterAdmin(env, request);
    payload = await permissionGrantsPayload(env, session);
  } else {
    throw new AuthFailure(404, "not_found", "The commerce route was not found.");
  }
  return jsonResponse(payload, { headers: corsHeaders(request, env) });
}

async function handlePost(request, env, path, fetchImpl = fetch, schedulerRuntime = {}) {
  requireAdminOrigin(request, env);
  const session = await requireAdmin(env, request);
  await requireCsrf(request, session);
  const snapshotBody = path === "printful/catalogue/snapshot" ? await readSnapshotRequest(request) : null;
  const isSnapshotStart = snapshotBody?.phase === "begin" && !snapshotBody?.checkpoint;
  const rateCategory = path === "printful/catalogue/migrate"
    ? "commerce_migration"
    : path.endsWith("/send-test") ? "commerce_email"
    : path === "printful/catalogue/snapshot" && !isSnapshotStart ? "commerce_snapshot" : "commerce";
  await enforceRateLimit(env, request, rateCategory, session.accountId);
  let payload;
  let authEventType;

  if (path === "stripe/verify") {
    await requireCommerceCapability(env, session, "commerce.payments.manage");
    payload = await verifyStripeAccount(env, session, fetchImpl);
    authEventType = "stripe_account_verified";
  } else if (path === "test-checkout") {
    await requireMasterAdmin(env, request);
    const body = await readJsonBody(request);
    const checkoutRequestId = String(body.checkoutRequestId || "");
    const productId = String(body.productId || "");
    const variantId = String(body.variantId || "");
    if (Object.keys(body).some((key) => !new Set(["checkoutRequestId", "productId", "variantId", "quantity", "recipient", "quoteId", "shippingOptionId", "customer"]).has(key)) || Object.keys(body).length !== 8) {
      throw new AuthFailure(400, "stripe_test_checkout_request_invalid", "The controlled test checkout request is invalid.");
    }
    payload = await createStripeCheckoutSession(env, request, {
      checkoutRequestId,
      items: [{ productId, variantId, quantity: body.quantity }],
      recipient: body.recipient,
      quoteId: body.quoteId,
      shippingOptionId: body.shippingOptionId,
      customer: body.customer,
    }, fetchImpl, { gate: "controlled_test" });
    authEventType = "stripe_test_checkout_created";
  } else if (/^orders\/[^/]+\/printful-draft$/.test(path)) {
    await requireMasterAdmin(env, request);
    const body = await readJsonBody(request);
    if (!body || Object.keys(body).length !== 1 || body.confirmUnconfirmedDraft !== true) {
      throw new AuthFailure(400, "printful_draft_confirmation_required", "Explicit confirmation of an unconfirmed Printful draft is required.");
    }
    payload = await createStoredPrintfulDraftOrder(env, session, decodePathPart(path.split("/")[1]), fetchImpl);
    authEventType = payload.created ? "printful_order_draft_created" : "printful_order_draft_reconciled";
  } else if (path === "printful/verify") {
    await requireCommerceCapability(env, session, "commerce.integrations.manage");
    payload = await verifyPrintfulStore(env, session, fetchImpl);
    authEventType = "printful_store_verified";
  } else if (path === "printful/catalogue/source/verify") {
    await requireCommerceCapability(env, session, "commerce.integrations.manage");
    payload = { ok: true, ...(await discoverLegacyPrintfulSource(env, fetchImpl)) };
    authEventType = "printful_catalogue_source_verified";
  } else if (path === "printful/catalogue/snapshot") {
    await requireCommerceCapability(env, session, "commerce.integrations.manage");
    requireCommerceDatabase(env);
    const body = snapshotBody;
    if (body.phase === "begin") {
      payload = await beginPrintfulCatalogueSnapshot(env, body, fetchImpl, schedulerRuntime);
    } else if (body.phase === "products") {
      payload = await readPrintfulCatalogueProductChunk(env, body, fetchImpl, schedulerRuntime);
    } else if (body.phase === "files") {
      payload = await readPrintfulCatalogueFileChunk(env, body, fetchImpl, schedulerRuntime);
    } else if (body.phase === "assemble") {
      const providerSnapshot = await assemblePrintfulCatalogueSnapshot(env, body);
      payload = {
        ok: true,
        ...providerSnapshot,
        publicCatalogue: PUBLIC_WIX_CATALOGUE,
        reconciliation: reconcileCatalogues(providerSnapshot, PUBLIC_WIX_CATALOGUE),
        downloadFilenames: {
          source: "printful-wix-source.snapshot.json",
          target: "printful-api-target.snapshot.json",
          publicCatalogue: "public-wix-catalog.snapshot.json",
          reconciliation: "catalogue-reconciliation.json",
        },
      };
      authEventType = "printful_catalogue_snapshot_completed";
    } else {
      throw new AuthFailure(400, "printful_snapshot_phase_invalid", "The catalogue snapshot phase is invalid.");
    }
  } else if (path === "printful/catalogue/migrate") {
    await requireMasterAdmin(env, request);
    requireCommerceDatabase(env);
    const body = await readJsonBody(request);
    if (!body || Object.keys(body).length !== 1 || body.action !== "continue_permanent_printful_migration") {
      throw new AuthFailure(400, "printful_migration_action_invalid", "An explicit permanent migration continuation action is required.");
    }
    await resumeManuallyPausedPermanentPrintfulMigration(env);
    payload = await runPermanentPrintfulMigrationStep(env, session, fetchImpl, schedulerRuntime);
  } else if (path === "business") {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    await updateBusinessProfile(env, session, body);
    payload = await businessInformationPayload(env, session);
    authEventType = "commerce_business_updated";
  } else if (path === "tax") {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await createTaxRegistration(env, session, body);
    authEventType = "commerce_tax_registration_created";
  } else if (/^tax\/[^/]+$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateTaxRegistration(env, session, decodePathPart(path.slice("tax/".length)), body);
    authEventType = "commerce_tax_registration_updated";
  } else if (/^templates\/[^/]+\/preview$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await templatePreviewPayload(env, session, decodePathPart(path.split("/")[1]), body);
  } else if (/^templates\/[^/]+\/send-test$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.templates.manage");
    payload = await sendTestTemplateEmail(env, session, decodePathPart(path.split("/")[1]), body, fetchImpl);
    authEventType = "commerce_template_test_email_requested";
  } else if (path.startsWith("templates/")) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.templates.manage");
    const templateKey = decodePathPart(path.slice("templates/".length));
    payload = await updateTemplate(env, session, templateKey, body);
    authEventType = "commerce_template_updated";
  } else if (/^orders\/[^/]+\/documents\/(receipt|invoice)\/issue$/.test(path)) {
    const body = await readJsonBody(request);
    if (body?.confirmIssue !== true || Object.keys(body).length !== 1) throw new AuthFailure(400, "document_issue_confirmation_required", "Explicit document issuance confirmation is required.");
    await requireCommerceCapability(env, session, "commerce.templates.manage");
    const [, orderId, , documentType] = path.split("/");
    payload = await issueOrderDocumentAccess(env, session, decodePathPart(orderId), documentType);
    authEventType = "commerce_order_document_issued";
  } else if (path === "products/bulk") {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await bulkUpdateMerchandisingProducts(env, session, body);
    authEventType = "commerce_products_bulk_updated";
  } else if (path === "products/featured") {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateFeaturedProducts(env, session, body);
    authEventType = "commerce_featured_products_updated";
  } else if (/^products\/[^/]+\/media\/ingest$/.test(path)) {
    await requireCommerceCapability(env, session, "commerce.business.manage");
    const productId = decodePathPart(path.split("/")[1]);
    if (String(request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
      payload = await uploadCommerceProductMedia(env, session, productId, request);
      authEventType = "commerce_product_media_uploaded";
    } else {
      const body = await readJsonBody(request);
      payload = await ingestCommerceProductMedia(env, session, productId, body, fetchImpl);
      authEventType = "commerce_product_media_ingested";
    }
  } else if (path === "collections/bulk") {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await bulkUpdateCollections(env, session, body);
    authEventType = "commerce_collections_bulk_updated";
  } else if (path === "collections") {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await createCollection(env, session, body);
    authEventType = "commerce_collection_created";
  } else if (path === "collections/order") {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateCollectionOrder(env, session, body);
    authEventType = "commerce_collections_reordered";
  } else if (/^collections\/[^/]+\/products\/bulk$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateCollectionMemberships(env, session, decodePathPart(path.split("/")[1]), body);
    authEventType = "commerce_collection_memberships_updated";
  } else if (/^collections\/[^/]+\/products$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateCollectionProducts(env, session, decodePathPart(path.split("/")[1]), body);
    authEventType = "commerce_collection_products_updated";
  } else if (/^collections\/[^/]+\/archive$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await archiveCollection(env, session, decodePathPart(path.split("/")[1]), body);
    authEventType = "commerce_collection_archived";
  } else if (/^collections\/[^/]+\/delete$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await deleteCollection(env, session, decodePathPart(path.split("/")[1]), body);
    authEventType = "commerce_collection_deleted";
  } else if (/^collections\/[^/]+$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateCollection(env, session, decodePathPart(path.split("/")[1]), body);
    authEventType = "commerce_collection_updated";
  } else if (/^products\/[^/]+\/collections$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateProductCollections(env, session, decodePathPart(path.split("/")[1]), body);
    authEventType = "commerce_product_collections_updated";
  } else if (/^products\/[^/]+\/variants\/[^/]+$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    const [, productPart, , variantPart] = path.split("/");
    payload = await updateMerchandisingVariant(env, session, decodePathPart(productPart), decodePathPart(variantPart), body);
    authEventType = "commerce_variant_updated";
  } else if (/^products\/[^/]+$/.test(path)) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateMerchandisingProduct(env, session, decodePathPart(path.slice("products/".length)), body);
    authEventType = "commerce_product_updated";
  } else if (path === "permissions/grant") {
    const body = await readJsonBody(request);
    await requireMasterAdmin(env, request);
    await grantCommerceCapability(env, session, body.accountId, body.capability, body.reason);
    payload = await permissionGrantsPayload(env, session);
    authEventType = "commerce_capability_granted";
  } else if (path === "permissions/revoke") {
    const body = await readJsonBody(request);
    await requireMasterAdmin(env, request);
    await revokeCommerceCapability(env, session, body.accountId, body.capability);
    payload = await permissionGrantsPayload(env, session);
    authEventType = "commerce_capability_revoked";
  } else {
    throw new AuthFailure(404, "not_found", "The commerce action was not found.");
  }

  if (authEventType) await writeAudit(env, {
    actorAccountId: session.accountId,
    eventType: authEventType,
    result: "success",
    provider: path === "stripe/verify" ? "stripe" : path.startsWith("printful/") ? "printful" : undefined,
    metadata: {
      commerceAudit: true,
      ...(path === "stripe/verify" ? { environment: "test" } : {}),
      ...(path === "printful/verify" ? { access: "single_store", providerApi: "real", orderMode: "draft_only" } : {}),
      ...(path === "printful/catalogue/source/verify" ? {
        access: "read_only_migration_source",
        sourceStoreId: payload.store.id,
        sourceStoreType: payload.store.type,
        configuredSourceIdMatches: payload.configurationMatches,
      } : {}),
      ...(path === "printful/catalogue/snapshot" ? {
        access: "read_only_catalogue_snapshot",
        sourceStoreId: payload.source.store.id,
        targetStoreId: payload.target.store.id,
        sourceProductCount: payload.source.counts.products,
        sourceVariantCount: payload.source.counts.variants,
        targetProductCount: payload.target.counts.products,
        targetVariantCount: payload.target.counts.variants,
        matchedCount: payload.reconciliation.counts.printfulBackedMatches,
        unresolvedCount: payload.reconciliation.counts.unresolved,
        nonPrintfulCount: payload.reconciliation.counts.nonPrintful,
        correlationId: payload.correlationId,
      } : {}),
    },
  });
  return jsonResponse(payload, { headers: corsHeaders(request, env) });
}

async function readSnapshotRequest(request) {
  const text = await request.text();
  if (!text) return { phase: "begin" };
  if (text.length > 8 * 1024 * 1024) throw new AuthFailure(413, "printful_snapshot_body_too_large", "The catalogue snapshot evidence is too large.");
  let body;
  try { body = JSON.parse(text); }
  catch { throw new AuthFailure(400, "invalid_json", "The request body must be valid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AuthFailure(400, "invalid_body", "The request body is invalid.");
  return body;
}

function requireCommerceDatabase(env) {
  if (!env?.THIRDRAILIFY_COMMERCE_DB || typeof env.THIRDRAILIFY_COMMERCE_DB.prepare !== "function") {
    throw new AuthFailure(503, "commerce_database_unavailable", "Commerce storage is required for this audited action.");
  }
}

function requireAdminOriginWhenPresent(request, env) {
  if (!request.headers.get("origin")) return;
  requireAdminOrigin(request, env);
}

function requireAdminOrigin(request, env) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const adminOrigin = normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
  if (!origin || origin !== adminOrigin) throw new AuthFailure(403, "origin_not_allowed", "This request origin is not allowed.");
}

function handleOptions(request, env) {
  requireAdminOrigin(request, env);
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, env),
      "Access-Control-Allow-Headers": "content-type,x-csrf-token",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value).slice(0, 80);
  } catch {
    return "";
  }
}

export { handleGet, handlePost };
