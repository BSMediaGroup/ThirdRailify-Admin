import { AuthFailure, cleanText, hmacSha256, randomId, timingSafeEqual } from "./auth-core.js";

const PRINTFUL_API_ORIGIN = "https://api.printful.com";
const SOURCE_STORE_ID = "16847493";
const SOURCE_STORE_NAME = "Third Railify Official";
const TARGET_STORE_ID = "18668025";
const TARGET_STORE_NAME = "Third Railify API";
const PAGE_LIMIT = 100;
const MAX_PAGES = 1000;
const MAX_PRODUCTS = 10_000;
const MAX_FILES = 20_000;
const MAX_CREDENTIAL_LENGTH = 4096;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_ATTEMPTS = 3;
const PRODUCT_CHUNK_SIZE = 12;
const FILE_CHUNK_SIZE = 20;
const SNAPSHOT_EVIDENCE_TTL_MS = 4 * 60 * 60 * 1000;
// 675 ms between request starts is at most 88.9 requests/minute, leaving
// deliberate headroom below Printful V1's published 120 requests/minute.
export const PRINTFUL_REQUEST_START_INTERVAL_MS = 675;
const PRINTFUL_429_FALLBACK_MS = 61_000;
const PRINTFUL_THROTTLE_SAFETY_MS = 1_000;
const MAX_PROVIDER_THROTTLE_MS = 2 * 60 * 60 * 1000;
const MAX_PROVIDER_THROTTLE_CYCLES = 12;
const MAX_PROVIDER_REQUESTS_PER_INVOCATION = 24;
const MAX_TRANSIENT_RETRY_DELAY_MS = 5_000;

export const PRINTFUL_CATALOGUE_ENDPOINTS = Object.freeze({
  stores: `${PRINTFUL_API_ORIGIN}/stores`,
  sourceProducts: `${PRINTFUL_API_ORIGIN}/sync/products`,
  targetProducts: `${PRINTFUL_API_ORIGIN}/store/products`,
  files: `${PRINTFUL_API_ORIGIN}/files`,
});

export function parseCadMinorUnits(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(text);
  if (!match) return { status: "malformed", value: text || null, minorUnits: null };
  const major = BigInt(match[1]);
  const minorUnits = major * 100n + BigInt(match[2]);
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) return { status: "malformed", value: text, minorUnits: null };
  return { status: "valid", value: text, minorUnits: Number(minorUnits) };
}

export async function discoverLegacyPrintfulSource(env, fetchImpl = fetch, schedulerRuntime = {}) {
  const credential = requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable");
  const scheduler = createPrintfulRequestScheduler(fetchImpl, null, { ...schedulerRuntime, maxRequestsPerInvocation: Number.POSITIVE_INFINITY });
  const payload = await completeScheduledGet(scheduler, PRINTFUL_CATALOGUE_ENDPOINTS.stores, credential, "source_stores");
  const store = normalizeSingleStore(payload, "source");
  assertLegacySourceStore(store);
  assertDifferentStoreIds(store.id, TARGET_STORE_ID);
  const configuredStoreId = optionalStoreId(env?.PRINTFUL_WIX_SOURCE_STORE_ID, "printful_wix_source_store_id_invalid");
  return {
    store,
    configuredStoreId,
    configurationMatches: configuredStoreId === store.id,
  };
}

export async function discoverPermanentPrintfulTarget(env, fetchImpl = fetch, schedulerRuntime = {}) {
  const credential = requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
  const scheduler = createPrintfulRequestScheduler(fetchImpl, null, { ...schedulerRuntime, maxRequestsPerInvocation: Number.POSITIVE_INFINITY });
  const payload = await completeScheduledGet(scheduler, PRINTFUL_CATALOGUE_ENDPOINTS.stores, credential, "target_stores");
  const store = normalizeSingleStore(payload, "target");
  const configuredStoreId = requiredStoreId(env?.PRINTFUL_STORE_ID, "printful_target_store_id_invalid");
  if (store.id !== TARGET_STORE_ID || configuredStoreId !== TARGET_STORE_ID || store.id !== configuredStoreId) {
    throw new AuthFailure(409, "printful_target_store_mismatch", "The permanent Printful store identity does not match safe configuration.");
  }
  if (normalizeName(store.name) !== normalizeName(TARGET_STORE_NAME) || store.type !== "native") {
    throw new AuthFailure(409, "printful_target_store_identity_invalid", "The permanent Printful store is not the expected native Third Railify API store.");
  }
  return { store, configuredStoreId };
}

export async function snapshotPrintfulCatalogues(env, fetchImpl = fetch, schedulerRuntime = {}) {
  const correlationId = randomId();
  const configuredSourceId = requiredStoreId(env?.PRINTFUL_WIX_SOURCE_STORE_ID, "printful_wix_source_store_id_required");
  const configuredTargetId = requiredStoreId(env?.PRINTFUL_STORE_ID, "printful_target_store_id_invalid");
  if (configuredSourceId !== SOURCE_STORE_ID) {
    throw new AuthFailure(409, "printful_source_store_mismatch", "The legacy Printful source identity does not match safe configuration.");
  }
  if (configuredTargetId !== TARGET_STORE_ID) {
    throw new AuthFailure(409, "printful_target_store_mismatch", "The permanent Printful store identity does not match safe configuration.");
  }
  assertDifferentStoreIds(configuredSourceId, configuredTargetId);

  const scheduler = createPrintfulRequestScheduler(fetchImpl, null, { ...schedulerRuntime, maxRequestsPerInvocation: Number.POSITIVE_INFINITY });
  const sourceIdentity = await discoverIdentityWithScheduler(env, "source", scheduler);
  const targetIdentity = await discoverIdentityWithScheduler(env, "target", scheduler);
  if (sourceIdentity.store.id !== configuredSourceId) {
    throw new AuthFailure(409, "printful_source_store_mismatch", "The legacy Printful source identity does not match safe configuration.");
  }

  const sourceCredential = requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable");
  const targetCredential = requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
  const sourceProductsRead = await readCompleteCatalogue(PRINTFUL_CATALOGUE_ENDPOINTS.sourceProducts, sourceCredential, "source", scheduler);
  const targetProductsRead = await readCompleteCatalogue(PRINTFUL_CATALOGUE_ENDPOINTS.targetProducts, targetCredential, "target", scheduler);
  const sourceProducts = await enrichIncompleteFileMetadata(sourceProductsRead, sourceCredential, "source", scheduler);
  const targetProducts = await enrichIncompleteFileMetadata(targetProductsRead, targetCredential, "target", scheduler);

  return {
    schemaVersion: 1,
    correlationId,
    endpointsUsed: [
      "GET /stores",
      "GET /sync/products?offset={offset}&limit=100",
      "GET /sync/products/{id}",
      "GET /store/products?offset={offset}&limit=100",
      "GET /store/products/{id}",
      "GET /files/{id} only when product detail omits required file metadata",
    ],
    source: buildCatalogueSnapshot(sourceIdentity.store, sourceProducts, "legacy_wix_source"),
    target: buildCatalogueSnapshot(targetIdentity.store, targetProducts, "permanent_api_target"),
    safety: {
      providerMethods: ["GET"],
      sourceCredential: "PRINTFUL_WIX_SOURCE_TOKEN",
      targetCredential: "PRINTFUL_API_TOKEN",
      tokensIncluded: false,
      customerOrOrderDataIncluded: false,
    },
  };
}

