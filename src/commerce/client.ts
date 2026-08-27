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
  safety: { providerMethods: string[]; sourceCredential: string; targetCredential: string; tokensIncluded: boolean; customerOrOrderDataIncluded: boolean };
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
export function capturePrintfulCatalogueSnapshot(csrfToken: string) {
  return adminApi<PrintfulProviderSnapshotPayload>("/api/admin/commerce/printful/catalogue/snapshot", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
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
