import { AuthFailure, nowIso, randomId } from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";
import { readCurrentPrintfulSnapshot, desiredProductImages, providerMetadata } from "./current-catalogue-reconciliation.js";
import { ingestCommerceProductMedia } from "./commerce-media.js";
import { storefrontEligibility } from "./storefront-eligibility.js";
import { imageList } from "./commerce-image-authority.js";
import { transactionGuard } from "./commerce-transaction-guards.js";
import { publicCataloguePayload } from "./public-catalogue.js";

const fail = (code, message) => { throw new AuthFailure(409, code, message); };
const parse = (value) => { try { return JSON.parse(value || "{}"); } catch { return {}; } };
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

export async function previewCurrentProductRepair(env, session, input, fetchImpl = fetch, runtime = {}) {
  if (!input || Object.keys(input).some((k) => !["kind", "productIds", "restoreOverride", "approvedThumbnailIds"].includes(k)) || !["media", "publication"].includes(input.kind) || !Array.isArray(input.productIds) || input.productIds.length < 1 || input.productIds.length > 20 || input.productIds.some((id) => typeof id !== "string" || id.length > 160) || new Set(input.productIds).size !== input.productIds.length || (input.restoreOverride !== undefined && typeof input.restoreOverride !== "boolean") || (input.approvedThumbnailIds !== undefined && (!Array.isArray(input.approvedThumbnailIds) || input.approvedThumbnailIds.length > 20 || input.approvedThumbnailIds.some((id) => !input.productIds.includes(id))))) fail("repair_input_invalid", "Select 1–20 current products and a repair type.");
  const db = requireCommerceDb(env);
  const snapshot = await readCurrentPrintfulSnapshot(env, fetchImpl, runtime);
  const plan = await buildPlan(db, snapshot, input);
  const id = `ccr_${randomId()}`, timestamp = nowIso();
  const preview = { ok: true, runId: id, kind: input.kind, approvedThumbnailIds: input.approvedThumbnailIds || [], confirmationText: `APPLY ${input.kind.toUpperCase()} ${input.productIds.length}`, snapshotFingerprint: snapshot.fingerprint, store: snapshot.store, counts: snapshot.counts, retrievedAt: snapshot.retrievedAt, input, digest: plan.digest, products: plan.products, changes: plan.products.filter((p) => p.changesRequired).length, blockers: plan.products.filter((p) => p.blockers.length).map((p) => ({ id: p.id, reasons: p.blockers })) };
  await db.prepare(`INSERT INTO commerce_catalogue_reconciliation_runs (id,state,provider_store_id,provider_store_name,provider_store_type,provider_contract,provider_snapshot_hash,provider_product_count,provider_variant_count,confirmation_text,unusual_reduction,preview_json,actor_account_id,previewed_at,created_at,updated_at) VALUES (?,'previewed',?,?,?,?,?,?,?,?,0,?,?,?,?,?)`).bind(id, snapshot.store.id, snapshot.store.name, snapshot.store.type, "printful-v1-sync-products", snapshot.fingerprint, snapshot.counts.products, snapshot.counts.variants, preview.confirmationText, JSON.stringify(preview), session.accountId, timestamp, timestamp, timestamp).run();
  return preview;
}