export async function beginPrintfulCatalogueSnapshot(env, input = {}, fetchImpl = fetch, schedulerRuntime = {}) {
  assertSnapshotConfiguration(env);
  const state = input?.checkpoint
    ? await verifiedOperationCheckpoint(env, input.checkpoint, input.checkpointSignature, "begin")
    : newBeginCheckpoint(schedulerRuntime);
  const scheduler = createPrintfulRequestScheduler(fetchImpl, state.rate, schedulerRuntime);
  while (scheduler.requestsStarted() < MAX_PROVIDER_REQUESTS_PER_INVOCATION && state.step !== "complete") {
    const outcome = await runBeginStep(env, state, scheduler);
    state.rate = scheduler.snapshot();
    if (outcome?.kind === "throttled") return pausedPhaseResult(env, state, outcome, beginProgress(state));
    if (outcome?.kind === "yielded") return continuingPhaseResult(env, state, beginProgress(state));
  }
  state.rate = scheduler.snapshot();
  if (state.step !== "complete") return continuingPhaseResult(env, state, beginProgress(state));
  const manifest = {
    correlationId: state.correlationId,
    expiresAt: state.expiresAt,
    source: { store: state.source.store, summaries: state.source.summaries },
    target: { store: state.target.store, summaries: state.target.summaries },
  };
  const rateCheckpoint = rateEvidence(state.correlationId, state.rate);
  return {
    ok: true,
    status: "complete",
    phase: "manifest",
    schemaVersion: 1,
    correlationId: state.correlationId,
    manifest,
    signature: await signSnapshotEvidence(env, "manifest", manifest),
    rateCheckpoint,
    rateCheckpointSignature: await signSnapshotEvidence(env, "rate", rateCheckpoint),
    chunkSizes: { products: PRODUCT_CHUNK_SIZE, files: FILE_CHUNK_SIZE },
    endpointsUsed: snapshotEndpointsUsed(),
    safety: snapshotSafety(),
    progress: beginProgress(state),
  };
}

export async function readPrintfulCatalogueProductChunk(env, input, fetchImpl = fetch, schedulerRuntime = {}) {
  assertSnapshotConfiguration(env);
  await verifySnapshotEvidence(env, "manifest", input?.manifest, input?.manifestSignature);
  const state = input?.checkpoint
    ? await verifiedOperationCheckpoint(env, input.checkpoint, input.checkpointSignature, "products", input.manifest.correlationId)
    : await newProductCheckpoint(env, input);
  const role = requireSnapshotRole(state.role);
  const manifestRole = input.manifest[role];
  const summaries = new Map(manifestRole.summaries.map((summary) => [String(summary.id), summary]));
  if (state.requestedIds.some((id) => !summaries.has(id))) throw new AuthFailure(400, "printful_snapshot_product_unknown", "A requested snapshot product is not present in the signed manifest.");
  const baseUrl = role === "source" ? PRINTFUL_CATALOGUE_ENDPOINTS.sourceProducts : PRINTFUL_CATALOGUE_ENDPOINTS.targetProducts;
  const credential = role === "source"
    ? requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable")
    : requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
  const scheduler = createPrintfulRequestScheduler(fetchImpl, state.rate, schedulerRuntime);
  while (state.cursor < state.requestedIds.length) {
    const id = state.requestedIds[state.cursor];
    const outcome = await scheduler.get(`${baseUrl}/${encodeURIComponent(id)}`, credential, `${role}_product_detail`);
    state.rate = scheduler.snapshot();
    if (outcome.kind === "throttled") return pausedPhaseResult(env, state, outcome, itemProgress(state, input.manifest));
    if (outcome.kind === "yielded") return continuingPhaseResult(env, state, itemProgress(state, input.manifest));
    state.products.push(normalizeProductDetail(outcome.payload?.result, summaries.get(id), role));
    state.cursor += 1;
  }
  state.products.sort((left, right) => compareIds(left.id, right.id));
  const chunk = {
    correlationId: input.manifest.correlationId,
    role,
    productIds: state.requestedIds,
    products: state.products,
    incompleteFileIds: incompleteFileIds(state.products),
  };
  return completedChunkResult(env, "products", chunk, state.rate, itemProgress(state, input.manifest));
}

export async function readPrintfulCatalogueFileChunk(env, input, fetchImpl = fetch, schedulerRuntime = {}) {
  assertSnapshotConfiguration(env);
  await verifySnapshotEvidence(env, "manifest", input?.manifest, input?.manifestSignature);
  await verifySnapshotEvidence(env, "products", input?.productChunk, input?.productChunkSignature);
  const state = input?.checkpoint
    ? await verifiedOperationCheckpoint(env, input.checkpoint, input.checkpointSignature, "files", input.manifest.correlationId)
    : await newFileCheckpoint(env, input);
  const role = requireSnapshotRole(state.role);
  if (input.productChunk.role !== role || input.productChunk.correlationId !== input.manifest.correlationId) {
    throw new AuthFailure(400, "printful_snapshot_evidence_mismatch", "Snapshot evidence does not belong to this catalogue run.");
  }
  const allowed = new Set(input.productChunk.incompleteFileIds.map(String));
  if (state.requestedIds.some((id) => !allowed.has(id))) throw new AuthFailure(400, "printful_snapshot_file_unknown", "A requested file is not present in the signed product evidence.");
  const credential = role === "source"
    ? requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable")
    : requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
  const scheduler = createPrintfulRequestScheduler(fetchImpl, state.rate, schedulerRuntime);
  while (state.cursor < state.requestedIds.length) {
    const id = state.requestedIds[state.cursor];
    const outcome = await scheduler.get(`${PRINTFUL_CATALOGUE_ENDPOINTS.files}/${encodeURIComponent(id)}`, credential, `${role}_file_detail`);
    state.rate = scheduler.snapshot();
    if (outcome.kind === "throttled") return pausedPhaseResult(env, state, outcome, itemProgress(state, input.manifest));
    if (outcome.kind === "yielded") return continuingPhaseResult(env, state, itemProgress(state, input.manifest));
    state.files.push(normalizeFile(outcome.payload?.result));
    state.cursor += 1;
  }
  state.files.sort((left, right) => compareIds(left.id, right.id));
  const chunk = { correlationId: input.manifest.correlationId, role, fileIds: state.requestedIds, files: state.files };
  return completedChunkResult(env, "files", chunk, state.rate, itemProgress(state, input.manifest));
}

