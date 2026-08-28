import { AuthFailure, cleanText, randomId } from "./auth-core.js";
import { PRINTFUL_REQUEST_START_INTERVAL_MS } from "./printful-catalogue.js";
import { requireCommerceDb, writeCommerceAudit } from "./commerce-core.js";

export const PERMANENT_MIGRATION_ID = "permanent-printful-2026-08";
export const PRINTFUL_SOURCE_STORE_ID = "16847493";
export const PRINTFUL_TARGET_STORE_ID = "18668025";
export const PRINTFUL_SOURCE_STORE_NAME = "Third Railify Official";
export const PRINTFUL_TARGET_STORE_NAME = "Third Railify API";
export const PRINTFUL_MIGRATION_ENDPOINTS = Object.freeze({
  stores: "https://api.printful.com/stores",
  scopes: "https://api.printful.com/v2/oauth-scopes",
  sourceProduct: (id) => `https://api.printful.com/sync/products/${encodeURIComponent(id)}`,
  sourceVariant: (id) => `https://api.printful.com/sync/variant/${encodeURIComponent(id)}`,
  sourceFile: (id) => `https://api.printful.com/files/${encodeURIComponent(id)}`,
  fileV2: (id) => `https://api.printful.com/v2/files/${encodeURIComponent(id)}`,
  targetFiles: "https://api.printful.com/files",
  targetProduct: (externalId) => `https://api.printful.com/store/products/@${encodeURIComponent(externalId)}`,
  targetProducts: "https://api.printful.com/store/products",
});

const EXPECTED_PRODUCTS = 49;
const EXPECTED_ACTIVE_VARIANTS = 1317;
const EXPECTED_DEFERRED_VARIANTS = 5;
const EXPECTED_D1_PRODUCTS = 50;
const EXPECTED_D1_VARIANTS = 1323;
const MAX_VARIANTS_PER_PRODUCT = 100;
const LEASE_MS = 60_000;
const PROCESSING_POLL_MS = 5_000;
const TRANSIENT_RETRY_MS = 2_000;
const MAX_TRANSIENT_ATTEMPTS = 3;
const MAX_SOURCE_FILE_REPRESENTATIVES = 3;
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const ACCEPTED_STRIPE_TEST_ORDER_ID = "ord_e47b94a4-4252-438b-8ca7-c47470029940";
const ACCEPTED_STRIPE_TEST_SESSION_ID = "cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC";
const TARGET_WRITE_SCOPE_ALIASES = new Set(["sync_products", "sync_products/write", "products", "products/write"]);
const RECOVERABLE_BLOCK_CODES = new Set(["printful_source_file_original_url_missing", "printful_source_file_url_unavailable", "printful_source_file_resolution_incomplete"]);
const PRODUCT_BLOCK_CODES = new Set([
  "printful_source_file_url_unavailable",
  "printful_source_file_original_url_missing",
  "printful_target_external_id_conflict",
  "printful_target_variant_count_conflict",
  "printful_target_variant_identity_conflict",
  "printful_target_catalogue_variant_conflict",
  "printful_target_price_conflict",
  "printful_target_file_failed",
  "printful_target_file_count_conflict",
  "printful_target_file_placement_conflict",
  "printful_target_create_rejected",
]);

