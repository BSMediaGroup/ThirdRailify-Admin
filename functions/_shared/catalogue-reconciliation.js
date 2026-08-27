const PRINTFUL_CLASSES = new Set(["PRINTFUL_MERCH", "PHYSICAL_PRODUCT_REQUIRES_RECONCILIATION"]);
const NON_PRINTFUL_CLASSES = new Set(["GIFT_CARD", "DONATION", "VIP_MEMBERSHIP", "NON_PRINTFUL_PHYSICAL", "OTHER"]);
const TARGET_NATIVE_PRODUCT_ID = "459991347";
const RELATED_LEGACY_ARTWORK_PRODUCT_ID = "439028668";

export function reconcileCatalogues(providerPayload, publicSnapshot) {
  const sourceProducts = array(providerPayload?.source?.products);
  const targetProducts = array(providerPayload?.target?.products);
  const publicProducts = array(publicSnapshot?.products);
  const duplicateEvidence = collectDuplicateEvidence(sourceProducts, targetProducts);
  const evidenceAggregates = aggregateEvidence(sourceProducts, targetProducts);

  const matrix = publicProducts.map((product) => reconcilePublicProduct(product, sourceProducts, targetProducts));
  const matchedSourceIds = new Set(matrix.flatMap((entry) => entry.sourceMatch ? [String(entry.sourceMatch.productId)] : []));
  for (const source of sourceProducts.filter((product) => !matchedSourceIds.has(String(product.id)))) matrix.push(reconcileSourceOnly(source, targetProducts));
  matrix.sort(compareMatrixEntries);

  const targetDispositions = targetProducts.map((target) => targetDisposition(target, sourceProducts)).sort((left, right) => compareIds(left.targetProductId, right.targetProductId));
  const selection = buildCatalogueWriteSelection({
    sourceStore: providerPayload?.source?.store,
    targetStore: providerPayload?.target?.store,
    sourceProducts,
    targetProducts,
    publicProducts,
    matrix,
    targetDispositions,
    duplicateEvidence,
    evidenceAggregates,
  });
  const plannedTargetPayloads = selection.products
    .filter((entry) => entry.decision === "MIGRATE_CREATE_TARGET")
    .map((entry) => entry.targetPayload)
    .sort((left, right) => compareIds(left.migrationMetadata.legacySourceProductId, right.migrationMetadata.legacySourceProductId));

  const counts = {
    publicProducts: publicProducts.length,
    printfulBackedMatches: matrix.filter((entry) => entry.public && entry.sourceMatch && entry.strongIdentity).length,
    nonPrintful: matrix.filter((entry) => entry.public && entry.sourceClassification === "NON_PRINTFUL_PUBLIC").length,
    unresolved: matrix.filter((entry) => entry.public && !entry.strongIdentity && entry.sourceClassification !== "NON_PRINTFUL_PUBLIC").length,
    sourceOnly: matrix.filter((entry) => !entry.public).length,
    priceConflicts: matrix.filter((entry) => entry.priceStatus === "price_conflict").length,
    variantConflicts: matrix.filter((entry) => entry.variantStatus === "variant_conflict").length,
    fileConflicts: matrix.filter((entry) => entry.fileStatus === "file_conflict").length,
    plannedTargetCreates: plannedTargetPayloads.length,
    manualDecisions: selection.counts.manualReview,
    targetNativeKeeps: selection.counts.keepExistingTarget,
    migrationEligibleVariants: selection.counts.migrationEligibleVariants,
    discontinuedVariantsExcluded: selection.counts.discontinuedVariantsExcluded,
    temporarilyOutOfStockVariantsDeferred: selection.counts.temporarilyOutOfStockVariants,
  };

  return {
    schemaVersion: 1,
    sourceStore: providerPayload?.source?.store,
    targetStore: providerPayload?.target?.store,
    counts,
    evidenceAggregates,
    duplicateEvidence,
    matrix,
    targetDispositions,
    plannedTargetPayloads,
    writeSelection: selection,
  };
}

