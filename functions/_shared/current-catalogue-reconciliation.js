import { AuthFailure, cleanText, nowIso, randomId } from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";

const PRINTFUL_ORIGIN = "https://api.printful.com";
const EXPECTED_STORE_NAME = "Third Railify API";
const EXPECTED_STORE_TYPE = "native";
const PAGE_SIZE = 10;
const MAX_PAGES = 100;
const MAX_PRODUCTS = 1000;
const DETAIL_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 20_000;
const CONTRACT = "printful-v1-sync-products";
const CURRENT = "current";

export async function currentCatalogueReconciliationStatus(env, session) {
  const db = requireCommerceDb(env);
  const storeId = configuredStoreId(env);
  const [counts, latest] = await Promise.all([
    db.prepare(`SELECT
      COUNT(*) total_products,
      SUM(CASE WHEN provider_store_id=? AND provider_presence='current' THEN 1 ELSE 0 END) current_products,
      SUM(CASE WHEN provider_store_id=? AND provider_presence='current' AND status='active' AND visibility='public' THEN 1 ELSE 0 END) public_products,
      SUM(CASE WHEN provider_presence<>'current' OR archived_at IS NOT NULL THEN 1 ELSE 0 END) archived_products,
      SUM(CASE WHEN provider_reconciliation_status IN ('needs_review','ambiguous') THEN 1 ELSE 0 END) needs_review_products,
      (SELECT COUNT(*) FROM commerce_product_variants WHERE provider_store_id=? AND provider_presence='current') current_variants
      FROM commerce_products`).bind(storeId, storeId, storeId).first(),
    db.prepare(`SELECT id,state,provider_store_id,provider_store_name,provider_store_type,provider_snapshot_hash,
      provider_product_count,provider_variant_count,unusual_reduction,preview_json,result_json,previewed_at,applied_at,updated_at
      FROM commerce_catalogue_reconciliation_runs ORDER BY created_at DESC LIMIT 1`).first(),
  ]);
  return {
    ok: true,
    access: session?.access || null,
    authority: { provider: "Printful", contract: CONTRACT, configuredStoreId: storeId, configurationState: "configured", storeVerified: Boolean(latest), store: latest ? { id: latest.provider_store_id, name: latest.provider_store_name, type: latest.provider_store_type } : null },
    counts: {
      totalProducts: number(counts?.total_products), currentProducts: number(counts?.current_products), publicProducts: number(counts?.public_products),
      archivedProducts: number(counts?.archived_products), needsReviewProducts: number(counts?.needs_review_products), currentVariants: number(counts?.current_variants),
    },
    latest: latest ? serializeRun(latest) : null,
  };
}