export async function permanentMigrationPayload(env) {
  const db = requireCommerceDb(env);
  const job = await requireMigrationJob(db);
  const [products, variants, settings, orders, providers, fileMappings] = await Promise.all([
    db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN migration_status = 'target_native' THEN 1 ELSE 0 END) AS target_native,
      SUM(CASE WHEN migration_status = 'target_verified' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN migration_status = 'blocked' THEN 1 ELSE 0 END) AS blocked
      FROM commerce_products`).first(),
    db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN migration_status = 'deferred' THEN 1 ELSE 0 END) AS deferred,
      SUM(CASE WHEN migration_status = 'target_verified' AND fulfillment_mapping_status = 'mapped' THEN 1 ELSE 0 END) AS mapped,
      SUM(CASE WHEN availability_status = 'discontinued' AND is_sellable = 1 THEN 1 ELSE 0 END) AS discontinued_sellable
      FROM commerce_product_variants`).first(),
    db.prepare("SELECT setting_key, value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled', 'live_payment_capture_enabled', 'fulfillment_submission_enabled', 'printful_order_mode') ORDER BY setting_key").all(),
    commerceOrderCounts(db),
    db.prepare("SELECT provider, safe_metadata_json FROM commerce_provider_connections WHERE provider IN ('stripe','printful','wix')").all(),
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN json_extract(safe_metadata_json, '$.resolutionMethod') IN ('source_v2_url','source_v1_url','sync_variant_url','local_exact_artwork','original_url') THEN 1 ELSE 0 END) AS original_exact,
      SUM(CASE WHEN json_extract(safe_metadata_json, '$.resolutionMethod') = 'target_existing_file' THEN 1 ELSE 0 END) AS target_existing,
      SUM(CASE WHEN json_extract(safe_metadata_json, '$.resolutionMethod') = 'printful_preview_rehydrated' THEN 1 ELSE 0 END) AS preview_rehydrated
      FROM commerce_printful_file_mappings WHERE source_store_id = ?`).bind(PRINTFUL_SOURCE_STORE_ID).first(),
  ]);
  const current = job.current_product_id
    ? await db.prepare("SELECT id, title, legacy_printful_source_product_id, migration_status FROM commerce_products WHERE id = ?").bind(job.current_product_id).first()
    : null;
  const fileProgress = current
    ? await db.prepare(`SELECT
        COUNT(DISTINCT json_extract(file.value, '$.sourceFileId')) AS total,
        COUNT(DISTINCT CASE WHEN resolved.source_file_id IS NOT NULL THEN json_extract(file.value, '$.sourceFileId') END) AS resolved
      FROM commerce_product_variants AS variant, json_each(variant.file_mapping_json) AS file
      LEFT JOIN commerce_printful_file_mappings AS resolved
        ON resolved.source_store_id = ? AND resolved.source_file_id = json_extract(file.value, '$.sourceFileId')
      WHERE variant.product_id = ? AND variant.migration_status IN ('selected', 'target_created', 'provider_processing', 'target_verified')
        AND variant.availability_status = 'active'`)
      .bind(PRINTFUL_SOURCE_STORE_ID, current.id).first()
    : null;
  const safeState = safeJson(job.safe_state_json, {});
  const manuallyPaused = safeState.manualPause === true;
  const blockedProducts = Array.isArray(safeState.blockedProducts) ? safeState.blockedProducts : [];
  const publicStatus = job.status === "completed" && blockedProducts.length
    ? "completed_with_blocked_products"
    : job.status;
  const settingMap = Object.fromEntries(settings.results.map((row) => [row.setting_key, safeJson(row.value_json, null)]));
  const providerMap = providerSafetyMap(providers.results);
  const safety = permanentMigrationSafety(settingMap, providerMap, orders.prohibited);
  const processedProducts = number(job.products_verified) + blockedProducts.length;
  return {
    ok: true,
    migration: {
      id: job.id,
      status: publicStatus,
      phase: job.phase,
      currentProduct: current ? { id: current.id, title: current.title, legacySourceProductId: current.legacy_printful_source_product_id, migrationStatus: current.migration_status } : null,
      fileProgress: fileProgress ? { resolved: number(fileProgress.resolved), total: number(fileProgress.total) } : null,
      completedProducts: number(job.products_verified),
      processedProducts,
      remainingProducts: Math.max(0, EXPECTED_PRODUCTS - processedProducts),
      totalProducts: EXPECTED_PRODUCTS,
      productsCreated: number(job.products_created),
      productsAdopted: number(job.products_adopted),
      variantsMapped: number(job.variants_mapped),
      providerFailures: number(job.provider_failures),
      providerRequestCount: number(job.provider_request_count),
      providerState: manuallyPaused ? "paused" : job.status === "waiting" ? "waiting" : job.status === "blocked" ? "blocked" : job.status === "completed" ? "completed" : "ready",
      retryAt: manuallyPaused ? null : number(job.throttle_until || job.next_provider_request_at) || null,
      manuallyPaused,
      lastError: safeState.lastError || null,
      canResume: job.status === "blocked" && RECOVERABLE_BLOCK_CODES.has(safeState.lastError?.code),
      checkpointState: job.status === "blocked" && RECOVERABLE_BLOCK_CODES.has(safeState.lastError?.code) ? "checkpointed_resumable" : job.status === "completed" ? "verified" : "checkpointed",
      scopes: safeState.scopes || null,
      targetVerified: safeState.targetVerified === true,
      sourceVerified: safeState.sourceVerified === true,
      updatedAt: job.updated_at,
      completedAt: job.completed_at || null,
      blockedProducts,
    },
    catalogue: {
      plannedProductCreates: EXPECTED_PRODUCTS,
      targetNativeKeeps: number(products.target_native),
      eligibleVariants: EXPECTED_ACTIVE_VARIANTS,
      deferredVariants: number(variants.deferred),
      d1Products: number(products.total),
      d1Variants: number(variants.total),
      verifiedProducts: number(products.verified),
      mappedVariants: number(variants.mapped),
      blockedProducts: number(products.blocked),
      fileMappings: {
        unique: number(fileMappings.total),
        originalExact: number(fileMappings.original_exact),
        targetExisting: number(fileMappings.target_existing),
        printfulPreviewRehydrated: number(fileMappings.preview_rehydrated),
        unresolved: number(safeState.unresolvedArtworkMappings),
      },
    },
    safety: {
      ...safety,
      commerceOrders: number(orders.total),
      printfulOrdersCreated: 0,
      printfulWebhooksMutated: 0,
    },
  };
}

export async function resumeManuallyPausedPermanentPrintfulMigration(env) {
  const db = requireCommerceDb(env);
  const job = await requireMigrationJob(db);
  const state = safeJson(job.safe_state_json, {});
  if (state.manualPause !== true) return false;
  const resumedState = withoutKeys(state, ["manualPause", "manualPauseReason", "manualPauseAt"]);
  const timestamp = Date.now();
  const result = await db.prepare(`UPDATE commerce_catalogue_migrations SET status='running', next_provider_request_at=NULL,
    throttle_until=NULL, safe_state_json=?, revision=revision+1, updated_at=?
    WHERE id=? AND json_extract(safe_state_json,'$.manualPause')=1
      AND (step_lease_token IS NULL OR step_lease_expires_at <= ?)`)
    .bind(JSON.stringify(resumedState), iso(timestamp), PERMANENT_MIGRATION_ID, timestamp).run();
  if (number(result?.meta?.changes) !== 1) throw new AuthFailure(409, "printful_migration_checkpoint_busy", "The permanent migration checkpoint is currently leased; retry the explicit continuation shortly.");
  return true;
}

export async function runPermanentPrintfulMigrationStep(env, session, fetchImpl = fetch, runtime = {}) {
  const db = requireCommerceDb(env);
  await assertPermanentCatalogueAuthority(db, env);
  const now = typeof runtime.now === "function" ? runtime.now : Date.now;
  const leaseToken = randomId();
  let job = await requireMigrationJob(db);
  if (await recoverLegacyTargetIdRejection(db, job, now())) {
    job = await requireMigrationJob(db);
    await writeCommerceAudit(env, {
      actorAccountId: session?.accountId,
      action: "printful.catalogue_target_file_ids_rejected",
      targetType: "commerce_catalogue_migration",
      targetId: PERMANENT_MIGRATION_ID,
      result: "success",
      metadata: { recovery: "preview_rehydration", preservedProviderFailures: number(job.provider_failures) },
    });
  }
  if (job.status === "blocked") {
    const resumed = await resumeRecoverableBlockedJob(db, job, now());
    if (!resumed) return permanentMigrationPayload(env);
    job = await requireMigrationJob(db);
    await writeCommerceAudit(env, {
      actorAccountId: session?.accountId,
      action: "printful.catalogue_migration_resumed",
      targetType: "commerce_catalogue_migration",
      targetId: PERMANENT_MIGRATION_ID,
      result: "success",
      metadata: { phase: job.phase, productId: job.current_product_id, preservedProductsVerified: number(job.products_verified), preservedVariantsMapped: number(job.variants_mapped) },
    });
  }
  if (job.status === "completed") return permanentMigrationPayload(env);
  const claimed = await db.prepare(`UPDATE commerce_catalogue_migrations
    SET step_lease_token = ?, step_lease_expires_at = ?, revision = revision + 1,
        status = CASE WHEN status = 'ready' THEN 'running' ELSE status END,
        started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE id = ? AND (step_lease_token IS NULL OR step_lease_expires_at <= ?)`)
    .bind(leaseToken, now() + LEASE_MS, iso(now()), iso(now()), PERMANENT_MIGRATION_ID, now()).run();
  if (number(claimed?.meta?.changes) !== 1) return permanentMigrationPayload(env);

  try {
    job = await requireMigrationJob(db);
    const waitUntil = Math.max(number(job.throttle_until), number(job.next_provider_request_at));
    if (waitUntil > now()) {
      await updateJob(db, leaseToken, { status: "waiting", updated_at: iso(now()) });
      return permanentMigrationPayload(env);
    }
    if (job.status === "waiting") await updateJob(db, leaseToken, { status: "running", throttle_until: null, updated_at: iso(now()) });
    job = await requireMigrationJob(db);
    if (job.phase === "preflight") await runPreflightStep(db, env, job, leaseToken, fetchImpl, now);
    else await runProductStep(db, env, job, leaseToken, fetchImpl, now);
  } catch (error) {
    if (error instanceof MigrationWait) {
      await updateJob(db, leaseToken, { status: "waiting", updated_at: iso(now()) });
    } else if (PRODUCT_BLOCK_CODES.has(error?.code) && (await requireMigrationJob(db)).current_product_id) {
      job = await requireMigrationJob(db);
      await skipBlockedProduct(db, job, leaseToken, error, now());
      await writeCommerceAudit(env, {
        actorAccountId: session?.accountId,
        action: "printful.catalogue_product_blocked",
        targetType: "commerce_product",
        targetId: job.current_product_id,
        result: "error",
        metadata: { migrationId: PERMANENT_MIGRATION_ID, phase: job.phase, code: error.code, continued: true },
      });
    } else {
      await blockMigration(db, job, leaseToken, error, now());
      await writeCommerceAudit(env, {
        actorAccountId: session?.accountId,
        action: "printful.catalogue_migration_blocked",
        targetType: "commerce_catalogue_migration",
        targetId: PERMANENT_MIGRATION_ID,
        result: "error",
        metadata: { phase: job.phase, productId: job.current_product_id || null, code: error?.code || "migration_failed" },
      });
    }
  } finally {
    await db.prepare("UPDATE commerce_catalogue_migrations SET step_lease_token = NULL, step_lease_expires_at = NULL WHERE id = ? AND step_lease_token = ?")
      .bind(PERMANENT_MIGRATION_ID, leaseToken).run();
  }
  const payload = await permanentMigrationPayload(env);
  if (["completed", "completed_with_blocked_products"].includes(payload.migration.status)) {
    await writeCommerceAudit(env, {
      actorAccountId: session?.accountId,
      action: "printful.catalogue_migration_completed",
      targetType: "commerce_catalogue_migration",
      targetId: PERMANENT_MIGRATION_ID,
      result: "success",
      metadata: { productsCreated: payload.migration.productsCreated, productsAdopted: payload.migration.productsAdopted, variantsMapped: payload.migration.variantsMapped },
    });
  }
  return payload;
}

async function runPreflightStep(db, env, job, leaseToken, fetchImpl, now) {
  const state = safeJson(job.safe_state_json, {});
  const step = state.preflightStep || "target_store";
  if (step === "target_store") {
    const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.stores, credential: targetCredential(env), operation: "target_store", allowedStatuses: [200] }, fetchImpl, now);
    const store = normalizeSingleStore(response.payload, "target");
    assertStore(store, PRINTFUL_TARGET_STORE_ID, PRINTFUL_TARGET_STORE_NAME, "native", "target");
    await setSafeState(db, leaseToken, { ...state, preflightStep: "target_scopes", targetVerified: true, targetStore: store }, now());
    return;
  }
  if (step === "target_scopes") {
    const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.scopes, credential: targetCredential(env), operation: "target_scopes", allowedStatuses: [200] }, fetchImpl, now);
    const scopes = normalizeOAuthScopes(response.payload);
    assertMigrationScopes(scopes);
    await setSafeState(db, leaseToken, { ...state, preflightStep: "source_store", targetVerified: true, scopes }, now());
    return;
  }
  if (step === "source_store") {
    const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.stores, credential: sourceCredential(env), operation: "source_store", allowedStatuses: [200] }, fetchImpl, now);
    const store = normalizeSingleStore(response.payload, "source");
    assertStore(store, PRINTFUL_SOURCE_STORE_ID, PRINTFUL_SOURCE_STORE_NAME, "wix", "source");
    if (store.id === PRINTFUL_TARGET_STORE_ID) throw migrationError("printful_source_target_store_collision", "Legacy source and permanent target Store IDs must differ.");
    await updateJob(db, leaseToken, {
      phase: "source_product",
      status: "running",
      safe_state_json: JSON.stringify({ ...state, preflightStep: "complete", targetVerified: true, sourceVerified: true, sourceStore: store }),
      updated_at: iso(now()),
    });
  }
}

async function runProductStep(db, env, job, leaseToken, fetchImpl, now) {
  let product = job.current_product_id ? await migrationProduct(db, job.current_product_id) : null;
  if (!product) {
    product = await db.prepare(`SELECT * FROM commerce_products
      WHERE legacy_printful_source_product_id IS NOT NULL
        AND migration_status IN ('selected', 'resolving_files', 'target_created', 'provider_processing')
      ORDER BY CAST(legacy_printful_source_product_id AS INTEGER), id LIMIT 1`).first();
    if (!product) {
      const state = safeJson(job.safe_state_json, {});
      const blockedProducts = Array.isArray(state.blockedProducts) ? state.blockedProducts : [];
      await updateJob(db, leaseToken, {
        status: "completed",
        phase: "completed",
        current_product_id: null,
        safe_state_json: JSON.stringify({ ...state, finalStatus: blockedProducts.length ? "completed_with_blocked_products" : "completed" }),
        completed_at: iso(now()),
        updated_at: iso(now()),
      });
      return;
    }
    const phase = phaseForProduct(product);
    await updateJob(db, leaseToken, { current_product_id: product.id, phase, status: "running", updated_at: iso(now()) });
    job = await requireMigrationJob(db);
  }
  if (job.phase === "source_product") return readAndValidateSourceProduct(db, env, job, product, leaseToken, fetchImpl, now);
  if (job.phase === "source_files") return resolveNextSourceFile(db, env, job, product, leaseToken, fetchImpl, now);
  if (job.phase === "target_lookup") return lookupTargetProduct(db, env, job, product, leaseToken, fetchImpl, now);
  if (job.phase === "target_create") return createTargetProduct(db, env, job, product, leaseToken, fetchImpl, now);
  if (job.phase === "target_verify") return verifyTargetProduct(db, env, job, product, leaseToken, fetchImpl, now);
  throw migrationError("printful_migration_phase_invalid", `Unsupported durable migration phase ${job.phase}.`);
}

async function readAndValidateSourceProduct(db, env, job, product, leaseToken, fetchImpl, now) {
  const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.sourceProduct(product.legacy_printful_source_product_id), credential: sourceCredential(env), operation: "source_product", allowedStatuses: [200] }, fetchImpl, now);
  const result = normalizeSyncProductResponse(response.payload, "source");
  const expected = await productVariants(db, product.id);
  validateSourceProduct(result, product, expected);
  await db.batch([
    db.prepare("UPDATE commerce_products SET migration_status = 'resolving_files', updated_at = ? WHERE id = ? AND migration_status = 'selected'").bind(iso(now()), product.id),
    db.prepare("UPDATE commerce_catalogue_migrations SET phase = 'source_files', status = 'running', updated_at = ? WHERE id = ? AND step_lease_token = ?").bind(iso(now()), PERMANENT_MIGRATION_ID, leaseToken),
  ]);
}

async function resolveNextSourceFile(db, env, job, product, leaseToken, fetchImpl, now) {
  const unresolved = await db.prepare(`SELECT DISTINCT json_extract(file.value, '$.sourceFileId') AS source_file_id,
      json_extract(file.value, '$.filename') AS expected_filename,
      json_extract(file.value, '$.type') AS expected_type
    FROM commerce_product_variants AS variant, json_each(variant.file_mapping_json) AS file
    LEFT JOIN commerce_printful_file_mappings AS resolved
      ON resolved.source_store_id = ? AND resolved.source_file_id = json_extract(file.value, '$.sourceFileId')
    WHERE variant.product_id = ? AND variant.migration_status = 'selected' AND variant.availability_status = 'active'
      AND resolved.source_file_id IS NULL
    ORDER BY CAST(json_extract(file.value, '$.sourceFileId') AS INTEGER) LIMIT 1`)
    .bind(PRINTFUL_SOURCE_STORE_ID, product.id).first();
  if (!unresolved) {
    const state = safeJson(job.safe_state_json, {});
    if (state.sourceFileResolution) await setSafeState(db, leaseToken, withoutKeys(state, ["sourceFileResolution"]), now());
    await updateJob(db, leaseToken, { phase: "target_lookup", status: "running", updated_at: iso(now()) });
    return;
  }
  const sourceFileId = String(unresolved.source_file_id);
  if (!sourceFileId || cleanText(unresolved.expected_type, 120) === "preview") throw migrationError("printful_target_file_plan_invalid", `Source file ${sourceFileId || "unknown"} is a mockup preview rather than print artwork.`);
  const representatives = await sourceFileRepresentatives(db, product.id, sourceFileId);
  const state = safeJson((await requireMigrationJob(db)).safe_state_json, {});
  const forceRehydration = Array.isArray(state.rejectedTargetFileIds) && state.rejectedTargetFileIds.map(String).includes(sourceFileId);
  const resolution = state.sourceFileResolution?.sourceFileId === sourceFileId
    ? state.sourceFileResolution
    : {
        sourceFileId,
        expectedFilename: safeFilename(unresolved.expected_filename),
        attemptedVariantIds: [],
        targetV2Attempted: forceRehydration,
        targetV1Attempted: forceRehydration,
        sourceV2Attempted: false,
        sourceV1Attempted: false,
        previewUploadAttempted: false,
        previewBytesValidated: false,
      };
  const checkpoint = async (next) => setSafeState(db, leaseToken, { ...state, sourceFileResolution: next }, now());
  const persist = async (file) => {
    await persistFileMapping(db, file, now());
    await setSafeState(db, leaseToken, withoutKeys(state, ["sourceFileResolution"]), now());
  };

  if (!resolution.targetV2Attempted) {
    const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.fileV2(sourceFileId), credential: targetCredential(env), operation: "target_file_v2_probe", allowedStatuses: [200, 401, 403, 404] }, fetchImpl, now);
    const candidate = response.status === 200 ? normalizeFileDetail(response.payload, sourceFileId, resolution.expectedFilename) : null;
    if (candidate && state.targetExistingIdsRejectedForCreate !== true) return persist(targetExistingMapping(candidate, sourceFileId));
    await checkpoint({ ...resolution, targetV2Attempted: true, previewCandidate: safePreviewCandidate(candidate) || resolution.previewCandidate || null });
    return;
  }
  if (!resolution.targetV1Attempted) {
    const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.sourceFile(sourceFileId), credential: targetCredential(env), operation: "target_file_v1_probe", allowedStatuses: [200, 401, 403, 404] }, fetchImpl, now);
    const candidate = response.status === 200 ? normalizeFileDetail(response.payload, sourceFileId, resolution.expectedFilename) : null;
    if (candidate && state.targetExistingIdsRejectedForCreate !== true) return persist(targetExistingMapping(candidate, sourceFileId));
    await checkpoint({ ...resolution, targetV1Attempted: true, previewCandidate: safePreviewCandidate(candidate) || resolution.previewCandidate || null });
    return;
  }
  if (!resolution.sourceV2Attempted) {
    const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.fileV2(sourceFileId), credential: sourceCredential(env), operation: "source_file_v2", allowedStatuses: [200, 401, 403, 404] }, fetchImpl, now);
    const candidate = response.status === 200 ? normalizeFileDetail(response.payload, sourceFileId, resolution.expectedFilename) : null;
    if (candidate?.url) return persist(originalUrlMapping(candidate, "source_v2_url"));
    await checkpoint({ ...resolution, sourceV2Attempted: true, previewCandidate: safePreviewCandidate(candidate) || resolution.previewCandidate || null });
    return;
  }
  if (!resolution.sourceV1Attempted) {
    const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.sourceFile(sourceFileId), credential: sourceCredential(env), operation: "source_file_v1", allowedStatuses: [200, 401, 403, 404] }, fetchImpl, now);
    const candidate = response.status === 200 ? normalizeFileDetail(response.payload, sourceFileId, resolution.expectedFilename) : null;
    if (candidate?.url) return persist(originalUrlMapping(candidate, "source_v1_url"));
    await checkpoint({ ...resolution, sourceV1Attempted: true, previewCandidate: safePreviewCandidate(candidate) || resolution.previewCandidate || null });
    return;
  }

  const attempted = new Set(Array.isArray(resolution.attemptedVariantIds) ? resolution.attemptedVariantIds.map(String) : []);
  const representative = representatives.find((variant) => !attempted.has(variant.legacySourceVariantId));
  if (representative) {
    const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.sourceVariant(representative.legacySourceVariantId), credential: sourceCredential(env), operation: "source_variant_file", allowedStatuses: [200] }, fetchImpl, now);
    const inspected = inspectSourceVariantFile(response.payload, {
      sourceFileId,
      expectedFilename: unresolved.expected_filename,
      legacySyncVariantId: representative.legacySourceVariantId,
      legacySyncProductId: product.legacy_printful_source_product_id,
      catalogueVariantId: representative.catalogueVariantId,
    });
    if (inspected.file?.url) return persist(originalUrlMapping(inspected.file, "sync_variant_url"));
    await checkpoint({
      ...resolution,
      attemptedVariantIds: [...attempted, representative.legacySourceVariantId],
      previewCandidate: safePreviewCandidate(inspected.candidate) || resolution.previewCandidate || null,
    });
    return;
  }

  const preview = safePreviewCandidate(resolution.previewCandidate);
  if (preview && !resolution.previewUploadAttempted) {
    const targetFilename = derivativeFilename(sourceFileId, preview.previewUrl, preview.mimeType);
    const response = await providerRequest(db, env, job, leaseToken, {
      method: "POST",
      url: PRINTFUL_MIGRATION_ENDPOINTS.targetFiles,
      credential: targetCredential(env),
      operation: "target_file_rehydrate",
      allowedStatuses: [200, 400, 401, 403, 404, 409, 422],
      body: { url: preview.previewUrl, filename: targetFilename, visible: false },
    }, fetchImpl, now);
    if (response.status === 200) {
      const target = normalizeCreatedTargetFile(response.payload, targetFilename);
      return persist({
        id: sourceFileId,
        url: preview.previewUrl,
        filename: targetFilename,
        status: "ok",
        metadata: {
          resolutionMethod: "printful_preview_rehydrated",
          sourceStoreId: PRINTFUL_SOURCE_STORE_ID,
          sourceFileId,
          sourceFilename: resolution.expectedFilename,
          targetStoreId: PRINTFUL_TARGET_STORE_ID,
          targetFileId: target.id,
          targetFilename,
          previewUrl: preview.previewUrl,
          providerHash: target.hash || null,
        },
      });
    }
    await checkpoint({ ...resolution, previewUploadAttempted: true, previewRejectedStatus: response.status });
    return;
  }
  if (preview && resolution.previewUploadAttempted && !resolution.previewBytesValidated) {
    const validation = await validatePrintfulPreviewBytes(preview.previewUrl, fetchImpl);
    await checkpoint({ ...resolution, previewBytesValidated: true, previewByteEvidence: validation, directDataUploadSupported: false });
    return;
  }

  const localExact = localExactArtwork(env, sourceFileId, resolution.expectedFilename);
  if (localExact) return persist({
    id: sourceFileId,
    url: localExact.url,
    filename: localExact.filename,
    status: "ok",
    metadata: {
      resolutionMethod: "local_exact_artwork",
      sourceStoreId: PRINTFUL_SOURCE_STORE_ID,
      sourceFileId,
      sourceFilename: resolution.expectedFilename,
      targetStoreId: PRINTFUL_TARGET_STORE_ID,
      targetFileId: null,
      targetFilename: localExact.filename,
      sha256: localExact.sha256 || null,
    },
  });
  throw migrationError("printful_source_file_url_unavailable", `Source file ${sourceFileId} has no target-accessible ID, original URL, accepted Printful preview rehydration, or exact hosted local artwork.`);
}

async function sourceFileRepresentatives(db, productId, sourceFileId) {
  const rows = await db.prepare(`SELECT DISTINCT variant.legacy_source_variant_id, variant.target_catalogue_variant_id
    FROM commerce_product_variants AS variant, json_each(variant.file_mapping_json) AS file
    WHERE variant.product_id = ? AND variant.migration_status = 'selected' AND variant.availability_status = 'active'
      AND json_extract(file.value, '$.sourceFileId') = ? AND variant.legacy_source_variant_id IS NOT NULL
    ORDER BY CAST(variant.legacy_source_variant_id AS INTEGER), variant.legacy_source_variant_id
    LIMIT ?`).bind(productId, sourceFileId, MAX_SOURCE_FILE_REPRESENTATIVES).all();
  return rows.results.map((row) => ({ legacySourceVariantId: String(row.legacy_source_variant_id), catalogueVariantId: String(row.target_catalogue_variant_id) }));
}

async function persistFileMapping(db, file, now) {
  if (!file || !providerId(file.id) || !safeHttps(file.url) || !safeFilename(file.filename) || !new Set(["ok", "accepted"]).has(file.status)) {
    throw migrationError("printful_file_mapping_invalid", "A resolved Printful file mapping is invalid.");
  }
  await db.prepare(`INSERT INTO commerce_printful_file_mappings
    (source_store_id, source_file_id, source_url, filename, file_status, safe_metadata_json, resolved_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_store_id, source_file_id) DO UPDATE SET
      source_url = excluded.source_url, filename = excluded.filename, file_status = excluded.file_status,
      safe_metadata_json = excluded.safe_metadata_json, resolved_at = excluded.resolved_at, updated_at = excluded.updated_at`)
    .bind(PRINTFUL_SOURCE_STORE_ID, file.id, file.url, file.filename, file.status, JSON.stringify(file.metadata || {}), iso(now), iso(now)).run();
}

export function normalizeFileDetail(payload, expectedId, expectedFilename) {
  const raw = payload?.data || (payload?.code === 200 ? payload.result : null);
  if (!raw || Array.isArray(raw) || String(raw.id) !== String(expectedId)) return null;
  const status = cleanText(raw.status, 40).toLowerCase();
  const filename = safeFilename(raw.filename || expectedFilename);
  if (!new Set(["ok", "accepted"]).has(status) || !filename || (expectedFilename && normalizeName(filename) !== normalizeName(expectedFilename))) return null;
  return {
    id: String(raw.id),
    filename,
    status,
    url: safeHttps(raw.url),
    previewUrl: safeHttps(raw.preview_url || raw.previewUrl),
    thumbnailUrl: safeHttps(raw.thumbnail_url || raw.thumbnailUrl),
    mimeType: cleanText(raw.mime_type || raw.mimeType, 160) || null,
    size: nullableNumber(raw.size),
    width: nullableNumber(raw.width),
    height: nullableNumber(raw.height),
    dpi: nullableNumber(raw.dpi),
    hash: cleanText(raw.hash, 160) || null,
  };
}

function targetExistingMapping(candidate, sourceFileId) {
  return {
    id: sourceFileId,
    url: candidate.url || candidate.previewUrl || candidate.thumbnailUrl || PRINTFUL_MIGRATION_ENDPOINTS.sourceFile(sourceFileId),
    filename: candidate.filename,
    status: candidate.status,
    metadata: {
      resolutionMethod: "target_existing_file",
      sourceStoreId: PRINTFUL_SOURCE_STORE_ID,
      sourceFileId,
      sourceFilename: candidate.filename,
      targetStoreId: PRINTFUL_TARGET_STORE_ID,
      targetFileId: sourceFileId,
      targetFilename: candidate.filename,
      providerHash: candidate.hash,
      previewUrl: candidate.previewUrl,
      mimeType: candidate.mimeType,
      size: candidate.size,
      width: candidate.width,
      height: candidate.height,
      dpi: candidate.dpi,
    },
  };
}

function originalUrlMapping(candidate, resolutionMethod) {
  return {
    id: candidate.id,
    url: candidate.url,
    filename: candidate.filename,
    status: candidate.status,
    metadata: {
      resolutionMethod,
      sourceStoreId: PRINTFUL_SOURCE_STORE_ID,
      sourceFileId: candidate.id,
      sourceFilename: candidate.filename,
      targetStoreId: PRINTFUL_TARGET_STORE_ID,
      targetFileId: null,
      targetFilename: candidate.filename,
      providerHash: candidate.hash || null,
      mimeType: candidate.mimeType || null,
    },
  };
}

function safePreviewCandidate(candidate) {
  if (!candidate || !safeFilename(candidate.filename) || !new Set(["ok", "accepted"]).has(cleanText(candidate.status, 40).toLowerCase())) return null;
  const previewUrl = safeHttps(candidate.previewUrl || candidate.preview_url);
  if (!previewUrl) return null;
  const parsed = new URL(previewUrl);
  if (parsed.hostname !== "files.cdn.printful.com") return null;
  return {
    id: String(candidate.id || ""),
    filename: safeFilename(candidate.filename),
    status: cleanText(candidate.status, 40).toLowerCase(),
    previewUrl,
    mimeType: cleanText(candidate.mimeType || candidate.mime_type, 160) || null,
  };
}

export function derivativeFilename(sourceFileId, previewUrl, mimeType) {
  const path = new URL(previewUrl).pathname.toLowerCase();
  const type = cleanText(mimeType, 160).toLowerCase();
  const extension = path.endsWith(".jpg") || path.endsWith(".jpeg") || type === "image/jpeg" ? "jpg"
    : path.endsWith(".webp") || type === "image/webp" ? "webp"
      : "png";
  return `trf-migrated-${sourceFileId}.${extension}`;
}

export function normalizeCreatedTargetFile(payload, expectedFilename) {
  const raw = payload?.code === 200 ? payload.result : payload?.data;
  if (!raw || !providerId(raw.id)) throw migrationError("printful_target_file_create_response_invalid", "Printful returned an invalid target File Library response.");
  const filename = safeFilename(raw.filename || expectedFilename);
  if (!filename || normalizeName(filename) !== normalizeName(expectedFilename)) throw migrationError("printful_target_file_create_response_invalid", "Printful returned a conflicting target File Library filename.");
  const status = cleanText(raw.status, 40).toLowerCase() || "accepted";
  if (!["ok", "accepted", "waiting", "pending", "processing"].includes(status)) throw migrationError("printful_target_file_create_response_invalid", "The target File Library object is not processable.");
  return { id: String(raw.id), filename, status, hash: cleanText(raw.hash, 160) || null };
}

async function validatePrintfulPreviewBytes(previewUrl, fetchImpl) {
  const parsed = new URL(previewUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "files.cdn.printful.com") throw migrationError("printful_preview_url_invalid", "The Printful preview URL is not on the accepted CDN origin.");
  const response = await fetchImpl(previewUrl, { method: "GET", headers: { Accept: "image/png,image/jpeg,image/webp" }, redirect: "follow" });
  if (!response?.ok) throw migrationError("printful_preview_fetch_failed", `Printful preview retrieval failed safely (HTTP ${number(response?.status) || 502}).`);
  const finalUrl = safeHttps(response.url || previewUrl);
  if (!finalUrl || new URL(finalUrl).hostname !== "files.cdn.printful.com") throw migrationError("printful_preview_redirect_invalid", "Printful preview retrieval left the accepted CDN origin.");
  const contentType = cleanText(response.headers?.get?.("content-type"), 160).split(";")[0].toLowerCase();
  if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(contentType)) throw migrationError("printful_preview_content_type_invalid", "The Printful preview did not return an accepted image content type.");
  const declared = number(response.headers?.get?.("content-length"));
  if (declared > MAX_PREVIEW_BYTES) throw migrationError("printful_preview_too_large", "The Printful preview exceeds the bounded migration size.");
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_PREVIEW_BYTES) throw migrationError("printful_preview_size_invalid", "The Printful preview is empty or exceeds the bounded migration size.");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return { contentType, size: bytes.byteLength, sha256: [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("") };
}

function localExactArtwork(env, sourceFileId, expectedFilename) {
  const configured = safeJson(env?.PRINTFUL_LOCAL_EXACT_ARTWORK_URLS, {});
  const raw = configured?.[sourceFileId];
  if (!raw || safeFilename(raw.sourceFilename || raw.filename) !== safeFilename(expectedFilename)) return null;
  const url = safeHttps(raw.url);
  const filename = safeFilename(raw.targetFilename || raw.filename || expectedFilename);
  const sha256 = cleanText(raw.sha256, 64).toLowerCase();
  if (!url || !filename || (sha256 && !/^[a-f0-9]{64}$/.test(sha256))) return null;
  return { url, filename, sha256: sha256 || null };
}

async function lookupTargetProduct(db, env, job, product, leaseToken, fetchImpl, now) {
  const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.targetProduct(product.target_printful_external_id), credential: targetCredential(env), operation: "target_lookup", allowedStatuses: [200, 404] }, fetchImpl, now);
  if (response.status === 404) {
    await updateJob(db, leaseToken, { phase: "target_create", status: "running", updated_at: iso(now()) });
    return;
  }
  const result = normalizeSyncProductResponse(response.payload, "target");
  const expected = await expectedTargetVariants(db, product.id);
  const verification = validateTargetProduct(result, product, expected);
  await persistTargetProductId(db, product, result.syncProduct.id, verification.processing ? "provider_processing" : "target_created", true, now());
  if (verification.processing) {
    await scheduleProcessingPoll(db, leaseToken, now());
  } else {
    await mapVerifiedProduct(db, product, result, expected, leaseToken, true, now());
  }
}

async function createTargetProduct(db, env, job, product, leaseToken, fetchImpl, now) {
  const expected = await expectedTargetVariants(db, product.id);
  if (expected.length > MAX_VARIANTS_PER_PRODUCT) throw migrationError("printful_product_variant_limit_exceeded", `${product.title} has ${expected.length} target variants; Printful permits at most 100.`);
  const payload = buildTargetCreatePayload(product, expected);
  assertNoSourceFileIds(payload);
  const response = await providerRequest(db, env, job, leaseToken, { method: "POST", url: PRINTFUL_MIGRATION_ENDPOINTS.targetProducts, credential: targetCredential(env), operation: "target_create", allowedStatuses: [200, 400, 409, 422], body: payload }, fetchImpl, now);
  if (response.status !== 200) {
    const rejectedIds = [...new Set(expected.filter((variant) => variant.resolutionMethod === "target_existing_file" && variant.targetFileId).map((variant) => variant.targetFileId))];
    if (rejectedIds.length) {
      await rejectReadableTargetFileIds(db, job, product, rejectedIds, leaseToken, response, now());
      return;
    }
    throw migrationError("printful_target_create_rejected", `Printful rejected target create safely (HTTP ${response.status})${providerErrorMessage(response.payload) ? `: ${providerErrorMessage(response.payload)}` : "."}`);
  }
  const created = normalizeCreatedProduct(response.payload, product, expected.length);
  await db.batch([
    db.prepare("UPDATE commerce_products SET target_printful_product_id = ?, migration_status = 'target_created', updated_at = ? WHERE id = ? AND target_printful_product_id IS NULL")
      .bind(created.id, iso(now()), product.id),
    db.prepare(`UPDATE commerce_catalogue_migrations SET phase = 'target_verify', status = 'waiting', products_created = products_created + 1,
      next_provider_request_at = ?, updated_at = ? WHERE id = ? AND step_lease_token = ?`)
      .bind(now() + PROCESSING_POLL_MS, iso(now()), PERMANENT_MIGRATION_ID, leaseToken),
  ]);
}

async function rejectReadableTargetFileIds(db, job, product, sourceFileIds, leaseToken, response, now) {
  const state = safeJson((await requireMigrationJob(db)).safe_state_json, {});
  const rejectedTargetFileIds = [...new Set([...(Array.isArray(state.rejectedTargetFileIds) ? state.rejectedTargetFileIds.map(String) : []), ...sourceFileIds.map(String)])].slice(-1000);
  const statements = sourceFileIds.map((id) => db.prepare(`DELETE FROM commerce_printful_file_mappings
    WHERE source_store_id = ? AND source_file_id = ?
      AND json_extract(safe_metadata_json, '$.resolutionMethod') = 'target_existing_file'`)
    .bind(PRINTFUL_SOURCE_STORE_ID, id));
  statements.push(db.prepare(`UPDATE commerce_catalogue_migrations SET phase = 'source_files', status = 'running',
    provider_failures = provider_failures + 1, safe_state_json = ?, updated_at = ?
    WHERE id = ? AND step_lease_token = ?`)
    .bind(JSON.stringify({
      ...state,
      rejectedTargetFileIds,
      targetExistingIdsRejectedForCreate: true,
      lastTargetIdRejection: {
        productId: product.id,
        sourceFileIds: sourceFileIds.map(String),
        status: response.status,
        reason: providerErrorMessage(response.payload) || "Target-readable legacy File IDs were rejected for Sync Product creation.",
        at: iso(now),
      },
    }), iso(now), PERMANENT_MIGRATION_ID, leaseToken));
  const results = await db.batch(statements);
  if (number(results[results.length - 1]?.meta?.changes) !== 1) throw migrationError("printful_target_file_fallback_checkpoint_failed", `The target File ID fallback for ${product.title} could not be checkpointed.`);
}

async function recoverLegacyTargetIdRejection(db, job, now) {
  if (job.status === "completed") return false;
  const state = safeJson(job.safe_state_json, {});
  const blockedProducts = Array.isArray(state.blockedProducts) ? state.blockedProducts : [];
  const priorContractRecoveries = Array.isArray(state.providerContractRecoveries) ? state.providerContractRecoveries.map(String) : [];
  const priorVerificationRecoveries = Array.isArray(state.targetVerificationRecoveries) ? state.targetVerificationRecoveries.map(String) : [];
  const verificationBlock = blockedProducts.find((entry) => entry?.code === "printful_target_file_placement_conflict"
    && providerId(entry?.productId) && !priorVerificationRecoveries.includes(String(entry.productId)));
  if (verificationBlock) {
    const product = await migrationProduct(db, verificationBlock.productId);
    const active = job.current_product_id ? await migrationProduct(db, job.current_product_id) : null;
    const activeHasPriority = active && active.id !== verificationBlock.productId && !active.target_printful_product_id
      && ["selected", "resolving_files", "target_created", "provider_processing"].includes(active.migration_status)
      && number(active.legacy_printful_source_product_id) < number(verificationBlock.sourceProductId);
    if (!activeHasPriority && product?.migration_status === "blocked" && providerId(product.target_printful_product_id)) {
      const remainingBlocks = blockedProducts.filter((entry) => entry !== verificationBlock);
      const nextState = withoutKeys({
        ...state,
        blockedProducts: remainingBlocks,
        targetVerificationRecoveries: [...new Set([...priorVerificationRecoveries, product.id])].slice(-EXPECTED_PRODUCTS),
      }, ["lastProductError", "sourceFileResolution", "lastError"]);
      const statements = [];
      if (active && active.id !== product.id && !active.target_printful_product_id && active.migration_status === "resolving_files") {
        statements.push(db.prepare("UPDATE commerce_products SET migration_status='selected', updated_at=? WHERE id=? AND migration_status='resolving_files'").bind(iso(now), active.id));
      }
      statements.push(
        db.prepare("UPDATE commerce_products SET migration_status='target_created', status='restricted', updated_at=? WHERE id=? AND migration_status='blocked' AND target_printful_product_id IS NOT NULL").bind(iso(now), product.id),
        db.prepare(`UPDATE commerce_product_variants SET migration_status='target_created', fulfillment_mapping_status='planned', status='restricted', updated_at=?
          WHERE product_id=? AND migration_status='blocked'`).bind(iso(now), product.id),
        db.prepare(`UPDATE commerce_catalogue_migrations SET status='running', phase='target_verify', current_product_id=?, safe_state_json=?,
          step_lease_token=NULL, step_lease_expires_at=NULL, revision=revision+1, updated_at=? WHERE id=?`)
          .bind(product.id, JSON.stringify(nextState), iso(now), PERMANENT_MIGRATION_ID),
      );
      const results = await db.batch(statements);
      if (number(results[results.length - 1]?.meta?.changes) !== 1) throw migrationError("commerce_target_verification_recovery_failed", "The created target product verification checkpoint could not be restored.");
      return true;
    }
  }
  const recoverable = blockedProducts.find((entry) => {
    if (entry?.code !== "printful_target_create_rejected" || !providerId(entry?.productId)) return false;
    const contract = providerContractError(entry.reason);
    return !contract || !priorContractRecoveries.includes(`${entry.productId}:${contract}`);
  });
  if (!recoverable) return false;
  const active = job.current_product_id ? await migrationProduct(db, job.current_product_id) : null;
  if (active && active.id !== recoverable.productId && !active.target_printful_product_id
      && ["selected", "resolving_files", "target_created", "provider_processing"].includes(active.migration_status)
      && number(active.legacy_printful_source_product_id) < number(recoverable.sourceProductId)) return false;
  const product = await migrationProduct(db, recoverable.productId);
  if (!product || product.migration_status !== "blocked" || product.target_printful_product_id) return false;
  const files = await db.prepare(`SELECT DISTINCT mapping.source_file_id
    FROM commerce_product_variants AS variant, json_each(variant.file_mapping_json) AS file
    JOIN commerce_printful_file_mappings AS mapping
      ON mapping.source_store_id = ? AND mapping.source_file_id = json_extract(file.value, '$.sourceFileId')
    WHERE variant.product_id = ? AND json_extract(mapping.safe_metadata_json, '$.resolutionMethod') = 'target_existing_file'`)
    .bind(PRINTFUL_SOURCE_STORE_ID, product.id).all();
  const ids = files.results.map((row) => String(row.source_file_id));
  const contractError = providerContractError(recoverable.reason);
  if (!ids.length && !contractError) return false;
  const current = job.current_product_id ? await migrationProduct(db, job.current_product_id) : null;
  const rejectedTargetFileIds = [...new Set([...(Array.isArray(state.rejectedTargetFileIds) ? state.rejectedTargetFileIds.map(String) : []), ...ids])].slice(-1000);
  const remainingBlocks = blockedProducts.filter((entry) => entry !== recoverable);
  const providerContractRecoveries = contractError ? [...new Set([...priorContractRecoveries, `${product.id}:${contractError}`])].slice(-EXPECTED_PRODUCTS * 4) : priorContractRecoveries;
  const nextState = withoutKeys({ ...state, blockedProducts: remainingBlocks, rejectedTargetFileIds, targetExistingIdsRejectedForCreate: true, providerContractRecoveries }, ["lastProductError", "sourceFileResolution", "lastError"]);
  const statements = ids.map((id) => db.prepare(`DELETE FROM commerce_printful_file_mappings
    WHERE source_store_id = ? AND source_file_id = ?
      AND json_extract(safe_metadata_json, '$.resolutionMethod') = 'target_existing_file'`).bind(PRINTFUL_SOURCE_STORE_ID, id));
  if (current && current.id !== product.id && !current.target_printful_product_id && current.migration_status === "resolving_files") {
    statements.push(db.prepare("UPDATE commerce_products SET migration_status='selected', updated_at=? WHERE id=? AND migration_status='resolving_files'").bind(iso(now), current.id));
  }
  statements.push(
    db.prepare("UPDATE commerce_products SET migration_status='resolving_files', status='restricted', updated_at=? WHERE id=? AND migration_status='blocked' AND target_printful_product_id IS NULL").bind(iso(now), product.id),
    db.prepare(`UPDATE commerce_product_variants SET migration_status='selected', fulfillment_mapping_status='planned', status='restricted', updated_at=?
      WHERE product_id=? AND migration_status='blocked'`).bind(iso(now), product.id),
    db.prepare(`UPDATE commerce_catalogue_migrations SET status='running', phase=?, current_product_id=?, safe_state_json=?,
      step_lease_token=NULL, step_lease_expires_at=NULL, revision=revision+1, updated_at=? WHERE id=?`)
      .bind(ids.length ? "source_files" : contractError ? "target_lookup" : "source_files", product.id, JSON.stringify(nextState), iso(now), PERMANENT_MIGRATION_ID),
  );
  const results = await db.batch(statements);
  if (number(results[results.length - 1]?.meta?.changes) !== 1) throw migrationError("commerce_target_id_recovery_failed", "The rejected target File ID checkpoint could not be restored for preview rehydration.");
  return true;
}

function providerErrorMessage(payload) {
  const value = payload?.result || payload?.error || payload?.message;
  const text = typeof value === "string" ? value : value?.message || value?.reason;
  return cleanText(text, 300);
}

function providerContractError(reason) {
  const text = String(reason || "");
  if (/thread_colors/i.test(text)) return "embroidery_thread_colors";
  if (/Invalid placement type/i.test(text)) return "embroidery_placement";
  return null;
}

function targetFilePlacement(value, embroidery) {
  const placement = cleanText(value, 120);
  if (!embroidery || placement.startsWith("embroidery_")) return placement;
  if (/^(front|front_large|back|left|right)$/.test(placement)) return `embroidery_${placement}`;
  return placement;
}

async function verifyTargetProduct(db, env, job, product, leaseToken, fetchImpl, now) {
  const response = await providerRequest(db, env, job, leaseToken, { url: PRINTFUL_MIGRATION_ENDPOINTS.targetProduct(product.target_printful_external_id), credential: targetCredential(env), operation: "target_verify", allowedStatuses: [200] }, fetchImpl, now);
  const result = normalizeSyncProductResponse(response.payload, "target");
  const expected = await expectedTargetVariants(db, product.id);
  const verification = validateTargetProduct(result, product, expected);
  await persistTargetProductId(db, product, result.syncProduct.id, verification.processing ? "provider_processing" : "target_created", false, now());
  if (verification.processing) await scheduleProcessingPoll(db, leaseToken, now());
  else await mapVerifiedProduct(db, product, result, expected, leaseToken, false, now());
}

export function buildTargetCreatePayload(product, variants) {
  if (!Array.isArray(variants) || !variants.length || variants.length > MAX_VARIANTS_PER_PRODUCT) throw migrationError("printful_target_payload_variant_count_invalid", "The target create variant set is invalid.");
  return {
    sync_product: { external_id: product.target_printful_external_id, name: product.title, ...(safeHttps(safeJson(product.safe_metadata_json, {}).targetThumbnail) ? { thumbnail: safeHttps(safeJson(product.safe_metadata_json, {}).targetThumbnail) } : {}) },
    sync_variants: variants.map((variant) => ({
      external_id: variant.target_printful_external_id,
      variant_id: Number(variant.target_catalogue_variant_id),
      retail_price: minorUnitsToPrice(variant.unit_amount),
      ...(variant.sku ? { sku: variant.sku } : {}),
      files: variant.files.map((file) => ({
        type: file.type,
        ...(file.targetFileId ? { id: Number(file.targetFileId) } : { url: file.url, filename: file.filename }),
        ...(file.options.length ? { options: file.options } : {}),
      })),
      ...(variant.targetOptions.length ? { options: variant.targetOptions } : {}),
      availability_status: "active",
    })),
  };
}

export function assertNoSourceFileIds(payload) {
  for (const variant of payload?.sync_variants || []) {
    for (const file of variant.files || []) {
      const hasId = Number.isSafeInteger(file.id) && file.id > 0;
      const hasUrl = Boolean(safeHttps(file.url));
      if (hasId === hasUrl || file.type === "preview") throw migrationError("printful_cross_store_file_payload_invalid", "Target payloads must contain exactly one validated target File ID or HTTPS artwork URL and a non-preview placement.");
    }
  }
  return true;
}

export function normalizeOAuthScopes(payload) {
  if (!payload || !Array.isArray(payload.data)) throw migrationError("printful_oauth_scopes_invalid", "Printful returned an invalid OAuth scope response.");
  const values = payload.data.map((scope) => cleanText(scope?.value, 160).toLowerCase()).filter(Boolean);
  if (!values.length || new Set(values).size !== values.length) throw migrationError("printful_oauth_scopes_invalid", "Printful returned missing or duplicate OAuth scopes.");
  return values.sort();
}

export function assertMigrationScopes(scopes) {
  const has = (aliases, prefix) => scopes.some((scope) => aliases.has(scope) || (scope.startsWith(`${prefix}/`) && /(?:^|\/)write$/.test(scope)));
  const authority = {
    products: has(TARGET_WRITE_SCOPE_ALIASES, "sync_products") || has(TARGET_WRITE_SCOPE_ALIASES, "products"),
    files: has(new Set(["files", "files/write", "file_library", "file_library/write"]), "files"),
    orders: has(new Set(["orders", "orders/write"]), "orders"),
    webhooks: has(new Set(["webhooks", "webhooks/write"]), "webhooks"),
  };
  if (!authority.products) throw migrationError("printful_product_write_scope_missing", "The permanent Printful token lacks Sync Product write authority.");
  if (!authority.files || !authority.orders || !authority.webhooks) throw migrationError("printful_expected_manage_scopes_missing", "The permanent Printful token does not expose all expected file, order, and webhook manage scopes.");
  return authority;
}

export function normalizeSourceFile(payload, expectedId, expectedFilename, options = {}) {
  const raw = payload?.code === 200 ? payload.result : null;
  if (!raw || String(raw.id) !== String(expectedId)) throw migrationError("printful_source_file_invalid", `Source file ${expectedId} returned invalid identity metadata.`);
  const status = cleanText(raw.status, 40).toLowerCase();
  if (!new Set(["ok", "accepted"]).has(status)) throw migrationError("printful_source_file_not_ready", `Source file ${expectedId} is not in an acceptable state.`);
  const url = safeHttps(raw.url);
  if (!url) {
    if (options.optionalUrl === true) return null;
    throw migrationError("printful_source_file_original_url_missing", `Source file ${expectedId} does not expose a usable original HTTPS URL.`);
  }
  const filename = safeFilename(raw.filename || expectedFilename);
  if (!filename) throw migrationError("printful_source_file_filename_invalid", `Source file ${expectedId} has no safe filename.`);
  const bounds = { size: [raw.size, 0, 10_000_000_000], width: [raw.width, 0, 100_000], height: [raw.height, 0, 100_000], dpi: [raw.dpi, 0, 10_000] };
  for (const [field, [value, min, max]] of Object.entries(bounds)) if (value !== null && value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max)) throw migrationError("printful_source_file_metadata_invalid", `Source file ${expectedId} has invalid ${field} metadata.`);
  return { id: String(raw.id), url, filename, status, metadata: { resolvedVia: "file_library", mimeType: cleanText(raw.mime_type, 160) || null, size: nullableNumber(raw.size), width: nullableNumber(raw.width), height: nullableNumber(raw.height), dpi: nullableNumber(raw.dpi), hash: cleanText(raw.hash, 160) || null } };
}

export function normalizeSourceVariantFile(payload, expected) {
  return inspectSourceVariantFile(payload, expected).file;
}

export function inspectSourceVariantFile(payload, expected) {
  const raw = payload?.code === 200 ? payload.result?.sync_variant : null;
  if (!raw || String(raw.id) !== String(expected.legacySyncVariantId)) throw migrationError("printful_source_variant_file_identity_invalid", `Source Sync Variant ${expected.legacySyncVariantId} returned invalid identity metadata.`);
  if (String(raw.sync_product_id) !== String(expected.legacySyncProductId) || (raw.variant_id !== null && raw.variant_id !== undefined && String(raw.variant_id) !== String(expected.catalogueVariantId))) throw migrationError("printful_source_variant_file_product_conflict", `Source Sync Variant ${expected.legacySyncVariantId} no longer belongs to the accepted source product and catalogue variant.`);
  if (!Array.isArray(raw.files)) throw migrationError("printful_source_variant_file_response_invalid", `Source Sync Variant ${expected.legacySyncVariantId} returned invalid file metadata.`);
  const matches = raw.files.filter((file) => String(file?.id) === String(expected.sourceFileId));
  const genuine = matches.find((file) => cleanText(file?.type, 120) !== "preview") || null;
  const original = matches.find((file) => cleanText(file?.type, 120) !== "preview" && safeHttps(file?.url));
  const filename = safeFilename((original || genuine)?.filename || expected.expectedFilename);
  const candidate = genuine && filename ? {
    id: String(expected.sourceFileId),
    filename,
    status: cleanText(genuine.status, 40).toLowerCase() || "ok",
    url: safeHttps(genuine.url),
    previewUrl: safeHttps(genuine.preview_url || genuine.previewUrl),
    thumbnailUrl: safeHttps(genuine.thumbnail_url || genuine.thumbnailUrl),
    mimeType: cleanText(genuine.mime_type || genuine.mimeType, 160) || null,
  } : null;
  if (!original) return { file: null, candidate };
  if (!filename) throw migrationError("printful_source_file_filename_invalid", `Source file ${expected.sourceFileId} has no safe filename.`);
  return { file: {
    id: String(expected.sourceFileId),
    url: safeHttps(original.url),
    filename,
    status: "ok",
    metadata: { resolvedVia: "sync_variant", legacySyncVariantId: String(expected.legacySyncVariantId), fileType: cleanText(original.type, 120) || null },
  }, candidate };
}

export function validateSourceProduct(result, product, expected) {
  if (String(result.syncProduct.id) !== String(product.legacy_printful_source_product_id)) throw migrationError("printful_source_product_identity_conflict", `Source product ${product.title} returned a different Printful identity.`);
  const byId = new Map(result.syncVariants.map((variant) => [String(variant.id), variant]));
  for (const variant of expected.filter((item) => item.migration_status === "selected")) {
    const actual = byId.get(String(variant.legacy_source_variant_id));
    if (!actual || String(actual.variant_id) !== String(variant.target_catalogue_variant_id)) throw migrationError("printful_source_variant_identity_conflict", `Source variant ${variant.legacy_source_variant_id} no longer matches the accepted catalogue identity.`);
    if (priceToMinorUnits(actual.retail_price) !== number(variant.unit_amount)) throw migrationError("printful_source_variant_price_conflict", `Source variant ${variant.legacy_source_variant_id} no longer matches the accepted CAD price.`);
    const actualFiles = normalizeActualFiles(actual.files).filter((file) => file.type !== "preview");
    if (!actualFiles.length) throw migrationError("printful_source_variant_files_missing", `Active source variant ${variant.legacy_source_variant_id} has no required artwork.`);
    const plannedFiles = safeJson(variant.file_mapping_json, []);
    if (!sameMultiset(actualFiles.map((file) => `${file.id}:${file.type}`), plannedFiles.map((file) => `${file.sourceFileId}:${file.type}`))) throw migrationError("printful_source_variant_files_conflict", `Source variant ${variant.legacy_source_variant_id} artwork no longer matches the accepted write selection.`);
  }
}

export function validateTargetProduct(result, product, expected) {
  if (String(result.syncProduct.external_id) !== String(product.target_printful_external_id) || normalizeName(result.syncProduct.name) !== normalizeName(product.title)) throw migrationError("printful_target_external_id_conflict", `Permanent target external ID ${product.target_printful_external_id} is owned by a conflicting product.`);
  if (result.syncVariants.length !== expected.length) throw migrationError("printful_target_variant_count_conflict", `Permanent target product ${product.title} has ${result.syncVariants.length} variants; ${expected.length} are required.`);
  const expectedByExternalId = new Map(expected.map((variant) => [variant.target_printful_external_id, variant]));
  const actualByExternalId = new Map();
  let processing = false;
  for (const actual of result.syncVariants) {
    const externalId = cleanText(actual.external_id, 240);
    if (!externalId || actualByExternalId.has(externalId) || !expectedByExternalId.has(externalId)) throw migrationError("printful_target_variant_identity_conflict", `Permanent target product ${product.title} contains an unexpected or duplicate variant identity.`);
    actualByExternalId.set(externalId, actual);
    const expectedVariant = expectedByExternalId.get(externalId);
    if (String(actual.variant_id) !== String(expectedVariant.target_catalogue_variant_id)) throw migrationError("printful_target_catalogue_variant_conflict", `Target variant ${externalId} has the wrong Printful catalogue variant.`);
    if (priceToMinorUnits(actual.retail_price) !== number(expectedVariant.unit_amount)) throw migrationError("printful_target_price_conflict", `Target variant ${externalId} has the wrong CAD retail price.`);
    const actualFiles = normalizeActualFiles(actual.files).filter((file) => file.type !== "preview");
    if (actualFiles.some((file) => file.status === "failed")) throw migrationError("printful_target_file_failed", `Target variant ${externalId} has failed artwork processing.`);
    if (actualFiles.some((file) => ["waiting", "pending", "processing"].includes(file.status))) processing = true;
    if (actualFiles.length !== expectedVariant.files.length) {
      if (processing) continue;
      throw migrationError("printful_target_file_count_conflict", `Target variant ${externalId} has an unexpected print-file count.`);
    }
    const expectedTargetFileIds = new Set(expectedVariant.files.map((file) => String(file.targetFileId || "")).filter(Boolean));
    const actualIdentities = actualFiles.map((file) => `${canonicalTargetPlacement(file.type)}:${expectedTargetFileIds.has(file.id) ? file.id : file.filename}`);
    const expectedIdentities = expectedVariant.files.map((file) => `${canonicalTargetPlacement(file.type)}:${file.targetFileId || file.filename}`);
    if (!sameMultiset(actualIdentities, expectedIdentities)) throw migrationError("printful_target_file_placement_conflict", `Target variant ${externalId} does not match the required print placements and files.`);
  }
  if (actualByExternalId.size !== expectedByExternalId.size) throw migrationError("printful_target_variant_identity_conflict", `Permanent target product ${product.title} is missing expected variants.`);
  return { processing };
}

async function mapVerifiedProduct(db, product, result, expected, leaseToken, adopted, now) {
  const actualByExternalId = new Map(result.syncVariants.map((variant) => [String(variant.external_id), variant]));
  const statements = expected.map((variant) => {
    const actual = actualByExternalId.get(variant.target_printful_external_id);
    return db.prepare(`UPDATE commerce_product_variants SET
      target_printful_product_id = ?, target_printful_sync_variant_id = ?,
      fulfillment_mapping_status = 'mapped', migration_status = 'target_verified', status = 'restricted',
      visibility = 'private', is_sellable = 0, updated_at = ?
      WHERE id = ? AND legacy_source_variant_id = ? AND target_printful_external_id = ?`)
      .bind(String(result.syncProduct.id), String(actual.id), iso(now), variant.id, variant.legacy_source_variant_id, variant.target_printful_external_id);
  });
  statements.push(db.prepare(`UPDATE commerce_products SET target_printful_product_id = ?, migration_status = 'target_verified',
    status = 'restricted', visibility = 'private', updated_at = ? WHERE id = ? AND target_printful_external_id = ?`)
    .bind(String(result.syncProduct.id), iso(now), product.id, product.target_printful_external_id));
  statements.push(db.prepare(`UPDATE commerce_catalogue_migrations SET
    phase = 'source_product', status = 'running', current_product_id = NULL,
    products_verified = products_verified + 1, products_adopted = products_adopted + ?,
    variants_mapped = variants_mapped + ?, updated_at = ?
    WHERE id = ? AND step_lease_token = ?`)
    .bind(adopted ? 1 : 0, expected.length, iso(now), PERMANENT_MIGRATION_ID, leaseToken));
  const results = await db.batch(statements);
  if (results.some((entry) => number(entry?.meta?.changes) !== 1)) throw migrationError("printful_target_mapping_persistence_failed", `Verified target mappings for ${product.title} could not be persisted exactly once.`);
}

async function expectedTargetVariants(db, productId) {
  const rows = await productVariants(db, productId);
  const active = rows.filter((row) => row.migration_status === "selected" || row.migration_status === "target_created" || row.migration_status === "provider_processing" || row.migration_status === "target_verified");
  if (!active.length || active.length > MAX_VARIANTS_PER_PRODUCT || active.some((row) => row.availability_status !== "active")) throw migrationError("printful_target_variant_selection_invalid", "The authoritative active target variant set is invalid.");
  const mappings = await db.prepare("SELECT source_file_id, source_url, filename, safe_metadata_json FROM commerce_printful_file_mappings WHERE source_store_id = ?")
    .bind(PRINTFUL_SOURCE_STORE_ID).all();
  const byFileId = new Map(mappings.results.map((row) => [String(row.source_file_id), row]));
  return active.map((row) => {
    const targetOptions = cleanOptions(safeJson(row.safe_metadata_json, {}).targetOptions);
    const automaticEmbroideryThreadColor = targetOptions.some((option) => option.id === "embroidery_type");
    const plannedFiles = safeJson(row.file_mapping_json, []);
    const files = plannedFiles.map((planned) => {
      const resolved = byFileId.get(String(planned.sourceFileId));
      if (!resolved || !safeHttps(resolved.source_url)) throw migrationError("printful_source_file_resolution_incomplete", `Source file ${planned.sourceFileId} has not been resolved safely.`);
      const metadata = safeJson(resolved.safe_metadata_json, {});
      const usesTargetFile = ["target_existing_file", "printful_preview_rehydrated"].includes(metadata.resolutionMethod)
        && String(metadata.targetStoreId) === PRINTFUL_TARGET_STORE_ID
        && providerId(metadata.targetFileId);
      const plannedOptions = cleanOptions(planned.options);
      const options = automaticEmbroideryThreadColor && !plannedOptions.some((option) => option.id === "auto_thread_color" || option.id === "full_color" || option.id.startsWith("thread_colors"))
        ? [...plannedOptions, { id: "auto_thread_color", value: true }]
        : plannedOptions;
      return {
        type: targetFilePlacement(planned.type, automaticEmbroideryThreadColor),
        url: resolved.source_url,
        filename: safeFilename(metadata.targetFilename || resolved.filename || planned.filename),
        targetFileId: usesTargetFile ? String(metadata.targetFileId) : null,
        resolutionMethod: cleanText(metadata.resolutionMethod, 80) || "original_url",
        options,
      };
    });
    if (!files.length || files.some((file) => !file.type || file.type === "preview" || !file.filename)) throw migrationError("printful_target_file_plan_invalid", `Variant ${row.id} has an invalid target file plan.`);
    return { ...row, files, targetOptions };
  });
}

async function productVariants(db, productId) {
  const rows = await db.prepare("SELECT * FROM commerce_product_variants WHERE product_id = ? ORDER BY CAST(legacy_source_variant_id AS INTEGER), id").bind(productId).all();
  return rows.results;
}

async function persistTargetProductId(db, product, targetProductId, status, adopted, now) {
  if (product.target_printful_product_id && String(product.target_printful_product_id) !== String(targetProductId)) throw migrationError("printful_target_product_mapping_conflict", `Product ${product.title} is already mapped to another target Printful product.`);
  const provenance = { ...safeJson(product.migration_provenance_json, {}), targetDisposition: adopted ? "adopted_existing_migration_product" : "created_by_permanent_migration", targetProductId: String(targetProductId) };
  await db.prepare("UPDATE commerce_products SET target_printful_product_id = ?, migration_status = ?, migration_provenance_json = ?, updated_at = ? WHERE id = ?")
    .bind(String(targetProductId), status, JSON.stringify(provenance), iso(now), product.id).run();
}

async function scheduleProcessingPoll(db, leaseToken, now) {
  await updateJob(db, leaseToken, { phase: "target_verify", status: "waiting", next_provider_request_at: now + PROCESSING_POLL_MS, updated_at: iso(now) });
}

async function providerRequest(db, env, job, leaseToken, request, fetchImpl, now) {
  const current = await requireMigrationJob(db);
  const waitUntil = Math.max(number(current.throttle_until), number(current.next_provider_request_at));
  if (waitUntil > now()) throw new MigrationWait();
  const startedAt = now();
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method || "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${request.credential}`, ...(request.body ? { "Content-Type": "application/json" } : {}) },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    });
  } catch {
    await transientProviderFailure(db, current, leaseToken, request.operation, null, now());
    throw new MigrationWait();
  }
  const status = number(response?.status) || 502;
  await updateJob(db, leaseToken, { provider_request_count: number(current.provider_request_count) + 1, last_provider_request_at: startedAt, next_provider_request_at: startedAt + PRINTFUL_REQUEST_START_INTERVAL_MS, last_http_status: status, updated_at: iso(now()) });
  if (status === 419 || status === 429) {
    const retryAt = providerRetryAt(response.headers, now());
    await updateJob(db, leaseToken, { status: "waiting", throttle_until: retryAt, next_provider_request_at: retryAt, last_http_status: status, updated_at: iso(now()) });
    throw new MigrationWait();
  }
  if (!request.allowedStatuses.includes(status)) {
    if (status >= 500) {
      await transientProviderFailure(db, current, leaseToken, request.operation, status, now());
      throw new MigrationWait();
    }
    throw migrationError(`printful_${request.operation}_rejected`, `Printful rejected ${request.operation.replaceAll("_", " ")} safely (HTTP ${status}).`);
  }
  let payload = null;
  try { payload = await response.json(); }
  catch { throw migrationError(`printful_${request.operation}_response_invalid`, "Printful returned invalid JSON."); }
  const state = safeJson(current.safe_state_json, {});
  if (state.transientAttempts) await setSafeState(db, leaseToken, { ...state, transientAttempts: {} }, now());
  return { status, payload };
}

