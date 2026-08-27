import { adminApi } from "../auth/client";

export type CommerceStatus = "unavailable" | "setup_required" | "pending" | "connected" | "restricted" | "disabled" | "error" | "legacy_production" | "deferred";
export type CommerceCapability = "commerce.view" | "commerce.business.manage" | "commerce.payments.manage" | "commerce.integrations.manage" | "commerce.templates.manage";
export type CommerceAccess = { isMasterAdmin: boolean; capabilities: CommerceCapability[] };
export type ProviderStatus = {
  provider: string; label: string; status: CommerceStatus; credentialCustody: "environment_secret" | "admin_encrypted" | "no_secret";
  integrationMode?: string | null; environment: string; externalAccountId?: string | null; countryCode?: string | null; currencyCode?: string | null;
  accountCreated?: boolean; apiConfigured?: boolean; webhookEndpointReady?: boolean; webhookSigningConfigured?: boolean; webhookConfigured?: boolean; checkoutEnabled?: boolean; livePaymentsEnabled?: boolean; livePayoutReadiness?: string;
  metadata?: Record<string, unknown>; lastSynchronizedAt?: string | null;
};
export type PublicAddress = { line1?: string; line2?: string; city?: string; province?: string; postalCode?: string; country?: string };
export type BusinessProfile = {
  tradingName: string; countryCode: string; provinceCode: string; currencyCode: string; publicAddress: PublicAddress;
  publicContactEmail: string; supportEmail: string; publicPhone: string; websiteUrl: string; invoicePrefix: string; documentFooter: string;
  taxProviderState: string; invoiceAccentColor: string; receiptAccentColor: string;
  private: { legalBusinessNameStored: boolean; privateAddressStored: boolean; registrations: Array<{ type: string; jurisdiction: string; maskedIdentifier: string; status: string }> };
};
export type CommerceOverviewPayload = {
  ok: boolean; databaseConfigured: boolean; encryptionConfigured: boolean; stripeSecretConfigured: boolean; printfulSecretConfigured: boolean; access: CommerceAccess;
  printfulCatalogueSnapshot: {
    available: boolean; configurationReady: boolean; actionPath: string; sourceTargetDistinct: boolean;
    source: PrintfulStoreIdentity; target: PrintfulStoreIdentity;
  };
  posture: Record<string, string>; providers: ProviderStatus[]; business: Omit<BusinessProfile, "private">;
  completeness: { businessProfile: string; tax: string; templates: string };
  counts: { products: number | null; orders: number | null; templates: number | null }; checkedAt: string;
};
export type BusinessPayload = { ok: boolean; databaseConfigured: boolean; encryptionConfigured: boolean; access: CommerceAccess; profile: BusinessProfile };
export type CommerceTemplate = {
  templateKey: string; subject: string; preheader: string; heading: string; introduction: string; bodyBlocks: string[];
  ctaLabel: string; ctaUrl: string; supportText: string; footer: string; accentColor: string; status: "draft" | "disabled" | "ready"; revision: number;
};
export type TemplatesPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess; templates: CommerceTemplate[] };
export type MerchandisingProduct = {
  id: string; slug: string; title: string; status: string; featured: boolean; featuredOrder: number | null;
  displayData: { hasImage: boolean; hasPrice: boolean; ready: boolean }; updatedAt: string;
};
export type MerchandisingPayload = {
  ok: boolean; databaseConfigured: boolean; access: CommerceAccess | null; products: MerchandisingProduct[];
  featured: MerchandisingProduct[]; updatedAt: string | null;
};
export type CommerceOrder = {
  id: string; checkoutStatus: string; paymentStatus: string; fulfillmentStatus: string;
  currencyCode: string; expectedAmount: number; stripeSessionId: string | null; stripePaymentIntentId: string | null;
  createdAt: string; updatedAt: string; checkoutCreatedAt: string | null; paymentConfirmedAt: string | null;
};
export type CommerceOrdersPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess; orders: CommerceOrder[] };
export type PrintfulStoreIdentity = { id: string; name: string; type: string };
export type PrintfulSourceVerificationPayload = {
  ok: boolean; store: PrintfulStoreIdentity; configuredStoreId: string | null; configurationMatches: boolean;
};
export type PrintfulCatalogueSnapshot = {
  role: string; store: PrintfulStoreIdentity;
  counts: { products: number; variants: number; synced: number; ignored: number; ignoredProducts: number; unavailable: number; missingPrices: number; malformedPrices: number; malformedOrMissingPrices: number; missingFiles: number; variantsWithoutFiles: number };
  products: unknown[];
};
export type PublicWixCatalogueSnapshot = {
  schemaVersion: number;
  source: { repository: string; file: string; totalProductsReportedByLegacyAudit: number; productsRepresentedInCurrentPublicSnapshot: number };
  products: unknown[];
};
export type CatalogueReconciliation = {
  schemaVersion: number;
  counts: { publicProducts: number; printfulBackedMatches: number; nonPrintful: number; unresolved: number; sourceOnly: number; priceConflicts: number; variantConflicts: number; fileConflicts: number; plannedTargetCreates: number; manualDecisions: number };
  matrix: unknown[]; targetDispositions: unknown[]; plannedTargetPayloads: unknown[];
};
export type PrintfulProviderSnapshotPayload = {
  ok: boolean; schemaVersion: number; correlationId: string; endpointsUsed: string[];
  source: PrintfulCatalogueSnapshot; target: PrintfulCatalogueSnapshot;
  publicCatalogue: PublicWixCatalogueSnapshot; reconciliation: CatalogueReconciliation;
  downloadFilenames: { source: string; target: string; publicCatalogue: string; reconciliation: string };
  safety: { providerMethods: string[]; sourceCredential: string; targetCredential: string; tokensIncluded: boolean; customerOrOrderDataIncluded: boolean };
};
type SnapshotRole = "source" | "target";
type SnapshotManifest = {
  correlationId: string; expiresAt: string;
  source: { store: PrintfulStoreIdentity; summaries: Array<{ id: string }> };
  target: { store: PrintfulStoreIdentity; summaries: Array<{ id: string }> };
};
type SnapshotManifestPayload = {
  ok: boolean; phase: "manifest"; schemaVersion: number; correlationId: string; manifest: SnapshotManifest; signature: string;
  chunkSizes: { products: number; files: number };
};
type SnapshotProductEvidence = {
  chunk: { correlationId: string; role: SnapshotRole; productIds: string[]; products: unknown[]; incompleteFileIds: string[] };
  signature: string;
};
type SnapshotFileEvidence = {
  chunk: { correlationId: string; role: SnapshotRole; fileIds: string[]; files: unknown[] };
  signature: string;
};