export async function assemblePrintfulCatalogueSnapshot(env, input) {
  assertSnapshotConfiguration(env);
  await verifySnapshotEvidence(env, "manifest", input?.manifest, input?.manifestSignature);
  const productEvidence = requireEvidenceArray(input?.productEvidence, "product");
  const fileEvidence = requireEvidenceArray(input?.fileEvidence, "file");
  for (const evidence of productEvidence) await verifySnapshotEvidence(env, "products", evidence?.chunk, evidence?.signature);
  for (const evidence of fileEvidence) await verifySnapshotEvidence(env, "files", evidence?.chunk, evidence?.signature);
  const sourceProducts = assembleRoleProducts("source", input.manifest, productEvidence, fileEvidence);
  const targetProducts = assembleRoleProducts("target", input.manifest, productEvidence, fileEvidence);
  return {
    schemaVersion: 1,
    correlationId: input.manifest.correlationId,
    endpointsUsed: snapshotEndpointsUsed(),
    source: buildCatalogueSnapshot(input.manifest.source.store, sourceProducts, "legacy_wix_source"),
    target: buildCatalogueSnapshot(input.manifest.target.store, targetProducts, "permanent_api_target"),
    safety: snapshotSafety(),
  };
}

async function readCompleteCatalogue(baseUrl, credential, role, scheduler) {
  const summaries = await readCatalogueSummaries(baseUrl, credential, role, scheduler);
  const orderedSummaries = [...summaries].sort((left, right) => compareIds(left?.id, right?.id));
  const details = [];
  for (const summary of orderedSummaries) {
    const id = requiredProviderId(summary?.id, `printful_${role}_product_id_invalid`);
    const detailPayload = await completeScheduledGet(scheduler, `${baseUrl}/${encodeURIComponent(id)}`, credential, `${role}_product_detail`);
    details.push(normalizeProductDetail(detailPayload?.result, summary, role));
  }
  return details.sort((left, right) => compareIds(left.id, right.id));
}

