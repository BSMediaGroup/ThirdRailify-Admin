const PRINTFUL_CLASS = "PRINTFUL_MERCH";

export function reconcileCatalogues(providerPayload, publicSnapshot) {
  const sourceProducts = array(providerPayload?.source?.products);
  const targetProducts = array(providerPayload?.target?.products);
  const publicProducts = array(publicSnapshot?.products);
  const duplicateEvidence = {
    sourceProductIds: duplicates(sourceProducts.map((product) => product.id)),
    sourceExternalIds: duplicates(sourceProducts.map((product) => product.externalId)),
    sourceVariantIds: duplicates(sourceProducts.flatMap((product) => array(product.variants).map((variant) => variant.id))),
    sourceVariantExternalIds: duplicates(sourceProducts.flatMap((product) => array(product.variants).map((variant) => variant.externalId))),
    sourceSkus: duplicates(sourceProducts.flatMap((product) => array(product.variants).map((variant) => variant.sku))),
    targetProductIds: duplicates(targetProducts.map((product) => product.id)),
    targetExternalIds: duplicates(targetProducts.map((product) => product.externalId)),
    targetSkus: duplicates(targetProducts.flatMap((product) => array(product.variants).map((variant) => variant.sku))),
  };

  const matrix = publicProducts.map((product) => reconcilePublicProduct(product, sourceProducts, targetProducts));
  const matchedSourceIds = new Set(matrix.flatMap((entry) => entry.sourceMatch ? [entry.sourceMatch.productId] : []));
  for (const source of sourceProducts.filter((product) => !matchedSourceIds.has(product.id))) {
    matrix.push(reconcileSourceOnly(source, targetProducts));
  }
  matrix.sort(compareMatrixEntries);

  const plannedTargetPayloads = sourceProducts
    .filter((source) => !findTargetMatch(source, targetProducts).match)
    .map(buildPlannedPayload)
    .sort((left, right) => compareIds(left.migrationMetadata.legacySourceProductId, right.migrationMetadata.legacySourceProductId));

  const targetDispositions = targetProducts.map((target) => targetDisposition(target, sourceProducts))
    .sort((left, right) => compareIds(left.targetProductId, right.targetProductId));

  const counts = {
    publicProducts: publicProducts.length,
    printfulBackedMatches: matrix.filter((entry) => entry.public && entry.sourceMatch).length,
    nonPrintful: matrix.filter((entry) => entry.public && entry.public.classification !== PRINTFUL_CLASS).length,
    unresolved: matrix.filter((entry) => entry.public && !entry.sourceMatch && entry.classification !== "NON_PRINTFUL").length,
    sourceOnly: matrix.filter((entry) => !entry.public).length,
    priceConflicts: matrix.filter((entry) => entry.priceStatus === "price_conflict").length,
    variantConflicts: matrix.filter((entry) => entry.variantStatus === "variant_conflict").length,
    fileConflicts: matrix.filter((entry) => entry.fileStatus === "file_conflict").length,
    plannedTargetCreates: plannedTargetPayloads.length,
    manualDecisions: matrix.filter((entry) => entry.manualReview).length
      + targetDispositions.filter((entry) => entry.recommendation === "MANUAL_REVIEW").length,
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
  if (publicProduct.classification !== PRINTFUL_CLASS) {
    return baseMatrix(publicProduct, { classification: "NON_PRINTFUL", manualReview: false, recommendedAction: "EXCLUDE_FROM_PRINTFUL" });
  }
  const sourceResult = findSourceMatch(publicProduct, sourceProducts);
  if (!sourceResult.match) {
    return baseMatrix(publicProduct, {
      classification: sourceResult.ambiguous ? "AMBIGUOUS" : "PUBLIC_ONLY",
      matchEvidence: sourceResult.evidence,
      manualReview: true,
    });
  }

  const source = sourceResult.match;
  const targetResult = findTargetMatch(source, targetProducts);
  const priceStatus = comparePrice(publicProduct.visibleUnitAmountCad, source.variants);
  const variantStatus = compareOptions(publicProduct.optionLabels, source.variants);
  const fileStatus = array(source.variants).some((variant) => !array(variant.files).length) ? "file_conflict" : "files_present";
  const conflict = priceStatus === "price_conflict" || variantStatus === "variant_conflict" || fileStatus === "file_conflict";
  const classification = priceStatus === "price_conflict"
    ? "PRICE_CONFLICT"
    : variantStatus === "variant_conflict"
      ? "VARIANT_CONFLICT"
      : fileStatus === "file_conflict"
        ? "FILE_CONFLICT"
        : targetResult.match
          ? "TARGET_ALREADY_PRESENT"
          : "MATCHED_PRINTFUL_SOURCE";
  return baseMatrix(publicProduct, {
    classification,
    matchEvidence: sourceResult.evidence,
    sourceMatch: sourceProjection(source),
    targetMatch: targetResult.match ? targetProjection(targetResult.match, targetResult.evidence) : null,
    priceStatus,
    priceRangeCad: priceRange(source.variants),
    variantStatus,
    fileStatus,
    recommendedAction: targetResult.match ? "MAP_EXISTING_TARGET" : "PLAN_TARGET_CREATE",
    blocker: conflict || targetResult.ambiguous ? "Resolve recorded reconciliation conflicts before any write migration." : null,
    manualReview: conflict || targetResult.ambiguous,
  });
}

function reconcileSourceOnly(source, targetProducts) {
  const targetResult = findTargetMatch(source, targetProducts);
  const pricesValid = array(source.variants).every((variant) => variant.price?.status === "valid");
  return {
    public: null,
    classification: targetResult.match ? "TARGET_ALREADY_PRESENT" : "PRINTFUL_SOURCE_ONLY",
    matchEvidence: [],
    sourceMatch: sourceProjection(source),
    targetMatch: targetResult.match ? targetProjection(targetResult.match, targetResult.evidence) : null,
    priceStatus: pricesValid
      ? new Set(array(source.variants).map((variant) => variant.unitAmountCad)).size > 1 ? "price_variant_specific" : "printful_price_only"
      : "price_missing",
    priceRangeCad: priceRange(source.variants),
    variantStatus: "source_only",
    fileStatus: array(source.variants).some((variant) => !array(variant.files).length) ? "file_conflict" : "files_present",
    recommendedAction: targetResult.match ? "MAP_EXISTING_TARGET" : "PLAN_TARGET_CREATE",
    blocker: "No current Public Wix projection matched this source product.",
    manualReview: true,
  };
}

function findSourceMatch(publicProduct, sourceProducts) {
  const ranked = sourceProducts.map((source) => ({ source, evidence: publicEvidence(publicProduct, source) }))
    .filter((entry) => entry.evidence.strength > 0)
    .sort(compareRanked);
  return selectUniqueCandidate(ranked, "source");
}

function findTargetMatch(source, targetProducts) {
  const ranked = targetProducts.map((target) => ({ target, evidence: targetEvidence(source, target) }))
    .filter((entry) => entry.evidence.strength > 0)
    .sort(compareRanked);
  return selectUniqueCandidate(ranked, "target");
}

function selectUniqueCandidate(ranked, key) {
  if (!ranked.length) return { match: null, evidence: [], ambiguous: false };
  const best = ranked[0];
  const tied = ranked.filter((entry) => entry.evidence.strength === best.evidence.strength);
  if (tied.length !== 1) return { match: null, evidence: unique(tied.flatMap((entry) => entry.evidence.reasons)), ambiguous: true };
  return { match: best[key], evidence: best.evidence.reasons, ambiguous: false };
}

function publicEvidence(publicProduct, source) {
  const reasons = [];
  let strength = 0;
  const declaredExternalIds = compact([publicProduct.wixExternalProductId]);
  const declaredSyncIds = compact([publicProduct.printfulSyncProductId, publicProduct.sourcePrintfulProductId]);
  const declaredVariantIds = compact(publicProduct.printfulSyncVariantIds);
  const declaredSkus = compact(publicProduct.skus);
  const declaredCatalogueIds = compact(publicProduct.printfulCatalogueVariantIds);

  if (source.externalId && declaredExternalIds.includes(String(source.externalId))) { strength += 1000; reasons.push("external_id_exact"); }
  if (declaredSyncIds.includes(String(source.id))) { strength += 900; reasons.push("sync_product_id_exact"); }
  if (declaredVariantIds.length && setEquals(declaredVariantIds, array(source.variants).map((variant) => variant.id))) { strength += 800; reasons.push("sync_variant_ids_exact"); }
  if (declaredSkus.length && setEquals(declaredSkus, array(source.variants).map((variant) => variant.sku))) { strength += 700; reasons.push("sku_set_match"); }
  if (declaredCatalogueIds.length && setEquals(declaredCatalogueIds, array(source.variants).map((variant) => variant.catalogueVariantId))) { strength += 600; reasons.push("catalogue_variant_set_match"); }
  if (variantStructureMatches(publicProduct.optionLabels, source.variants)) { strength += 50; reasons.push("variant_structure_match"); }
  if (comparePrice(publicProduct.visibleUnitAmountCad, source.variants) === "price_exact") { strength += 40; reasons.push("price_exact"); }
  if (filesCorrelate([publicProduct.image, ...array(publicProduct.images)], source.variants)) { strength += 30; reasons.push("file_reference_match"); }
  if (normalizeName(publicProduct.title) === normalizeName(source.name)) { strength += 10; reasons.push("name_exact_normalized"); }

  const hasDeclaredStableId = declaredExternalIds.length || declaredSyncIds.length || declaredVariantIds.length || declaredSkus.length || declaredCatalogueIds.length;
  const hasStableMatch = reasons.some((reason) => ["external_id_exact", "sync_product_id_exact", "sync_variant_ids_exact", "sku_set_match", "catalogue_variant_set_match"].includes(reason));
  if (hasDeclaredStableId && !hasStableMatch) return { strength: 0, reasons: [] };
  return { strength, reasons };
}

function targetEvidence(source, target) {
  const reasons = [];
  let strength = 0;
  if (target.externalId === plannedExternalId(source)) { strength += 1100; reasons.push("planned_external_id_exact"); }
  if (source.externalId && target.externalId && source.externalId === target.externalId) { strength += 1000; reasons.push("external_id_exact"); }
  if (String(target.legacySourceSyncProductId || "") === String(source.id)) { strength += 900; reasons.push("legacy_sync_product_id_exact"); }
  if (setEquals(array(source.variants).map((variant) => variant.sku), array(target.variants).map((variant) => variant.sku), true)) { strength += 700; reasons.push("sku_set_match"); }
  if (setEquals(array(source.variants).map((variant) => variant.catalogueVariantId), array(target.variants).map((variant) => variant.catalogueVariantId), true)) { strength += 600; reasons.push("catalogue_variant_set_match"); }
  if (variantShape(source.variants) === variantShape(target.variants) && array(source.variants).length > 0) { strength += 50; reasons.push("variant_structure_match"); }
  if (priceSignature(source.variants) === priceSignature(target.variants) && priceSignature(source.variants)) { strength += 40; reasons.push("price_set_match"); }
  if (fileSignature(source.variants) && fileSignature(source.variants) === fileSignature(target.variants)) { strength += 30; reasons.push("file_mapping_match"); }
  if (normalizeName(source.name) === normalizeName(target.name)) { strength += 10; reasons.push("name_exact_normalized"); }
  return { strength, reasons };
}

function targetDisposition(target, sourceProducts) {
  const ranked = sourceProducts.map((source) => ({ source, evidence: targetEvidence(source, target) }))
    .filter((entry) => entry.evidence.strength > 0)
    .sort(compareRanked);
  const selected = selectUniqueCandidate(ranked, "source");
  const strength = ranked[0]?.evidence?.strength || 0;
  return {
    targetProductId: target.id,
    externalId: target.externalId,
    name: target.name,
    variants: target.variants,
    sourceProductId: selected.match?.id || null,
    evidence: selected.evidence,
    recommendation: selected.match && strength >= 600 ? "MAP" : "MANUAL_REVIEW",
  };
}

function comparePrice(publicAmount, variants) {
  const valid = array(variants).filter((variant) => variant.price?.status === "valid").map((variant) => variant.unitAmountCad);
  if (!Number.isSafeInteger(publicAmount)) return valid.length ? "printful_price_only" : "price_missing";
  if (!valid.length) return "public_price_only";
  const distinct = unique(valid);
  if (distinct.length === 1 && distinct[0] === publicAmount) return "price_exact";
  if (distinct.length > 1 && distinct.includes(publicAmount)) return "price_variant_specific";
  return "price_conflict";
}

function compareOptions(optionLabels = [], variants) {
  const expected = new Set(array(optionLabels).map((label) => normalizeName(label)));
  if (expected.has("size") && !array(variants).some((variant) => variant.size)) return "variant_conflict";
  if (expected.has("color") && !array(variants).some((variant) => variant.color)) return "variant_conflict";
  return "variant_structure_supported";
}

function buildPlannedPayload(source) {
  const stableId = plannedExternalId(source);
  return {
    endpoint: "POST /store/products",
    send: false,
    sync_product: { external_id: stableId, name: source.name, thumbnail: source.thumbnailUrl },
    sync_variants: array(source.variants).map((variant) => ({
      external_id: `${stableId}-v-${variant.id}`.slice(0, 240),
      variant_id: variant.catalogueVariantId,
      retail_price: variant.retailPrice,
      sku: variant.sku,
      files: array(variant.files).map((file) => ({ type: file.type, id: file.id, url: file.url, filename: file.filename, options: file.options })),
      options: variant.options,
    })),
    migrationMetadata: {
      legacySourceProductId: source.id,
      legacyExternalProductId: source.externalId,
      legacyVariantIds: array(source.variants).map((variant) => variant.id),
    },
  };
}

function baseMatrix(publicProduct, overrides) {
  return {
    public: {
      id: publicProduct.id,
      title: publicProduct.title,
      slug: publicProduct.slug,
      publicUrl: publicProduct.publicUrl,
      visibleUnitAmountCad: publicProduct.visibleUnitAmountCad,
      optionLabels: publicProduct.optionLabels,
      classification: publicProduct.classification,
    },
    classification: "AMBIGUOUS",
    matchEvidence: [],
    sourceMatch: null,
    targetMatch: null,
    priceStatus: Number.isSafeInteger(publicProduct.visibleUnitAmountCad) ? "public_price_only" : "price_missing",
    priceRangeCad: null,
    variantStatus: "unresolved",
    fileStatus: "unresolved",
    recommendedAction: "MANUAL_REVIEW",
    blocker: "Authenticated provider snapshot evidence is required.",
    manualReview: true,
    ...overrides,
  };
}

function sourceProjection(source) {
  return { productId: source.id, externalId: source.externalId, name: source.name, variantCount: array(source.variants).length };
}

function targetProjection(target, evidence) {
  return { productId: target.id, externalId: target.externalId, name: target.name, evidence };
}

function plannedExternalId(source) {
  return `trf-${slugify(source.name)}-${source.id}`.slice(0, 240);
}

function priceRange(variants) {
  const prices = array(variants).filter((variant) => variant.price?.status === "valid").map((variant) => variant.unitAmountCad);
  return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
}

function variantStructureMatches(optionLabels, variants) {
  return compareOptions(optionLabels, variants) === "variant_structure_supported" && array(variants).length > 0;
}

function variantShape(variants) {
  return array(variants).map((variant) => `${normalizeName(variant.size)}:${normalizeName(variant.color)}`).sort().join("|");
}

function priceSignature(variants) {
  const values = array(variants).filter((variant) => variant.price?.status === "valid").map((variant) => variant.unitAmountCad).sort((a, b) => a - b);
  return values.length ? values.join("|") : "";
}

function fileSignature(variants) {
  const values = array(variants).flatMap((variant) => array(variant.files).map((file) => `${file.id || ""}:${normalizeName(file.type)}:${normalizeName(file.filename)}`)).filter((value) => value !== "::").sort();
  return values.length ? values.join("|") : "";
}

function filesCorrelate(images, variants) {
  const publicNames = compact(images).map((value) => String(value).split(/[\\/]/).pop()).filter(Boolean);
  if (!publicNames.length) return false;
  const providerNames = array(variants).flatMap((variant) => array(variant.files).map((file) => file.filename)).filter(Boolean);
  return publicNames.some((name) => providerNames.includes(name));
}

function setEquals(left, right, requireNonEmpty = false) {
  const leftSet = new Set(compact(left));
  const rightSet = new Set(compact(right));
  if (requireNonEmpty && (!leftSet.size || !rightSet.size)) return false;
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function duplicates(values) {
  const counts = new Map();
  for (const value of compact(values)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value, count]) => ({ value, count })).sort((left, right) => compareIds(left.value, right.value));
}

function compact(values) {
  return array(values).filter((value) => value !== null && value !== undefined && String(value).trim()).map((value) => String(value));
}

function unique(values) {
  return [...new Set(values)];
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeName(value) {
  return String(value || "").normalize("NFKD").replace(/[™®©]/g, "").replace(/[^a-z0-9]+/gi, " ").trim().replace(/\s+/g, " ").toLowerCase();
}

function slugify(value) {
  return normalizeName(value).replace(/\s+/g, "-") || "product";
}

function compareRanked(left, right) {
  return right.evidence.strength - left.evidence.strength || compareIds(left.source?.id ?? left.target?.id, right.source?.id ?? right.target?.id);
}

function compareMatrixEntries(left, right) {
  if (Boolean(left.public) !== Boolean(right.public)) return left.public ? -1 : 1;
  const leftKey = left.public?.slug || `~${left.sourceMatch?.productId || ""}`;
  const rightKey = right.public?.slug || `~${right.sourceMatch?.productId || ""}`;
  return compareIds(leftKey, rightKey);
}

function compareIds(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), "en", { numeric: true });
}
