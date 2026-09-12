// One stored-state result for Admin diagnostics and customer projections.
// Global payment/fulfillment settings deliberately do not participate in display.
export function storefrontEligibility(product, variants, storeId, { environment = "live", shippingStrategy = null, weights = [] } = {}) {
  const metadata = parse(product.safe_metadata_json);
  const current = product.provider_presence === "current";
  const productReasons = [];
  if (!current) productReasons.push("provider_not_current");
  if (!storeId || product.provider_store_id !== String(storeId)) productReasons.push("wrong_store");
  if (product.archived_at) productReasons.push("archived");
  if (!validProviderId(product.target_printful_product_id)) productReasons.push("product_mapping_missing");
  if (product.requires_shipping !== 1) productReasons.push("unsupported_fulfillment");
  if (metadata.providerCatalogue?.ignored) productReasons.push("product_ignored");
  if (product.provider_reconciliation_status !== "current") productReasons.push("provider_review_required");
  if (!metadata.publicImage) productReasons.push("mockup_unavailable");
  if (product.currency_code !== "CAD") productReasons.push("product_currency_invalid");
  const rows = variants.map((variant) => {
    const reasons = [];
    if (variant.provider_presence !== "current") reasons.push("provider_not_current");
    if (variant.provider_store_id !== String(storeId)) reasons.push("wrong_store");
    if (variant.archived_at) reasons.push("archived");
    if (variant.is_ignored !== 0) reasons.push("ignored");
    if (variant.availability_status !== "active") reasons.push("provider_unavailable");
    if (variant.currency_code !== "CAD" || !Number.isSafeInteger(variant.unit_amount) || variant.unit_amount <= 0 || variant.unit_amount > 100_000_000) reasons.push("invalid_cad_price");
    if (variant.fulfillment_provider !== "printful") reasons.push("unsupported_fulfillment");
    if (!validProviderId(variant.target_printful_sync_variant_id) || !validProviderId(variant.target_catalogue_variant_id) || !validProviderId(variant.target_printful_product_id) || variant.target_printful_product_id !== product.target_printful_product_id || variant.fulfillment_mapping_status !== "mapped") reasons.push("mapping_invalid");
    const localReasons = [];
    if (variant.status !== "active") localReasons.push("variant_disabled");
    if (variant.visibility !== "public") localReasons.push("variant_private");
    if (parse(variant.safe_metadata_json).publicationIntent === "operator_hidden") localReasons.push("variant_hidden_by_operator");
    if (variant.is_sellable !== 1) localReasons.push("variant_not_enabled");
    return { id: variant.id, eligible: reasons.length === 0, published: reasons.length === 0 && localReasons.length === 0, reasons, localReasons, publicationIntent: parse(variant.safe_metadata_json).publicationIntent || "unknown" };
  });
  const localReasons = [];
  if (product.status !== "active") localReasons.push("product_disabled");
  if (product.visibility !== "public") localReasons.push("product_private");
  if (metadata.publicationIntent === "operator_hidden") localReasons.push("product_hidden_by_operator");
  const productPublicationReasons = [...localReasons];
  if (!rows.some((v) => v.published)) localReasons.push("no_enabled_variants");
  const exclusions = {};
  for (const v of rows) for (const reason of [...v.reasons, ...v.localReasons]) exclusions[reason] = (exclusions[reason] || 0) + 1;
  const purchaseReasons = [];
  if (product.checkout_environment !== environment) purchaseReasons.push("checkout_environment_mismatch");
  if (metadata.saleRestriction?.enabled === true) purchaseReasons.push("display_only");
  if (protectedTestProduct(product)) purchaseReasons.push("deliberate_test_product");
  for (const row of rows) {
    const override = weights.find(w => w.variant_id === row.id && w.weight_mg !== null);
    const weight = override || weights.find(w => w.product_id === product.id && w.variant_id === null && w.weight_mg !== null);
    row.shipping = { policy: shippingStrategy, weightMg: weight?.weight_mg ?? null, source: override ? "variant_override" : weight ? "product_default" : "unknown", provenance: weight?.provenance || null,
      ready: shippingStrategy === "printful_dynamic" || (shippingStrategy === "merchant_weight_bands" && Number.isSafeInteger(weight?.weight_mg) && weight.weight_mg > 0),
      reasons: shippingStrategy === "merchant_weight_bands" && !weight ? ["shipping_item_weight_missing"] : shippingStrategy ? [] : ["shipping_policy_unknown"] };
    row.purchaseReasons = [...productReasons, ...productPublicationReasons, ...row.reasons, ...row.localReasons, ...purchaseReasons];
    row.purchasable = row.purchaseReasons.length === 0;
    row.quoteAvailability = "not_quoted";
  }
  return { displayable: productReasons.length === 0 && localReasons.length === 0, canPublish: productReasons.length === 0 && !protectedTestProduct(product) && rows.some((v) => v.eligible), purchasable: rows.some(v => v.purchasable), purchaseReasons, shippingPolicy: shippingStrategy, quoteAvailability: "not_quoted", reasons: [...productReasons, ...localReasons], productReasons, productPublicationReasons, currentVariants: variants.filter((v) => v.provider_presence === "current").length, eligibleVariants: rows.filter((v) => v.eligible).length, publicVariants: rows.filter((v) => v.published).length, exclusions, variants: rows, publicationIntent: metadata.publicationIntent || "unknown" };
}
export function protectedTestProduct(product) {
  const metadata = parse(product.safe_metadata_json);
  return metadata.testFixture === true || metadata.sandbox === true || metadata.checkoutEnvironmentLocked === "test";
}
// Same decimal identifier contract as shipping-core; a numeric prefix is insufficient.
export function validProviderId(value) { return typeof value === "string" && /^[1-9]\d{0,18}$/.test(value); }
function parse(value) { try { const parsed = JSON.parse(value || "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
