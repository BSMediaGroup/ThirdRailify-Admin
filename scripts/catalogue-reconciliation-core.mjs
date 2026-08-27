export function reconcileCatalogues(providerPayload, publicSnapshot) {
  const sourceProducts = providerPayload?.source?.products || [];
  const targetProducts = providerPayload?.target?.products || [];
  const publicProducts = publicSnapshot?.products || [];
  const duplicateEvidence = {
    sourceProductIds: duplicates(sourceProducts.map((product) => product.id)),
    sourceExternalIds: duplicates(sourceProducts.map((product) => product.externalId)),
    sourceVariantIds: duplicates(sourceProducts.flatMap((product) => product.variants.map((variant) => variant.id))),
    sourceVariantExternalIds: duplicates(sourceProducts.flatMap((product) => product.variants.map((variant) => variant.externalId))),
    sourceSkus: duplicates(sourceProducts.flatMap((product) => product.variants.map((variant) => variant.sku))),
    targetProductIds: duplicates(targetProducts.map((product) => product.id)),
    targetExternalIds: duplicates(targetProducts.map((product) => product.externalId)),
    targetSkus: duplicates(targetProducts.flatMap((product) => product.variants.map((variant) => variant.sku))),
  };

  const matrix = publicProducts.map((publicProduct) => reconcilePublicProduct(publicProduct, sourceProducts, targetProducts));
  const matchedSourceIds = new Set(matrix.flatMap((entry) => entry.sourceMatch ? [entry.sourceMatch.productId] : []));
  for (const source of sourceProducts.filter((product) => !matchedSourceIds.has(product.id))) {
    matrix.push(reconcileSourceOnly(source, targetProducts));
  }

  const plannedTargetPayloads = sourceProducts
    .filter((source) => !findTargetMatch(source, targetProducts).match)
    .map(buildPlannedPayload)
    .sort((left, right) => left.migrationMetadata.legacySourceProductId.localeCompare(right.migrationMetadata.legacySourceProductId, "en", { numeric: true }));

  const targetDispositions = targetProducts.map((target) => {
    const candidates = sourceProducts.map((source) => ({ source, evidence: targetEvidence(source, target) })).filter((entry) => entry.evidence.strength > 0).sort((left, right) => right.evidence.strength - left.evidence.strength);
    const best = candidates[0];
    const tied = best ? candidates.filter((entry) => entry.evidence.strength === best.evidence.strength) : [];
    return {
      targetProductId: target.id,
      externalId: target.externalId,
      name: target.name,
      variants: target.variants,
      sourceProductId: tied.length === 1 ? best.source.id : null,
      evidence: tied.length === 1 ? best.evidence.reasons : [],
      recommendation: !best ? "MANUAL_REVIEW_UNMATCHED_TARGET" : tied.length > 1 ? "MANUAL_REVIEW_AMBIGUOUS_TARGET" : best.evidence.strength >= 90 ? "PRESERVE_AS_ALREADY_PRESENT" : "MANUAL_REVIEW_POSSIBLE_PARTIAL_MIGRATION",
    };
  }).sort((left, right) => left.targetProductId.localeCompare(right.targetProductId, "en", { numeric: true }));

  const counts = {
    publicProducts: publicProducts.length,
    printfulBackedMatches: matrix.filter((entry) => entry.public && entry.sourceMatch).length,
    nonPrintful: matrix.filter((entry) => entry.public?.fulfillmentClass && entry.public.fulfillmentClass !== "printful_merchandise").length,
    unresolved: matrix.filter((entry) => entry.public && !entry.sourceMatch && entry.classification !== "NON_PRINTFUL").length,
    sourceOnly: matrix.filter((entry) => !entry.public).length,
    priceConflicts: matrix.filter((entry) => entry.priceStatus === "price_conflict").length,
    variantConflicts: matrix.filter((entry) => entry.variantStatus === "variant_conflict").length,
    fileConflicts: matrix.filter((entry) => entry.fileStatus === "file_conflict").length,
    plannedTargetCreates: plannedTargetPayloads.length,
    manualDecisions: matrix.filter((entry) => entry.manualReview).length + targetDispositions.filter((entry) => entry.recommendation.startsWith("MANUAL_REVIEW")).length,
  };

  return {
    schemaVersion: 1,
    sourceStore: providerPayload.source.store,
    targetStore: providerPayload.target.store,
    counts,
    duplicateEvidence,
    matrix,
    targetDispositions,
    plannedTargetPayloads,
  };
}