export async function previewCurrentCatalogueReconciliation(env, session, fetchImpl = fetch, runtime = {}) {
  const db = requireCommerceDb(env);
  const snapshot = await readCurrentPrintfulSnapshot(env, fetchImpl, runtime);
  const local = await loadLocalCatalogue(db);
  const plan = buildCurrentCataloguePlan(snapshot, local);
  const runId = `ccr_${randomId()}`;
  const timestamp = nowIso();
  const confirmationText = plan.unusualReduction ? `RECONCILE ${snapshot.counts.products} ARCHIVE ${plan.changes.productsArchived}` : `RECONCILE ${snapshot.counts.products}`;
  const preview = publicPlan(plan, runId, confirmationText, timestamp);
  const statements = [
    db.prepare(`INSERT INTO commerce_catalogue_reconciliation_runs (
      id,state,provider_store_id,provider_store_name,provider_store_type,provider_contract,
      provider_snapshot_hash,provider_product_count,provider_variant_count,confirmation_text,
      unusual_reduction,preview_json,actor_account_id,previewed_at,created_at,updated_at
    ) VALUES (?,'previewed',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      runId, snapshot.store.id, snapshot.store.name, snapshot.store.type, CONTRACT, snapshot.fingerprint,
      snapshot.counts.products, snapshot.counts.variants, confirmationText, plan.unusualReduction ? 1 : 0,
      JSON.stringify(preview), session.accountId, timestamp, timestamp, timestamp,
    ),
    ...plan.items.flatMap((item) => reconciliationItemStatements(db, runId, item, timestamp)),
  ];
  await db.batch(statements);
  return preview;
}

export async function applyCurrentCatalogueReconciliation(env, session, input, fetchImpl = fetch, runtime = {}) {
  const db = requireCommerceDb(env);
  const runId = cleanText(input?.runId, 80);
  const confirmation = cleanText(input?.confirmation, 40);
  if (!/^ccr_[A-Za-z0-9_-]{20,}$/.test(runId) || Object.keys(input || {}).some((key) => !["runId", "confirmation"].includes(key))) {
    throw new AuthFailure(400, "catalogue_reconciliation_apply_invalid", "A valid reconciliation preview is required.");
  }
  const run = await db.prepare("SELECT * FROM commerce_catalogue_reconciliation_runs WHERE id=? LIMIT 1").bind(runId).first();
  if (!run) throw new AuthFailure(404, "catalogue_reconciliation_preview_not_found", "The reconciliation preview was not found.");
  if (run.state !== "previewed") throw new AuthFailure(409, "catalogue_reconciliation_preview_not_applicable", "The reconciliation preview is no longer applicable.");
  if (confirmation !== run.confirmation_text) throw new AuthFailure(400, "catalogue_reconciliation_confirmation_required", `Type ${run.confirmation_text} exactly to continue.`);

  const claimTime = nowIso();
  const claim = await db.prepare("UPDATE commerce_catalogue_reconciliation_runs SET state='applying',updated_at=? WHERE id=? AND state='previewed'").bind(claimTime, runId).run();
  if (Number(claim?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "catalogue_reconciliation_preview_not_applicable", "The reconciliation preview is no longer applicable.");

  try {
    const snapshot = await readCurrentPrintfulSnapshot(env, fetchImpl, runtime);
    if (snapshot.fingerprint !== run.provider_snapshot_hash || snapshot.store.id !== run.provider_store_id
      || snapshot.counts.products !== Number(run.provider_product_count) || snapshot.counts.variants !== Number(run.provider_variant_count)) {
      throw new AuthFailure(409, "catalogue_reconciliation_snapshot_changed", "The Printful catalogue changed after Preview. Run a new read-only preview.");
    }
    const local = await loadLocalCatalogue(db);
    const plan = buildCurrentCataloguePlan(snapshot, local);
    const preview = JSON.parse(run.preview_json);
    if (plan.planDigest !== preview.planDigest || plan.blockers.length) {
      throw new AuthFailure(409, plan.blockers.length ? "catalogue_reconciliation_blocked" : "catalogue_reconciliation_local_state_changed", plan.blockers.length ? "The reconciliation contains unresolved identity or price blockers." : "The local catalogue changed after Preview. Run a new preview.");
    }

    const timestamp = nowIso();
    const statements = applyStatements(db, plan, snapshot, timestamp);
    const result = {
      runId, state: "applied", store: snapshot.store, snapshotFingerprint: snapshot.fingerprint,
      providerProducts: snapshot.counts.products, providerVariants: snapshot.counts.variants,
      changes: plan.changes, appliedAt: timestamp,
    };
    statements.push(db.prepare(`UPDATE commerce_catalogue_reconciliation_runs SET state='applied',result_json=?,applied_at=?,updated_at=? WHERE id=? AND state='applying'`).bind(JSON.stringify(result), timestamp, timestamp, runId));
    statements.push(db.prepare(`INSERT INTO commerce_audit (id,actor_account_id,action,target_type,target_id,result,metadata_json,created_at)
      VALUES (?,?,?,?,?,'success',?,?)`).bind(randomId(), session.accountId, "commerce.catalogue_reconciliation_applied", "commerce_catalogue", snapshot.store.id, JSON.stringify({ runId, storeId: snapshot.store.id, snapshotFingerprint: snapshot.fingerprint, providerProducts: snapshot.counts.products, providerVariants: snapshot.counts.variants, changes: plan.changes }), timestamp));
    await db.batch(statements);
    return { ok: true, ...result };
  } catch (error) {
    const failedAt = nowIso();
    try {
      await db.prepare("UPDATE commerce_catalogue_reconciliation_runs SET state='failed',failed_at=?,updated_at=? WHERE id=? AND state='applying'").bind(failedAt, failedAt, runId).run();
    } catch {
      // Preserve the original failure; the run remains non-applicable even if failure recording is unavailable.
    }
    throw error;
  }
}

export async function readCurrentPrintfulSnapshot(env, fetchImpl = fetch, runtime = {}) {
  const storeId = configuredStoreId(env);
  const token = requiredToken(env);
  const get = createGet(fetchImpl, token, storeId, runtime);
  const storesPayload = await get(`${PRINTFUL_ORIGIN}/stores`, "store_identity", false);
  const stores = requiredArray(storesPayload?.result, "printful_stores_invalid").map(normalizeStore);
  const store = stores.find((item) => item.id === storeId);
  if (!store) throw new AuthFailure(409, "printful_configured_store_not_visible", "The configured Printful Store ID is not visible to this credential.");
  if (normalizeName(store.name) !== normalizeName(EXPECTED_STORE_NAME) || store.type !== EXPECTED_STORE_TYPE) throw new AuthFailure(409, "printful_store_identity_invalid", "The configured Printful store is not the expected Third Railify API store.");

  const summaries = [];
  let expectedTotal = null;
  for (let page = 0, offset = 0; page < MAX_PAGES; page += 1) {
    const payload = await get(`${PRINTFUL_ORIGIN}/store/products?offset=${offset}&limit=${PAGE_SIZE}`, "sync_product_page");
    const result = requiredArray(payload?.result, "printful_sync_products_invalid");
    const paging = normalizePaging(payload?.paging, offset, result.length);
    if (expectedTotal === null) expectedTotal = paging.total;
    if (paging.total !== expectedTotal) throw new AuthFailure(502, "printful_pagination_changed", "Printful catalogue pagination changed during the read.");
    summaries.push(...result.map(normalizeSummary));
    if (summaries.length > MAX_PRODUCTS) throw new AuthFailure(502, "printful_catalogue_too_large", "The Printful catalogue exceeds the bounded reader limit.");
    if (offset + result.length >= expectedTotal) break;
    if (!result.length) throw new AuthFailure(502, "printful_pagination_incomplete", "Printful returned an incomplete catalogue page.");
    offset += result.length;
    if (page === MAX_PAGES - 1) throw new AuthFailure(502, "printful_pagination_incomplete", "Printful catalogue pagination did not terminate safely.");
  }
  if (!Number.isSafeInteger(expectedTotal) || expectedTotal < 1 || summaries.length !== expectedTotal) throw new AuthFailure(409, "printful_catalogue_empty_or_incomplete", "The current Printful store returned an empty or incomplete catalogue. No reconciliation can proceed.");
  if (new Set(summaries.map((item) => item.id)).size !== summaries.length) throw new AuthFailure(502, "printful_catalogue_duplicate", "Printful returned duplicate Sync Product identities.");

  const products = await mapLimit([...summaries].sort(compareProvider), DETAIL_CONCURRENCY, async (summary) => {
    const payload = await get(`${PRINTFUL_ORIGIN}/store/products/${encodeURIComponent(summary.id)}`, "sync_product_detail");
    return normalizeProduct(payload?.result, summary);
  });
  const variantIds = products.flatMap((product) => product.variants.map((variant) => variant.id));
  if (new Set(variantIds).size !== variantIds.length) throw new AuthFailure(502, "printful_variant_duplicate", "Printful returned duplicate Sync Variant identities.");
  const fingerprint = await sha256Hex(canonicalJson({ contract: CONTRACT, store, products }));
  return {
    contract: CONTRACT, store, products, fingerprint, retrievedAt: nowIso(),
    counts: {
      products: products.length, variants: variantIds.length,
      ignoredProducts: products.filter((product) => product.isIgnored).length,
      ignoredVariants: products.flatMap((product) => product.variants).filter((variant) => variant.isIgnored).length,
      incompleteProducts: products.filter((product) => product.reviewReasons.length).length,
      productsWithoutImages: products.filter((product) => !product.images.length).length,
      productsWithoutValidVariants: products.filter((product) => !product.variants.some(providerVariantEligible)).length,
    },
  };
}

export function buildCurrentCataloguePlan(snapshot, local) {
  const providerById = new Map(snapshot.products.map((product) => [product.id, product]));
  const providerByExternal = uniqueMap(snapshot.products, (product) => product.externalId);
  const matchedProviderIds = new Set();
  const items = [];
  const localById = new Map(local.products.map((product) => [product.id, product]));

  for (const product of local.products) {
    const match = deterministicProductMatch(product, snapshot.store.id, providerById, providerByExternal);
    const history = product.orderReferences > 0 || product.communityReferences > 0;
    if (match) {
      matchedProviderIds.add(match.id);
      const desired = desiredExistingProduct(product, match, snapshot);
      const incomplete = match.reviewReasons.length > 0 || productIncomplete(product, match);
      const changed = productNeedsUpdate(product, desired, match, snapshot.fingerprint);
      items.push({ kind: "local", classification: incomplete ? "current_incomplete_local_data" : "current_exact_match", action: changed ? "update" : "keep", localProductId: product.id, providerProductId: match.id, history, desired, provider: match, detail: itemDetail(product, match, incomplete) });
      continue;
    }
    const wrongStore = product.providerStoreId && product.providerStoreId !== snapshot.store.id;
    const titleCandidates = snapshot.products.filter((candidate) => normalizeName(candidate.name) === normalizeName(product.title));
    const primary = wrongStore ? "wrong_store" : titleCandidates.length ? "ambiguous_replacement_candidate" : (product.targetPrintfulProductId || product.targetPrintfulExternalId) ? "provider_missing" : "legacy_unidentified";
    const alreadyArchived = product.status === "disabled" && product.visibility === "private" && !product.isFeatured && Boolean(product.archivedAt) && product.providerSnapshotHash === snapshot.fingerprint;
    items.push({ kind: "local", classification: primary, action: alreadyArchived ? "keep" : "archive", localProductId: product.id, providerProductId: null, history, desired: null, provider: null, detail: { title: product.title, titleCandidateIds: titleCandidates.map((candidate) => candidate.id), orderReferences: product.orderReferences, communityReferences: product.communityReferences } });
  }

  const usedSlugs = new Set(local.products.map((product) => product.slug));
  for (const provider of snapshot.products) {
    if (matchedProviderIds.has(provider.id)) continue;
    const externalConflict = provider.externalId && local.products.find((product) => product.targetPrintfulExternalId === provider.externalId && product.targetPrintfulProductId && product.targetPrintfulProductId !== provider.id);
    const desired = desiredNewProduct(provider, snapshot, usedSlugs);
    items.push({ kind: "provider", classification: "current_provider_not_imported", action: externalConflict ? "review" : "insert", localProductId: desired.id, providerProductId: provider.id, history: false, desired, provider, blocker: externalConflict ? `Provider External ID conflicts with local product ${externalConflict.id}.` : null, detail: { title: provider.name, reviewReasons: provider.reviewReasons, externalIdentityConflict: externalConflict?.id || null } });
  }

  const primaryCounts = countBy(items, (item) => item.classification);
  const archiveItems = items.filter((item) => item.action === "archive");
  const changes = {
    productsInserted: items.filter((item) => item.action === "insert").length,
    productsUpdated: items.filter((item) => item.action === "update").length,
    productsArchived: archiveItems.length,
    productsUnchanged: items.filter((item) => item.action === "keep").length,
    variantsInserted: items.reduce((sum, item) => sum + number(item.desired?.variantChanges?.inserted), 0),
    variantsUpdated: items.reduce((sum, item) => sum + number(item.desired?.variantChanges?.updated), 0),
    variantsArchived: items.reduce((sum, item) => sum + number(item.desired?.variantChanges?.archived), 0) + archiveItems.reduce((sum, item) => sum + (localById.get(item.localProductId)?.variants.length || 0), 0),
    imagesReconciled: items.filter((item) => ["insert", "update"].includes(item.action) && item.desired?.imagesChanged).length,
    collectionMembershipsRemoved: archiveItems.reduce((sum, item) => sum + (localById.get(item.localProductId)?.collectionCount || 0), 0),
    featuredStatesRemoved: archiveItems.filter((item) => localById.get(item.localProductId)?.isFeatured).length,
  };
  const counts = {
    ...emptyClassCounts(), ...primaryCounts,
    historically_referenced: items.filter((item) => item.history).length,
    safe_unreferenced_legacy: archiveItems.filter((item) => !item.history).length,
  };
  const blockers = items.filter((item) => item.blocker).map((item) => ({ localProductId: item.localProductId, providerProductId: item.providerProductId, reason: item.blocker }));
  const localUnarchived = local.products.filter((product) => !product.archivedAt).length;
  const unusualReduction = archiveItems.length > 0 && snapshot.counts.products < Math.max(1, Math.floor(localUnarchived / 2));
  const digestInput = { storeId: snapshot.store.id, fingerprint: snapshot.fingerprint, items: items.map((item) => ({ c: item.classification, a: item.action, l: item.localProductId, p: item.providerProductId, d: item.desired ? desiredDigest(item.desired) : null })) };
  return { snapshot, local, items, counts, changes, blockers, unusualReduction, planDigest: fastStableDigest(canonicalJson(digestInput)) };
}

function applyStatements(db, plan, snapshot, timestamp) {
  const statements = [];
  const archive = plan.items.filter((item) => item.action === "archive");
  if (archive.length) {
    for (const chunk of chunks(archive, 80)) {
      const ids = chunk.map((item) => item.localProductId); const placeholders = ids.map(() => "?").join(",");
      statements.push(db.prepare(`UPDATE commerce_products SET status='disabled',visibility='private',is_featured=0,featured_order=NULL,
        provider_presence=CASE WHEN provider_store_id IS NOT NULL AND provider_store_id<>? THEN 'wrong_store' WHEN target_printful_product_id IS NOT NULL OR target_printful_external_id IS NOT NULL THEN 'provider_missing' ELSE 'legacy' END,
        provider_reconciliation_status=CASE WHEN id IN (${chunk.filter((item) => item.classification === "ambiguous_replacement_candidate").map(() => "?").join(",") || "NULL"}) THEN 'ambiguous' ELSE 'archived' END,
        provider_reconciled_at=?,provider_snapshot_hash=?,archived_at=?,archived_reason='not_in_current_printful_store',updated_at=? WHERE id IN (${placeholders})`)
        .bind(snapshot.store.id, ...chunk.filter((item) => item.classification === "ambiguous_replacement_candidate").map((item) => item.localProductId), timestamp, snapshot.fingerprint, timestamp, timestamp, ...ids));
      statements.push(db.prepare(`UPDATE commerce_product_variants SET status='disabled',visibility='private',is_sellable=0,
        provider_presence='provider_missing',provider_reconciled_at=?,provider_snapshot_hash=?,archived_at=?,updated_at=? WHERE product_id IN (${placeholders})`).bind(timestamp, snapshot.fingerprint, timestamp, timestamp, ...ids));
      statements.push(db.prepare(`DELETE FROM commerce_product_collections WHERE product_id IN (${placeholders})`).bind(...ids));
    }
  }
  for (const item of plan.items.filter((entry) => entry.action === "insert" || entry.action === "update")) statements.push(...upsertProductStatements(db, item, snapshot, timestamp));
  return statements;
}

function upsertProductStatements(db, item, snapshot, timestamp) {
  const desired = item.desired;
  const metadataJson = JSON.stringify(desired.metadata);
  const statements = [];
  if (item.action === "insert") {
    statements.push(db.prepare(`INSERT INTO commerce_products (
      id,source_provider,external_product_id,slug,title,currency_code,status,safe_metadata_json,created_at,updated_at,
      is_featured,featured_order,unit_amount,checkout_environment,visibility,max_checkout_quantity,requires_shipping,
      target_printful_product_id,target_printful_external_id,migration_status,migration_provenance_json,
      provider_store_id,provider_presence,provider_reconciliation_status,provider_last_seen_at,provider_reconciled_at,provider_snapshot_hash
    ) VALUES (?,'printful',?,?,?,'CAD','active',?,?,?,0,NULL,?,'test','private',20,1,?,?,'target_verified',?,?,?,?,?,?,?)`)
      .bind(desired.id, desired.externalProductId, desired.slug, desired.title, metadataJson, timestamp, timestamp, desired.unitAmount,
        desired.providerProductId, desired.providerExternalId, JSON.stringify(desired.provenance), snapshot.store.id, CURRENT, desired.reconciliationStatus,
        snapshot.retrievedAt, timestamp, snapshot.fingerprint));
  } else {
    statements.push(db.prepare(`UPDATE commerce_products SET unit_amount=?,safe_metadata_json=?,target_printful_product_id=?,target_printful_external_id=?,
      migration_status='target_verified',migration_provenance_json=?,provider_store_id=?,provider_presence='current',provider_reconciliation_status=?,
      provider_last_seen_at=?,provider_reconciled_at=?,provider_snapshot_hash=?,archived_at=NULL,archived_reason=NULL,
      visibility=CASE WHEN ?='needs_review' THEN 'private' ELSE visibility END,
      is_featured=CASE WHEN ?='needs_review' THEN 0 ELSE is_featured END,
      featured_order=CASE WHEN ?='needs_review' THEN NULL ELSE featured_order END,updated_at=? WHERE id=?`)
      .bind(desired.unitAmount, metadataJson, desired.providerProductId, desired.providerExternalId, JSON.stringify(desired.provenance), snapshot.store.id,
        desired.reconciliationStatus, snapshot.retrievedAt, timestamp, snapshot.fingerprint, desired.reconciliationStatus, desired.reconciliationStatus,
        desired.reconciliationStatus, timestamp, desired.id));
  }
  const providerVariantIds = desired.variants.map((variant) => variant.providerVariantId);
  if (item.action === "update") {
    const clause = providerVariantIds.length ? `target_printful_sync_variant_id NOT IN (${providerVariantIds.map(() => "?").join(",")})` : "1=1";
    statements.push(db.prepare(`UPDATE commerce_product_variants SET status='disabled',visibility='private',is_sellable=0,provider_presence='provider_missing',archived_at=?,provider_reconciled_at=?,provider_snapshot_hash=?,updated_at=? WHERE product_id=? AND (${clause})`).bind(timestamp, timestamp, snapshot.fingerprint, timestamp, desired.id, ...providerVariantIds));
  }
  for (const variant of desired.variants) {
    if (variant.existingId) {
      statements.push(db.prepare(`UPDATE commerce_product_variants SET local_variant_key=?,status=?,visibility=?,is_sellable=?,availability_status=?,is_ignored=?,
        unit_amount=?,currency_code='CAD',sku=?,size_label=?,color_label=?,option_values_json=?,target_printful_product_id=?,target_printful_external_id=?,
        target_printful_sync_variant_id=?,target_catalogue_product_id=?,target_catalogue_variant_id=?,fulfillment_provider='printful',fulfillment_mapping_status=?,
        migration_status='target_verified',migration_provenance_json=?,safe_metadata_json=?,provider_store_id=?,provider_presence='current',provider_last_seen_at=?,
        provider_reconciled_at=?,provider_snapshot_hash=?,archived_at=NULL,updated_at=? WHERE id=? AND product_id=?`)
        .bind(variant.localVariantKey, variant.status, variant.visibility, variant.sellable, variant.availability, variant.ignored, variant.unitAmount,
          variant.sku, variant.size, variant.color, JSON.stringify(variant.options), desired.providerProductId, variant.externalId, variant.providerVariantId,
          variant.catalogueProductId, variant.catalogueVariantId, variant.mappingStatus, JSON.stringify(variant.provenance), JSON.stringify(variant.metadata),
          snapshot.store.id, snapshot.retrievedAt, timestamp, snapshot.fingerprint, timestamp, variant.existingId, desired.id));
    } else {
      statements.push(db.prepare(`INSERT INTO commerce_product_variants (
        id,product_id,local_variant_key,status,visibility,is_sellable,availability_status,is_ignored,unit_amount,currency_code,sku,size_label,color_label,
        option_values_json,target_printful_product_id,target_printful_external_id,target_printful_sync_variant_id,target_catalogue_product_id,target_catalogue_variant_id,
        fulfillment_provider,fulfillment_mapping_status,migration_status,migration_provenance_json,file_mapping_json,safe_metadata_json,created_at,updated_at,
        provider_store_id,provider_presence,provider_last_seen_at,provider_reconciled_at,provider_snapshot_hash
      ) VALUES (?,?,?,?,?,?,?,?,?,'CAD',?,?,?,?,?,?,?,?,?,'printful',?,'target_verified',?,'[]',?,?,?,?, 'current',?,?,?)`)
        .bind(variant.id, desired.id, variant.localVariantKey, variant.status, variant.visibility, variant.sellable, variant.availability, variant.ignored,
          variant.unitAmount, variant.sku, variant.size, variant.color, JSON.stringify(variant.options), desired.providerProductId, variant.externalId,
          variant.providerVariantId, variant.catalogueProductId, variant.catalogueVariantId, variant.mappingStatus, JSON.stringify(variant.provenance),
          JSON.stringify(variant.metadata), timestamp, timestamp, snapshot.store.id, snapshot.retrievedAt, timestamp, snapshot.fingerprint));
    }
  }
  return statements;
}

function desiredExistingProduct(local, provider, snapshot) {
  const variants = desiredVariants(local, provider, snapshot);
  const eligible = provider.variants.filter(providerVariantEligible);
  const reconciliationStatus = provider.reviewReasons.length ? "needs_review" : "current";
  const metadata = { ...local.metadata, publicImage: provider.images[0] || null, publicImages: provider.images.slice(1), providerCatalogue: providerMetadata(snapshot.store, provider) };
  return {
    id: local.id, slug: local.slug, title: local.title, externalProductId: local.externalProductId,
    providerProductId: provider.id, providerExternalId: provider.externalId, unitAmount: eligible.length ? Math.min(...eligible.map((variant) => variant.unitAmount)) : local.unitAmount,
    reconciliationStatus, metadata, variants, imagesChanged: !sameStrings([local.metadata.publicImage, ...array(local.metadata.publicImages)].filter(Boolean), provider.images),
    variantChanges: variantChanges(local.variants, variants), provenance: { contract: CONTRACT, storeId: snapshot.store.id, syncProductId: provider.id, reconciledFrom: "current_store_read_only" },
  };
}

function desiredNewProduct(provider, snapshot, usedSlugs) {
  const id = stableProductId(snapshot.store.id, provider.id);
  const slug = uniqueSlug(provider.name, provider.id, usedSlugs);
  const variants = desiredVariants({ id, variants: [] }, provider, snapshot);
  const eligible = provider.variants.filter(providerVariantEligible);
  return {
    id, slug, title: provider.name, externalProductId: provider.externalId, providerProductId: provider.id, providerExternalId: provider.externalId,
    unitAmount: eligible.length ? Math.min(...eligible.map((variant) => variant.unitAmount)) : 1,
    reconciliationStatus: provider.reviewReasons.length ? "needs_review" : "current",
    metadata: { description: "", publicImage: provider.images[0] || null, publicImages: provider.images.slice(1), categories: [], tags: [], displayOrder: 1000, providerCatalogue: providerMetadata(snapshot.store, provider) },
    variants, imagesChanged: provider.images.length > 0, variantChanges: { inserted: variants.length, updated: 0, archived: 0 },
    provenance: { contract: CONTRACT, storeId: snapshot.store.id, syncProductId: provider.id, reconciledFrom: "current_store_read_only" },
  };
}

function desiredVariants(local, provider, snapshot) {
  const existingById = new Map(local.variants.map((variant) => [variant.targetPrintfulSyncVariantId, variant]).filter(([id]) => id));
  const existingByExternal = uniqueMap(local.variants.filter((variant) => !variant.targetPrintfulSyncVariantId), (variant) => variant.targetPrintfulExternalId);
  return provider.variants.map((variant) => {
    const existing = existingById.get(variant.id) || (variant.externalId ? existingByExternal.get(variant.externalId) : null);
    const eligible = providerVariantEligible(variant);
    const availability = normalizeAvailability(variant.availabilityStatus);
    return {
      id: existing?.id || stableVariantId(snapshot.store.id, variant.id), existingId: existing?.id || null,
      providerVariantId: variant.id, externalId: variant.externalId, localVariantKey: existing?.localVariantKey || `printful-${variant.id}`,
      status: eligible ? (existing?.status || "active") : "disabled", visibility: eligible ? (existing?.visibility || "public") : "private",
      sellable: eligible ? (existing?.isSellable ? 1 : 0) : 0, ignored: variant.isIgnored ? 1 : 0, availability,
      unitAmount: variant.unitAmount || existing?.unitAmount || 1, sku: variant.sku, size: variant.size, color: variant.color, options: variant.options,
      catalogueProductId: variant.catalogueProductId, catalogueVariantId: variant.catalogueVariantId,
      mappingStatus: eligible && variant.catalogueVariantId ? "mapped" : "manual_review",
      metadata: { ...(existing?.metadata || {}), displayLabel: existing?.metadata?.displayLabel || variant.name || [variant.size, variant.color].filter(Boolean).join(" / ") || "Standard", providerImage: variant.catalogueImageUrl || null },
      provenance: { contract: CONTRACT, storeId: snapshot.store.id, syncProductId: provider.id, syncVariantId: variant.id, snapshotHash: snapshot.fingerprint },
    };
  });
}

async function loadLocalCatalogue(db) {
  const [productsResult, variantsResult] = await Promise.all([
    db.prepare(`SELECT p.*,COUNT(DISTINCT pc.collection_id) collection_count,
      (SELECT COUNT(*) FROM commerce_order_items oi WHERE oi.product_id=p.id) order_references,
      (SELECT COUNT(*) FROM community_submissions cs WHERE cs.product_id=p.id) community_references
      FROM commerce_products p LEFT JOIN commerce_product_collections pc ON pc.product_id=p.id GROUP BY p.id ORDER BY p.id`).all(),
    db.prepare("SELECT * FROM commerce_product_variants ORDER BY product_id,id").all(),
  ]);
  const variants = new Map();
  for (const row of variantsResult?.results || []) {
    const next = variants.get(row.product_id) || []; next.push(localVariant(row)); variants.set(row.product_id, next);
  }
  return { products: (productsResult?.results || []).map((row) => localProduct(row, variants.get(row.id) || [])) };
}

function localProduct(row, variants) { return {
  id: row.id, slug: row.slug, title: row.title, status: row.status, visibility: row.visibility, isFeatured: row.is_featured === 1,
  unitAmount: numberOrNull(row.unit_amount), externalProductId: textOrNull(row.external_product_id), targetPrintfulProductId: textOrNull(row.target_printful_product_id),
  targetPrintfulExternalId: textOrNull(row.target_printful_external_id), providerStoreId: textOrNull(row.provider_store_id), providerPresence: row.provider_presence,
  providerReconciliationStatus: row.provider_reconciliation_status, providerSnapshotHash: textOrNull(row.provider_snapshot_hash), archivedAt: textOrNull(row.archived_at),
  metadata: safeObject(row.safe_metadata_json), variants, collectionCount: number(row.collection_count), orderReferences: number(row.order_references), communityReferences: number(row.community_references),
}; }
function localVariant(row) { return { id: row.id, localVariantKey: row.local_variant_key, status: row.status, visibility: row.visibility, isSellable: row.is_sellable === 1,
  availability: row.availability_status, unitAmount: numberOrNull(row.unit_amount), targetPrintfulExternalId: textOrNull(row.target_printful_external_id),
  targetPrintfulSyncVariantId: textOrNull(row.target_printful_sync_variant_id), providerStoreId: textOrNull(row.provider_store_id), providerPresence: row.provider_presence,
  providerSnapshotHash: textOrNull(row.provider_snapshot_hash), metadata: safeObject(row.safe_metadata_json) }; }

function normalizeProduct(result, summary) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new AuthFailure(502, "printful_product_detail_invalid", "Printful returned invalid Sync Product detail.");
  const rawProduct = result.sync_product && typeof result.sync_product === "object" ? result.sync_product : summary;
  const id = providerId(rawProduct.id ?? summary.id, "printful_product_id_invalid");
  if (id !== summary.id) throw new AuthFailure(502, "printful_product_identity_mismatch", "Printful returned mismatched Sync Product detail.");
  const variants = requiredArray(result.sync_variants, "printful_variants_invalid").map((variant) => normalizeVariant(variant, id)).sort(compareProvider);
  const images = uniqueStrings([safeHttps(rawProduct.thumbnail_url ?? rawProduct.thumbnail), ...variants.map((variant) => variant.catalogueImageUrl)].filter(Boolean));
  const reviewReasons = [];
  if (rawProduct.is_ignored === true) reviewReasons.push("product_ignored");
  if (!images.length) reviewReasons.push("missing_customer_safe_image");
  if (!variants.some(providerVariantEligible)) reviewReasons.push("no_valid_current_variants");
  if (variants.some((variant) => variant.currency !== "CAD" || !variant.unitAmount)) reviewReasons.push("price_or_currency_review");
  return { id, externalId: optionalText(rawProduct.external_id, 240), name: requiredText(rawProduct.name ?? summary.name, 300, "printful_product_name_invalid"),
    isIgnored: rawProduct.is_ignored === true, status: optionalText(rawProduct.status, 80), images, variants, reviewReasons: uniqueStrings(reviewReasons) };
}

function normalizeVariant(raw, productId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AuthFailure(502, "printful_variant_invalid", "Printful returned an invalid Sync Variant.");
  const syncProductId = providerId(raw.sync_product_id ?? productId, "printful_variant_product_id_invalid");
  if (syncProductId !== productId) throw new AuthFailure(502, "printful_variant_product_mismatch", "Printful returned a Sync Variant for a different product.");
  const currency = String(raw.currency || "CAD").trim().toUpperCase();
  const unitAmount = decimalMinor(raw.retail_price);
  return { id: providerId(raw.id, "printful_variant_id_invalid"), externalId: optionalText(raw.external_id, 240), syncProductId,
    catalogueProductId: optionalProviderId(raw.product_id ?? raw.product?.product_id ?? raw.product?.id), catalogueVariantId: optionalProviderId(raw.variant_id),
    name: optionalText(raw.name, 300), sku: optionalText(raw.sku, 240), size: optionalText(raw.size, 120), color: optionalText(raw.color, 120),
    options: optionObject(raw.options), synced: raw.synced === true, isIgnored: raw.is_ignored === true, availabilityStatus: optionalText(raw.availability_status, 80),
    unitAmount, currency, catalogueImageUrl: safeHttps(raw.product?.image) };
}

function normalizeSummary(raw) { return { id: providerId(raw?.id, "printful_product_id_invalid"), externalId: optionalText(raw?.external_id, 240), name: requiredText(raw?.name, 300, "printful_product_name_invalid") }; }
function normalizeStore(raw) { return { id: configuredId(raw?.id, "printful_store_id_invalid"), name: requiredText(raw?.name, 240, "printful_store_name_invalid"), type: requiredText(raw?.type, 80, "printful_store_type_invalid").toLowerCase() }; }

function createGet(fetchImpl, token, storeId, runtime) {
  const wait = typeof runtime.wait === "function" ? runtime.wait : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const interval = Number.isSafeInteger(runtime.intervalMs) ? runtime.intervalMs : 675;
  let nextStart = 0; let queue = Promise.resolve();
  return (url, operation, includeStore = true) => {
    const start = queue.then(async () => { const delay = Math.max(0, nextStart - Date.now()); if (delay) await wait(delay); nextStart = Date.now() + interval; });
    queue = start.catch(() => {});
    return start.then(async () => {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try { response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(includeStore ? { "X-PF-Store-Id": storeId } : {}) } }); }
      catch { throw new AuthFailure(502, `printful_${operation}_unavailable`, "Printful could not be reached for the read-only catalogue scan."); }
      finally { clearTimeout(timeout); }
      if (!response?.ok) {
        const status = Number(response?.status || 502);
        const code = status === 401 || status === 403 ? "printful_authentication_failed" : status === 429 || status === 419 ? "printful_rate_limited" : "printful_read_failed";
        throw new AuthFailure(status === 401 || status === 403 ? 503 : 502, code, `Printful read-only catalogue scan failed safely (HTTP ${status}).`);
      }
      try { return await response.json(); } catch { throw new AuthFailure(502, "printful_response_invalid", "Printful returned invalid JSON."); }
    });
  };
}

function publicPlan(plan, runId, confirmationText, previewedAt) { return {
  ok: true, runId, state: "previewed", confirmationText, previewedAt,
  authority: { provider: "Printful", contract: CONTRACT, store: plan.snapshot.store, storeVerified: true, selection: "explicit_configured_store_id", methods: ["GET"] },
  snapshot: { fingerprint: plan.snapshot.fingerprint, retrievedAt: plan.snapshot.retrievedAt, ...plan.snapshot.counts },
  local: { products: plan.local.products.length, activeProducts: plan.local.products.filter((product) => product.status === "active").length, publicProducts: plan.local.products.filter((product) => product.status === "active" && product.visibility === "public").length, variants: plan.local.products.reduce((sum, product) => sum + product.variants.length, 0) },
  counts: plan.counts, changes: plan.changes, unusualReduction: plan.unusualReduction, blockers: plan.blockers,
  groups: Object.fromEntries([...new Set(plan.items.map((item) => item.classification))].sort().map((classification) => [classification, plan.items.filter((item) => item.classification === classification).map((item) => ({ localProductId: item.kind === "local" ? item.localProductId : null, providerProductId: item.providerProductId, action: item.action, historicallyReferenced: item.history, ...item.detail }))])),
  planDigest: plan.planDigest,
}; }

function reconciliationItemStatements(db, runId, item, timestamp) {
  const primary = db.prepare(`INSERT INTO commerce_catalogue_reconciliation_items (id,run_id,local_product_id,provider_sync_product_id,classification,planned_action,historically_referenced,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(`cci_${randomId()}`, runId, item.kind === "local" ? item.localProductId : null, item.providerProductId, item.classification, item.action, item.history ? 1 : 0, JSON.stringify(item.detail || {}), timestamp);
  const result = [primary];
  if (item.history) result.push(db.prepare(`INSERT INTO commerce_catalogue_reconciliation_items (id,run_id,local_product_id,provider_sync_product_id,classification,planned_action,historically_referenced,detail_json,created_at) VALUES (?,?,?,?,?,'keep',1,?,?)`).bind(`cci_${randomId()}`, runId, item.localProductId, item.providerProductId, "historically_referenced", JSON.stringify({ primaryClassification: item.classification }), timestamp));
  else if (item.action === "archive") result.push(db.prepare(`INSERT INTO commerce_catalogue_reconciliation_items (id,run_id,local_product_id,provider_sync_product_id,classification,planned_action,historically_referenced,detail_json,created_at) VALUES (?,?,?,?,?,'archive',0,?,?)`).bind(`cci_${randomId()}`, runId, item.localProductId, item.providerProductId, "safe_unreferenced_legacy", JSON.stringify({ primaryClassification: item.classification }), timestamp));
  return result;
}

function deterministicProductMatch(local, storeId, byId, byExternal) {
  if (local.providerStoreId && local.providerStoreId !== storeId) return null;
  if (local.targetPrintfulProductId) return byId.get(local.targetPrintfulProductId) || null;
  return local.targetPrintfulExternalId ? byExternal.get(local.targetPrintfulExternalId) || null : null;
}
function productIncomplete(local, provider) { const ids = new Set(local.variants.map((variant) => variant.targetPrintfulSyncVariantId).filter(Boolean)); return provider.variants.some((variant) => !ids.has(variant.id)) || [...ids].some((id) => !provider.variants.some((variant) => variant.id === id)) || !sameStrings([local.metadata.publicImage, ...array(local.metadata.publicImages)].filter(Boolean), provider.images); }
function productNeedsUpdate(local, desired, provider, fingerprint) { return local.providerStoreId !== desired.provenance.storeId || local.providerPresence !== CURRENT || local.providerSnapshotHash !== fingerprint || local.targetPrintfulProductId !== provider.id || local.targetPrintfulExternalId !== provider.externalId || productIncomplete(local, provider) || local.providerReconciliationStatus !== desired.reconciliationStatus; }
function itemDetail(local, provider, incomplete) { return { title: local.title, providerTitle: provider.name, localVariants: local.variants.length, providerVariants: provider.variants.length, imageChange: !sameStrings([local.metadata.publicImage, ...array(local.metadata.publicImages)].filter(Boolean), provider.images), incomplete, reviewReasons: provider.reviewReasons, orderReferences: local.orderReferences, communityReferences: local.communityReferences }; }
function desiredDigest(value) { return { id: value.id, p: value.providerProductId, e: value.providerExternalId, s: value.reconciliationStatus, u: value.unitAmount, i: [value.metadata.publicImage, ...array(value.metadata.publicImages)], v: value.variants.map((variant) => [variant.id, variant.providerVariantId, variant.externalId, variant.catalogueVariantId, variant.unitAmount, variant.status, variant.visibility, variant.sellable]) }; }
function variantChanges(local, desired) { const localCurrent = new Map(local.map((variant) => [variant.targetPrintfulSyncVariantId, variant]).filter(([id]) => id)); const desiredIds = new Set(desired.map((variant) => variant.providerVariantId)); return { inserted: desired.filter((variant) => !variant.existingId).length, updated: desired.filter((variant) => variant.existingId && localCurrent.get(variant.providerVariantId)?.providerSnapshotHash !== variant.provenance.snapshotHash).length, archived: [...localCurrent.keys()].filter((id) => !desiredIds.has(id)).length }; }
function providerMetadata(store, provider) { return { contract: CONTRACT, storeId: store.id, syncProductId: provider.id, externalProductId: provider.externalId, providerName: provider.name, status: provider.status, ignored: provider.isIgnored, reviewReasons: provider.reviewReasons, imageProvenance: "printful_sync_product_and_catalogue_mockups" }; }
function providerVariantEligible(variant) { return variant.synced === true && variant.isIgnored !== true && normalizeAvailability(variant.availabilityStatus) === "active" && Number.isSafeInteger(variant.unitAmount) && variant.unitAmount > 0 && variant.currency === "CAD" && Boolean(variant.catalogueVariantId); }
function normalizeAvailability(value) { const text = String(value || "active").toLowerCase(); if (text === "temporary_out_of_stock" || text === "temporarily_out_of_stock" || text === "out_of_stock") return "temporarily_out_of_stock"; if (text === "discontinued") return "discontinued"; return "active"; }

function normalizePaging(raw, offset, length) { const total = Number(raw?.total), pageOffset = Number(raw?.offset), limit = Number(raw?.limit); if (!Number.isSafeInteger(total) || total < 0 || pageOffset !== offset || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || length > limit || offset + length > total) throw new AuthFailure(502, "printful_pagination_invalid", "Printful returned invalid pagination metadata."); return { total, offset: pageOffset, limit }; }
function configuredStoreId(env) { return configuredId(env?.PRINTFUL_STORE_ID, "printful_store_id_required"); }
function configuredId(value, code) { const text = String(value ?? "").trim(); if (!/^[1-9]\d{0,19}$/.test(text)) throw new AuthFailure(503, code, "The explicit server-only Printful Store ID is not configured."); return text; }
function requiredToken(env) { const token = String(env?.PRINTFUL_API_TOKEN || "").trim(); if (!token || token.length > 4096 || /\s/.test(token)) throw new AuthFailure(503, "printful_token_unavailable", "The server-only Printful credential is not configured."); return token; }
function providerId(value, code) { const id = optionalProviderId(value); if (!id) throw new AuthFailure(502, code, "Printful returned an invalid provider identity."); return id; }
function optionalProviderId(value) { const text = String(value ?? "").trim(); return /^[A-Za-z0-9@._:-]{1,240}$/.test(text) ? text : null; }
function requiredText(value, maximum, code) { const text = optionalText(value, maximum); if (!text) throw new AuthFailure(502, code, "Printful returned an invalid required field."); return text; }
function requiredArray(value, code) { if (!Array.isArray(value)) throw new AuthFailure(502, code, "Printful returned an invalid list."); return value; }
function optionalText(value, maximum) { const text = cleanText(value, maximum); return text || null; }
function decimalMinor(value) { const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(String(value ?? "").trim()); if (!match) return null; const amount = Number(match[1]) * 100 + Number(match[2]); return Number.isSafeInteger(amount) && amount > 0 ? amount : null; }
function optionObject(value) { if (!Array.isArray(value)) return {}; return Object.fromEntries(value.slice(0, 20).map((item) => [cleanText(item?.id, 80), cleanText(item?.value, 120)]).filter(([key, item]) => key && item)); }
function safeHttps(value) { try { const url = new URL(String(value || "")); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; } }
function safeObject(value) { try { const parsed = JSON.parse(String(value || "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function textOrNull(value) { const text = String(value ?? "").trim(); return text || null; }
function number(value) { const next = Number(value); return Number.isSafeInteger(next) && next >= 0 ? next : 0; }
function numberOrNull(value) { const next = Number(value); return Number.isSafeInteger(next) ? next : null; }
function array(value) { return Array.isArray(value) ? value : []; }
function uniqueStrings(values) { return [...new Set(values.filter(Boolean).map(String))]; }
function sameStrings(left, right) { const a = uniqueStrings(left), b = uniqueStrings(right); return a.length === b.length && a.every((item, index) => item === b[index]); }
function uniqueMap(values, key) { const grouped = new Map(); const duplicate = new Set(); for (const value of values) { const id = key(value); if (!id) continue; if (grouped.has(id)) duplicate.add(id); else grouped.set(id, value); } for (const id of duplicate) grouped.delete(id); return grouped; }
function normalizeName(value) { return String(value || "").normalize("NFKD").replace(/[^a-z0-9]+/gi, " ").trim().replace(/\s+/g, " ").toLowerCase(); }
function stableProductId(storeId, productId) { return `printful-${storeId}-${productId}`.slice(0, 160); }
function stableVariantId(storeId, variantId) { return `printful-variant-${storeId}-${variantId}`.slice(0, 160); }
function uniqueSlug(name, providerIdValue, used) { const base = String(name || "product").normalize("NFKD").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 145) || "product"; let slug = `${base}-${String(providerIdValue).replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase()}`.slice(0, 180); let suffix = 2; while (used.has(slug)) { slug = `${base.slice(0, 168)}-${suffix++}`; } used.add(slug); return slug; }
function compareProvider(left, right) { return String(left.id).localeCompare(String(right.id), "en", { numeric: true }); }
function countBy(values, key) { const result = {}; for (const value of values) result[key(value)] = number(result[key(value)]) + 1; return result; }
function emptyClassCounts() { return { current_exact_match: 0, current_incomplete_local_data: 0, current_provider_not_imported: 0, wrong_store: 0, provider_missing: 0, legacy_unidentified: 0, ambiguous_replacement_candidate: 0 }; }
function chunks(values, size) { const result = []; for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size)); return result; }
async function mapLimit(values, limit, mapper) { const output = new Array(values.length); let cursor = 0; await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { for (;;) { const index = cursor++; if (index >= values.length) return; output[index] = await mapper(values[index], index); } })); return output; }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
async function sha256Hex(value) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function fastStableDigest(value) { let a = 0x811c9dc5; for (let index = 0; index < value.length; index += 1) { a ^= value.charCodeAt(index); a = Math.imul(a, 0x01000193); } return `${(a >>> 0).toString(16).padStart(8, "0")}${value.length.toString(16).padStart(8, "0")}`; }
function serializeRun(row) { return { id: row.id, state: row.state, store: { id: row.provider_store_id, name: row.provider_store_name, type: row.provider_store_type }, snapshotFingerprint: row.provider_snapshot_hash, providerProducts: Number(row.provider_product_count), providerVariants: Number(row.provider_variant_count), unusualReduction: row.unusual_reduction === 1, preview: safeObject(row.preview_json), result: row.result_json ? safeObject(row.result_json) : null, previewedAt: row.previewed_at, appliedAt: row.applied_at, updatedAt: row.updated_at }; }
