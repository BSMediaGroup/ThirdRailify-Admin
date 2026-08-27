import { AuthFailure, cleanText, randomId } from "./auth-core.js";

const PRINTFUL_API_ORIGIN = "https://api.printful.com";
const TARGET_STORE_ID = "18668025";
const TARGET_STORE_NAME = "Third Railify API";
const PAGE_LIMIT = 100;
const MAX_PAGES = 1000;
const MAX_PRODUCTS = 10_000;
const MAX_CREDENTIAL_LENGTH = 4096;

export const PRINTFUL_CATALOGUE_ENDPOINTS = Object.freeze({
  stores: `${PRINTFUL_API_ORIGIN}/stores`,
  sourceProducts: `${PRINTFUL_API_ORIGIN}/sync/products`,
  targetProducts: `${PRINTFUL_API_ORIGIN}/store/products`,
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
  const sourceIdentity = await discoverLegacyPrintfulSource(env, fetchImpl);
  const configuredSourceId = requiredStoreId(env?.PRINTFUL_WIX_SOURCE_STORE_ID, "printful_wix_source_store_id_required");
  if (sourceIdentity.store.id !== configuredSourceId) {
    throw new AuthFailure(409, "printful_wix_source_store_mismatch", "The token-resolved legacy Printful Store ID does not match safe configuration.");
  }
  assertDifferentStoreIds(configuredSourceId, requiredStoreId(env?.PRINTFUL_STORE_ID, "printful_target_store_id_invalid"));
  const targetIdentity = await discoverPermanentPrintfulTarget(env, fetchImpl);

  const sourceCredential = requiredCredential(env?.PRINTFUL_WIX_SOURCE_TOKEN, "printful_wix_source_token_unavailable");
  const targetCredential = requiredCredential(env?.PRINTFUL_API_TOKEN, "printful_target_token_unavailable");
  const [sourceProducts, targetProducts] = await Promise.all([
    readCompleteCatalogue(fetchImpl, PRINTFUL_CATALOGUE_ENDPOINTS.sourceProducts, sourceCredential, "source"),
    readCompleteCatalogue(fetchImpl, PRINTFUL_CATALOGUE_ENDPOINTS.targetProducts, targetCredential, "target"),
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

async function readCompleteCatalogue(fetchImpl, baseUrl, credential, role) {
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

  const orderedSummaries = [...summaries].sort((left, right) => compareIds(left?.id, right?.id));
  const details = [];
  for (const summary of orderedSummaries) {
    const id = requiredProviderId(summary?.id, `printful_${role}_product_id_invalid`);
    const detailPayload = await printfulGet(fetchImpl, `${baseUrl}/${encodeURIComponent(id)}`, credential, `${role}_product_detail`);
    details.push(normalizeProductDetail(detailPayload?.result, summary, role));
  }
  return details.sort((left, right) => compareIds(left.id, right.id));
}

function buildCatalogueSnapshot(store, products, role) {
  const variants = products.flatMap((product) => product.variants);
  return {
    role,
    store,
    counts: {
      products: products.length,
      variants: variants.length,
      synced: variants.filter((variant) => variant.synced === true).length,
      ignored: variants.filter((variant) => variant.isIgnored === true).length,
      unavailable: variants.filter((variant) => variant.availabilityStatus && variant.availabilityStatus !== "active").length,
      malformedOrMissingPrices: variants.filter((variant) => variant.price.status !== "valid").length,
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
    size: optionalText(variant.size, 120),
    color: optionalText(variant.color, 120),
    synced: booleanOrNull(variant.synced),
    isIgnored: booleanOrNull(variant.is_ignored),
    availabilityStatus: optionalText(variant.availability_status, 80),
    options: normalizeOptions(variant.options),
    files: normalizeFiles(variant.files),
  };
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => ({
    id: providerIdOrNull(file?.id),
    type: optionalText(file?.type, 120),
    url: safeUrl(file?.url),
    filename: optionalText(file?.filename, 300),
    previewUrl: safeUrl(file?.preview_url),
    thumbnailUrl: safeUrl(file?.thumbnail_url),
    status: optionalText(file?.status, 80),
    visible: booleanOrNull(file?.visible),
    options: normalizeOptions(file?.options),
  })).sort((left, right) => `${left.type || ""}:${left.id || ""}:${left.filename || ""}`.localeCompare(`${right.type || ""}:${right.id || ""}:${right.filename || ""}`));
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.slice(0, 100).map((option) => ({
    id: optionalText(option?.id, 120),
    value: scalarOptionValue(option?.value),
  })).filter((option) => option.id).sort((left, right) => left.id.localeCompare(right.id));
}

async function printfulGet(fetchImpl, url, credential, operation) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${credential}` },
    });
  } catch {
    throw new AuthFailure(502, `printful_${operation}_unavailable`, "Printful catalogue discovery is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) {
    throw new AuthFailure(502, `printful_${operation}_rejected`, "Printful rejected a read-only catalogue request.");
  }
  try {
    return await response.json();
  } catch {
    throw new AuthFailure(502, `printful_${operation}_invalid`, "Printful returned an invalid catalogue response.");
  }
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
  const type = store.type.toLowerCase();
  if (store.id === TARGET_STORE_ID || type === "native" || normalizeName(store.name) === normalizeName(TARGET_STORE_NAME)) {
    throw new AuthFailure(409, "printful_wix_source_is_target", "The legacy source credential resolves to the permanent native target and was rejected.");
  }
  if (!type.includes("wix")) {
    throw new AuthFailure(409, "printful_wix_source_identity_ambiguous", "The source credential does not resolve unambiguously to a Wix-connected Printful store.");
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
