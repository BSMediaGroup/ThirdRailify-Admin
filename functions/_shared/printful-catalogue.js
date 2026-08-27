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
const DETAIL_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_ATTEMPTS = 2;
const MAX_RETRY_DELAY_MS = 2_000;
const PRODUCT_CHUNK_SIZE = 12;
const FILE_CHUNK_SIZE = 20;
const SNAPSHOT_EVIDENCE_TTL_MS = 15 * 60 * 1000;

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

export async function discoverLegacyPrintfulSource(env, fetchImpl = fetch) {
  const credential = requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable");
  const payload = await printfulGet(fetchImpl, PRINTFUL_CATALOGUE_ENDPOINTS.stores, credential, "source_stores");
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

export async function discoverPermanentPrintfulTarget(env, fetchImpl = fetch) {
  const credential = requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
  const payload = await printfulGet(fetchImpl, PRINTFUL_CATALOGUE_ENDPOINTS.stores, credential, "target_stores");
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

export async function snapshotPrintfulCatalogues(env, fetchImpl = fetch) {
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

  const [sourceIdentity, targetIdentity] = await Promise.all([
    discoverLegacyPrintfulSource(env, fetchImpl),
    discoverPermanentPrintfulTarget(env, fetchImpl),
  ]);
  if (sourceIdentity.store.id !== configuredSourceId) {
    throw new AuthFailure(409, "printful_source_store_mismatch", "The legacy Printful source identity does not match safe configuration.");
  }

  const sourceCredential = requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable");
  const targetCredential = requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
  const detailLimiter = createConcurrencyLimiter(DETAIL_CONCURRENCY);
  const [sourceProductsRead, targetProductsRead] = await Promise.all([
    readCompleteCatalogue(fetchImpl, PRINTFUL_CATALOGUE_ENDPOINTS.sourceProducts, sourceCredential, "source", detailLimiter),
    readCompleteCatalogue(fetchImpl, PRINTFUL_CATALOGUE_ENDPOINTS.targetProducts, targetCredential, "target", detailLimiter),
  ]);
  const [sourceProducts, targetProducts] = await Promise.all([
    enrichIncompleteFileMetadata(fetchImpl, sourceProductsRead, sourceCredential, "source", detailLimiter),
    enrichIncompleteFileMetadata(fetchImpl, targetProductsRead, targetCredential, "target", detailLimiter),
  ]);

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

export async function beginPrintfulCatalogueSnapshot(env, fetchImpl = fetch) {
  assertSnapshotConfiguration(env);
  const correlationId = randomId();
  const expiresAt = new Date(Date.now() + SNAPSHOT_EVIDENCE_TTL_MS).toISOString();
  const [sourceIdentity, targetIdentity] = await Promise.all([
    discoverLegacyPrintfulSource(env, fetchImpl),
    discoverPermanentPrintfulTarget(env, fetchImpl),
  ]);
  const [sourceSummaries, targetSummaries] = await Promise.all([
    readCatalogueSummaries(fetchImpl, PRINTFUL_CATALOGUE_ENDPOINTS.sourceProducts, requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable"), "source"),
    readCatalogueSummaries(fetchImpl, PRINTFUL_CATALOGUE_ENDPOINTS.targetProducts, requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable"), "target"),
  ]);
  const manifest = {
    correlationId,
    expiresAt,
    source: { store: sourceIdentity.store, summaries: sourceSummaries.map(safeProductSummary) },
    target: { store: targetIdentity.store, summaries: targetSummaries.map(safeProductSummary) },
  };
  return {
    ok: true,
    phase: "manifest",
    schemaVersion: 1,
    correlationId,
    manifest,
    signature: await signSnapshotEvidence(env, "manifest", manifest),
    chunkSizes: { products: PRODUCT_CHUNK_SIZE, files: FILE_CHUNK_SIZE },
    endpointsUsed: snapshotEndpointsUsed(),
    safety: snapshotSafety(),
  };
}

export async function readPrintfulCatalogueProductChunk(env, input, fetchImpl = fetch) {
  assertSnapshotConfiguration(env);
  await verifySnapshotEvidence(env, "manifest", input?.manifest, input?.manifestSignature);
  const role = requireSnapshotRole(input?.role);
  const manifestRole = input.manifest[role];
  await verifyRoleIdentity(env, role, fetchImpl);
  const ids = requireChunkIds(input?.productIds, PRODUCT_CHUNK_SIZE, "product");
  const summaries = new Map(manifestRole.summaries.map((summary) => [String(summary.id), summary]));
  if (ids.some((id) => !summaries.has(id))) throw new AuthFailure(400, "printful_snapshot_product_unknown", "A requested snapshot product is not present in the signed manifest.");
  const baseUrl = role === "source" ? PRINTFUL_CATALOGUE_ENDPOINTS.sourceProducts : PRINTFUL_CATALOGUE_ENDPOINTS.targetProducts;
  const credential = role === "source"
    ? requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable")
    : requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
  const limiter = createConcurrencyLimiter(DETAIL_CONCURRENCY);
  const products = await mapWithConcurrency(ids, DETAIL_CONCURRENCY, async (id) => {
    const payload = await limiter(() => printfulGet(fetchImpl, `${baseUrl}/${encodeURIComponent(id)}`, credential, `${role}_product_detail`));
    return normalizeProductDetail(payload?.result, summaries.get(id), role);
  });
  products.sort((left, right) => compareIds(left.id, right.id));
  const chunk = {
    correlationId: input.manifest.correlationId,
    role,
    productIds: ids,
    products,
    incompleteFileIds: incompleteFileIds(products),
  };
  return { ok: true, phase: "products", chunk, signature: await signSnapshotEvidence(env, "products", chunk) };
}

export async function readPrintfulCatalogueFileChunk(env, input, fetchImpl = fetch) {
  assertSnapshotConfiguration(env);
  await verifySnapshotEvidence(env, "manifest", input?.manifest, input?.manifestSignature);
  await verifySnapshotEvidence(env, "products", input?.productChunk, input?.productChunkSignature);
  const role = requireSnapshotRole(input?.role);
  if (input.productChunk.role !== role || input.productChunk.correlationId !== input.manifest.correlationId) {
    throw new AuthFailure(400, "printful_snapshot_evidence_mismatch", "Snapshot evidence does not belong to this catalogue run.");
  }
  await verifyRoleIdentity(env, role, fetchImpl);
  const ids = requireChunkIds(input?.fileIds, FILE_CHUNK_SIZE, "file");
  const allowed = new Set(input.productChunk.incompleteFileIds.map(String));
  if (ids.some((id) => !allowed.has(id))) throw new AuthFailure(400, "printful_snapshot_file_unknown", "A requested file is not present in the signed product evidence.");
  const credential = role === "source"
    ? requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable")
    : requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
  const limiter = createConcurrencyLimiter(DETAIL_CONCURRENCY);
  const files = await mapWithConcurrency(ids, DETAIL_CONCURRENCY, async (id) => {
    const payload = await limiter(() => printfulGet(fetchImpl, `${PRINTFUL_CATALOGUE_ENDPOINTS.files}/${encodeURIComponent(id)}`, credential, `${role}_file_detail`));
    return normalizeFile(payload?.result);
  });
  files.sort((left, right) => compareIds(left.id, right.id));
  const chunk = { correlationId: input.manifest.correlationId, role, fileIds: ids, files };
  return { ok: true, phase: "files", chunk, signature: await signSnapshotEvidence(env, "files", chunk) };
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

async function readCompleteCatalogue(fetchImpl, baseUrl, credential, role, detailLimiter) {
  const summaries = await readCatalogueSummaries(fetchImpl, baseUrl, credential, role);
  const orderedSummaries = [...summaries].sort((left, right) => compareIds(left?.id, right?.id));
  const details = await mapWithConcurrency(orderedSummaries, DETAIL_CONCURRENCY, async (summary) => {
    const id = requiredProviderId(summary?.id, `printful_${role}_product_id_invalid`);
    const detailPayload = await detailLimiter(() => printfulGet(fetchImpl, `${baseUrl}/${encodeURIComponent(id)}`, credential, `${role}_product_detail`));
    return normalizeProductDetail(detailPayload?.result, summary, role);
  });
  return details.sort((left, right) => compareIds(left.id, right.id));
}

async function readCatalogueSummaries(fetchImpl, baseUrl, credential, role) {
  const summaries = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${baseUrl}?offset=${offset}&limit=${PAGE_LIMIT}`;
    const payload = await printfulGet(fetchImpl, url, credential, `${role}_products`);
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

async function enrichIncompleteFileMetadata(fetchImpl, products, credential, role, detailLimiter) {
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
  const details = await mapWithConcurrency(ids, DETAIL_CONCURRENCY, async (id) => {
    const payload = await detailLimiter(() => printfulGet(fetchImpl, `${PRINTFUL_CATALOGUE_ENDPOINTS.files}/${encodeURIComponent(id)}`, credential, `${role}_file_detail`));
    return [id, normalizeFile(payload?.result)];
  });
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

async function printfulGet(fetchImpl, url, credential, operation) {
  const label = operationLabel(operation);
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    let response;
    let timedOut = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      response = await fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json", Authorization: `Bearer ${credential}` },
      });
    } catch {
      if (attempt < REQUEST_ATTEMPTS) {
        await boundedDelay(250 * attempt);
        continue;
      }
      const reason = timedOut ? `timed out after ${REQUEST_ATTEMPTS} attempts` : `could not be reached after ${REQUEST_ATTEMPTS} attempts`;
      throw new AuthFailure(502, `printful_${operation}_unavailable`, `Printful ${label} ${reason}.`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response?.ok) {
      if (attempt < REQUEST_ATTEMPTS && isRetriableStatus(response?.status)) {
        await boundedDelay(retryDelayMs(response, attempt));
        continue;
      }
      const status = Number.isInteger(response?.status) ? response.status : 502;
      throw new AuthFailure(502, `printful_${operation}_rejected`, `Printful ${label} failed safely (HTTP ${status}).`);
    }
    try {
      return await response.json();
    } catch {
      throw new AuthFailure(502, `printful_${operation}_invalid`, `Printful ${label} returned invalid JSON.`);
    }
  }
  throw new AuthFailure(502, `printful_${operation}_unavailable`, `Printful ${label} could not be completed.`);
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function createConcurrencyLimiter(limit) {
  let active = 0;
  const pending = [];
  const runNext = () => {
    while (active < limit && pending.length) {
      const entry = pending.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          runNext();
        });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    pending.push({ task, resolve, reject });
    runNext();
  });
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

function isRetriableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  return Math.min(250 * attempt, MAX_RETRY_DELAY_MS);
}

function boundedDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