export function buildCatalogueWriteSelection(input) {
  const products = [];
  const sourceById = new Map(input.sourceProducts.map((product) => [String(product.id), product]));
  for (const entry of input.matrix) {
    if (entry.public) {
      if (entry.sourceClassification === "NON_PRINTFUL_PUBLIC") {
        products.push({ decision: "NON_PRINTFUL", public: entry.public, sourceProductId: null, blocker: null, targetPayload: null });
        continue;
      }
      if (!entry.sourceMatch || !entry.strongIdentity) {
        products.push({ decision: "MANUAL_REVIEW", public: entry.public, sourceProductId: entry.sourceMatch?.productId || null, blocker: entry.blocker || "No unambiguous strong Printful source identity.", targetPayload: null });
        continue;
      }
      const source = sourceById.get(String(entry.sourceMatch.productId));
      const analysis = analyzeSourceProduct(source);
      if (source.isIgnored || analysis.ignoredActive.length) products.push(selectionProjection(entry, source, analysis, "MANUAL_REVIEW", "Ignored active Printful source records require an operator decision."));
      else if (entry.targetMatch) products.push(selectionProjection(entry, source, analysis, "KEEP_EXISTING_TARGET", null));
      else if (entry.priceStatus === "price_conflict" || entry.variantStatus === "variant_conflict" || entry.fileStatus === "file_conflict") products.push(selectionProjection(entry, source, analysis, "MANUAL_REVIEW", "The live/source price, option, or artwork evidence conflicts."));
      else {
        const payload = buildPlannedPayload(source, analysis);
        products.push({ ...selectionProjection(entry, source, analysis, "MIGRATE_CREATE_TARGET", null), targetPayload: payload });
      }
      continue;
    }

    const source = sourceById.get(String(entry.sourceMatch?.productId));
    if (!source) continue;
    const analysis = analyzeSourceProduct(source);
    if (source.isIgnored || analysis.ignoredActive.length) products.push(selectionProjection(entry, source, analysis, "MANUAL_REVIEW", "Ignored Printful source records require review and are not publication authority."));
    else if (analysis.active.length === 0 && analysis.temporarilyOutOfStock.length === 0) products.push(selectionProjection(entry, source, analysis, "EXCLUDE_DISCONTINUED_LEGACY", null));
    else products.push(selectionProjection(entry, source, analysis, "EXCLUDE_NOT_CURRENTLY_PUBLISHED", null));
  }

  for (const disposition of input.targetDispositions) {
    if (disposition.recommendation !== "KEEP_TARGET_NATIVE") continue;
    products.push({
      decision: disposition.relatedLegacyArtworkProductId ? "KEEP_EXISTING_TARGET_RELATED_LEGACY" : "KEEP_EXISTING_TARGET",
      targetProductId: disposition.targetProductId,
      relatedLegacyArtworkProductId: disposition.relatedLegacyArtworkProductId,
      public: null,
      sourceProductId: null,
      blocker: null,
      targetPayload: null,
      provenance: { targetStoreId: input.targetStore?.id || null, disposition: "USER_OWNED_REAL_TARGET_DATA" },
    });
  }

  const counts = {
    totalLegacyPrintfulProducts: input.sourceProducts.length,
    currentlyPublishedWixProducts: input.publicProducts.length,
    migrateCreateTarget: products.filter((entry) => entry.decision === "MIGRATE_CREATE_TARGET").length,
    keepExistingTarget: products.filter((entry) => entry.decision === "KEEP_EXISTING_TARGET" || entry.decision === "KEEP_EXISTING_TARGET_RELATED_LEGACY").length,
    excludedNotCurrentlyPublished: products.filter((entry) => entry.decision === "EXCLUDE_NOT_CURRENTLY_PUBLISHED").length,
    excludedDiscontinuedLegacy: products.filter((entry) => entry.decision === "EXCLUDE_DISCONTINUED_LEGACY").length,
    manualReview: products.filter((entry) => entry.decision === "MANUAL_REVIEW").length,
    nonPrintful: products.filter((entry) => entry.decision === "NON_PRINTFUL").length,
    migrationEligibleVariants: products.filter((entry) => entry.decision === "MIGRATE_CREATE_TARGET").reduce((sum, entry) => sum + entry.eligibleVariantIds.length, 0),
    discontinuedVariantsExcluded: input.evidenceAggregates.source.availability.DISCONTINUED,
    migrationDiscontinuedVariantsExcluded: products.filter((entry) => entry.decision === "MIGRATE_CREATE_TARGET").reduce((sum, entry) => sum + entry.excludedDiscontinuedVariantIds.length, 0),
    temporarilyOutOfStockVariants: input.evidenceAggregates.source.availability.TEMPORARILY_OUT_OF_STOCK,
    migrationTemporarilyOutOfStockVariants: products.filter((entry) => entry.decision === "MIGRATE_CREATE_TARGET").reduce((sum, entry) => sum + entry.temporarilyOutOfStockVariants.length, 0),
    activeVariantsWithoutFiles: input.evidenceAggregates.source.filelessByAvailability.ACTIVE,
    temporarilyOutOfStockVariantsWithoutFiles: input.evidenceAggregates.source.filelessByAvailability.TEMPORARILY_OUT_OF_STOCK,
    discontinuedVariantsWithoutFiles: input.evidenceAggregates.source.filelessByAvailability.DISCONTINUED,
  };
  const acceptanceGates = {
    exactLivePublishedProductCount: Number.isSafeInteger(counts.currentlyPublishedWixProducts) && counts.currentlyPublishedWixProducts > 0,
    allPlannedProductsStronglyMapped: products.filter((entry) => entry.decision === "MIGRATE_CREATE_TARGET").every((entry) => entry.strongIdentity === true),
    zeroActiveVariantsMissingArtwork: counts.activeVariantsWithoutFiles === 0,
    allPlannedPricesValidCadIntegerCents: products.filter((entry) => entry.decision === "MIGRATE_CREATE_TARGET").every((entry) => entry.prices.every((price) => Number.isSafeInteger(price.unitAmountCad) && price.unitAmountCad >= 0 && price.currency === "CAD")),
    discontinuedVariantsExcludedFromPayloads: products.filter((entry) => entry.targetPayload).every((entry) => entry.targetPayload.sync_variants.every((variant) => variant.migration_availability === "ACTIVE")),
    targetNativeProductPreserved: products.some((entry) => entry.targetProductId === TARGET_NATIVE_PRODUCT_ID && entry.decision.startsWith("KEEP_EXISTING_TARGET")),
    duplicateSkusDoNotBlock: true,
    zeroUnresolvedIdentityConflictsInWriteSet: products.filter((entry) => entry.decision === "MIGRATE_CREATE_TARGET").every((entry) => !entry.blocker),
    checkoutEnabled: false,
    fulfillmentEnabled: false,
  };
  return {
    schemaVersion: 1,
    generatedFrom: {
      sourceStoreId: input.sourceStore?.id || null,
      targetStoreId: input.targetStore?.id || null,
      publicationAuthority: "CURRENT_LIVE_WIX_PUBLIC_GET_CENSUS",
      immutableSourceSnapshot: "printful-wix-source.snapshot.json",
      immutableTargetSnapshot: "printful-api-target.snapshot.json",
    },
    counts,
    acceptanceGates,
    duplicateSkuEvidence: input.duplicateEvidence.sourceSkus,
    products: products.sort(compareSelectionEntries),
  };
}