async function readCatalogueSummaries(baseUrl, credential, role, scheduler) {
  const summaries = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${baseUrl}?offset=${offset}&limit=${PAGE_LIMIT}`;
    const payload = await completeScheduledGet(scheduler, url, credential, `${role}_products`);
    const result = requireArray(payload?.result, `printful_${role}_products_invalid`);
    const paging = normalizePaging(payload?.paging, offset, result.length);
    summaries.push(...result);
    if (summaries.length > MAX_PRODUCTS) {
      throw new AuthFailure(502, `printful_${role}_catalogue_too_large`, "The Printful catalogue exceeds the bounded migration reader limit.");
    }
    if (result.length === 0 || offset + result.length >= paging.total) break;
    offset += result.length;
    if (page === MAX_PAGES - 1) throw new AuthFailure(502, `printful_${role}_pagination_invalid`, "Printful catalogue pagination did not terminate safely.");
  }

  return summaries.sort((left, right) => compareIds(left?.id, right?.id));
}

function buildCatalogueSnapshot(store, products, role) {
  const variants = products.flatMap((product) => product.variants);
  const missingPrices = variants.filter((variant) => variant.price.status === "malformed" && variant.price.value === null).length;
  const malformedPrices = variants.filter((variant) => variant.price.status === "malformed" && variant.price.value !== null).length;
  return {
    role,
    store,
    counts: {
      products: products.length,
      variants: variants.length,
      synced: variants.filter((variant) => variant.synced === true).length,
      ignored: variants.filter((variant) => variant.isIgnored === true).length,
      ignoredProducts: products.filter((product) => product.isIgnored === true).length,
      unavailable: variants.filter((variant) => variant.availabilityStatus && variant.availabilityStatus !== "active").length,
      missingPrices,
      malformedPrices,
      malformedOrMissingPrices: missingPrices + malformedPrices,
      missingFiles: variants.filter((variant) => variant.files.length === 0).length,
      variantsWithoutFiles: variants.filter((variant) => variant.files.length === 0).length,
    },
    products,
  };
}

function normalizeProductDetail(result, summary, role) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AuthFailure(502, `printful_${role}_product_detail_invalid`, "Printful returned an invalid product detail response.");
  }
  const product = result.sync_product && typeof result.sync_product === "object" ? result.sync_product : summary;
  const variants = requireArray(result.sync_variants, `printful_${role}_variants_invalid`)
    .map((variant) => normalizeVariant(variant, role))
    .sort((left, right) => compareIds(left.id, right.id));
  const id = requiredProviderId(product?.id ?? summary?.id, `printful_${role}_product_id_invalid`);
  return {
    id,
    externalId: optionalText(product?.external_id, 240),
    name: requiredText(product?.name, 300, `printful_${role}_product_name_invalid`),
    variantCount: integerOrNull(product?.variants) ?? variants.length,
    syncedCount: integerOrNull(product?.synced),
    thumbnailUrl: safeUrl(product?.thumbnail_url ?? product?.thumbnail),
    isIgnored: booleanOrNull(product?.is_ignored),
    status: optionalText(product?.status, 80),
    catalogueProductId: providerIdOrNull(product?.product_id),
    variants,
  };
}

function normalizeVariant(variant, role) {
  if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
    throw new AuthFailure(502, `printful_${role}_variant_invalid`, "Printful returned an invalid variant record.");
  }
  const price = parseCadMinorUnits(variant.retail_price);
  return {
    id: requiredProviderId(variant.id, `printful_${role}_variant_id_invalid`),
    externalId: optionalText(variant.external_id, 240),
    syncProductId: providerIdOrNull(variant.sync_product_id),
    catalogueProductId: providerIdOrNull(variant.product_id ?? variant.product?.product_id ?? variant.product?.id),
    catalogueVariantId: providerIdOrNull(variant.variant_id),
    name: optionalText(variant.name, 300),
    sku: optionalText(variant.sku, 240),
    retailPrice: price.value,
    unitAmountCad: price.minorUnits,
    price,
    currency: optionalText(variant.currency, 12),
    size: optionalText(variant.size, 120),
    color: optionalText(variant.color, 120),
    synced: booleanOrNull(variant.synced),
    isIgnored: booleanOrNull(variant.is_ignored),
    availabilityStatus: optionalText(variant.availability_status, 80),
    catalogueProductName: optionalText(variant.product?.name, 300),
    catalogueVariantName: optionalText(variant.product?.variant_name, 300),
    catalogueImageUrl: safeUrl(variant.product?.image),
    options: normalizeOptions(variant.options),
    files: normalizeFiles(variant.files),
  };
}

async function enrichIncompleteFileMetadata(products, credential, role, scheduler) {
  const needed = new Map();
  for (const product of products) {
    for (const variant of product.variants) {
      for (const file of variant.files) {
        if (file.id && (!file.type || (!file.url && !file.filename))) needed.set(file.id, null);
      }
    }
  }
  if (needed.size > MAX_FILES) throw new AuthFailure(502, `printful_${role}_file_count_too_large`, "The Printful catalogue exceeds the bounded file-metadata reader limit.");
  const ids = [...needed.keys()].sort(compareIds);
  const details = [];
  for (const id of ids) {
    const payload = await completeScheduledGet(scheduler, `${PRINTFUL_CATALOGUE_ENDPOINTS.files}/${encodeURIComponent(id)}`, credential, `${role}_file_detail`);
    details.push([id, normalizeFile(payload?.result)]);
  }
  for (const [id, detail] of details) needed.set(id, detail);
  if (!needed.size) return products;
  return products.map((product) => ({
    ...product,
    variants: product.variants.map((variant) => ({
      ...variant,
      files: variant.files.map((file) => file.id && needed.get(file.id) ? mergeFile(file, needed.get(file.id)) : file),
    })),
  }));
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map(normalizeFile).sort((left, right) => `${left.type || ""}:${left.id || ""}:${left.filename || ""}`.localeCompare(`${right.type || ""}:${right.id || ""}:${right.filename || ""}`));
}

function normalizeFile(file) {
  return {
    id: providerIdOrNull(file?.id),
    type: optionalText(file?.type, 120),
    url: safeUrl(file?.url),
    filename: optionalText(file?.filename, 300),
    previewUrl: safeUrl(file?.preview_url),
    thumbnailUrl: safeUrl(file?.thumbnail_url),
    status: optionalText(file?.status, 80),
    visible: booleanOrNull(file?.visible),
    options: normalizeOptions(file?.options),
  };
}

function mergeFile(primary, detail) {
  return {
    id: primary.id || detail.id,
    type: primary.type || detail.type,
    url: primary.url || detail.url,
    filename: primary.filename || detail.filename,
    previewUrl: primary.previewUrl || detail.previewUrl,
    thumbnailUrl: primary.thumbnailUrl || detail.thumbnailUrl,
    status: primary.status || detail.status,
    visible: primary.visible ?? detail.visible,
    options: primary.options.length ? primary.options : detail.options,
  };
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.slice(0, 100).map((option) => ({
    id: optionalText(option?.id, 120),
    value: scalarOptionValue(option?.value),
  })).filter((option) => option.id).sort((left, right) => left.id.localeCompare(right.id));
}

export function createPrintfulRequestScheduler(fetchImpl = fetch, initialState = null, runtime = {}) {
  const now = typeof runtime.now === "function" ? runtime.now : Date.now;
  const sleep = typeof runtime.sleep === "function" ? runtime.sleep : boundedDelay;
  const random = typeof runtime.random === "function" ? runtime.random : Math.random;
  const invocationLimit = runtime.maxRequestsPerInvocation === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Number.isSafeInteger(runtime.maxRequestsPerInvocation) && runtime.maxRequestsPerInvocation > 0
      ? runtime.maxRequestsPerInvocation
      : MAX_PROVIDER_REQUESTS_PER_INVOCATION;
  const state = normalizeRateState(initialState, now());
  let invocationRequestCount = 0;

  const throttleOutcome = () => ({
    kind: "throttled",
    statusCode: state.throttleStatus || 429,
    retryAt: state.throttleUntil,
    retryAfterMs: Math.max(0, state.throttleUntil - now()),
    exhausted: state.throttleCycles > MAX_PROVIDER_THROTTLE_CYCLES,
    rateControl: state.rateControl,
  });

  return {
    snapshot: () => ({ ...state, rateControl: state.rateControl ? { ...state.rateControl } : null }),
    requestsStarted: () => invocationRequestCount,
    async get(url, credential, operation) {
      if (state.throttleUntil > now()) return throttleOutcome();
      if (state.throttleUntil) {
        state.throttleUntil = 0;
        state.throttleStatus = null;
      }
      for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
        // Once one logical GET starts, finish its bounded transient attempts in
        // this invocation so retry counts cannot reset at a phase boundary.
        if (attempt === 1 && invocationRequestCount >= invocationLimit) return { kind: "yielded" };
        const waitMs = Math.max(0, state.nextProviderRequestAt - now());
        if (waitMs) await sleep(waitMs);
        const startedAt = now();
        state.lastProviderRequestAt = startedAt;
        state.nextProviderRequestAt = startedAt + PRINTFUL_REQUEST_START_INTERVAL_MS;
        state.providerRequestCount += 1;
        invocationRequestCount += 1;
        let response;
        let timedOut = false;
        const controller = new AbortController();
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
        try {
          response = await fetchImpl(url, {
            method: "GET",
            signal: controller.signal,
            headers: { Accept: "application/json", Authorization: `Bearer ${credential}` },
          });
        } catch {
          if (attempt < REQUEST_ATTEMPTS) {
            state.nextProviderRequestAt = Math.max(state.nextProviderRequestAt, now() + transientRetryDelay(attempt, random));
            continue;
          }
          const reason = timedOut ? `timed out after ${REQUEST_ATTEMPTS} attempts` : `could not be reached after ${REQUEST_ATTEMPTS} attempts`;
          throw new AuthFailure(502, `printful_${operation}_unavailable`, `Printful ${operationLabel(operation)} ${reason}.`);
        } finally {
          clearTimeout(timeout);
        }

        state.rateControl = normalizeRateControlHeaders(response?.headers, now());
        const status = Number.isInteger(response?.status) ? response.status : 502;
        if (status === 419 || status === 429) {
          applyProviderThrottle(state, status, state.rateControl, now());
          return throttleOutcome();
        }
        if (!response?.ok) {
          if (attempt < REQUEST_ATTEMPTS && isTransientStatus(status)) {
            state.nextProviderRequestAt = Math.max(state.nextProviderRequestAt, now() + transientRetryDelay(attempt, random));
            continue;
          }
          throw new AuthFailure(502, `printful_${operation}_rejected`, `Printful ${operationLabel(operation)} failed safely (HTTP ${status}).`);
        }
        if (state.rateControl?.remaining === 0 && state.rateControl.resetAt > now()) {
          state.throttleUntil = Math.min(state.rateControl.resetAt + PRINTFUL_THROTTLE_SAFETY_MS, now() + MAX_PROVIDER_THROTTLE_MS);
          state.throttleStatus = 429;
          state.nextProviderRequestAt = Math.max(state.nextProviderRequestAt, state.throttleUntil);
        }
        try {
          return { kind: "success", payload: await response.json(), rateControl: state.rateControl };
        } catch {
          throw new AuthFailure(502, `printful_${operation}_invalid`, `Printful ${operationLabel(operation)} returned invalid JSON.`);
        }
      }
      throw new AuthFailure(502, `printful_${operation}_unavailable`, `Printful ${operationLabel(operation)} could not be completed.`);
    },
    sleep,
    now,
  };
}

async function completeScheduledGet(scheduler, url, credential, operation) {
  for (;;) {
    const outcome = await scheduler.get(url, credential, operation);
    if (outcome.kind === "success") return outcome.payload;
    if (outcome.kind === "yielded") {
      await scheduler.sleep(Math.max(0, scheduler.snapshot().nextProviderRequestAt - scheduler.now()));
      continue;
    }
    if (outcome.exhausted) throw new AuthFailure(502, `printful_${operation}_rate_limit_exhausted`, `Printful ${operationLabel(operation)} remained rate limited after bounded recovery.`);
    await scheduler.sleep(outcome.retryAfterMs);
  }
}

function normalizeRateState(value, now) {
  if (!value) return {
    nextProviderRequestAt: now,
    lastProviderRequestAt: null,
    providerRequestCount: 0,
    throttleUntil: 0,
    throttleStatus: null,
    throttleCycles: 0,
    rateControl: null,
  };
  const nextProviderRequestAt = safeTimestamp(value.nextProviderRequestAt, now);
  const lastProviderRequestAt = value.lastProviderRequestAt === null ? null : safeTimestamp(value.lastProviderRequestAt, now);
  const throttleUntil = value.throttleUntil ? safeTimestamp(value.throttleUntil, now) : 0;
  const providerRequestCount = Number(value.providerRequestCount);
  const throttleCycles = Number(value.throttleCycles);
  if (!Number.isSafeInteger(providerRequestCount) || providerRequestCount < 0 || providerRequestCount > 1_000_000
    || !Number.isSafeInteger(throttleCycles) || throttleCycles < 0 || throttleCycles > MAX_PROVIDER_THROTTLE_CYCLES + 1) {
    throw new AuthFailure(400, "printful_snapshot_rate_invalid", "Snapshot request pacing evidence is invalid.");
  }
  return {
    nextProviderRequestAt,
    lastProviderRequestAt,
    providerRequestCount,
    throttleUntil,
    throttleStatus: value.throttleStatus === 419 ? 419 : value.throttleStatus === 429 ? 429 : null,
    throttleCycles,
    rateControl: normalizeStoredRateControl(value.rateControl),
  };
}

function normalizeRateControlHeaders(headers, now) {
  const first = (...names) => names.map((name) => headers?.get?.(name)).find((value) => value !== null && value !== undefined && String(value).trim() !== "");
  const retryAfterRaw = first("Retry-After");
  const resetRaw = first("X-RateLimit-Reset", "X-Ratelimit-Reset");
  return {
    retryAfter: safeHeaderText(retryAfterRaw, 120),
    retryAt: parseRetryAfter(retryAfterRaw, now),
    limit: safeHeaderInteger(first("X-RateLimit-Limit", "X-Ratelimit-Limit")),
    remaining: safeHeaderInteger(first("X-RateLimit-Remaining", "X-Ratelimit-Remaining")),
    reset: safeHeaderText(resetRaw, 120),
    resetAt: parseRateReset(resetRaw, now),
    policy: safeHeaderText(first("X-RateLimit-Policy", "X-Ratelimit-Policy"), 240),
  };
}

function normalizeStoredRateControl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    retryAfter: safeHeaderText(value.retryAfter, 120),
    retryAt: safeOptionalTimestamp(value.retryAt),
    limit: safeHeaderInteger(value.limit),
    remaining: safeHeaderInteger(value.remaining),
    reset: safeHeaderText(value.reset, 120),
    resetAt: safeOptionalTimestamp(value.resetAt),
    policy: safeHeaderText(value.policy, 240),
  };
}

function applyProviderThrottle(state, status, rateControl, now) {
  const suppliedTimes = [rateControl?.retryAt, rateControl?.resetAt].filter((value) => Number.isFinite(value) && value > now);
  const baseRetryAt = suppliedTimes.length ? Math.max(...suppliedTimes) : now + PRINTFUL_429_FALLBACK_MS;
  const retryAt = Math.min(baseRetryAt + PRINTFUL_THROTTLE_SAFETY_MS, now + MAX_PROVIDER_THROTTLE_MS);
  state.throttleCycles += 1;
  state.throttleUntil = retryAt;
  state.throttleStatus = status;
  state.nextProviderRequestAt = Math.max(state.nextProviderRequestAt, retryAt);
}

function operationLabel(operation) {
  const role = operation.startsWith("source_") ? "legacy source" : operation.startsWith("target_") ? "permanent target" : "catalogue";
  const category = operation.endsWith("_stores") ? "identity read"
    : operation.endsWith("_products") ? "product enumeration"
      : operation.endsWith("_product_detail") ? "product-detail read"
        : operation.endsWith("_file_detail") ? "file-metadata read"
          : "read";
  return `${role} ${category}`;
}

function isTransientStatus(status) {
  return status === 408 || status === 425 || status >= 500;
}

function transientRetryDelay(attempt, random) {
  const jitter = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * 151);
  return Math.min(250 * (2 ** (attempt - 1)) + jitter, MAX_TRANSIENT_RETRY_DELAY_MS);
}

function parseRetryAfter(value, now) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return now + Math.ceil(Number(text) * 1000);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

function parseRateReset(value, now) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric >= 0) {
    if (numeric >= 1_000_000_000_000) return Math.floor(numeric);
    if (numeric >= 1_000_000_000) return Math.floor(numeric * 1000);
    return now + Math.ceil(numeric * 1000);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

function safeHeaderText(value, maximum) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return text ? text.slice(0, maximum) : null;
}

function safeHeaderInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeOptionalTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function safeTimestamp(value, now) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > now + SNAPSHOT_EVIDENCE_TTL_MS + MAX_PROVIDER_THROTTLE_MS) {
    throw new AuthFailure(400, "printful_snapshot_rate_invalid", "Snapshot request pacing evidence is invalid.");
  }
  return Math.floor(number);
}

function boundedDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function newBeginCheckpoint(runtime) {
  const now = typeof runtime.now === "function" ? runtime.now() : Date.now();
  return {
    phase: "begin",
    correlationId: randomId(),
    expiresAt: new Date(now + SNAPSHOT_EVIDENCE_TTL_MS).toISOString(),
    step: "source_identity",
    source: { store: null, summaries: [], offset: 0, total: null },
    target: { store: null, summaries: [], offset: 0, total: null },
    rate: normalizeRateState(null, now),
  };
}

async function runBeginStep(env, state, scheduler) {
  if (state.step === "source_identity" || state.step === "target_identity") {
    const role = state.step.startsWith("source") ? "source" : "target";
    const credential = roleCredential(env, role);
    const outcome = await scheduler.get(PRINTFUL_CATALOGUE_ENDPOINTS.stores, credential, `${role}_stores`);
    if (outcome.kind !== "success") return outcome;
    const store = normalizeSingleStore(outcome.payload, role);
    if (role === "source") {
      assertLegacySourceStore(store);
      assertDifferentStoreIds(store.id, TARGET_STORE_ID);
      if (requiredStoreId(env?.PRINTFUL_WIX_SOURCE_STORE_ID, "printful_wix_source_store_id_required") !== store.id) {
        throw new AuthFailure(409, "printful_source_store_mismatch", "The legacy Printful source identity does not match safe configuration.");
      }
      state.source.store = store;
      state.step = "target_identity";
    } else {
      if (store.id !== TARGET_STORE_ID || store.type !== "native" || normalizeName(store.name) !== normalizeName(TARGET_STORE_NAME)) {
        throw new AuthFailure(409, "printful_target_store_identity_invalid", "The permanent Printful store is not the expected native Third Railify API store.");
      }
      state.target.store = store;
      state.step = "source_pages";
    }
    return outcome;
  }

  const role = state.step === "source_pages" ? "source" : "target";
  const roleState = state[role];
  const baseUrl = role === "source" ? PRINTFUL_CATALOGUE_ENDPOINTS.sourceProducts : PRINTFUL_CATALOGUE_ENDPOINTS.targetProducts;
  const outcome = await scheduler.get(`${baseUrl}?offset=${roleState.offset}&limit=${PAGE_LIMIT}`, roleCredential(env, role), `${role}_products`);
  if (outcome.kind !== "success") return outcome;
  const result = requireArray(outcome.payload?.result, `printful_${role}_products_invalid`);
  const paging = normalizePaging(outcome.payload?.paging, roleState.offset, result.length);
  roleState.summaries.push(...result.map(safeProductSummary));
  roleState.total = paging.total;
  if (roleState.summaries.length > MAX_PRODUCTS) {
    throw new AuthFailure(502, `printful_${role}_catalogue_too_large`, "The Printful catalogue exceeds the bounded migration reader limit.");
  }
  if (result.length === 0 || roleState.offset + result.length >= paging.total) {
    roleState.summaries.sort((left, right) => compareIds(left.id, right.id));
    state.step = role === "source" ? "target_pages" : "complete";
  } else {
    roleState.offset += result.length;
  }
  return outcome;
}

async function discoverIdentityWithScheduler(env, role, scheduler) {
  const payload = await completeScheduledGet(scheduler, PRINTFUL_CATALOGUE_ENDPOINTS.stores, roleCredential(env, role), `${role}_stores`);
  const store = normalizeSingleStore(payload, role);
  if (role === "source") {
    assertLegacySourceStore(store);
    return { store, configuredStoreId: optionalStoreId(env?.PRINTFUL_WIX_SOURCE_STORE_ID, "printful_wix_source_store_id_invalid"), configurationMatches: String(env?.PRINTFUL_WIX_SOURCE_STORE_ID) === store.id };
  }
  if (store.id !== TARGET_STORE_ID || store.type !== "native" || normalizeName(store.name) !== normalizeName(TARGET_STORE_NAME)) {
    throw new AuthFailure(409, "printful_target_store_identity_invalid", "The permanent Printful store is not the expected native Third Railify API store.");
  }
  return { store, configuredStoreId: requiredStoreId(env?.PRINTFUL_STORE_ID, "printful_target_store_id_invalid") };
}

function roleCredential(env, role) {
  return role === "source"
    ? requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable")
    : requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
}

async function newProductCheckpoint(env, input) {
  const role = requireSnapshotRole(input?.role);
  const requestedIds = requireChunkIds(input?.productIds, PRODUCT_CHUNK_SIZE, "product");
  const rate = await verifiedRateState(env, input, input.manifest.correlationId);
  return { phase: "products", correlationId: input.manifest.correlationId, role, requestedIds, cursor: 0, products: [], rate };
}

async function newFileCheckpoint(env, input) {
  const role = requireSnapshotRole(input?.role);
  const requestedIds = requireChunkIds(input?.fileIds, FILE_CHUNK_SIZE, "file");
  const rate = await verifiedRateState(env, input, input.manifest.correlationId);
  return { phase: "files", correlationId: input.manifest.correlationId, role, requestedIds, cursor: 0, files: [], rate };
}

async function verifiedRateState(env, input, correlationId) {
  await verifySnapshotEvidence(env, "rate", input?.rateCheckpoint, input?.rateCheckpointSignature);
  if (input.rateCheckpoint.correlationId !== correlationId) throw new AuthFailure(400, "printful_snapshot_evidence_mismatch", "Snapshot pacing evidence does not belong to this catalogue run.");
  return normalizeRateState(input.rateCheckpoint.rate, Date.now());
}

async function verifiedOperationCheckpoint(env, checkpoint, signature, phase, correlationId = null) {
  await verifySnapshotEvidence(env, "checkpoint", checkpoint, signature);
  if (checkpoint.phase !== phase || (correlationId && checkpoint.correlationId !== correlationId)) {
    throw new AuthFailure(400, "printful_snapshot_evidence_mismatch", "Snapshot continuation evidence does not belong to this catalogue phase.");
  }
  const expiresAt = Date.parse(String(checkpoint.expiresAt || ""));
  if (phase === "begin" && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    throw new AuthFailure(409, "printful_snapshot_expired", "The catalogue snapshot run expired safely. Retry the read-only snapshot.");
  }
  if (phase === "begin") {
    if (!["source_identity", "target_identity", "source_pages", "target_pages", "complete"].includes(checkpoint.step)
      || !checkpoint.source || !checkpoint.target || !Array.isArray(checkpoint.source.summaries) || !Array.isArray(checkpoint.target.summaries)) {
      throw new AuthFailure(400, "printful_snapshot_evidence_invalid", "Snapshot continuation evidence is invalid.");
    }
  } else {
    requireSnapshotRole(checkpoint.role);
    requireChunkIds(checkpoint.requestedIds, phase === "products" ? PRODUCT_CHUNK_SIZE : FILE_CHUNK_SIZE, phase === "products" ? "product" : "file");
    if (!Number.isSafeInteger(checkpoint.cursor) || checkpoint.cursor < 0 || checkpoint.cursor > checkpoint.requestedIds.length) {
      throw new AuthFailure(400, "printful_snapshot_cursor_invalid", "Snapshot continuation cursor is invalid.");
    }
    const records = phase === "products" ? checkpoint.products : checkpoint.files;
    if (!Array.isArray(records) || records.length !== checkpoint.cursor) throw new AuthFailure(400, "printful_snapshot_cursor_invalid", "Snapshot continuation records are inconsistent.");
  }
  checkpoint.rate = normalizeRateState(checkpoint.rate, Date.now());
  return checkpoint;
}

async function pausedPhaseResult(env, state, outcome, progress) {
  const checkpoint = structuredClone(state);
  const exhausted = outcome.exhausted || state.rate.throttleCycles > MAX_PROVIDER_THROTTLE_CYCLES;
  const response = {
    ok: !exhausted,
    status: exhausted ? "failed" : "throttled",
    phase: state.phase,
    reason: exhausted ? "printful_rate_limit_recovery_exhausted" : "printful_rate_limited",
    providerStatus: outcome.statusCode,
    retryAt: new Date(outcome.retryAt).toISOString(),
    retryAfterMs: outcome.retryAfterMs,
    cursor: checkpointCursor(state),
    partialResults: partialCheckpointResults(state),
    checkpoint,
    checkpointSignature: await signSnapshotEvidence(env, "checkpoint", checkpoint),
    rateControl: outcome.rateControl,
    progress,
  };
  if (exhausted) response.message = "Printful remained rate limited after bounded automatic recovery. Completed snapshot progress was retained safely.";
  return response;
}

async function continuingPhaseResult(env, state, progress) {
  const checkpoint = structuredClone(state);
  return {
    ok: true,
    status: "continuing",
    phase: state.phase,
    checkpoint,
    checkpointSignature: await signSnapshotEvidence(env, "checkpoint", checkpoint),
    progress,
  };
}

async function completedChunkResult(env, phase, chunk, rate, progress) {
  const rateCheckpoint = rateEvidence(chunk.correlationId, rate);
  return {
    ok: true,
    status: "complete",
    phase,
    chunk,
    signature: await signSnapshotEvidence(env, phase, chunk),
    rateCheckpoint,
    rateCheckpointSignature: await signSnapshotEvidence(env, "rate", rateCheckpoint),
    progress,
  };
}

function rateEvidence(correlationId, rate) {
  return { correlationId, rate: normalizeRateState(rate, Date.now()) };
}

function checkpointCursor(state) {
  if (state.phase === "begin") return { step: state.step, sourceOffset: state.source.offset, targetOffset: state.target.offset };
  return { index: state.cursor, id: state.requestedIds[state.cursor] || null };
}

function partialCheckpointResults(state) {
  if (state.phase === "products") return state.products;
  if (state.phase === "files") return state.files;
  return { sourceSummaries: state.source.summaries, targetSummaries: state.target.summaries };
}

function beginProgress(state) {
  const completed = state.source.summaries.length + state.target.summaries.length;
  const knownTotals = [state.source.total, state.target.total].filter(Number.isSafeInteger);
  return {
    currentPhase: state.step.startsWith("source") ? "Legacy catalogue enumeration" : state.step.startsWith("target") ? "Target catalogue enumeration" : "Catalogue manifest",
    completed,
    total: knownTotals.length === 2 ? knownTotals[0] + knownTotals[1] : null,
    providerState: "reading",
  };
}

function itemProgress(state, manifest) {
  const phaseName = state.phase === "products"
    ? state.role === "source" ? "Legacy product details" : "Target product details"
    : state.role === "source" ? "Legacy files" : "Target files";
  return { currentPhase: phaseName, completed: state.cursor, total: state.requestedIds.length, providerState: "reading", catalogueTotal: manifest[state.role].summaries.length };
}

function assertSnapshotConfiguration(env) {
  const sourceId = requiredStoreId(env?.PRINTFUL_WIX_SOURCE_STORE_ID, "printful_wix_source_store_id_required");
  const targetId = requiredStoreId(env?.PRINTFUL_STORE_ID, "printful_target_store_id_invalid");
  if (sourceId !== SOURCE_STORE_ID) throw new AuthFailure(409, "printful_source_store_mismatch", "The legacy Printful source identity does not match safe configuration.");
  if (targetId !== TARGET_STORE_ID) throw new AuthFailure(409, "printful_target_store_mismatch", "The permanent Printful store identity does not match safe configuration.");
  assertDifferentStoreIds(sourceId, targetId);
}

async function verifyRoleIdentity(env, role, fetchImpl) {
  if (role === "source") return discoverLegacyPrintfulSource(env, fetchImpl);
  return discoverPermanentPrintfulTarget(env, fetchImpl);
}

function safeProductSummary(summary) {
  return {
    id: requiredProviderId(summary?.id, "printful_product_id_invalid"),
    external_id: optionalText(summary?.external_id, 240),
    name: requiredText(summary?.name, 300, "printful_product_name_invalid"),
    variants: integerOrNull(summary?.variants),
    synced: integerOrNull(summary?.synced),
    thumbnail_url: safeUrl(summary?.thumbnail_url ?? summary?.thumbnail),
    is_ignored: booleanOrNull(summary?.is_ignored),
    status: optionalText(summary?.status, 80),
    product_id: providerIdOrNull(summary?.product_id),
  };
}

function snapshotEndpointsUsed() {
  return [
    "GET /stores",
    "GET /sync/products?offset={offset}&limit=100",
    "GET /sync/products/{id}",
    "GET /store/products?offset={offset}&limit=100",
    "GET /store/products/{id}",
    "GET /files/{id} only when product detail omits required file metadata",
  ];
}

function snapshotSafety() {
  return {
    providerMethods: ["GET"],
    sourceCredential: "PRINTFUL_WIX_SOURCE_TOKEN",
    targetCredential: "PRINTFUL_API_TOKEN",
    tokensIncluded: false,
    customerOrOrderDataIncluded: false,
  };
}

function incompleteFileIds(products) {
  return [...new Set(products.flatMap((product) => product.variants.flatMap((variant) => variant.files
    .filter((file) => file.id && (!file.type || (!file.url && !file.filename)))
    .map((file) => file.id))))].sort(compareIds);
}

function requireSnapshotRole(value) {
  if (value !== "source" && value !== "target") throw new AuthFailure(400, "printful_snapshot_role_invalid", "Snapshot catalogue role is invalid.");
  return value;
}

function requireChunkIds(value, maximum, kind) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new AuthFailure(400, `printful_snapshot_${kind}_chunk_invalid`, `Snapshot ${kind} chunk is invalid.`);
  }
  const ids = value.map((id) => requiredProviderId(id, `printful_snapshot_${kind}_id_invalid`));
  if (new Set(ids).size !== ids.length) throw new AuthFailure(400, `printful_snapshot_${kind}_chunk_invalid`, `Snapshot ${kind} chunk contains duplicates.`);
  return ids.sort(compareIds);
}

function requireEvidenceArray(value, kind) {
  if (!Array.isArray(value) || value.length > MAX_PRODUCTS) throw new AuthFailure(400, `printful_snapshot_${kind}_evidence_invalid`, `Snapshot ${kind} evidence is invalid.`);
  return value;
}

async function signSnapshotEvidence(env, kind, value) {
  return hmacSha256(requiredSnapshotEvidenceSecret(env), `printful-catalogue:${kind}:${canonicalJson(value)}`);
}

async function verifySnapshotEvidence(env, kind, value, signature) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !/^[A-Za-z0-9_-]{20,128}$/.test(String(signature || ""))) {
    throw new AuthFailure(400, "printful_snapshot_evidence_invalid", "Snapshot evidence is invalid or incomplete.");
  }
  const expected = await signSnapshotEvidence(env, kind, value);
  if (!timingSafeEqual(expected, String(signature))) throw new AuthFailure(400, "printful_snapshot_evidence_invalid", "Snapshot evidence could not be verified.");
  if (kind === "manifest") {
    const expiresAt = Date.parse(String(value.expiresAt || ""));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + SNAPSHOT_EVIDENCE_TTL_MS + 60_000) {
      throw new AuthFailure(409, "printful_snapshot_expired", "The catalogue snapshot run expired safely. Retry the read-only snapshot.");
    }
    if (!value.source?.store || !value.target?.store || !Array.isArray(value.source?.summaries) || !Array.isArray(value.target?.summaries)) {
      throw new AuthFailure(400, "printful_snapshot_manifest_invalid", "Snapshot manifest is invalid.");
    }
  }
}

function requiredSnapshotEvidenceSecret(env) {
  const secret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || "");
  if (secret.length < 16 || secret.length > 4096) throw new AuthFailure(503, "printful_snapshot_signing_unavailable", "Snapshot evidence protection is not configured.");
  return secret;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function assembleRoleProducts(role, manifest, productEvidence, fileEvidence) {
  const expectedIds = manifest[role].summaries.map((summary) => String(summary.id)).sort(compareIds);
  const products = [];
  const suppliedIds = [];
  const incompleteIds = new Set();
  for (const evidence of productEvidence.filter((entry) => entry?.chunk?.role === role)) {
    const chunk = evidence.chunk;
    if (chunk.correlationId !== manifest.correlationId || !Array.isArray(chunk.productIds) || !Array.isArray(chunk.products) || !Array.isArray(chunk.incompleteFileIds)) {
      throw new AuthFailure(400, "printful_snapshot_product_evidence_invalid", "Snapshot product evidence does not belong to this catalogue run.");
    }
    const chunkProductIds = chunk.products.map((product) => String(product?.id)).sort(compareIds);
    if (!sameIds(chunk.productIds, chunkProductIds)) throw new AuthFailure(400, "printful_snapshot_product_evidence_invalid", "Snapshot product evidence is inconsistent.");
    suppliedIds.push(...chunkProductIds);
    products.push(...chunk.products);
    for (const id of chunk.incompleteFileIds) incompleteIds.add(String(id));
  }
  if (!sameIds(expectedIds, suppliedIds)) throw new AuthFailure(400, "printful_snapshot_product_evidence_incomplete", `Snapshot ${role} product evidence is incomplete.`);

  const fileMap = new Map();
  for (const evidence of fileEvidence.filter((entry) => entry?.chunk?.role === role)) {
    const chunk = evidence.chunk;
    if (chunk.correlationId !== manifest.correlationId || !Array.isArray(chunk.fileIds) || !Array.isArray(chunk.files)) {
      throw new AuthFailure(400, "printful_snapshot_file_evidence_invalid", "Snapshot file evidence does not belong to this catalogue run.");
    }
    const normalizedIds = chunk.files.map((file) => String(file?.id)).sort(compareIds);
    if (!sameIds(chunk.fileIds, normalizedIds)) throw new AuthFailure(400, "printful_snapshot_file_evidence_invalid", "Snapshot file evidence is inconsistent.");
    for (const file of chunk.files) {
      const id = String(file.id);
      if (fileMap.has(id)) throw new AuthFailure(400, "printful_snapshot_file_evidence_invalid", "Snapshot file evidence contains duplicates.");
      fileMap.set(id, file);
    }
  }
  if ([...incompleteIds].some((id) => !fileMap.has(id))) {
    throw new AuthFailure(400, "printful_snapshot_file_evidence_incomplete", `Snapshot ${role} file evidence is incomplete.`);
  }
  return products.map((product) => ({
    ...product,
    variants: product.variants.map((variant) => ({
      ...variant,
      files: variant.files.map((file) => file.id && fileMap.has(String(file.id)) ? mergeFile(file, fileMap.get(String(file.id))) : file),
    })),
  })).sort((left, right) => compareIds(left.id, right.id));
}

function sameIds(left, right) {
  const normalizedLeft = left.map(String).sort(compareIds);
  const normalizedRight = right.map(String).sort(compareIds);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((id, index) => id === normalizedRight[index]);
}

function normalizeSingleStore(payload, role) {
  const stores = requireArray(payload?.result, `printful_${role}_stores_invalid`);
  if (stores.length !== 1) {
    throw new AuthFailure(409, `printful_${role}_store_count_invalid`, `The ${role} Printful credential must resolve to exactly one store.`);
  }
  const raw = stores[0];
  return {
    id: requiredStoreId(raw?.id, `printful_${role}_store_id_invalid`),
    name: requiredText(raw?.name, 240, `printful_${role}_store_name_invalid`),
    type: requiredText(raw?.type, 80, `printful_${role}_store_type_invalid`).toLowerCase(),
  };
}

function assertLegacySourceStore(store) {
  if (store.id !== SOURCE_STORE_ID) {
    throw new AuthFailure(409, "printful_source_store_mismatch", "The source credential does not resolve to the verified legacy Wix Store ID.");
  }
  if (store.type !== "wix" || normalizeName(store.name) !== normalizeName(SOURCE_STORE_NAME)) {
    throw new AuthFailure(409, "printful_source_store_identity_invalid", "The source credential does not resolve to the verified legacy Wix store identity.");
  }
}

function assertDifferentStoreIds(left, right) {
  if (String(left) === String(right)) throw new AuthFailure(409, "printful_source_target_store_collision", "Legacy source and permanent target Store IDs must differ.");
}

function normalizePaging(paging, offset, resultLength) {
  const total = integerOrNull(paging?.total);
  const pageOffset = integerOrNull(paging?.offset);
  const limit = integerOrNull(paging?.limit);
  if (total === null || total < 0 || pageOffset !== offset || limit === null || limit < 1 || limit > PAGE_LIMIT) {
    throw new AuthFailure(502, "printful_pagination_invalid", "Printful returned invalid catalogue pagination metadata.");
  }
  if (resultLength > limit || offset + resultLength > total) {
    throw new AuthFailure(502, "printful_pagination_invalid", "Printful returned inconsistent catalogue pagination metadata.");
  }
  return { total, offset: pageOffset, limit };
}

function requiredCredential(value, code) {
  const credential = typeof value === "string" ? value.trim() : "";
  if (!credential || credential.length > MAX_CREDENTIAL_LENGTH || /\s/.test(credential)) {
    throw new AuthFailure(503, code, "The required server-only Printful credential is not configured.");
  }
  return credential;
}

function requiredStoreId(value, code) {
  const id = optionalStoreId(value, code);
  if (!id) throw new AuthFailure(503, code, "The required safe Printful Store ID is not configured.");
  return id;
}

function optionalStoreId(value, code) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^[1-9]\d{0,19}$/.test(text)) throw new AuthFailure(503, code, "A configured Printful Store ID is invalid.");
  return text;
}

function requiredProviderId(value, code) {
  const id = providerIdOrNull(value);
  if (!id) throw new AuthFailure(502, code, "Printful returned a record without a valid provider ID.");
  return id;
}

function providerIdOrNull(value) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9@._:-]{1,240}$/.test(text) ? text : null;
}

function requiredText(value, maxLength, code) {
  const text = optionalText(value, maxLength);
  if (!text) throw new AuthFailure(502, code, "Printful returned a required field in an invalid form.");
  return text;
}

function optionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = cleanText(String(value), maxLength);
  return text || null;
}

function safeUrl(value) {
  const text = optionalText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function scalarOptionValue(value) {
  if (typeof value === "string") return optionalText(value, 500);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function requireArray(value, code) {
  if (!Array.isArray(value)) throw new AuthFailure(502, code, "Printful returned an invalid catalogue response.");
  return value;
}

function compareIds(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), "en", { numeric: true });
}