function reconcilePublicProduct(publicProduct, sourceProducts, targetProducts) {
  if (publicProduct.fulfillmentClass && publicProduct.fulfillmentClass !== "printful_merchandise") {
    return baseMatrix(publicProduct, { classification: "NON_PRINTFUL", manualReview: false });
  }
  const match = findSourceMatch(publicProduct, sourceProducts);
  if (!match.match) {
    return baseMatrix(publicProduct, { classification: match.ambiguous ? "AMBIGUOUS" : "PUBLIC_ONLY", matchEvidence: match.evidence, manualReview: true });
  }
  const source = match.match;
  const target = findTargetMatch(source, targetProducts);
  const priceStatus = comparePrice(publicProduct.visibleUnitAmountCad, source.variants);
  const variantStatus = compareOptions(publicProduct.optionLabels, source.variants);
  const fileStatus = source.variants.some((variant) => !variant.files.length) ? "file_conflict" : "files_present";
  const conflicts = [priceStatus === "price_conflict", variantStatus === "variant_conflict", fileStatus === "file_conflict"];
  const classification = priceStatus === "price_conflict" ? "PRICE_CONFLICT" : variantStatus === "variant_conflict" ? "VARIANT_CONFLICT" : fileStatus === "file_conflict" ? "FILE_CONFLICT" : target.match ? "TARGET_ALREADY_PRESENT" : "MATCHED_PRINTFUL_SOURCE";
  return baseMatrix(publicProduct, {
    classification,
    matchEvidence: match.evidence,
    sourceMatch: sourceProjection(source),
    targetMatch: target.match ? { productId: target.match.id, externalId: target.match.externalId, name: target.match.name, evidence: target.evidence } : null,
    priceStatus,
    priceRangeCad: priceRange(source.variants),
    variantStatus,
    fileStatus,
    recommendedAction: target.match ? "PRESERVE_AND_MAP_EXISTING_TARGET" : "PLAN_TARGET_PRODUCT_CREATE",
    manualReview: conflicts.some(Boolean) || target.ambiguous,
  });
}

function reconcileSourceOnly(source, targetProducts) {
  const target = findTargetMatch(source, targetProducts);
  return {
    public: null,
    classification: target.match ? "TARGET_ALREADY_PRESENT" : "PRINTFUL_SOURCE_ONLY",
    matchEvidence: [],
    sourceMatch: sourceProjection(source),
    targetMatch: target.match ? { productId: target.match.id, externalId: target.match.externalId, name: target.match.name, evidence: target.evidence } : null,
    priceStatus: source.variants.every((variant) => variant.price.status === "valid") ? (new Set(source.variants.map((variant) => variant.unitAmountCad)).size > 1 ? "price_variant_specific" : "printful_price_only") : "price_missing",
    priceRangeCad: priceRange(source.variants),
    variantStatus: "source_only",
    fileStatus: source.variants.some((variant) => !variant.files.length) ? "file_conflict" : "files_present",
    recommendedAction: target.match ? "PRESERVE_AND_MAP_EXISTING_TARGET" : "PLAN_TARGET_PRODUCT_CREATE",
    manualReview: true,
  };
}

function findSourceMatch(publicProduct, sourceProducts) {
  const exactIds = sourceProducts.filter((source) => source.externalId && [publicProduct.id, publicProduct.wixExternalProductId].filter(Boolean).includes(source.externalId));
  if (exactIds.length === 1) return { match: exactIds[0], evidence: ["external_id_exact"], ambiguous: false };
  if (exactIds.length > 1) return { match: null, evidence: ["duplicate_external_id"], ambiguous: true };
  const names = sourceProducts.filter((source) => normalizeName(source.name) === normalizeName(publicProduct.title));
  if (names.length === 1) return { match: names[0], evidence: ["name_exact_normalized"], ambiguous: false };
  return { match: null, evidence: names.length > 1 ? ["duplicate_normalized_name"] : [], ambiguous: names.length > 1 };
}

function findTargetMatch(source, targetProducts) {
  const ranked = targetProducts.map((target) => ({ target, evidence: targetEvidence(source, target) })).filter((entry) => entry.evidence.strength > 0).sort((left, right) => right.evidence.strength - left.evidence.strength);
  if (!ranked.length) return { match: null, evidence: [], ambiguous: false };
  const tied = ranked.filter((entry) => entry.evidence.strength === ranked[0].evidence.strength);
  if (tied.length !== 1) return { match: null, evidence: tied.flatMap((entry) => entry.evidence.reasons), ambiguous: true };
  return { match: tied[0].target, evidence: tied[0].evidence.reasons, ambiguous: false };
}