function reconcilePublicProduct(publicProduct, sourceProducts, targetProducts) {
  if (NON_PRINTFUL_CLASSES.has(publicProduct.classification)) return baseMatrix(publicProduct, { classification: "NON_PRINTFUL", sourceClassification: "NON_PRINTFUL_PUBLIC", manualReview: false, recommendedAction: "NON_PRINTFUL" });
  const sourceResult = findSourceMatch(publicProduct, sourceProducts);
  if (!sourceResult.match || !sourceResult.strong) {
    return baseMatrix(publicProduct, {
      classification: sourceResult.ambiguous ? "AMBIGUOUS" : "PUBLIC_ONLY",
      sourceClassification: sourceResult.ambiguous ? "AMBIGUOUS_LIVE_MATCH" : PRINTFUL_CLASSES.has(publicProduct.classification) ? "OTHER_REVIEW_REQUIRED" : "NON_PRINTFUL_PUBLIC",
      matchEvidence: sourceResult.evidence,
      sourceMatch: sourceResult.match ? sourceProjection(sourceResult.match) : null,
      strongIdentity: false,
      manualReview: PRINTFUL_CLASSES.has(publicProduct.classification),
      blocker: sourceResult.ambiguous ? "Multiple source records share the strongest available identity evidence." : "No strong Printful source identity matched this live product.",
    });
  }

  const source = sourceResult.match;
  const targetResult = findTargetMatch(source, targetProducts);
  const analysis = analyzeSourceProduct(source);
  const priceStatus = comparePrice(publicProduct.visibleUnitAmountCad, analysis.migrationCandidates);
  const variantStatus = compareOptions(publicProduct.optionLabels, analysis.migrationCandidates);
  const fileStatus = analysis.missingRequiredFiles.length ? "file_conflict" : "files_ready";
  const conflict = priceStatus === "price_conflict" || variantStatus === "variant_conflict" || fileStatus === "file_conflict";
  const ignoredReview = source.isIgnored || analysis.ignoredActive.length > 0;
  const classification = ignoredReview ? "IGNORED_SOURCE_REVIEW" : priceStatus === "price_conflict" ? "PRICE_CONFLICT" : variantStatus === "variant_conflict" ? "VARIANT_CONFLICT" : fileStatus === "file_conflict" ? "FILE_CONFLICT" : targetResult.match ? "TARGET_ALREADY_PRESENT" : "MATCHED_PRINTFUL_SOURCE";
  return baseMatrix(publicProduct, {
    classification,
    sourceClassification: ignoredReview ? "IGNORED_SOURCE_REVIEW" : "MIGRATE_LIVE_WIX",
    matchEvidence: sourceResult.evidence,
    matchPriority: sourceResult.priority,
    strongIdentity: true,
    sourceMatch: sourceProjection(source),
    targetMatch: targetResult.match ? targetProjection(targetResult.match, targetResult.evidence) : null,
    priceStatus,
    priceRangeCad: priceRange(analysis.migrationCandidates),
    variantStatus,
    fileStatus,
    availability: analysis.availability,
    recommendedAction: ignoredReview || conflict ? "MANUAL_REVIEW" : targetResult.match ? "KEEP_EXISTING_TARGET" : "MIGRATE_CREATE_TARGET",
    blocker: ignoredReview ? "Ignored active source records require review." : conflict || targetResult.ambiguous ? "Resolve recorded reconciliation conflicts before any write migration." : null,
    manualReview: ignoredReview || conflict || targetResult.ambiguous,
  });
}