export async function applyCurrentProductRepair(env, session, input, fetchImpl = fetch, runtime = {}) {
  if (!input || Object.keys(input).some((k) => !["runId", "confirmation"].includes(k)) || !/^ccr_[\w-]{20,}$/.test(input.runId || "")) fail("repair_input_invalid", "A repair preview is required.");
  const db = requireCommerceDb(env);
  const run = await db.prepare("SELECT * FROM commerce_catalogue_reconciliation_runs WHERE id=?").bind(input.runId).first();
  if (!run || run.state !== "previewed" || !["media", "publication"].includes(parse(run.preview_json).kind) || run.confirmation_text !== input.confirmation || run.actor_account_id !== session.accountId) fail("repair_preview_invalid", "Review your repair Preview and its exact confirmation.");
  const preview = parse(run.preview_json);
  const snapshot = await readCurrentPrintfulSnapshot(env, fetchImpl, runtime);
  const plan = await buildPlan(db, snapshot, preview.input);
  if (snapshot.fingerprint !== run.provider_snapshot_hash || plan.digest !== preview.digest) fail("repair_state_changed", "Provider or local state changed. Preview again.");
  if (plan.products.some((p) => p.blockers.length)) fail("repair_blocked", "Resolve the per-product exclusions before applying.");
  const claim = await db.prepare("UPDATE commerce_catalogue_reconciliation_runs SET state='applying' WHERE id=? AND state='previewed'").bind(run.id).run();
  if (claim.meta.changes !== 1) fail("repair_claim_failed", "This Preview has already been used.");
  try {
    // All asset staging completes before any active media references change.
    if (preview.kind === "media") for (const row of plan.rows) {
      const urls = [...new Set([...row.desired.images, ...row.provider.variants.flatMap((v) => v.customerPreviewUrls.slice(0, 1))])];
      if (urls.length > 25) fail("repair_media_limit", "This product exceeds the bounded media repair limit.");
      const media = urls.length ? await ingestCommerceProductMedia(env, session, row.product.id, { imageUrls: urls }, fetchImpl) : { assets: [] };
      row.assets = media.assets.map((asset, i) => ({ ...asset, sourceUrl: urls[i], sourceClass: row.metadata.providerAssets?.find((a) => a.sourceUrl === urls[i])?.sourceClass || (preview.input.approvedThumbnailIds?.includes(row.product.id) && row.provider.imageSelection.thumbnailCandidate === urls[i] ? "merchant_thumbnail" : row.provider.images.includes(urls[i]) || row.provider.variants.some((v) => v.customerPreviewUrls.includes(urls[i])) ? "merchant_preview" : "editorial") }));
    }
    if ((await buildPlan(db, snapshot, preview.input)).digest !== plan.digest) fail("repair_state_changed", "Local state changed during staging. Preview again.");
    const timestamp = nowIso(), statements = [];
    for (const row of plan.rows) {
      for (const [table, record] of [["commerce_products", row.product], ...row.variants.map((v) => ["commerce_product_variants", v])]) {
        const entries = Object.entries(record);
        statements.push(transactionGuard(db, `EXISTS (SELECT 1 FROM ${table} WHERE ${entries.map(([key]) => `${key} IS ?`).join(" AND ")})`, entries.map(([, value]) => value)));
      }
      statements.push(transactionGuard(db, "(SELECT COUNT(*) FROM commerce_product_variants WHERE product_id=?)=?", [row.product.id, row.variants.length]));
    }
    let changedProducts = 0;
    for (const row of plan.rows) {
      const { product, variants, provider } = row;
      if (preview.kind === "publication") {
        const ids = row.diagnostic.variants.filter((v) => v.eligible).map((v) => v.id);
        if (product.status === "active" && product.visibility === "public" && row.metadata.publicationIntent === "operator_publish" && variants.filter((v) => ids.includes(v.id)).every((v) => v.status === "active" && v.visibility === "public" && v.is_sellable === 1 && parse(v.safe_metadata_json).publicationIntent === "operator_publish")) continue;
        statements.push(db.prepare("UPDATE commerce_products SET status='active',visibility='public',safe_metadata_json=?,updated_at=? WHERE id=?").bind(JSON.stringify({ ...row.metadata, publicationIntent: "operator_publish" }), timestamp, product.id));
        for (const v of variants.filter((v) => ids.includes(v.id))) statements.push(db.prepare("UPDATE commerce_product_variants SET status='active',visibility='public',is_sellable=1,safe_metadata_json=?,updated_at=? WHERE id=?").bind(JSON.stringify({ ...parse(v.safe_metadata_json), publicationIntent: "operator_publish" }), timestamp, v.id));
        changedProducts += 1;
      } else {
        const mapped = (url) => row.assets.find((asset) => asset.sourceUrl === url)?.url || null;
        const images = [...new Set(row.desired.images.map(mapped).filter(Boolean))];
        const authority = { ...row.desired.authority };
        if (authority.version === 2) for (const key of ["manualImages", "order", "excludedProviderImages"]) authority[key] = (authority[key] || []).map((url) => mapped(url) || url);
        const metadata = { ...row.metadata, publicImage: images[0] || null, publicImages: images.slice(1), imageAuthority: authority, providerAssets: row.assets, providerCatalogue: providerMetadata(snapshot.store, provider, snapshot.fingerprint) };
        if (JSON.stringify(metadata).length > 16384) fail("repair_metadata_limit", "The staged media provenance exceeds the product metadata limit; reduce the selected gallery.");
        const variantUpdates = variants.map((v) => { const pv = provider.variants.find((p) => p.id === v.target_printful_sync_variant_id); return { v, metadata: { ...parse(v.safe_metadata_json), providerImage: mapped(pv?.customerPreviewUrls[0]) || null, providerImageSource: pv?.customerPreviews[0] || null } }; });
        const changed = JSON.stringify(metadata) !== JSON.stringify(row.metadata) || variantUpdates.some(({ v, metadata: m }) => JSON.stringify(m) !== v.safe_metadata_json);
        if (changed) {
          changedProducts += 1;
          statements.push(db.prepare("UPDATE commerce_products SET safe_metadata_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(metadata), timestamp, product.id));
          for (const { v, metadata: m } of variantUpdates) statements.push(db.prepare("UPDATE commerce_product_variants SET safe_metadata_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(m), timestamp, v.id));
        }
      }
    }
    const result = { ok: true, kind: preview.kind, changedProducts, productIds: preview.input.productIds, appliedAt: timestamp };
    statements.push(db.prepare("UPDATE commerce_catalogue_reconciliation_runs SET state='applied',result_json=?,applied_at=?,updated_at=? WHERE id=?").bind(JSON.stringify(result), timestamp, timestamp, run.id));
    // Preview retains the former image references for recovery; immutable objects are never deleted.
    await db.batch(statements);
    if (preview.kind === "publication") {
      const projection = await publicCataloguePayload(env);
      return { ...result, projection: { verified: preview.input.productIds.every((id) => projection.products.some((p) => p.id === id)), products: projection.products.filter((p) => preview.input.productIds.includes(p.id)).map((p) => ({ id: p.id, publicVariants: p.variants.length, featured: p.featured })), checkoutEnabled: projection.checkoutEnabled } };
    }
    return result;
  } catch (error) {
    await db.prepare("UPDATE commerce_catalogue_reconciliation_runs SET state='failed',updated_at=? WHERE id=? AND state='applying'").bind(nowIso(), run.id).run();
    throw error;
  }
}

async function buildPlan(db, snapshot, input) {
  const rows = [];
  for (const id of input.productIds) {
    const product = await db.prepare("SELECT * FROM commerce_products WHERE id=?").bind(id).first();
    if (!product || product.provider_presence !== "current" || product.provider_store_id !== snapshot.store.id || product.archived_at) fail("repair_product_not_current", "Every selection must be a current product in the configured store.");
    const provider = snapshot.products.find((p) => p.id === product.target_printful_product_id);
    if (!provider) fail("repair_provider_missing", "The selected product is absent from the complete current provider snapshot.");
    const variants = (await db.prepare("SELECT * FROM commerce_product_variants WHERE product_id=? ORDER BY id").bind(id).all()).results;
    const metadata = parse(product.safe_metadata_json);
    const desired = desiredProductImages({ metadata: input.restoreOverride ? { ...metadata, imageAuthority: null } : metadata }, provider, snapshot);
    if (input.kind === "media" && input.approvedThumbnailIds?.includes(id)) {
      const thumbnail = provider.imageSelection.thumbnailCandidate;
      if (!thumbnail) fail("repair_thumbnail_missing", "The current product has no thumbnail to review.");
      desired.images = [...new Set([thumbnail, ...desired.images])].slice(0, 25);
      desired.authority = { ...desired.authority, kind: "editorial_override", version: 2, source: "admin_reviewed_provider_thumbnail", primaryLocked: true, manualImages: [...new Set([thumbnail, ...(desired.authority.manualImages || [])])] };
    }
    const diagnostic = storefrontEligibility(product, variants, snapshot.store.id);
    if (provider.isIgnored) diagnostic.productReasons.push("fresh_provider_product_ignored");
    for (const v of diagnostic.variants) {
      const local = variants.find((row) => row.id === v.id), pv = provider.variants.find((row) => row.id === local.target_printful_sync_variant_id);
      if (!pv || !pv.synced || pv.isIgnored || pv.availabilityStatus !== "active" || pv.currency !== "CAD" || !pv.unitAmount || pv.catalogueVariantId !== local.target_catalogue_variant_id || pv.catalogueProductId !== local.target_catalogue_product_id) { v.eligible = false; v.reasons.push("fresh_provider_variant_invalid"); }
    }
    diagnostic.eligibleVariants = diagnostic.variants.filter((v) => v.eligible).length;
    const blockers = input.kind === "media" ? (!provider.images.length ? ["mockup_unavailable"] : metadata.imageAuthority?.kind === "editorial_override" && metadata.imageAuthority.version !== 2 && !input.restoreOverride ? ["legacy_override_intent_unknown_choose_restore_or_preserve"] : []) : [...diagnostic.productReasons, ...(!diagnostic.variants.some((v) => v.eligible) ? ["no_eligible_variants"] : [])];
    const plannedImages = desired.images.map((url) => metadata.providerAssets?.find((asset) => asset.sourceUrl === url)?.url || url);
    const changesRequired = input.kind === "media" ? metadata.providerCatalogue?.normalizerVersion !== 2 || JSON.stringify(imageList(metadata)) !== JSON.stringify([...new Set(plannedImages)]) || variants.some((v) => {
      const pv = provider.variants.find((p) => p.id === v.target_printful_sync_variant_id);
      const expected = metadata.providerAssets?.find((asset) => asset.sourceUrl === pv?.customerPreviewUrls[0])?.url || null;
      return parse(v.safe_metadata_json).providerImage !== expected;
    }) : product.status !== "active" || product.visibility !== "public" || diagnostic.variants.some((v) => v.eligible && !v.published);
    rows.push({ product, variants, metadata, provider, desired, diagnostic, blockers, changesRequired });
  }
  return { rows, digest: await hash(rows.map(({ product, variants }) => ({ product, variants }))), products: rows.map((row) => ({ id: row.product.id, title: row.product.title, providerProductId: row.provider.id, beforeImages: imageList(row.metadata), beforeVariantImages: row.variants.map((v) => ({ id: v.id, image: parse(v.safe_metadata_json).providerImage || null })), selectedImages: row.desired.images, preservedImages: imageList(row.metadata).filter((url) => row.desired.images.includes(url) || row.metadata.providerAssets?.some((a) => a.url === url && row.desired.images.includes(a.sourceUrl))), authority: row.desired.authority, changesRequired: row.changesRequired, thumbnailReviewRequired: row.provider.imageSelection.thumbnailReviewRequired, thumbnailCandidate: row.provider.imageSelection.thumbnailCandidate, rejectedCatalogueImages: row.provider.imageSelection.catalogueCandidatesRejected, completeness: row.provider.imageSelection.completeness, diagnostic: row.diagnostic, blockers: row.blockers })) };
}