async function transientProviderFailure(db, job, leaseToken, operation, status, now) {
  const state = safeJson(job.safe_state_json, {});
  const attempts = number(state.transientAttempts?.[operation]) + 1;
  if (attempts > MAX_TRANSIENT_ATTEMPTS) throw migrationError(`printful_${operation}_unavailable`, `Printful ${operation.replaceAll("_", " ")} remained unavailable after bounded recovery.`);
  const transientAttempts = { ...(state.transientAttempts || {}), [operation]: attempts };
  await updateJob(db, leaseToken, { status: "waiting", next_provider_request_at: now + TRANSIENT_RETRY_MS * attempts, last_http_status: status, safe_state_json: JSON.stringify({ ...state, transientAttempts }), updated_at: iso(now) });
}

export async function assertPermanentCatalogueAuthority(db, env) {
  if (String(env?.PRINTFUL_STORE_ID) !== PRINTFUL_TARGET_STORE_ID || String(env?.PRINTFUL_WIX_SOURCE_STORE_ID) !== PRINTFUL_SOURCE_STORE_ID) throw migrationError("printful_store_configuration_invalid", "The configured source and target Printful Store IDs are not the accepted permanent migration identities.");
  targetCredential(env); sourceCredential(env);
  const [products, active, deferred, maxVariants, targetNative, settings] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total FROM commerce_products").first(),
    db.prepare("SELECT COUNT(*) AS total FROM commerce_product_variants WHERE availability_status = 'active' AND legacy_source_variant_id IS NOT NULL").first(),
    db.prepare("SELECT COUNT(*) AS total FROM commerce_product_variants WHERE migration_status = 'deferred' AND availability_status = 'temporarily_out_of_stock' AND is_sellable = 0").first(),
    db.prepare(`SELECT MAX(variant_count) AS maximum FROM (
      SELECT product_id, COUNT(*) AS variant_count FROM commerce_product_variants
      WHERE legacy_source_variant_id IS NOT NULL AND availability_status = 'active'
      GROUP BY product_id)`).first(),
    db.prepare("SELECT COUNT(*) AS total FROM commerce_products WHERE id = 'product-target-native-459991347' AND target_printful_product_id = '459991347' AND migration_status = 'target_native' AND visibility = 'private'").first(),
    db.prepare("SELECT setting_key, value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled','live_payment_capture_enabled','fulfillment_submission_enabled','printful_order_mode')").all(),
  ]);
  const values = Object.fromEntries(settings.results.map((row) => [row.setting_key, safeJson(row.value_json, null)]));
  if (number(products.total) !== EXPECTED_D1_PRODUCTS || number(active.total) !== EXPECTED_ACTIVE_VARIANTS || number(deferred.total) !== EXPECTED_DEFERRED_VARIANTS || number(maxVariants.maximum) > MAX_VARIANTS_PER_PRODUCT || number(targetNative.total) !== 1) throw migrationError("commerce_catalogue_authority_invalid", "Commerce D1 does not contain the exact accepted permanent catalogue authority.");
  const [orders, providers] = await Promise.all([
    commerceOrderCounts(db),
    db.prepare("SELECT provider, safe_metadata_json FROM commerce_provider_connections WHERE provider IN ('stripe','printful','wix')").all(),
  ]);
  const safety = permanentMigrationSafety(values, providerSafetyMap(providers.results), orders.prohibited);
  if (!safety.failClosed) throw migrationError("commerce_migration_safety_gate_open", "Checkout, payment capture, fulfillment, order, or Printful order-mode safety is not fail-closed.");
  const createProducts = await db.prepare("SELECT COUNT(*) AS total FROM commerce_products WHERE legacy_printful_source_product_id IS NOT NULL AND target_printful_external_id IS NOT NULL").first();
  if (number(createProducts.total) !== EXPECTED_PRODUCTS) throw migrationError("commerce_catalogue_selection_invalid", "Commerce D1 does not contain exactly 49 selected migration products.");
}