function reconcileSourceOnly(source, targetProducts) {
  const targetResult = findTargetMatch(source, targetProducts);
  const analysis = analyzeSourceProduct(source);
  const ignoredReview = source.isIgnored || analysis.ignoredActive.length > 0;
  return {
    public: null,
    classification: ignoredReview ? "IGNORED_SOURCE_REVIEW" : targetResult.match ? "TARGET_ALREADY_PRESENT" : "PRINTFUL_SOURCE_ONLY",
    sourceClassification: ignoredReview ? "IGNORED_SOURCE_REVIEW" : analysis.active.length || analysis.temporarilyOutOfStock.length ? "LEGACY_NOT_CURRENTLY_PUBLISHED" : "SOURCE_ORPHAN",
    matchEvidence: [], matchPriority: null, strongIdentity: false,
    sourceMatch: sourceProjection(source),
    targetMatch: targetResult.match ? targetProjection(targetResult.match, targetResult.evidence) : null,
    priceStatus: analysis.migrationCandidates.every((variant) => variant.price?.status === "valid") ? new Set(analysis.migrationCandidates.map((variant) => variant.unitAmountCad)).size > 1 ? "price_variant_specific" : "printful_price_only" : "price_missing",
    priceRangeCad: priceRange(analysis.migrationCandidates),
    variantStatus: "source_only",
    fileStatus: analysis.missingRequiredFiles.length ? "file_conflict" : "files_ready",
    availability: analysis.availability,
    recommendedAction: ignoredReview ? "MANUAL_REVIEW" : "EXCLUDE_NOT_CURRENTLY_PUBLISHED",
    blocker: ignoredReview ? "Ignored source record requires review." : "Not present in the current live Wix publication census.",
    manualReview: ignoredReview,
  };
}

function findSourceMatch(publicProduct, sourceProducts) {
  const declaredStableIds = compact([publicProduct.sourcePrintfulProductId, publicProduct.printfulSyncProductId, publicProduct.wixExternalProductId]);
  const ranked = sourceProducts.map((source) => ({ source, evidence: publicEvidence(publicProduct, source) })).filter((entry) => Number.isSafeInteger(entry.evidence.priority)).sort(compareRanked);
  if (!ranked.length) return { match: null, evidence: [], ambiguous: false, strong: false, priority: null };
  const best = ranked[0];
  const tied = ranked.filter((entry) => entry.evidence.priority === best.evidence.priority);
  if (tied.length !== 1) return { match: null, evidence: unique(tied.flatMap((entry) => entry.evidence.reasons)), ambiguous: true, strong: false, priority: best.evidence.priority };
  const hasStableMismatch = declaredStableIds.length > 0 && best.evidence.priority > 2;
  return { match: best.source, evidence: best.evidence.reasons, ambiguous: false, strong: best.evidence.priority <= 4 && !hasStableMismatch, priority: best.evidence.priority };
}

function findTargetMatch(source, targetProducts) {
  const ranked = targetProducts.map((target) => ({ target, evidence: targetEvidence(source, target) })).filter((entry) => Number.isSafeInteger(entry.evidence.priority) && entry.evidence.priority <= 4).sort(compareRanked);
  return selectUniqueCandidate(ranked, "target");
}

function selectUniqueCandidate(ranked, key) {
  if (!ranked.length) return { match: null, evidence: [], ambiguous: false, priority: null };
  const best = ranked[0];
  const tied = ranked.filter((entry) => entry.evidence.priority === best.evidence.priority);
  if (tied.length !== 1) return { match: null, evidence: unique(tied.flatMap((entry) => entry.evidence.reasons)), ambiguous: true, priority: best.evidence.priority };
  return { match: best[key], evidence: best.evidence.reasons, ambiguous: false, priority: best.evidence.priority };
}

