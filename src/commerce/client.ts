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
  counts: { publicProducts: number; printfulBackedMatches: number; nonPrintful: number; unresolved: number; sourceOnly: number; priceConflicts: number; variantConflicts: number; fileConflicts: number; plannedTargetCreates: number; manualDecisions: number; targetNativeKeeps?: number; migrationEligibleVariants?: number; discontinuedVariantsExcluded?: number; temporarilyOutOfStockVariantsDeferred?: number };
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
  ok: boolean; status: "complete"; phase: "manifest"; schemaVersion: number; correlationId: string; manifest: SnapshotManifest; signature: string;
  rateCheckpoint: SnapshotRateCheckpoint; rateCheckpointSignature: string;
  chunkSizes: { products: number; files: number };
};
type SnapshotRateCheckpoint = { correlationId: string; rate: Record<string, unknown> };
type SnapshotProductEvidence = {
  chunk: { correlationId: string; role: SnapshotRole; productIds: string[]; products: unknown[]; incompleteFileIds: string[] };
  signature: string;
};
type SnapshotFileEvidence = {
  chunk: { correlationId: string; role: SnapshotRole; fileIds: string[]; files: unknown[] };
  signature: string;
};
export type SnapshotProgress = {
  currentPhase: string;
  completed: number;
  total: number | null;
  providerState: "reading" | "rate_limited" | "waiting" | "resuming" | "assembling";
  retryAt?: string;
  retryAfterMs?: number;
  message?: string;
};
type SnapshotContinuationPayload = {
  ok: boolean; status: "continuing" | "throttled" | "failed"; phase: "begin" | "products" | "files";
  providerStatus?: 419 | 429; retryAt?: string; retryAfterMs?: number; message?: string;
  checkpoint: Record<string, unknown>; checkpointSignature: string;
  progress?: { currentPhase?: string; completed?: number; total?: number | null };
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
export async function capturePrintfulCatalogueSnapshot(csrfToken: string, onProgress?: (progress: SnapshotProgress) => void) {
  const path = "/api/admin/commerce/printful/catalogue/snapshot";
  const post = <T>(body: Record<string, unknown>) => adminApi<T>(path, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
  onProgress?.({ currentPhase: "Catalogue manifest", completed: 0, total: null, providerState: "reading", message: "Verifying both Store IDs and enumerating catalogue pages…" });
  const started = await completePhase<SnapshotManifestPayload>(post, { phase: "begin" }, { phase: "begin" }, onProgress, (progress) => ({ ...progress, currentPhase: progress.currentPhase || "Catalogue manifest" }));
  const productEvidence: SnapshotProductEvidence[] = [];
  const roles: SnapshotRole[] = ["source", "target"];
  const totalProducts = roles.reduce((total, role) => total + started.manifest[role].summaries.length, 0);
  let completedProducts = 0;
  let rateCheckpoint = started.rateCheckpoint;
  let rateCheckpointSignature = started.rateCheckpointSignature;
  for (const role of roles) {
    const ids = started.manifest[role].summaries.map((summary) => String(summary.id));
    for (const productIds of chunks(ids, started.chunkSizes.products)) {
      const currentPhase = role === "source" ? "Legacy product details" : "Target product details";
      onProgress?.({ currentPhase, completed: completedProducts, total: totalProducts, providerState: "reading" });
      const continuationBase = { phase: "products", manifest: started.manifest, manifestSignature: started.signature };
      const evidence = await completePhase<{ ok: boolean; status: "complete"; phase: "products"; rateCheckpoint: SnapshotRateCheckpoint; rateCheckpointSignature: string } & SnapshotProductEvidence>(
        post,
        { ...continuationBase, role, productIds, rateCheckpoint, rateCheckpointSignature },
        continuationBase,
        onProgress,
        (progress) => ({ completed: completedProducts + progress.completed, total: totalProducts, currentPhase }),
      );
      productEvidence.push({ chunk: evidence.chunk, signature: evidence.signature });
      rateCheckpoint = evidence.rateCheckpoint;
      rateCheckpointSignature = evidence.rateCheckpointSignature;
      completedProducts += productIds.length;
    }
  }
  const fileEvidence: SnapshotFileEvidence[] = [];
  const totalFiles = productEvidence.reduce((total, evidence) => total + evidence.chunk.incompleteFileIds.length, 0);
  let completedFiles = 0;
  for (const evidence of productEvidence) {
    for (const fileIds of chunks(evidence.chunk.incompleteFileIds, started.chunkSizes.files)) {
      const currentPhase = evidence.chunk.role === "source" ? "Legacy files" : "Target files";
      onProgress?.({ currentPhase, completed: completedFiles, total: totalFiles, providerState: "reading" });
      const continuationBase = {
        phase: "files", manifest: started.manifest, manifestSignature: started.signature,
        productChunk: evidence.chunk, productChunkSignature: evidence.signature,
      };
      const fileResult = await completePhase<{ ok: boolean; status: "complete"; phase: "files"; rateCheckpoint: SnapshotRateCheckpoint; rateCheckpointSignature: string } & SnapshotFileEvidence>(
        post,
        { ...continuationBase, role: evidence.chunk.role, fileIds, rateCheckpoint, rateCheckpointSignature },
        continuationBase,
        onProgress,
        (progress) => ({ completed: completedFiles + progress.completed, total: totalFiles, currentPhase }),
      );
      fileEvidence.push({ chunk: fileResult.chunk, signature: fileResult.signature });
      rateCheckpoint = fileResult.rateCheckpoint;
      rateCheckpointSignature = fileResult.rateCheckpointSignature;
      completedFiles += fileIds.length;
    }
  }
  onProgress?.({ currentPhase: "Final reconciliation", completed: totalProducts + totalFiles, total: totalProducts + totalFiles, providerState: "assembling", message: "Verifying signed evidence and building the deterministic reconciliation…" });
  return post<PrintfulProviderSnapshotPayload>({ phase: "assemble", manifest: started.manifest, manifestSignature: started.signature, productEvidence, fileEvidence });
}

async function completePhase<T extends { status: "complete" }>(
  post: <R>(body: Record<string, unknown>) => Promise<R>,
  initialBody: Record<string, unknown>,
  continuationBase: Record<string, unknown>,
  onProgress: ((progress: SnapshotProgress) => void) | undefined,
  mapProgress: (progress: { completed: number; total: number | null; currentPhase?: string }) => { completed: number; total: number | null; currentPhase?: string },
): Promise<T> {
  let body = initialBody;
  for (let cycle = 0; cycle < 10_000; cycle += 1) {
    const result = await post<T | SnapshotContinuationPayload>(body);
    if (result.status === "complete") return result;
    const mapped = mapProgress({
      completed: Number.isSafeInteger(result.progress?.completed) ? Number(result.progress?.completed) : 0,
      total: Number.isSafeInteger(result.progress?.total) ? Number(result.progress?.total) : null,
      currentPhase: result.progress?.currentPhase,
    });
    if (result.status === "failed") throw new Error(result.message || "Printful rate-limit recovery was exhausted after retaining completed snapshot progress.");
    if (result.status === "throttled") {
      await waitForProvider(requireRetryAt(result.retryAt), result.providerStatus, mapped, onProgress);
    } else {
      onProgress?.({ currentPhase: mapped.currentPhase || "Catalogue snapshot", completed: mapped.completed, total: mapped.total, providerState: "reading" });
    }
    body = { ...continuationBase, checkpoint: result.checkpoint, checkpointSignature: result.checkpointSignature };
  }
  throw new Error("The catalogue snapshot exceeded its bounded continuation budget.");
}

async function waitForProvider(retryAt: number, providerStatus: 419 | 429 | undefined, progress: { completed: number; total: number | null; currentPhase?: string }, onProgress?: (progress: SnapshotProgress) => void) {
  for (;;) {
    const remaining = Math.max(0, retryAt - Date.now());
    if (!remaining) break;
    onProgress?.({
      currentPhase: progress.currentPhase || "Catalogue snapshot", completed: progress.completed, total: progress.total,
      providerState: "waiting", retryAt: new Date(retryAt).toISOString(), retryAfterMs: remaining,
      message: `Printful ${providerStatus === 419 ? "rate warning" : "rate limit"}; snapshot safely paused. Resuming automatically in ${formatCountdown(remaining)}.`,
    });
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remaining)));
  }
  onProgress?.({ currentPhase: progress.currentPhase || "Catalogue snapshot", completed: progress.completed, total: progress.total, providerState: "resuming", retryAt: new Date(retryAt).toISOString(), retryAfterMs: 0, message: "Provider wait elapsed; resuming from the exact signed checkpoint…" });
}

function requireRetryAt(value: string | undefined) {
  const retryAt = Date.parse(String(value || ""));
  if (!Number.isFinite(retryAt)) throw new Error("Printful returned invalid safe retry timing.");
  return retryAt;
}

function formatCountdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
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