function commerceOrderCounts(db) {
  return db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN id <> ? OR environment <> 'test' OR checkout_status <> 'checkout_created'
      OR payment_status <> 'paid' OR fulfillment_status <> 'disabled'
      OR printful_order_id IS NOT NULL OR COALESCE(stripe_checkout_session_id, '') <> ?
      THEN 1 ELSE 0 END) AS prohibited FROM commerce_orders`)
    .bind(ACCEPTED_STRIPE_TEST_ORDER_ID, ACCEPTED_STRIPE_TEST_SESSION_ID).first();
}

function providerSafetyMap(rows) {
  return Object.fromEntries((rows || []).map((row) => [row.provider, safeJson(row.safe_metadata_json, {})]));
}

function permanentMigrationSafety(settings, providers, prohibitedCommerceOrders) {
  const stripe = providers.stripe || {};
  const printful = providers.printful || {};
  const wix = providers.wix || {};
  const printfulModes = [printful.mode, printful.order_mode].filter((value) => value !== undefined);
  const checkoutFailClosed = settings.checkout_enabled === false && stripe.checkout_enabled === false;
  const paymentFailClosed = settings.live_payment_capture_enabled === false && stripe.live_payments_enabled === false;
  const fulfillmentFailClosed = settings.fulfillment_submission_enabled === false && printful.fulfillment_enabled === false;
  const orderModeFailClosed = settings.printful_order_mode === "draft_only" && printfulModes.length > 0 && printfulModes.every((value) => value === "draft_only");
  const wixSourceReadOnly = wix.must_remain_untouched === true;
  const prohibitedCommerceOrderCount = number(prohibitedCommerceOrders);
  return {
    checkoutEnabled: !checkoutFailClosed,
    livePaymentCaptureEnabled: !paymentFailClosed,
    fulfillmentEnabled: !fulfillmentFailClosed,
    printfulOrderMode: orderModeFailClosed ? "draft_only" : "unsafe_or_unknown",
    wixSourceReadOnly,
    prohibitedCommerceOrders: prohibitedCommerceOrderCount,
    failClosed: checkoutFailClosed && paymentFailClosed && fulfillmentFailClosed && orderModeFailClosed && wixSourceReadOnly && prohibitedCommerceOrderCount === 0,
  };
}

async function blockMigration(db, job, leaseToken, error, now) {
  const state = { ...safeJson(job?.safe_state_json, {}), lastError: { code: cleanText(error?.code || "migration_failed", 120), message: cleanText(error?.message || "The migration failed safely.", 500), at: iso(now) } };
  const statements = [db.prepare(`UPDATE commerce_catalogue_migrations SET status = 'blocked', phase = 'blocked',
    provider_failures = provider_failures + 1, safe_state_json = ?, updated_at = ?
    WHERE id = ? AND step_lease_token = ?`).bind(JSON.stringify(state), iso(now), PERMANENT_MIGRATION_ID, leaseToken)];
  if (job?.current_product_id) statements.push(db.prepare("UPDATE commerce_products SET migration_status = 'blocked', status = 'error', updated_at = ? WHERE id = ? AND migration_status <> 'target_verified'").bind(iso(now), job.current_product_id));
  await db.batch(statements);
}

async function skipBlockedProduct(db, job, leaseToken, error, now) {
  const state = safeJson(job.safe_state_json, {});
  const product = await migrationProduct(db, job.current_product_id);
  if (!product) throw migrationError("commerce_product_migration_state_invalid", "The product-local migration failure lost its durable product identity.");
  const existing = Array.isArray(state.blockedProducts) ? state.blockedProducts.filter((entry) => entry?.productId !== product.id) : [];
  const sourceFileId = providerId(state.sourceFileResolution?.sourceFileId);
  const blockedProducts = [...existing, {
    productId: product.id,
    title: cleanText(product.title, 240),
    sourceProductId: String(product.legacy_printful_source_product_id),
    sourceFileId: sourceFileId || null,
    code: cleanText(error.code, 120),
    reason: cleanText(error.message, 500),
    at: iso(now),
  }].slice(-EXPECTED_PRODUCTS);
  const nextState = withoutKeys({
    ...state,
    blockedProducts,
    unresolvedArtworkMappings: number(state.unresolvedArtworkMappings) + (sourceFileId ? 1 : 0),
    lastProductError: blockedProducts[blockedProducts.length - 1],
  }, ["lastError", "sourceFileResolution", "transientAttempts"]);
  const results = await db.batch([
    db.prepare("UPDATE commerce_products SET migration_status = 'blocked', status = 'error', updated_at = ? WHERE id = ? AND migration_status <> 'target_verified'")
      .bind(iso(now), product.id),
    db.prepare(`UPDATE commerce_product_variants SET migration_status = 'blocked', fulfillment_mapping_status = 'conflict',
      status = 'error', visibility = 'private', is_sellable = 0, updated_at = ?
      WHERE product_id = ? AND migration_status IN ('selected','target_created','provider_processing')`)
      .bind(iso(now), product.id),
    db.prepare(`UPDATE commerce_catalogue_migrations SET phase = 'source_product', status = 'running', current_product_id = NULL,
      provider_failures = provider_failures + 1, safe_state_json = ?, updated_at = ?
      WHERE id = ? AND step_lease_token = ?`)
      .bind(JSON.stringify(nextState), iso(now), PERMANENT_MIGRATION_ID, leaseToken),
  ]);
  if (number(results[0]?.meta?.changes) !== 1 || number(results[2]?.meta?.changes) !== 1) throw migrationError("commerce_product_block_checkpoint_failed", `Product ${product.id} could not be checkpointed as blocked artwork exactly once.`);
}

async function resumeRecoverableBlockedJob(db, job, now) {
  const state = safeJson(job.safe_state_json, {});
  if (job.phase !== "blocked" || !job.current_product_id || !RECOVERABLE_BLOCK_CODES.has(state.lastError?.code)) return false;
  const product = await migrationProduct(db, job.current_product_id);
  if (!product || product.migration_status !== "blocked" || product.target_printful_product_id) return false;
  const resumedState = withoutKeys(state, ["lastError", "sourceFileResolution", "transientAttempts"]);
  const results = await db.batch([
    db.prepare(`UPDATE commerce_catalogue_migrations SET status = 'running', phase = 'source_files', safe_state_json = ?,
      step_lease_token = NULL, step_lease_expires_at = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'blocked' AND phase = 'blocked' AND current_product_id = ?`)
      .bind(JSON.stringify(resumedState), iso(now), PERMANENT_MIGRATION_ID, job.current_product_id),
    db.prepare(`UPDATE commerce_products SET migration_status = 'resolving_files', status = 'restricted', updated_at = ?
      WHERE id = ? AND migration_status = 'blocked' AND target_printful_product_id IS NULL`)
      .bind(iso(now), job.current_product_id),
  ]);
  if (results.some((entry) => number(entry?.meta?.changes) !== 1)) throw migrationError("commerce_migration_resume_conflict", "The blocked migration checkpoint could not be resumed exactly once.");
  return true;
}

async function setSafeState(db, leaseToken, state, now) {
  await updateJob(db, leaseToken, { safe_state_json: JSON.stringify(state), status: "running", updated_at: iso(now) });
}

async function updateJob(db, leaseToken, fields) {
  const allowed = new Set(["status", "phase", "current_product_id", "provider_request_count", "products_created", "products_adopted", "products_verified", "variants_mapped", "provider_failures", "last_provider_request_at", "next_provider_request_at", "throttle_until", "last_http_status", "safe_state_json", "started_at", "updated_at", "completed_at"]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const result = await db.prepare(`UPDATE commerce_catalogue_migrations SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, revision = revision + 1 WHERE id = ? AND step_lease_token = ?`)
    .bind(...entries.map(([, value]) => value), PERMANENT_MIGRATION_ID, leaseToken).run();
  if (number(result?.meta?.changes) !== 1) throw migrationError("commerce_migration_lease_lost", "The durable migration step lease was lost safely.");
}

async function requireMigrationJob(db) {
  const job = await db.prepare("SELECT * FROM commerce_catalogue_migrations WHERE id = ? LIMIT 1").bind(PERMANENT_MIGRATION_ID).first();
  if (!job) throw migrationError("commerce_migration_not_imported", "The permanent commerce catalogue has not been imported.");
  return job;
}

async function migrationProduct(db, id) {
  return db.prepare("SELECT * FROM commerce_products WHERE id = ? LIMIT 1").bind(id).first();
}

function phaseForProduct(product) {
  if (product.migration_status === "selected") return "source_product";
  if (product.migration_status === "resolving_files") return "source_files";
  if (["target_created", "provider_processing"].includes(product.migration_status)) return "target_verify";
  throw migrationError("commerce_product_migration_state_invalid", `Product ${product.id} has an invalid resumable migration state.`);
}

function normalizeSyncProductResponse(payload, role) {
  if (payload?.code !== 200 || !payload.result?.sync_product || !Array.isArray(payload.result.sync_variants)) throw migrationError(`printful_${role}_product_response_invalid`, `Printful returned an invalid ${role} product response.`);
  return { syncProduct: payload.result.sync_product, syncVariants: payload.result.sync_variants };
}

function normalizeCreatedProduct(payload, product, variantCount) {
  const raw = payload?.code === 200 ? payload.result : null;
  if (!raw || !providerId(raw.id) || String(raw.external_id) !== String(product.target_printful_external_id) || normalizeName(raw.name) !== normalizeName(product.title) || number(raw.variants) !== variantCount) throw migrationError("printful_target_create_response_invalid", `Printful returned an invalid create result for ${product.title}.`);
  return { id: String(raw.id) };
}

function normalizeSingleStore(payload, role) {
  if (payload?.code !== 200 || !Array.isArray(payload.result) || payload.result.length !== 1 || (payload.paging && number(payload.paging.total) !== 1)) throw migrationError(`printful_${role}_store_count_invalid`, `The ${role} Printful credential must resolve to exactly one store.`);
  const raw = payload.result[0];
  return { id: String(raw.id || ""), name: cleanText(raw.name, 240), type: cleanText(raw.type, 80).toLowerCase() };
}

function assertStore(store, id, name, type, role) {
  if (store.id !== id || normalizeName(store.name) !== normalizeName(name) || store.type !== type) throw migrationError(`printful_${role}_store_identity_invalid`, `The ${role} credential does not resolve to the accepted ${name} ${type} store.`);
}

function normalizeActualFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => ({ id: String(file?.id || ""), type: cleanText(file?.type || "default", 120) || "default", filename: safeFilename(file?.filename), url: safeHttps(file?.url), status: cleanText(file?.status, 40).toLowerCase() || "ok" }));
}

function canonicalTargetPlacement(value) {
  return cleanText(value, 120).replace(/^embroidery_/, "");
}

function providerRetryAt(headers, now) {
  const retryAfter = cleanText(headers?.get?.("retry-after"), 80);
  if (retryAfter && /^\d+$/.test(retryAfter)) return now + Math.min(Number(retryAfter) * 1000 + 1000, 2 * 60 * 60 * 1000);
  const reset = cleanText(headers?.get?.("x-ratelimit-reset"), 80);
  if (reset && /^\d+$/.test(reset)) {
    const value = Number(reset);
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    if (milliseconds > now && milliseconds - now <= 2 * 60 * 60 * 1000) return milliseconds + 1000;
  }
  return now + 61_000;
}

function targetCredential(env) { return credential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable"); }
function sourceCredential(env) { return credential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable"); }
function credential(value, code) { const token = typeof value === "string" ? value.trim() : ""; if (!token || token.length > 4096 || /\s|[\u0000-\u001f\u007f]/.test(token)) throw new AuthFailure(503, code, "The required server-only Printful credential is unavailable."); return token; }
function safeJson(value, fallback) { if (value && typeof value === "object") return value; try { return JSON.parse(String(value || "")); } catch { return fallback; } }
function withoutKeys(value, keys) { const copy = { ...(value || {}) }; for (const key of keys) delete copy[key]; return copy; }
function safeHttps(value) { try { const url = new URL(cleanText(value, 4096)); return url.protocol === "https:" ? url.toString() : null; } catch { return null; } }
function safeFilename(value) { const text = String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").replaceAll("\\", "/").split("/").pop().trim(); return text && text.length <= 500 ? text : null; }
function cleanOptions(value) { return Array.isArray(value) ? value.slice(0, 100).map((option) => ({ id: cleanText(option?.id, 120), value: option?.value })).filter((option) => option.id && option.value !== null && option.value !== undefined && ["string", "number", "boolean"].includes(typeof option.value)) : []; }
function sameMultiset(left, right) { return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]); }
function normalizeName(value) { return String(value || "").trim().replace(/\s+/g, " ").toLowerCase(); }
function providerId(value) { const text = String(value || ""); return /^[A-Za-z0-9._:@-]{1,240}$/.test(text) ? text : null; }
function minorUnitsToPrice(value) { const amount = number(value); if (!Number.isSafeInteger(amount) || amount < 1) throw migrationError("commerce_variant_price_invalid", "A target variant has an invalid authoritative CAD amount."); return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`; }
function priceToMinorUnits(value) { const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(String(value || "")); return match ? Number(match[1]) * 100 + Number(match[2]) : null; }
function nullableNumber(value) { return value === null || value === undefined ? null : Number(value); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function iso(value) { return new Date(value).toISOString(); }
function migrationError(code, message) { return new AuthFailure(409, code, message); }

class MigrationWait extends Error {}