function publicEvidence(publicProduct, source) {
  const matches = [];
  const declaredSourceIds = compact([publicProduct.sourcePrintfulProductId, publicProduct.printfulSyncProductId]);
  const declaredExternalIds = compact([publicProduct.wixExternalProductId]);
  const declaredVariantIds = compact(publicProduct.printfulSyncVariantIds);
  const declaredSkus = compact(publicProduct.skus);
  const declaredCatalogueIds = compact(publicProduct.printfulCatalogueVariantIds);
  if (declaredSourceIds.includes(String(source.id))) matches.push([1, "source_product_id_exact"]);
  if (source.externalId && declaredExternalIds.includes(String(source.externalId))) matches.push([2, "external_id_exact"]);
  if (normalizeName(publicProduct.title) && normalizeName(publicProduct.title) === normalizeName(source.name)) matches.push([3, "name_exact_normalized"]);
  if (declaredVariantIds.length && setEquals(declaredVariantIds, array(source.variants).map((variant) => variant.id))) matches.push([4, "sync_variant_ids_exact"]);
  if (declaredSkus.length && setEquals(declaredSkus, array(source.variants).map((variant) => variant.sku))) matches.push([4, "sku_set_match"]);
  if (declaredCatalogueIds.length && setEquals(declaredCatalogueIds, array(source.variants).map((variant) => variant.catalogueVariantId))) matches.push([5, "catalogue_variant_set_match"]);
  if (variantStructureMatches(publicProduct.optionLabels, source.variants)) matches.push([5, "variant_structure_match"]);
  if (filesCorrelate([publicProduct.image, ...array(publicProduct.images)], source.variants)) matches.push([6, "file_reference_match"]);
  const price = comparePrice(publicProduct.visibleUnitAmountCad, source.variants);
  if (price === "price_exact" || price === "price_variant_specific") matches.push([7, "price_match"]);
  const priority = matches.length ? Math.min(...matches.map(([rank]) => rank)) : null;
  return { priority, reasons: matches.sort((left, right) => left[0] - right[0]).map(([, reason]) => reason) };
}

function targetEvidence(source, target) {
  const matches = [];
  if (String(target.id) === TARGET_NATIVE_PRODUCT_ID) return { priority: null, reasons: [] };
  if (target.externalId === plannedExternalId(source)) matches.push([1, "planned_external_id_exact"]);
  if (String(target.legacySourceSyncProductId || "") === String(source.id)) matches.push([1, "legacy_sync_product_id_exact"]);
  if (source.externalId && target.externalId && source.externalId === target.externalId) matches.push([2, "external_id_exact"]);
  if (setEquals(array(source.variants).map((variant) => variant.sku), array(target.variants).map((variant) => variant.sku), true)) matches.push([4, "sku_set_match"]);
  if (setEquals(array(source.variants).map((variant) => variant.catalogueVariantId), array(target.variants).map((variant) => variant.catalogueVariantId), true)) matches.push([5, "catalogue_variant_set_match"]);
  if (normalizeName(source.name) === normalizeName(target.name)) matches.push([6, "name_exact_normalized_weak_target_aid"]);
  if (fileSignature(source.variants) && fileSignature(source.variants) === fileSignature(target.variants)) matches.push([7, "file_mapping_match_weak_target_aid"]);
  const priority = matches.length ? Math.min(...matches.map(([rank]) => rank)) : null;
  return { priority, reasons: matches.sort((left, right) => left[0] - right[0]).map(([, reason]) => reason) };
}

function targetDisposition(target, sourceProducts) {
  if (String(target.id) === TARGET_NATIVE_PRODUCT_ID) {
    const related = sourceProducts.find((source) => String(source.id) === RELATED_LEGACY_ARTWORK_PRODUCT_ID);
    return {
      targetProductId: String(target.id), externalId: target.externalId, name: target.name, variants: target.variants, sourceProductId: null,
      relatedLegacyArtworkProductId: related ? String(related.id) : null,
      evidence: related ? sharedArtworkNames(target, related).map((name) => `shared_artwork_filename:${name}`) : [],
      catalogueIdentityComparison: related ? { targetCatalogueProductIds: catalogueProductIds(target), legacyCatalogueProductIds: catalogueProductIds(related), exact: setEquals(catalogueProductIds(target), catalogueProductIds(related), true) } : null,
      recommendation: "KEEP_TARGET_NATIVE",
    };
  }
  const selected = findTargetSource(target, sourceProducts);
  return { targetProductId: String(target.id), externalId: target.externalId, name: target.name, variants: target.variants, sourceProductId: selected.match?.id || null, relatedLegacyArtworkProductId: null, evidence: selected.evidence, recommendation: selected.match ? "MAP" : "MANUAL_REVIEW" };
}

function findTargetSource(target, sourceProducts) {
  const ranked = sourceProducts.map((source) => ({ source, evidence: targetEvidence(source, target) })).filter((entry) => Number.isSafeInteger(entry.evidence.priority) && entry.evidence.priority <= 4).sort(compareRanked);
  return selectUniqueCandidate(ranked, "source");
}

