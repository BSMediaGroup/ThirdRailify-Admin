import { storefrontEligibility, protectedTestProduct } from "./storefront-eligibility.js";
import { transactionGuard } from "./commerce-transaction-guards.js";

// Scoped operational repair. Never changes visibility, sellability, prices, media,
// weights, payment configuration or immutable order snapshots.
export function catalogueEnvironmentRepairStatements(db, product, variants, snapshot, timestamp) {
  const metadata = JSON.parse(product.safe_metadata_json || "{}");
  const provenance = JSON.parse(product.migration_provenance_json || "{}");
  const provider = snapshot.products.find(p => p.id === product.target_printful_product_id);
  const eligibility = storefrontEligibility(product, variants, snapshot.store.id);
  if (snapshot.store.id !== "18668025" || snapshot.store.type !== "native" || !provider ||
      product.checkout_environment !== "test" || !eligibility.displayable || protectedTestProduct(product) ||
      metadata.saleRestriction?.enabled || metadata.publicationIntent !== "operator_publish" ||
      provenance.contract !== "printful-v1-sync-products" || provenance.storeId !== snapshot.store.id ||
      provenance.syncProductId !== provider.id || !variants.every(v => v.provider_presence !== "current" || provider.variants.some(p => p.id === v.target_printful_sync_variant_id && p.catalogueVariantId === v.target_catalogue_variant_id))) {
    throw new Error("catalogue_environment_repair_evidence_invalid");
  }
  const statements = [];
  for (const [table, row] of [["commerce_products", product], ...variants.map(v => ["commerce_product_variants", v])]) {
    const entries = Object.entries(row);
    statements.push(transactionGuard(db, `EXISTS(SELECT 1 FROM ${table} WHERE ${entries.map(([k]) => `${k} IS ?`).join(" AND ")})`, entries.map(([,v]) => v)));
  }
  statements.push(db.prepare("UPDATE commerce_products SET checkout_environment='live',updated_at=? WHERE id=?").bind(timestamp, product.id));
  const audit = { before: { environment: "test", status: product.status, visibility: product.visibility }, after: { environment: "live" }, providerStoreId: snapshot.store.id, providerProductId: provider.id, snapshotFingerprint: snapshot.fingerprint, variantIds: variants.map(v => v.id), reason: "published_native_catalogue_environment_mismatch" };
  statements.push(db.prepare("INSERT INTO commerce_audit(id,actor_account_id,action,target_type,target_id,result,metadata_json,created_at) VALUES (?,NULL,'commerce.catalogue_environment_repaired','commerce_product',?,'success',?,?)").bind(`environment-repair-${crypto.randomUUID()}`, product.id, JSON.stringify(audit), timestamp));
  return statements;
}
