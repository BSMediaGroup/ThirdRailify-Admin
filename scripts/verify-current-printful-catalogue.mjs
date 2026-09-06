import { readFile } from "node:fs/promises";
import { previewCurrentCatalogueReconciliation, readCurrentPrintfulSnapshot } from "../functions/_shared/current-catalogue-reconciliation.js";

const fileEnvironment = await loadEnvironment(new URL("../.env", import.meta.url));
const environment = { ...fileEnvironment, ...process.env };
if (process.argv.includes("--legacy-preview")) await printLegacyPreview(environment);
else {
  const snapshot = await readCurrentPrintfulSnapshot(environment);
  console.log(JSON.stringify({
    ok: true,
    method: "GET only",
    store: snapshot.store,
    counts: snapshot.counts,
    fingerprint: snapshot.fingerprint,
    retrievedAt: snapshot.retrievedAt,
    ...(process.argv.includes("--images") ? { images: await imageEvidence(snapshot) } : {}),
  }, null, 2));
}

async function imageEvidence(snapshot) {
  const products = snapshot.products;
  const results = [];
  for (const product of products) {
    const url = product.images[0];
    let resource = { status: null, imageContentType: false };
    if (url) {
      try {
        const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15000) });
        resource = { status: response.status, imageContentType: /^image\//.test(response.headers.get("content-type") || "") };
        await response.body?.cancel();
      } catch { resource = { status: "unavailable", imageContentType: false }; }
    }
    results.push({ syncProductId: product.id, title: product.name,
      linkedPreviewThumbnail: product.imageSelection.sources.includes("sync_product_thumbnail"),
      attachedPreviewCount: new Set(product.variants.flatMap((variant) => variant.customerPreviewUrls)).size,
      thumbnailReviewRequired: product.imageSelection.thumbnailReviewRequired,
      catalogueCandidatesRejected: product.imageSelection.catalogueCandidatesRejected,
      coverage: product.imageSelection.completeness,
      selectedSource: product.imageSelection.primarySource, selectedHost: url ? new URL(url).hostname : null,
      transportCheckOnly: resource, visualMerchantArtworkVerified: false });
  }
  return results;
}

async function printLegacyPreview(providerEnvironment) {
  const [{ createCommerceDatabases, commerceEnvironment, importPermanentCatalogue }, { default: manifest }] = await Promise.all([
    import("../tests/commerce-test-helpers.mjs"),
    import("../commerce-import/permanent-catalogue-import.json", { with: { type: "json" } }),
  ]);
  const harness = await createCommerceDatabases();
  try {
    await importPermanentCatalogue(harness.commerceDb, manifest);
    const result = await previewCurrentCatalogueReconciliation(
      commerceEnvironment(harness, providerEnvironment),
      { accountId: "local-preview", access: { isMasterAdmin: true } },
    );
    console.log(JSON.stringify({
      ok: true,
      method: "GET only; ephemeral local D1 preview",
      localBaseline: { products: manifest.products.length, variants: manifest.variants.length },
      store: result.authority.store,
      snapshot: result.snapshot,
      counts: result.counts,
      changes: result.changes,
      blockers: result.blockers,
      unusualReduction: result.unusualReduction,
      confirmationText: result.confirmationText,
      planDigest: result.planDigest,
    }, null, 2));
  } finally {
    await harness.dispose();
  }
}

async function loadEnvironment(url) {
  let source;
  try { source = await readFile(url, "utf8"); } catch { return {}; }
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return result;
}