function analyzeSourceProduct(source) {
  const variants = array(source?.variants);
  const active = variants.filter((variant) => availability(variant) === "ACTIVE");
  const temporarilyOutOfStock = variants.filter((variant) => availability(variant) === "TEMPORARILY_OUT_OF_STOCK");
  const discontinued = variants.filter((variant) => availability(variant) === "DISCONTINUED");
  const ignoredActive = active.filter((variant) => variant.isIgnored === true).concat(temporarilyOutOfStock.filter((variant) => variant.isIgnored === true));
  const migrationCandidates = active.filter((variant) => variant.isIgnored !== true);
  const missingRequiredFiles = migrationCandidates.filter((variant) => migrationFiles(variant).length === 0);
  return { active, temporarilyOutOfStock, discontinued, ignoredActive, migrationCandidates, missingRequiredFiles, availability: { ACTIVE: active.length, TEMPORARILY_OUT_OF_STOCK: temporarilyOutOfStock.length, DISCONTINUED: discontinued.length } };
}

function selectionProjection(entry, source, analysis, decision, blocker) {
  return {
    decision,
    canonicalFutureLocalProductId: `product-${source.id}`,
    public: entry.public,
    publicTitle: entry.public?.title || null,
    publicSlug: entry.public?.slug || null,
    sourceProductId: String(source.id),
    legacyWixExternalProductId: source.externalId || null,
    strongIdentity: entry.strongIdentity === true,
    matchEvidence: entry.matchEvidence,
    eligibleVariantIds: analysis.migrationCandidates.map((variant) => String(variant.id)),
    excludedDiscontinuedVariantIds: analysis.discontinued.map((variant) => String(variant.id)),
    temporarilyOutOfStockVariants: analysis.temporarilyOutOfStock.map((variant) => ({ id: String(variant.id), policy: "DEFER_PENDING_TARGET_CATALOGUE_SUPPORT_VERIFICATION" })),
    prices: analysis.migrationCandidates.map((variant) => ({ legacySourceVariantId: String(variant.id), unitAmountCad: variant.unitAmountCad, currency: variant.currency })),
    artworkReadiness: analysis.missingRequiredFiles.length ? "BLOCKED" : "READY",
    targetPayloadReadiness: decision === "MIGRATE_CREATE_TARGET" && !blocker ? "READY_NOT_SENT" : "NOT_PLANNED",
    provenance: { publicationAuthority: entry.public ? "CURRENT_LIVE_WIX_PUBLIC_GET_CENSUS" : "IMMUTABLE_PRINTFUL_LEGACY_SNAPSHOT_ONLY", legacySourceProductId: String(source.id), legacyWixExternalProductId: source.externalId || null },
    blocker,
    targetPayload: null,
  };
}

function buildPlannedPayload(source, analysis = analyzeSourceProduct(source)) {
  const stableId = plannedExternalId(source);
  return {
    endpoint: "POST /store/products", send: false,
    sync_product: { external_id: stableId, name: source.name, thumbnail: source.thumbnailUrl },
    sync_variants: analysis.migrationCandidates.map((variant) => ({
      external_id: `trf-source-variant-${variant.id}`,
      variant_id: numericOrString(variant.catalogueVariantId),
      retail_price: exactRetailPrice(variant),
      sku: variant.sku || null,
      files: migrationFiles(variant).map((file) => ({ type: file.type, id: numericOrString(file.id), filename: file.filename || null, options: array(file.options) })),
      options: array(variant.options),
      migration_availability: "ACTIVE",
    })),
    deferred_variants: analysis.temporarilyOutOfStock.map((variant) => ({ legacy_source_variant_id: String(variant.id), catalogue_variant_id: variant.catalogueVariantId, policy: "VERIFY_TARGET_SUPPORT_BEFORE_ANY_FUTURE_CREATE" })),
    migrationMetadata: {
      legacySourceProductId: String(source.id), legacyExternalProductId: source.externalId || null,
      eligibleLegacyVariantIds: analysis.migrationCandidates.map((variant) => String(variant.id)),
      excludedDiscontinuedVariantIds: analysis.discontinued.map((variant) => String(variant.id)),
      temporarilyOutOfStockVariantIds: analysis.temporarilyOutOfStock.map((variant) => String(variant.id)),
      publicationAuthority: "CURRENT_LIVE_WIX_PUBLIC_GET_CENSUS",
    },
  };
}

function collectDuplicateEvidence(sourceProducts, targetProducts) {
  const sourceVariants = sourceProducts.flatMap((product) => array(product.variants).map((variant) => ({ ...variant, productId: product.id })));
  const targetVariants = targetProducts.flatMap((product) => array(product.variants).map((variant) => ({ ...variant, productId: product.id })));
  return {
    sourceProductIds: duplicateRecords(sourceProducts, "id", (product) => ({ productId: product.id, name: product.name })),
    sourceExternalIds: duplicateRecords(sourceProducts, "externalId", (product) => ({ productId: product.id, name: product.name })),
    sourceVariantIds: duplicateRecords(sourceVariants, "id", variantIdentity),
    sourceVariantExternalIds: duplicateRecords(sourceVariants, "externalId", variantIdentity),
    sourceSkus: duplicateRecords(sourceVariants, "sku", variantIdentity),
    sourceCatalogueProductIds: duplicateRecords(sourceVariants, "catalogueProductId", variantIdentity),
    sourceCatalogueVariantIds: duplicateRecords(sourceVariants, "catalogueVariantId", variantIdentity),
    targetProductIds: duplicateRecords(targetProducts, "id", (product) => ({ productId: product.id, name: product.name })),
    targetExternalIds: duplicateRecords(targetProducts, "externalId", (product) => ({ productId: product.id, name: product.name })),
    targetVariantIds: duplicateRecords(targetVariants, "id", variantIdentity),
    targetSkus: duplicateRecords(targetVariants, "sku", variantIdentity),
    targetCatalogueProductIds: duplicateRecords(targetVariants, "catalogueProductId", variantIdentity),
    targetCatalogueVariantIds: duplicateRecords(targetVariants, "catalogueVariantId", variantIdentity),
  };
}