export function getCommerceOverview() { return adminApi<CommerceOverviewPayload>("/api/admin/commerce/overview"); }
export function verifyStripeConnection(csrfToken: string) {
  return adminApi<CommerceOverviewPayload>("/api/admin/commerce/stripe/verify", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
}
export function verifyPrintfulConnection(csrfToken: string) {
  return adminApi<CommerceOverviewPayload>("/api/admin/commerce/printful/verify", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
}
export function verifyPrintfulCatalogueSource(csrfToken: string) {
  return adminApi<PrintfulSourceVerificationPayload>("/api/admin/commerce/printful/catalogue/source/verify", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
}
export async function capturePrintfulCatalogueSnapshot(csrfToken: string, onProgress?: (message: string) => void) {
  const path = "/api/admin/commerce/printful/catalogue/snapshot";
  const post = <T>(body: Record<string, unknown>) => adminApi<T>(path, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
  onProgress?.("Verifying both Store IDs and enumerating catalogue pages…");
  const started = await post<SnapshotManifestPayload>({ phase: "begin" });
  const productEvidence: SnapshotProductEvidence[] = [];
  const roles: SnapshotRole[] = ["source", "target"];
  const totalProducts = roles.reduce((total, role) => total + started.manifest[role].summaries.length, 0);
  let completedProducts = 0;
  for (const role of roles) {
    const ids = started.manifest[role].summaries.map((summary) => String(summary.id));
    for (const productIds of chunks(ids, started.chunkSizes.products)) {
      onProgress?.(`Reading ${role === "source" ? "legacy source" : "permanent target"} product details (${completedProducts}/${totalProducts})…`);
      const evidence = await post<{ ok: boolean; phase: "products" } & SnapshotProductEvidence>({
        phase: "products", role, productIds, manifest: started.manifest, manifestSignature: started.signature,
      });
      productEvidence.push({ chunk: evidence.chunk, signature: evidence.signature });
      completedProducts += productIds.length;
    }
  }
  const fileEvidence: SnapshotFileEvidence[] = [];
  for (const evidence of productEvidence) {
    for (const fileIds of chunks(evidence.chunk.incompleteFileIds, started.chunkSizes.files)) {
      onProgress?.(`Completing ${evidence.chunk.role === "source" ? "legacy source" : "permanent target"} file metadata…`);
      const fileResult = await post<{ ok: boolean; phase: "files" } & SnapshotFileEvidence>({
        phase: "files",
        role: evidence.chunk.role,
        fileIds,
        manifest: started.manifest,
        manifestSignature: started.signature,
        productChunk: evidence.chunk,
        productChunkSignature: evidence.signature,
      });
      fileEvidence.push({ chunk: fileResult.chunk, signature: fileResult.signature });
    }
  }
  onProgress?.("Verifying evidence and building the deterministic reconciliation…");
  return post<PrintfulProviderSnapshotPayload>({
    phase: "assemble",
    manifest: started.manifest,
    manifestSignature: started.signature,
    productEvidence,
    fileEvidence,
  });
}
export function getBusinessProfile() { return adminApi<BusinessPayload>("/api/admin/commerce/business"); }
export function saveBusinessProfile(csrfToken: string, body: Record<string, unknown>) {
  return adminApi<BusinessPayload>("/api/admin/commerce/business", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
}
export function getCommerceTemplates() { return adminApi<TemplatesPayload>("/api/admin/commerce/templates"); }
export function saveCommerceTemplate(csrfToken: string, template: CommerceTemplate) {
  return adminApi<TemplatesPayload>(`/api/admin/commerce/templates/${encodeURIComponent(template.templateKey)}`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(template) });
}
export function getMerchandisingProducts() { return adminApi<MerchandisingPayload>("/api/admin/commerce/products"); }
export function getCommerceOrders() { return adminApi<CommerceOrdersPayload>("/api/admin/commerce/orders"); }
export function saveFeaturedProducts(csrfToken: string, featuredIds: string[]) {
  return adminApi<MerchandisingPayload>("/api/admin/commerce/products/featured", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ featuredIds }) });
}

function chunks<T>(values: T[], size: number) {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("The catalogue snapshot returned an invalid chunk size.");
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}
