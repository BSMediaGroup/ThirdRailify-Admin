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
  businessProfilePayload,
  commerceOverview,
  grantCommerceCapability,
  merchandisingProductsPayload,
  permissionGrantsPayload,
  requireCommerceCapability,
  revokeCommerceCapability,
  templatesPayload,
  updateBusinessProfile,
  updateFeaturedProducts,
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
import { commerceOrdersPayload } from "../../../_shared/checkout-core.js";

const ROUTE_PREFIX = "/api/admin/commerce";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method === "OPTIONS") return handleOptions(request, env);
    const path = new URL(request.url).pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET") return await handleGet(request, env, path);
    if (request.method === "POST") return await handlePost(request, env, path);
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
  } else if (path === "business") {
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await businessProfilePayload(env, session);
  } else if (path === "templates") {
    await requireCommerceCapability(env, session, "commerce.templates.manage");
    payload = await templatesPayload(env, session);
  } else if (path === "products") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await merchandisingProductsPayload(env, session);
  } else if (path === "orders") {
    await requireCommerceCapability(env, session, "commerce.view");
    payload = await commerceOrdersPayload(env, session);
  } else if (path === "permissions") {
    await requireMasterAdmin(env, request);
    payload = await permissionGrantsPayload(env, session);
  } else {
    throw new AuthFailure(404, "not_found", "The commerce route was not found.");
  }
  return jsonResponse(payload, { headers: corsHeaders(request, env) });
}

async function handlePost(request, env, path, fetchImpl = fetch) {
  requireAdminOrigin(request, env);
  const session = await requireAdmin(env, request);
  await requireCsrf(request, session);
  await enforceRateLimit(env, request, "commerce", session.accountId);
  let payload;
  let authEventType;

  if (path === "stripe/verify") {
    await requireCommerceCapability(env, session, "commerce.payments.manage");
    payload = await verifyStripeAccount(env, session, fetchImpl);
    authEventType = "stripe_account_verified";
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
    const body = await readSnapshotRequest(request);
    if (body.phase === "begin") {
      payload = await beginPrintfulCatalogueSnapshot(env, fetchImpl);
    } else if (body.phase === "products") {
      payload = await readPrintfulCatalogueProductChunk(env, body, fetchImpl);
    } else if (body.phase === "files") {
      payload = await readPrintfulCatalogueFileChunk(env, body, fetchImpl);
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
  } else if (path === "business") {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.business.manage");
    payload = await updateBusinessProfile(env, session, body);
    authEventType = "commerce_business_updated";
  } else if (path.startsWith("templates/")) {
    const body = await readJsonBody(request);
    await requireCommerceCapability(env, session, "commerce.templates.manage");
    const templateKey = decodePathPart(path.slice("templates/".length));
    payload = await updateTemplate(env, session, templateKey, body);
    authEventType = "commerce_template_updated";
  } else if (path === "products/featured") {
    const body = await readJsonBody(request);
    await requireMasterAdmin(env, request);
    payload = await updateFeaturedProducts(env, session, body);
    authEventType = "commerce_featured_products_updated";
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