function aggregateEvidence(sourceProducts, targetProducts) {
  return { source: aggregateProvider(sourceProducts), target: aggregateProvider(targetProducts) };
}

function aggregateProvider(products) {
  const variants = products.flatMap((product) => array(product.variants));
  return {
    products: products.length, variants: variants.length, synced: variants.filter((variant) => variant.synced === true).length,
    ignoredProducts: products.filter((product) => product.isIgnored === true).length,
    ignoredVariants: variants.filter((variant) => variant.isIgnored === true).length,
    ignoredActiveVariants: variants.filter((variant) => variant.isIgnored === true && availability(variant) !== "DISCONTINUED").length,
    availability: countAvailability(variants),
    filelessByAvailability: countAvailability(variants.filter((variant) => migrationFiles(variant, false).length === 0)),
    validPrices: variants.filter((variant) => variant.price?.status === "valid" && Number.isSafeInteger(variant.unitAmountCad)).length,
    missingPrices: variants.filter((variant) => variant.price?.status === "missing").length,
    malformedPrices: variants.filter((variant) => variant.price?.status === "malformed").length,
  };
}

function countAvailability(variants) {
  const result = { ACTIVE: 0, TEMPORARILY_OUT_OF_STOCK: 0, DISCONTINUED: 0, OTHER: 0 };
  for (const variant of variants) result[availability(variant)] += 1;
  return result;
}

function availability(variant) {
  const value = String(variant?.availabilityStatus || "").trim().toUpperCase();
  if (value === "ACTIVE") return "ACTIVE";
  if (value === "TEMPORARY_OUT_OF_STOCK" || value === "TEMPORARILY_OUT_OF_STOCK") return "TEMPORARILY_OUT_OF_STOCK";
  if (value === "DISCONTINUED") return "DISCONTINUED";
  if (!value && variant?.synced !== false) return "ACTIVE";
  return "OTHER";
}

function migrationFiles(variant, excludeNonProduction = true) {
  const files = array(variant?.files).filter((file) => file && (file.id || file.url) && file.status !== "failed");
  return excludeNonProduction ? files.filter((file) => String(file.type || "").toLowerCase() !== "preview") : files;
}

function comparePrice(publicAmount, variants) {
  const valid = array(variants).filter((variant) => variant.price?.status === "valid").map((variant) => variant.unitAmountCad);
  if (!Number.isSafeInteger(publicAmount)) return valid.length ? "printful_price_only" : "price_missing";
  if (!valid.length) return "public_price_only";
  const distinct = unique(valid);
  if (distinct.length === 1 && distinct[0] === publicAmount) return "price_exact";
  if (distinct.includes(publicAmount)) return "price_variant_specific";
  return "price_conflict";
}

function compareOptions(optionLabels = [], variants) {
  const expected = new Set(array(optionLabels).map((label) => normalizeName(label)));
  if (expected.has("size") && !array(variants).some((variant) => variant.size)) return "variant_conflict";
  if (expected.has("color") && !array(variants).some((variant) => variant.color)) return "variant_conflict";
  return "variant_structure_supported";
}

function baseMatrix(publicProduct, overrides) {
  return {
    public: { id: publicProduct.id, title: publicProduct.title, slug: publicProduct.slug, publicUrl: publicProduct.publicUrl || publicProduct.canonicalUrl, visibleUnitAmountCad: publicProduct.visibleUnitAmountCad, optionLabels: publicProduct.optionLabels, classification: publicProduct.classification },
    classification: "AMBIGUOUS", sourceClassification: "AMBIGUOUS_LIVE_MATCH", matchEvidence: [], matchPriority: null, strongIdentity: false,
    sourceMatch: null, targetMatch: null,
    priceStatus: Number.isSafeInteger(publicProduct.visibleUnitAmountCad) ? "public_price_only" : "price_missing",
    priceRangeCad: null, variantStatus: "unresolved", fileStatus: "unresolved", availability: null,
    recommendedAction: "MANUAL_REVIEW", blocker: "Strong provider identity evidence is required.", manualReview: true,
    ...overrides,
  };
}

