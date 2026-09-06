import { AuthFailure } from "./auth-core.js";
import { requireCommerceDb, merchandisingProductsPayload, filterMerchandisingProducts, normalizeProductListOptions } from "./commerce-core.js";
import { storefrontEligibility } from "./storefront-eligibility.js";
import { CATALOGUE_AUTHORITY_SQL } from "./commerce-transaction-guards.js";

export async function catalogueSellabilityReview(env, scope = { kind: "all_current" }, session = null, page = 1, group = "enable") {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || !["all_current", "selected", "matching"].includes(scope.kind) || Object.keys(scope).some(k => !["kind", ...(scope.kind === "selected" ? ["productIds"] : scope.kind === "matching" ? ["matching"] : [])].includes(k))) throw new AuthFailure(400, "catalogue_scope_invalid", "Choose selected, matching or all current products.");
  const db = requireCommerceDb(env);
  const fingerprint = (await db.prepare(CATALOGUE_AUTHORITY_SQL).first()).fingerprint;
  const [products, variants] = await Promise.all([db.prepare("SELECT * FROM commerce_products ORDER BY id").all(), db.prepare("SELECT * FROM commerce_product_variants ORDER BY product_id,id").all()]);
  let selected = products.results.filter(p => p.provider_presence === "current").map(p => p.id);
  if (scope.kind === "selected") {
    if (!Array.isArray(scope.productIds) || !scope.productIds.length || scope.productIds.length > 1000 || new Set(scope.productIds).size !== scope.productIds.length || scope.productIds.some(id => typeof id !== "string" || !products.results.some(p => p.id === id))) throw new AuthFailure(400, "catalogue_selection_invalid", "Select existing product identifiers (maximum 1000).");
    selected = scope.productIds;
  }
  if (scope.kind === "matching") {
    if (!scope.matching || typeof scope.matching !== "object" || Array.isArray(scope.matching) || Object.keys(scope.matching).some(k => !["query","visibility","status","migration","category","featured","catalogue","sort"].includes(k)) || Object.values(scope.matching).some(v => typeof v !== "string")) throw new AuthFailure(400, "catalogue_filters_invalid", "Review valid Products filters.");
    selected = filterMerchandisingProducts((await merchandisingProductsPayload(env, session)).products, normalizeProductListOptions(scope.matching)).map(p => p.id);
  }
  const selectedSet = new Set(selected), byProduct = new Map();
  for (const v of variants.results) { if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []); byProduct.get(v.product_id).push(v); }
  const groups = { enable: [], disable: [], correct: [], unpublished: [], blockers: [] };
  const counts = { currentProducts: 0, currentVariants: 0, totalVariants: variants.results.length, eligibleVariants: 0, eligibleSellableVariants: 0, eligibleNeedingEnablement: 0, ineligibleSellableVariants: 0, excludedUnavailableVariants: 0, intentionallyUnpublishedProducts: 0, intentionallyUnpublishedVariants: 0, dataBlockedVariants: 0, sellableVariants: 0, blockedVariants: 0 };
  for (const p of products.results) {
    const rows = byProduct.get(p.id) || [], diagnostic = storefrontEligibility(p, rows, env.PRINTFUL_STORE_ID);
    if (p.provider_presence === "current") counts.currentProducts++;
    const hiddenProduct = p.provider_presence === "current" && !p.archived_at && diagnostic.productPublicationReasons.length > 0;
    if (hiddenProduct) counts.intentionallyUnpublishedProducts++;
    if (!rows.length && p.provider_presence === "current") groups.blockers.push({ productId: p.id, variantId: null, label: p.title, reasons: [...diagnostic.productReasons, "no_variants"], href: `/products?productId=${encodeURIComponent(p.id)}` });
    for (const v of rows) {
      const d = diagnostic.variants.find(row => row.id === v.id);
      const reasons = [...diagnostic.productReasons, ...d.reasons];
      const publicationReasons = [...diagnostic.productPublicationReasons, ...d.localReasons.filter(r => r !== "variant_not_enabled")];
      const eligible = !reasons.length && !publicationReasons.length;
      const row = { productId: p.id, variantId: v.id, label: [p.title, v.size_label, v.color_label, v.sku].filter(Boolean).join(" / "), reasons: [...new Set([...reasons, ...publicationReasons])], href: `/products?productId=${encodeURIComponent(p.id)}&variantId=${encodeURIComponent(v.id)}` };
      if (p.provider_presence === "current" && v.provider_presence === "current") counts.currentVariants++;
      if (v.is_sellable === 1) counts.sellableVariants++;
      if (eligible) {
        counts.eligibleVariants++;
        if (v.is_sellable === 1) { counts.eligibleSellableVariants++; groups.correct.push({ ...row, reasons: ["eligible_already_sellable"] }); }
        else { counts.eligibleNeedingEnablement++; if (selectedSet.has(p.id)) groups.enable.push({ ...row, reasons: ["eligible_not_sellable"] }); }
      } else {
        counts.blockedVariants++;
        if (v.is_sellable === 1) { counts.ineligibleSellableVariants++; groups.disable.push(row); }
        else { counts.excludedUnavailableVariants++; groups.correct.push({ ...row, reasons: [...row.reasons, "excluded_already_unavailable"] }); }
        if (p.provider_presence === "current" && !p.archived_at && publicationReasons.length) { counts.intentionallyUnpublishedVariants++; groups.unpublished.push({ ...row, reasons: publicationReasons }); }
        if (p.provider_presence === "current" && !p.archived_at && reasons.length) { counts.dataBlockedVariants++; groups.blockers.push(row); }
      }
    }
  }
  if (!Number.isSafeInteger(page) || page < 1 || !Object.hasOwn(groups, group)) throw new AuthFailure(400, "catalogue_page_invalid", "Choose a valid diagnostics group and page.");
  if ((await db.prepare(CATALOGUE_AUTHORITY_SQL).first()).fingerprint !== fingerprint) throw new AuthFailure(409, "catalogue_refresh_required", "Catalogue changed. Refresh the review.");
  const digest = await catalogueReviewDigest(fingerprint, env, scope);
  const result = { ok: true, digest, scope, counts, selectedProducts: selected.length, enable: groups.enable.length, disable: groups.disable.length, disableOutsideScope: groups.disable.filter(r => !selectedSet.has(r.productId)).length, groups: Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.length])), diagnostics: { group, page, pageSize: 20, total: groups[group].length, rows: groups[group].slice((page - 1) * 20, page * 20) } };
  Object.defineProperties(result, { fingerprint: { value: fingerprint }, enableIds: { value: groups.enable.map(r => r.variantId) }, disableIds: { value: groups.disable.map(r => r.variantId) } });
  return result;
}
export function catalogueReviewDigest(fingerprint, env, scope) { return hash({ fingerprint, storeId: env.PRINTFUL_STORE_ID || null, scope }); }
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map(b => b.toString(16).padStart(2, "0")).join(""); }