function targetEvidence(source, target) {
  const reasons = [];
  let strength = 0;
  if (source.externalId && target.externalId && source.externalId === target.externalId) { strength += 100; reasons.push("external_id_exact"); }
  const sourceSkus = new Set(source.variants.map((variant) => variant.sku).filter(Boolean));
  const targetSkus = target.variants.map((variant) => variant.sku).filter(Boolean);
  if (sourceSkus.size && targetSkus.length && targetSkus.every((sku) => sourceSkus.has(sku))) { strength += 80; reasons.push("sku_set_match"); }
  const sourceVariants = new Set(source.variants.map((variant) => variant.catalogueVariantId).filter(Boolean));
  const targetVariants = target.variants.map((variant) => variant.catalogueVariantId).filter(Boolean);
  if (sourceVariants.size && targetVariants.length && targetVariants.every((id) => sourceVariants.has(id))) { strength += 40; reasons.push("catalogue_variant_set_match"); }
  if (normalizeName(source.name) === normalizeName(target.name)) { strength += 10; reasons.push("name_exact_normalized"); }
  return { strength, reasons };
}

function comparePrice(publicAmount, variants) {
  const valid = variants.filter((variant) => variant.price.status === "valid").map((variant) => variant.unitAmountCad);
  if (!Number.isSafeInteger(publicAmount)) return valid.length ? "printful_price_only" : "price_missing";
  if (!valid.length) return "public_price_only";
  const distinct = [...new Set(valid)];
  if (distinct.length === 1 && distinct[0] === publicAmount) return "price_exact";
  if (distinct.length > 1 && distinct.includes(publicAmount)) return "price_variant_specific";
  return "price_conflict";
}

function compareOptions(optionLabels = [], variants) {
  const expected = new Set(optionLabels.map((label) => label.toLowerCase()));
  if (expected.has("size") && !variants.some((variant) => variant.size)) return "variant_conflict";
  if (expected.has("color") && !variants.some((variant) => variant.color)) return "variant_conflict";
  return "variant_structure_supported";
}

function buildPlannedPayload(source) {
  const stableId = `trf-${slugify(source.name)}-${source.id}`.slice(0, 240);
  return {
    endpoint: "POST /store/products",
    send: false,
    sync_product: { external_id: stableId, name: source.name, thumbnail: source.thumbnailUrl },
    sync_variants: source.variants.map((variant) => ({
      external_id: `${stableId}-v-${variant.id}`.slice(0, 240),
      variant_id: variant.catalogueVariantId,
      retail_price: variant.retailPrice,
      sku: variant.sku,
      files: variant.files.map((file) => ({ type: file.type, id: file.id, url: file.url, filename: file.filename, options: file.options })),
      options: variant.options,
    })),
    migrationMetadata: { legacySourceProductId: source.id, legacyExternalProductId: source.externalId, legacyVariantIds: source.variants.map((variant) => variant.id) },
  };
}

function sourceProjection(source) {
  return { productId: source.id, externalId: source.externalId, name: source.name, variantCount: source.variants.length };
}

function baseMatrix(publicProduct, overrides) {
  return {
    public: { id: publicProduct.id, title: publicProduct.title, slug: publicProduct.slug, publicUrl: publicProduct.publicUrl, visibleUnitAmountCad: publicProduct.visibleUnitAmountCad, optionLabels: publicProduct.optionLabels, fulfillmentClass: publicProduct.fulfillmentClass },
    classification: "AMBIGUOUS",
    matchEvidence: [],
    sourceMatch: null,
    targetMatch: null,
    priceStatus: Number.isSafeInteger(publicProduct.visibleUnitAmountCad) ? "public_price_only" : "price_missing",
    priceRangeCad: null,
    variantStatus: "unresolved",
    fileStatus: "unresolved",
    recommendedAction: "MANUAL_REVIEW",
    manualReview: true,
    ...overrides,
  };
}

function priceRange(variants) {
  const prices = variants.filter((variant) => variant.price.status === "valid").map((variant) => variant.unitAmountCad);
  return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
}

function duplicates(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(String(value), (counts.get(String(value)) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value, "en", { numeric: true }));
}

function normalizeName(value) {
  return String(value || "").normalize("NFKD").replace(/[™®©]/g, "").replace(/[^a-z0-9]+/gi, " ").trim().replace(/\s+/g, " ").toLowerCase();
}

function slugify(value) {
  return normalizeName(value).replace(/\s+/g, "-") || "product";
}