function sourceProjection(source) { return { productId: String(source.id), externalId: source.externalId, name: source.name, variantCount: array(source.variants).length }; }
function targetProjection(target, evidence) { return { productId: String(target.id), externalId: target.externalId, name: target.name, evidence }; }
function plannedExternalId(source) { return `trf-source-product-${source.id}`; }

function exactRetailPrice(variant) {
  if (variant.price?.status !== "valid" || !Number.isSafeInteger(variant.unitAmountCad) || String(variant.currency).toUpperCase() !== "CAD") throw new Error(`Invalid CAD price for source variant ${variant.id}.`);
  return `${Math.floor(variant.unitAmountCad / 100)}.${String(variant.unitAmountCad % 100).padStart(2, "0")}`;
}

function priceRange(variants) {
  const prices = array(variants).filter((variant) => variant.price?.status === "valid").map((variant) => variant.unitAmountCad);
  return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
}

function variantStructureMatches(optionLabels, variants) { return array(optionLabels).length > 0 && compareOptions(optionLabels, variants) === "variant_structure_supported" && array(variants).length > 0; }

function fileSignature(variants) {
  const values = array(variants).flatMap((variant) => migrationFiles(variant).map((file) => `${normalizeName(file.type)}:${normalizeName(file.filename)}`)).filter((value) => value !== ":").sort();
  return values.length ? values.join("|") : "";
}

function filesCorrelate(images, variants) {
  const publicNames = compact(images).map((value) => decodeURIComponent(String(value).split(/[\\/]/).pop().split("?")[0])).filter(Boolean);
  if (!publicNames.length) return false;
  const providerNames = array(variants).flatMap((variant) => migrationFiles(variant).map((file) => file.filename)).filter(Boolean);
  return publicNames.some((name) => providerNames.includes(name));
}

function sharedArtworkNames(leftProduct, rightProduct) {
  const left = new Set(array(leftProduct.variants).flatMap((variant) => migrationFiles(variant).map((file) => normalizeName(file.filename))).filter(Boolean));
  const right = new Map(array(rightProduct.variants).flatMap((variant) => migrationFiles(variant).map((file) => [normalizeName(file.filename), file.filename])).filter(([name]) => name));
  return [...left].filter((name) => right.has(name)).map((name) => right.get(name)).sort();
}

function catalogueProductIds(product) { return unique(array(product.variants).map((variant) => String(variant.catalogueProductId || "")).filter(Boolean)).sort(compareIds); }

function setEquals(left, right, requireNonEmpty = false) {
  const leftSet = new Set(compact(left)); const rightSet = new Set(compact(right));
  if (requireNonEmpty && (!leftSet.size || !rightSet.size)) return false;
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function duplicateRecords(records, field, projection) {
  const grouped = new Map();
  for (const record of records) {
    const value = record?.[field];
    if (value === null || value === undefined || !String(value).trim()) continue;
    const key = String(value); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(projection(record));
  }
  return [...grouped.entries()].filter(([, matches]) => matches.length > 1).map(([value, matches]) => ({ value, count: matches.length, records: matches })).sort((left, right) => compareIds(left.value, right.value));
}

function variantIdentity(variant) { return { productId: String(variant.productId), variantId: String(variant.id), externalId: variant.externalId || null, sku: variant.sku || null, availabilityStatus: availability(variant), ignored: variant.isIgnored === true }; }
function compact(values) { return array(values).filter((value) => value !== null && value !== undefined && String(value).trim()).map((value) => String(value)); }
function unique(values) { return [...new Set(values)]; }
function array(value) { return Array.isArray(value) ? value : []; }

function normalizeName(value) {
  return String(value || "").normalize("NFKD").replace(/(?:â„¢|â€™|â€œ|â€|™|®|©)/g, "").replace(/[^a-z0-9]+/gi, " ").trim().replace(/\s+/g, " ").toLowerCase();
}

function compareRanked(left, right) { return left.evidence.priority - right.evidence.priority || compareIds(left.source?.id ?? left.target?.id, right.source?.id ?? right.target?.id); }
function compareMatrixEntries(left, right) { if (Boolean(left.public) !== Boolean(right.public)) return left.public ? -1 : 1; return compareIds(left.public?.slug || `~${left.sourceMatch?.productId || ""}`, right.public?.slug || `~${right.sourceMatch?.productId || ""}`); }
function compareSelectionEntries(left, right) { return compareIds(left.public?.slug || left.sourceProductId || `target-${left.targetProductId}`, right.public?.slug || right.sourceProductId || `target-${right.targetProductId}`); }
function compareIds(left, right) { return String(left ?? "").localeCompare(String(right ?? ""), "en", { numeric: true }); }
function numericOrString(value) { const number = Number(value); return Number.isSafeInteger(number) && String(number) === String(value) ? number : value; }

export { analyzeSourceProduct, buildPlannedPayload, normalizeName };
