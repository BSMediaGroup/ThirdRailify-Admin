import { adminApi } from "../auth/client";

export type CommerceStatus = "unavailable" | "setup_required" | "pending" | "connected" | "restricted" | "disabled" | "error" | "legacy_production" | "deferred";
export type CommerceCapability = "commerce.view" | "commerce.catalogue.manage" | "commerce.business.manage" | "commerce.payments.manage" | "commerce.integrations.manage" | "commerce.templates.manage" | "commerce.operations.manage";
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
  taxProviderState: string; invoiceAccentColor: string; receiptAccentColor: string; revision: number; updatedAt: string | null;
  private: { legalBusinessNameStored: boolean; privateAddressStored: boolean; privatePhoneStored: boolean; businessRegistrationNumberStored: boolean; legalBusinessNameMasked: string; privateAddressMasked: string; privatePhoneMasked: string; businessRegistrationNumberMasked: string; registrations: Array<{ type: string; jurisdiction: string; maskedIdentifier: string; status: string }> };
};
export type ReadinessDomain = { ready: boolean; status: "ready" | "blocked"; summary: string; details: Record<string, unknown> };
export type ProductionReadiness = { ok: boolean; authority: string; phase: "pre_cutover"; productionReady: boolean; mandatoryDomains: string[]; domains: Record<string, ReadinessDomain>; checkedAt: string };
export type BusinessReadinessState = "complete" | "partial" | "action_required" | "incomplete" | "not_configured" | "not_required" | "unverified" | "disabled";
export type BusinessReadinessItem = { id: string; label: string; state: BusinessReadinessState; detail: string };
export type BusinessReadinessGroup = { id: string; label: string; state: BusinessReadinessState; items: BusinessReadinessItem[] };
export type BusinessReadiness = {
  overallStatus: BusinessReadinessState; completion: { complete: number; total: number; percent: number }; groups: BusinessReadinessGroup[];
  profile: { coreIdentity: BusinessReadinessState; publicContact: BusinessReadinessState; legalIdentity: BusinessReadinessState; address: BusinessReadinessState; tax: BusinessReadinessState; documents: BusinessReadinessState; productionCommerce: BusinessReadinessState };
  dependencies: Record<string, ReadinessDomain | boolean>;
  documentIdentity: { tradingName: string; legalNameStored: boolean; addressStored: boolean; contactEmail: string | null; taxRegistrationState: BusinessReadinessState; receiptTemplate: { state: BusinessReadinessState; revision: number | null }; invoiceTemplate: { state: BusinessReadinessState; revision: number | null } };
};
export type CommerceOverviewPayload = {
  ok: boolean; databaseConfigured: boolean; encryptionConfigured: boolean; stripeSecretConfigured: boolean; printfulSecretConfigured: boolean; access: CommerceAccess;
  printfulCatalogueSnapshot: {
    available: boolean; configurationReady: boolean; actionPath: string; sourceTargetDistinct: boolean;
    source: PrintfulStoreIdentity; target: PrintfulStoreIdentity;
  };
  posture: Record<string, string>; providers: ProviderStatus[]; business: Omit<BusinessProfile, "private">;
  completeness: { businessProfile: string; tax: string; templates: string };
  counts: { products: number | null; orders: number | null; templates: number | null }; readiness?: ProductionReadiness; checkedAt: string;
};
export type BusinessPayload = { ok: boolean; databaseConfigured: boolean; encryptionConfigured: boolean; access: CommerceAccess; authority: string; privacy: { publicSafe: string[]; adminOnly: string[]; sensitive: string[] }; profile: BusinessProfile; readiness: BusinessReadiness; canonicalReadiness: ProductionReadiness | null };
export type CommerceTemplate = {
  templateKey: string; templateKind: "email" | "document"; displayName: string; subject: string; preheader: string; heading: string; introduction: string; bodyBlocks: string[];
  ctaLabel: string; ctaUrl: string; supportText: string; footer: string; accentColor: string; status: "draft" | "disabled" | "ready"; enabled: boolean; revision: number;
  validity?: { state: "valid" | "invalid"; action: "none" | "action_required"; code: string | null; message: string | null };
};
export type CommerceLaunchGate = { id: string; ready: boolean; detail: string };
export type CommerceLaunchPlan = {
  ok: true; state: "preflight" | "active" | "paused"; revision: number; ready: boolean; digest: string;
  hardGates: CommerceLaunchGate[]; advisories: CommerceLaunchGate[];
  catalogue: { totalVariants: number; eligibleVariants: number; sellableVariants: number; eligibleSellableVariants: number; ineligibleSellableVariants: number };
  shippingMarkets: Array<{ countryCode: string; displayName: string; status: string; strategy: string; revision: number }>;
  settings: { checkoutEnabled: boolean; liveCaptureEnabled: boolean; fulfillmentEnabled: boolean; transactionalEmailEnabled: boolean; stripeTaxEnabled: boolean; emergencyPaused: boolean };
};
export type CustomerEmailTemplate = CommerceTemplate & { purpose: string; updatedAt: string | null; productionTriggerImplemented: boolean };
export type CustomerEmailDelivery = {
  id: string; templateKey: string; templateRevision: number; orderId: string | null; environment: "test" | "live" | "unknown";
  purpose: "test_preview" | "transactional"; status: "pending" | "sending" | "sent" | "failed"; attemptCount: number;
  maskedRecipient: string; providerMessageReference: string | null; failure: string | null; createdAt: string | null; updatedAt: string | null; sentAt: string | null;
};
export type CustomerEmailsPayload = {
  ok: boolean; databaseConfigured: boolean; authority: string; access: CommerceAccess;
  provider: { name: "Resend"; configured: boolean; credentialConfigured: boolean; senderConfigured: boolean; replyToConfigured: boolean; externalVerification: "verified" | "unverified"; lastSuccessful: CustomerEmailDelivery | null; lastFailed: CustomerEmailDelivery | null };
  sender: { source: "server_environment"; providerCredentialConfigured: boolean; fromDisplayName: string | null; fromAddress: string | null; fromAddressConfigured: boolean; replyToAddress: string | null; replyToConfigured: boolean; sendingDomain: string | null; externallyVerified: false; businessDisplayName?: string | null; businessSupportEmail?: string | null };
  templates: CustomerEmailTemplate[];
  mergeVariables: Array<{ key: string; group: string; description: string }>;
  readiness: { state: "ready" | "ready_but_disabled" | "incomplete" | "action_required"; configurationReady: boolean; configuredTemplates: number; totalTemplates: number; minimumReadyTemplates: number; customerSendsEnabled: boolean; productionLifecycleImplemented: boolean };
  dependencies: {
    business: { complete: boolean; canonicalReady: boolean; displayName: string | null; supportEmail: string | null; href: string };
    documents: { receipt: { configured: boolean; status: string; enabled: boolean; revision: number | null }; invoice: { configured: boolean; status: string; enabled: boolean; revision: number | null }; customerAccessEnabled: boolean; href: string };
    orders: { href: string; orderSpecificHistoryOwner: true }; paypalRequired: false;
  };
  deliveries: { state: "available" | "unavailable"; recent: CustomerEmailDelivery[]; counts: { total: number; test: number; live: number; unknown: number; sent: number; failed: number; pending: number; sending: number }; lastSuccessful: CustomerEmailDelivery | null; lastFailed: CustomerEmailDelivery | null; idempotency: { implemented: true; authority: string; retriesAvailableFromThisRoute: false } };
  canonicalReadiness: null | { productionReady: boolean; communications: ReadinessDomain };
  safety: { customerSendsEnabled: boolean; mutableFromThisRoute: false; testSendExposed: false; previewMutates: false; providerCallsOnRead: false; providerCallsOnPreview: false; productionLifecycleImplemented: boolean };
  checkedAt: string;
};
export type PaymentAuthorityState = "configured" | "verified" | "unverified" | "disabled" | "unavailable";
export type PaymentGateState = "ready" | "action_required" | "disabled" | "unverified" | "not_applicable";
export type PaymentGate = { id: string; label: string; state: PaymentGateState; detail: string; href: string | null };
export type PaymentSummary = { available: boolean; successfulPayments: number | null; grossAmount: number | null; refundedPayments: number | null; refundAmount: number | null; netAfterRefunds: number | null };
export type PaymentWebhookEvidence = { eventId: string | null; eventType: string | null; eventCreatedAt: number | null; receivedAt: string | null; processedAt: string | null; environment: "test" | "live"; relatedObjectId: string | null; relatedObjectType: string | null; processingStatus: string | null; resultCode: string | null };
export type PayPalEnvironmentState = { clientIdConfigured?: boolean; clientSecretConfigured?: boolean; webhookIdConfigured?: boolean; expectedMerchantIdConfigured?: boolean; oauthVerified?: boolean; webhookReadbackVerified?: boolean; storeAcceptance?: "passed" | "not_run"; donationAcceptance?: "passed" | "not_run" };
export type PaymentsControlPlanePayload = {
  ok: boolean; databaseConfigured: boolean; access: CommerceAccess; authority: string;
  overall: { stripeState: PaymentAuthorityState; technicalConfiguration: PaymentAuthorityState; testAcceptance: PaymentAuthorityState; productionPayments: PaymentAuthorityState; payoutReadiness: PaymentAuthorityState; productionReady: boolean };
  merchant: { displayName: string; countryCode: string | null; provinceCode: string | null; currencyCode: string | null; publicContactEmail: string | null; supportEmail: string | null; completeness: "ready" | "incomplete" | "unavailable"; legalIdentityStored: boolean; privateAddressStored: boolean; businessRegistrationStored: boolean };
  stripe: { provider: "stripe"; displayName: string; integrationMode: "direct_merchant" | "unavailable"; environment: "test" | "live"; accountCreated: boolean; accountId: string | null; accountIdRestricted: boolean; countryCode: string | null; currencyCode: string | null; apiCredentialConfigured: boolean; apiVerified: boolean; webhookSigningSecretConfigured: boolean; webhookAcceptanceVerified: boolean; checkoutEnabled: boolean; livePaymentsEnabled: boolean; chargesEnabledInTest: boolean | null; payoutsEnabledInTest: boolean | null; detailsSubmittedInTest: boolean | null; lastVerifiedAt: string | null };
  paypal: { provider: "paypal"; state: "disabled" | "deferred" | "setup_required" | "connected"; integrationMode: "direct_merchant" | "unavailable"; environment: string; countryCode: string | null; currencyCode: string | null; credentialConfigured: boolean; preferred: boolean; sandbox: PayPalEnvironmentState; live: PayPalEnvironmentState; donationsEnabled: boolean; membershipEnabled: boolean; shopCheckoutEnabled: boolean; captureEnabled: boolean; webhookEvents: string[]; webhookUrl?: string | null; setupCommand?: string; latestVerifiedDelivery: null | { environment: string; event_type: string; received_at: string; result_code: string }; attempts: Array<{ environment: string; kind?: "store" | "donation"; normalized_state: string; count: number }>; donations: Array<{ environment: string; status: string; count: number; amount: number }>; diagnostics: Array<{ operation_kind: string; http_status: number | null; provider_code: string | null; provider_reason: string | null; request_id: string | null; retryable: number; occurred_at: string }>; providerMutationAvailable: false; lastVerifiedAt: string | null };
  gates: PaymentGate[];
  productionActivation: { checkout: { enabled: boolean; state: PaymentAuthorityState }; livePayments: { enabled: boolean; state: PaymentAuthorityState }; fulfillment: { enabled: boolean; state: PaymentAuthorityState }; controlledTestCheckout: { enabled: boolean; state: PaymentAuthorityState }; mutableFromThisRoute: false };
  testEvidence: null | { orderId: string; environment: "test"; amount: number; refundAmount: number; currencyCode: "CAD"; paymentStatus: string; checkoutStatus: string; fulfillmentStatus: string; productName: string | null; variantName: string | null; quantity: number; stripeSessionId: string | null; paymentIntentId: string | null; webhookEventId: string | null; webhookResult: string | null; createdAt: string | null; checkoutCreatedAt: string | null; paymentConfirmedAt: string | null; webhookReceivedAt: string | null };
  webhookHealth: { endpointImplemented: boolean; signingSecretConfigured: boolean; acceptanceVerified: boolean; externallyVerified: boolean; environment: "test" | "live"; counts: { total: number | null; processed: number | null; failed: number | null; test: number | null; live: number | null; duplicates: number | null }; latestProcessed: PaymentWebhookEvidence | null; latestFailed: PaymentWebhookEvidence | null; idempotency: { implemented: boolean; evidence: string } };
  paymentSummary: { currencyCode: "CAD"; live: PaymentSummary; test: PaymentSummary; processingFees: { available: false; reason: string } };
  paymentMethods: Array<{ id: "paypal" | "card" | "apple_pay" | "google_pay"; label: string; state: PaymentAuthorityState; detail: string }>;
  payoutState: { state: "unverified"; management: "managed_in_stripe"; balanceIntegrationAvailable: false; payoutIntegrationAvailable: false; bankDestinationStored: false; nextPayout: null; availableBalance: null; pendingBalance: null; schedule: null; testCapabilityObserved: boolean | null };
  dependencies: Array<{ id: string; label: string; state: PaymentGateState; detail: string; href: string }>;
  technical: { checkoutArchitecture: "stripe_hosted_checkout_sessions" | "provider_neutral_paypal_orders_v2"; directMerchant: boolean; stripeConnect: false; connectedAccounts: false; stripeAccountHeader: false; destinationCharges: false; applicationFees: false; transfers: false; publishableKeyRequired: boolean; providerMutationAvailable: false };
  checkedAt: string;
};
export type FulfillmentStatusProjection = { state: string; detail: string };
export type FulfillmentGate = { id: string; label: string; state: "ready" | "incomplete" | "disabled" | "blocked" | "optional"; detail: string; href: string | null };
export type FulfillmentDraftPreview = {
  builderVersion: string; kind: "draft_preview"; eligible: boolean; blockers: Array<{ code: string; message: string }>;
  labels: string[]; reference: string; environment: "test" | "live";
  item: null | { localOrderItemId?: string | null; productId: string; product: string; variantId: string; variant: string; provider: string; mappedProviderVariant: string | null; quantity: number | null };
  requirements: { recipient: { source: string; complete: boolean; missing: string[]; countryCode: string | null; postalCodePresent: boolean }; shipping: { required: boolean; strategy: string; configured: boolean; method: string | null } };
  safePayloadPreview: null | { externalReference: string; recipient: { source: string; countryCode: string | null; postalCodePresent: boolean }; items: Array<{ providerVariantId: string; quantity: number | null }>; shipping: { strategy: string; method: string | null } };
  submission: { available: false; mode: string; networkRequestMade: false; providerOrderCreated: false; localOrderMutated: false; migrationMutated: false };
};
export type FulfillmentShipment = { id: string; providerShipmentId: string; state: string; providerStatus: string | null; carrier: string | null; service: string | null; trackingAvailable: boolean; trackingReference: string | null; trackingUrl: string | null; reshipment: boolean; reshipmentOfShipmentId: string | null; returnedReasonCategory: string | null; shippedAt: string | null; deliveredAt: string | null; returnedAt: string | null; lastProviderEvidenceAt: string; items: Array<{ fulfillmentItemId: string; quantity: number }> };
export type FulfillmentLifecycleDetail = { available: boolean; id?: string; provider: string | null; providerOrderId: string | null; externalId: string | null; environment: "test" | "live" | null; providerState: string; fulfillmentState: string; confirmationState: string; providerStatus: string | null; failureCategory: string | null; providerCreatedAt: string | null; providerUpdatedAt: string | null; lastProviderEvidenceAt: string | null; shipmentCount: number; trackingAvailable: boolean; items: Array<{ id: string; orderItemId: string; providerOrderItemId: string | null; orderedQuantity: number; productName: string; variantName: string | null }>; shipments: FulfillmentShipment[]; evidence: Array<{ id: string; type: string; occurredAt: string; status: string; resultCode: string | null; retryCount: number; receivedAt: string; processedAt: string | null }>; shipmentNotification: { status: string; sendsEnabled: false; deliveryCreated: false } };
export type FulfillmentShippingPayload = {
  ok: boolean; databaseConfigured: boolean; authority: string; access: CommerceAccess;
  readiness: { provider: FulfillmentStatusProjection; catalogue: FulfillmentStatusProjection; customerShippingData: FulfillmentStatusProjection; paymentAuthority: FulfillmentStatusProjection; printfulOrderMode: FulfillmentStatusProjection; fulfillment: FulfillmentStatusProjection; tracking: FulfillmentStatusProjection; production: FulfillmentStatusProjection };
  provider: { name: "Printful"; state: string; configured: boolean; targetStoreConfigured: boolean; storeType: string | null; credentialConfigured: boolean; configurationEvidence: string; scopes: { products: boolean; files: boolean; orders: boolean; webhooks: boolean; evidenceRecorded: boolean }; orderMode: string; providerOrderMode: string; orderModeConsistent: boolean; fulfillmentEnabled: boolean; localProviderOrderCount: number; lastProviderOrderAt: string | null; lastConfigurationEvidenceAt: string | null };
  migration: { id: string; status: string; phase: string; manuallyPaused: boolean; verifiedProducts: number; mappedVariants: number; blockedProducts: number; deferredVariants: number; providerRequestCount: number; providerFailures: number; updatedAt: string | null; completedAt: string | null; mutableFromThisRoute: false };
  mapping: { storefrontProducts: number; storefrontVariants: number; totalProducts: number; totalVariants: number; mappedProviderProducts: number; mappedProviderVariants: number; unmappedVariants: number; blockedProducts: number; blockedVariants: number; deferredVariants: number; nonSellableVariants: number; potentiallyFulfillableVariants: number; contract: string };
  pipeline: Array<{ id: string; label: string; implemented: boolean; authority: string; transition: string; detail: string }>;
  shipping: { schema: { state: "ready" | "migration_required" | "unavailable"; migration: "0015_checkout_shipping_foundation.sql"; quoteTable: boolean; deliverySnapshotTable: boolean }; customerData: { state: string; persistedFields: string[]; orderSpecificPiiProjectedHere: false }; rates: { state: string; strategy: string; providerQuotePathImplemented: boolean; providerQuoteCalled: false } };
  tracking: { state: string; persistedFields: string[]; shipmentPollingImplemented: false; providerPollingPerformed: false };
  lifecycle: { schema: { state: string; migration: string }; providerOrderModel: { state: string; authority: string }; draftRecording: { state: string; idempotent: true }; webhookReceiver: { state: string; protocol: string; route: string }; webhookVerification: { state: string }; providerSubscription: { state: string }; shipmentNormalization: { state: string; authority: string }; partialShipmentHandling: { state: string; authority: string }; trackingStorage: { state: string }; carrierDeliveryPolling: { state: string }; reconciliationFallback: { state: string; automaticPolling: false }; fulfillmentSubmission: { state: string } };
  operations: { state: string; rows: Array<{ id: string; orderId: string; environment: "test" | "live"; paymentStatus: string; provider: string; providerOrderId: string; confirmationState: string; providerState: string; providerStatus: string; fulfillmentState: string; shipmentCount: number; trackingAvailable: boolean; lastProviderEvidenceAt: string }>; page: number; pageSize: number; total: number; totalPages: number; counts: { total: number; testOrders: number; liveOrders: number; livePartial: number; liveShipped: number; shipments: number; testShipments: number; liveShipments: number } };
  draftPreview: FulfillmentDraftPreview; gates: FulfillmentGate[];
  dependencies: { business: { href: string }; taxDocuments: { href: string }; customerEmails: { href: string; shipmentTemplate: { configured: boolean; state: string; revision: number | null; updatedAt: string | null }; sendsEnabled: boolean }; payments: { href: string }; products: { href: string }; orders: { href: string } };
  evidence: { recent: Array<{ id: string; environment: "test" | "live"; paymentStatus: string; fulfillmentStatus: string; providerOrderRecorded: boolean; providerOrderId: string | null; providerOrderStatus: string | null; providerConfirmationStatus: string | null; createdAt: string; updatedAt: string }>; counts: { totalOrders: number; testOrders: number; liveOrders: number; providerOrders: number; fulfillmentEvidence: number; testShippingSnapshots: number; liveShippingSnapshots: number; shipments: number }; lastAudit: null | { action: string; result: string; createdAt: string } };
  technical: { builderVersion: string; providerCallsOnRead: false; providerCallsOnPreview: false; previewPersists: false; previewAuditedAsMutation: false; shippingDataCapability: string; shippingRateCapability: string; trackingCapability: string; legacyTrackingColumns?: string[] };
  safety: { checkoutEnabled: boolean; controlledTestCheckoutEnabled: boolean; livePaymentCaptureEnabled: boolean; fulfillmentEnabled: boolean; orderMode: string; controlledTestDraftCreationImplemented: boolean; providerSubmissionAvailable: false; providerConfirmationAvailable: false; previewOnly: true; mutationsAvailableFromThisRoute: false };
  canonicalReadiness: ProductionReadiness | null; checkedAt: string;
};
export type TemplatesPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess; templates: CommerceTemplate[] };
export type TaxRegistration = { id: string; registrationType: "gst_hst" | "qst" | "pst" | "rst" | "other"; jurisdiction: string; countryCode: string; provinceCode: string | null; maskedIdentifier: string; status: string; effectiveDate: string | null; expiresAt: string | null; notes: string; documentDisclosureEnabled: boolean; revision: number; updatedAt: string };
export type TaxPayload = {
  ok: boolean; authority: string; access: CommerceAccess; registrations: TaxRegistration[];
  registrationState: { configured: boolean; activeCount: number; externallyVerified: false };
  calculation: { provider: string; stripeTax: string; ratesConfigured: boolean };
  documents: { tokenizedAccessSupported: boolean; customerAccessEnabled: boolean; deliveryEnabled: boolean; previewCount: number; issuedCount: number; revokedCount: number; lastGeneratedAt: string | null; lastGeneratedType: string | null; lastGeneratedStatus: string | null };
  readiness: { ready: boolean; status: string; reason: string };
};
export type TemplatePreviewPayload = { ok: boolean; preview: CommerceTemplate & { text: string; html: string }; source: string; test: boolean; orderId: string | null; variables: Record<string, string> };
export type CommerceDocument = { type: "receipt" | "invoice"; available: boolean; reason: string; test: boolean; marker: string; displayReference: string; orderReference: string; merchantName: string; legalName: string | null; legalAddress: PublicAddress | string | null; supportEmail: string; issuedAt: string; payment: string; fulfillment: string; items: Array<{ productName: string; variantName: string | null; options: Record<string, string>; unitAmount: number; quantity: number; lineTotalAmount: number }>; subtotal: number; shipping: number | null; tax: number | null; total: number; currency: string; templateKey: string; templateRevision: number; disclosures: string[]; html: string; text: string };
export type DocumentPreviewPayload = { ok: boolean; access: CommerceAccess; document: CommerceDocument };
export type MerchandisingVariant = {
  id: string; productId: string; localVariantKey: string; displayLabel: string; status: string; visibility: string;
  sellable: boolean; availability: string; unitAmount: number; currencyCode: string; sku: string | null;
  size: string | null; color: string | null; options: Record<string, string>; fulfillmentProvider: string;
  fulfillmentMappingStatus: string; migrationStatus: string; integration: Record<string, string | null>; updatedAt: string;
};
export type MerchandisingProduct = {
  id: string; slug: string; title: string; description: string; primaryImageUrl: string | null; additionalImages: string[];
  categories: string[]; collectionIds: string[]; tags: string[]; status: string; visibility: string; currencyCode: string; unitAmount: number | null;
  price: { minimum: number | null; maximum: number | null; label: string }; maxQuantity: number; requiresShipping: boolean;
  featured: boolean; featuredOrder: number | null; displayOrder: number; migrationStatus: string; sourceProvider: string;
  integration: Record<string, string | null>; variantCount: number; activeVariantCount: number; sellableVariantCount: number;
  readiness: { displayable: boolean; checkout: boolean; fulfillment: string }; variants: MerchandisingVariant[];
  displayData: { hasImage: boolean; hasPrice: boolean; ready: boolean }; updatedAt: string;
};
export type MerchandisingPayload = {
  ok: boolean; databaseConfigured: boolean; access: CommerceAccess | null; products: MerchandisingProduct[];
  featured: MerchandisingProduct[]; updatedAt: string | null;
};
export type OrderListFilters = { page?: number; pageSize?: 20 | 50 | 75 | 100; query?: string; environment?: "all" | "test" | "live"; payment?: string; fulfillment?: string; sort?: "newest" | "oldest" | "highest_total" | "lowest_total" };
export type CustomerAccount = { id: string; displayName: string; email: string | null; username: string | null; avatarUrl: string | null; providers: string[]; role: string; adminLevel: string; status: string; emailVerified: boolean; createdAt: string; lastLoginAt: string | null; source: string };
export type CommerceCustomer = {
  id: string; kind: "guest" | "account"; contact: { name: string; email: string }; account: CustomerAccount | null;
  createdAt: string; updatedAt: string; revision: number;
  summary: { orderCount: number; paidOrderCount: number; liveOrderCount: number; testOrderCount: number; livePaidOrderCount: number; testPaidOrderCount: number; liveSpendAmount: number; testSpendAmount: number; donationCount: number; completedDonationCount: number; liveDonationAmount: number; sandboxDonationAmount: number; currencyCode: "CAD"; firstOrderAt: string | null; lastOrderAt: string | null };
};
export type CustomerListFilters = { page?: number; pageSize?: 20 | 50 | 75 | 100; query?: string; type?: "all" | "account" | "guest"; environment?: "all" | "live" | "test"; purchase?: "any" | "paid" | "unpaid"; sort?: "latest_order" | "oldest" | "newest" | "highest_live_spend" | "most_orders" };
export type CustomersPayload = { ok: boolean; databaseConfigured: boolean; authority: string; access: CommerceAccess; customers: CommerceCustomer[]; page: number; pageSize: 20 | 50 | 75 | 100; totalMatching: number; totalPages: number; startIndex: number; endIndex: number; filters: Required<CustomerListFilters> };
export type CustomerOrder = { id: string; environment: "test" | "live"; paymentStatus: string; fulfillmentStatus: string; totalAmount: number; refundAmount: number; currencyCode: "CAD"; createdAt: string; paymentConfirmedAt: string | null; delivery: null | { countryCode: string; regionCode: string | null; method: string | null; historicalSnapshot: true }; documentCount: number; emailCount: number; fulfillment: { state: string; shipped: boolean; trackingAvailable: boolean; shipmentCount: number } };
export type CustomerDetail = CommerceCustomer & { orders: CustomerOrder[]; donations: Array<{ id:string;environment:"sandbox"|"live";amount:number;currencyCode:"CAD";status:string;createdAt:string;completedAt:string|null }>; orderPage: number; orderPageSize: number; orderTotalPages: number; communication: { documents: number; deliveries: number; boundedToVisibleOrders: true }; technical: { revision: number; linkedAccountId: string | null } };
export type CustomerDetailPayload = { ok: boolean; databaseConfigured: boolean; authority: string; access: CommerceAccess; customer: CustomerDetail };
export type CommerceOrderListItem = {
  id: string; test: boolean; environment: "test" | "live"; checkoutStatus: string; paymentStatus: string; fulfillmentStatus: string;
  paymentProvider: string; currencyCode: string; totalAmount: number; refundAmount: number; stripeSessionId: string | null; stripePaymentIntentId: string | null; paypalOrderId: string | null; paypalCaptureId: string | null; paymentAttemptState: string | null;
  hasPrintfulOrder: boolean; createdAt: string; updatedAt: string; checkoutCreatedAt: string | null; paymentConfirmedAt: string | null;
  lineCount: number; itemCount: number; documentCount: number; emailCount: number; customer: null | { id: string; kind: "guest" | "account"; accountId: string | null };
  fulfillment: { available: boolean; providerOrderId: string | null; providerState: string; state: string; confirmationState: string; shipmentCount: number; trackingAvailable: boolean };
};
export type OrderTimelineEntry = { id: string; timestamp: string; kind: string; title: string; detail: string; status: string | null };
export type CommerceOrderDetail = {
  id: string; test: boolean; environment: "test" | "live"; checkoutStatus: string; paymentStatus: string; fulfillmentStatus: string;
  paymentProvider: string; fulfillmentProvider: string | null; currencyCode: string; createdAt: string; updatedAt: string;
  checkoutCreatedAt: string | null; paymentConfirmedAt: string | null; paymentFailedAt: string | null; checkoutFailureCode: string | null;
  customer: { available: boolean; linked: boolean; legacy: boolean; id: string | null; kind: "guest" | "account" | null; contact: { name: string; email: string } | null; account: CustomerAccount | null; snapshot: { name: string | null; email: string | null; historical: true } | null; phone: string | null; billingAddress: PublicAddress | null; shippingAddress: PublicAddress | null };
  delivery: { available: boolean; recipientConfigured: boolean; destinationCountryCode: string | null; destinationRegionCode: string | null; strategy: string | null; provider: string | null; method: string | null; amount: number | null; currencyCode: string | null; quoteReference: string | null; quotedAt: string | null; capturedAt: string | null; addressExternallyVerified: false };
  items: Array<{ id: string; lineNumber: number; productId: string; variantId: string | null; productName: string; variantName: string | null; sku: string | null; options: Record<string, string>; currencyCode: string; unitAmount: number; quantity: number; lineTotalAmount: number; requiresShipping: boolean; fulfillmentProvider: string | null; fulfillmentVariantId: string | null; imageUrl: string | null }>;
  financial: { subtotalAmount: number; discountAmount: number | null; shippingAmount: number | null; taxAmount: number | null; totalAmount: number; refundAmount: number; netAmount: number | null; currencyCode: string };
  payment: { provider: string; status: string; environment: "test" | "live"; stripeSessionId: string | null; stripePaymentIntentId: string | null; paypalAttemptId: string | null; paypalOrderId: string | null; paypalCaptureId: string | null; providerStatus: string | null; normalizedState: string | null };
  fulfillment: { provider: string | null; status: string; printfulOrderId: string | null; orderMode: string; submissionEnabled: boolean; tracking: string | null; carrier: string | null; failureReason: string | null; providerCosts: { product: number; shipping: number; tax: number; refundCredit: number }; lifecycle: FulfillmentLifecycleDetail };
  documents: Array<{ id: string; type: string; displayReference: string; test: boolean; status: string; templateKey: string; templateRevision: number; issuedAt: string | null; createdAt: string; updatedAt: string }>;
  deliveries: Array<{ id: string; templateKey: string; templateRevision: number; eventKey: string; purpose: string; status: string; attemptCount: number; createdAt: string; updatedAt: string; sentAt: string | null }>;
  webhooks: Array<{ provider: "paypal" | "stripe"; eventId: string; eventType: string; eventCreatedAt: string | null; receivedAt: string; processedAt: string | null; test: boolean; relatedObjectId: string | null; relatedObjectType: string | null; processingStatus: string; resultCode: string | null }>;
  audit: Array<{ id: string; action: string; targetType: string; result: string; createdAt: string }>;
  technical: { checkoutRequestId: string | null; stripeSessionId: string | null; stripePaymentIntentId: string | null; paypalAttemptId: string | null; paypalOrderId: string | null; paypalCaptureId: string | null; printfulOrderId: string | null };
  timeline: OrderTimelineEntry[];
};
export type ProductListFilters = {
  page?: number; pageSize?: 20 | 50 | 75 | 100; query?: string; visibility?: string; status?: string;
  migration?: string; category?: string; featured?: "all" | "featured" | "not_featured"; sort?: "display" | "name" | "price";
};
export type MerchandisingListPayload = {
  ok: boolean; databaseConfigured: boolean; access: CommerceAccess | null; items: MerchandisingProduct[]; featured: MerchandisingProduct[];
  page: number; pageSize: 20 | 50 | 75 | 100; totalItems: number; totalPages: number;
  filters: Required<Pick<ProductListFilters, "query" | "visibility" | "status" | "migration" | "category" | "featured" | "sort">>;
  facets: { categories: string[]; migrationStatuses: string[] };
  totals: { products: number; publicProducts: number; variants: number; featuredProducts: number }; updatedAt: string | null;
};
export type ProductBulkOperation = "show" | "hide" | "feature" | "unfeature";
export type ProductBulkResult = {
  ok: true; operation: ProductBulkOperation; selection: "explicit" | "matching"; matched: number; requested: number;
  updated: number; unchanged: number; rejected: number; errors: string[]; updatedIds: string[];
};
export type ProductFeaturedResult = { ok: true; changed: boolean; product: { id: string; featured: boolean; featuredOrder: number | null; updatedAt: string | null } };
export type ControlledTestAcceptance = {
  enabled: boolean; normalCheckoutEnabled: boolean; livePaymentsEnabled: boolean; fulfillmentEnabled: boolean;
  existingOrderCount: number;
  stripe: { status: string; environment: string; integrationMode: string; currencyCode: string };
  candidate: null | { productId: string; variantId: string; slug: string; title: string; variantLabel: string; options: Record<string, string>; unitAmount: number; currencyCode: string; sellable: boolean; mappingStatus: string; migrationStatus: string };
};
export type CommerceOrdersPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess; controlledTest: ControlledTestAcceptance | null; orders: CommerceOrderListItem[]; page: number; pageSize: 20 | 50 | 75 | 100; totalMatching: number; totalPages: number; startIndex: number; endIndex: number; filters: Required<Pick<OrderListFilters, "query" | "environment" | "payment" | "fulfillment" | "sort">>; summary: { totalMatching: number; paid: number; pending: number; refunded: number; fulfillmentActive: number; testOrders: number; liveOrders: number; liveGrossAmount: number; liveNetAmount: number; currencyCode: string } };
export type CommerceOrderDetailPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess; order: CommerceOrderDetail };
export type TestCheckoutPayload = { ok: true; orderId: string; sessionId: string; checkoutUrl: string };
export type PrintfulStoreIdentity = { id: string; name: string; type: string };
export type PrintfulSourceVerificationPayload = {
  ok: boolean; store: PrintfulStoreIdentity; configuredStoreId: string | null; configurationMatches: boolean;
};
export type MerchandisingProductPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess; product: MerchandisingProduct };
export type CommerceMediaAsset = { url: string; sha256: string; contentType: string; bytes: number };
export type CommerceMediaLimits = { maxBytes: number; maxProductImages: number; maxAdditionalImages: number; acceptedTypes: string[] };
export type CommerceMediaIngestPayload = { ok: true; productId: string; primaryImageUrl: string | null; additionalImages: string[]; assets: CommerceMediaAsset[] };
export type CommerceMediaUploadPayload = { ok: true; productId: string; asset: CommerceMediaAsset; limits: CommerceMediaLimits; uploadedAt: string };
export type CommerceCollection = {
  id: string; slug: string; title: string; description: string; visibility: "public" | "hidden"; status: "active";
  displayOrder: number; revision: number; assignedProductCount: number; publicProductCount: number;
  thumbnailUrl: string | null; productIds?: string[]; createdAt: string; updatedAt: string;
};
export type CollectionsPayload = {
  ok: boolean; databaseConfigured: boolean; access: CommerceAccess | null; collections: CommerceCollection[];
  products: MerchandisingProduct[]; updatedAt: string | null;
};
export type CollectionOptionsPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess | null; collections: CommerceCollection[]; updatedAt: string | null };
export type CollectionListFilters = { page?: number; pageSize?: 20 | 50 | 75 | 100; query?: string; visibility?: "all" | "public" | "hidden"; contents?: "all" | "empty" | "contains_products"; sort?: "display" | "title_asc" | "title_desc" | "product_count" | "updated_desc" };
export type CollectionListPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess | null; items: CommerceCollection[]; page: number; pageSize: 20 | 50 | 75 | 100; totalItems: number; totalPages: number; startIndex: number; endIndex: number; filters: Required<Pick<CollectionListFilters, "query" | "visibility" | "contents" | "sort">>; totals: { collections: number; publicCollections: number; hiddenCollections: number; emptyCollections: number }; updatedAt: string | null };
export type CollectionDetailPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess | null; collection: CommerceCollection };
export type CollectionProduct = { id: string; slug: string; title: string; primaryImageUrl: string | null; status: string; visibility: string; assigned: boolean; priceLabel: string; updatedAt: string };
export type CollectionProductListFilters = { page?: number; pageSize?: 20 | 50 | 75 | 100; query?: string; visibility?: "all" | "public" | "hidden"; membership?: "all" | "assigned" | "available" };
export type CollectionProductListPayload = { ok: boolean; databaseConfigured: boolean; access: CommerceAccess | null; collectionId: string; items: CollectionProduct[]; page: number; pageSize: 20 | 50 | 75 | 100; totalItems: number; totalPages: number; startIndex: number; endIndex: number; filters: Required<Pick<CollectionProductListFilters, "query" | "visibility" | "membership">> };
export type CollectionBulkOperation = "show" | "hide";
export type CollectionBulkResult = { ok: true; operation: CollectionBulkOperation; selection: "explicit" | "matching"; matched: number; requested: number; updated: number; unchanged: number; rejected: number; errors: string[]; updatedIds: string[] };
export type CollectionMembershipResult = { ok: true; collectionId: string; revision: number; operation: "add" | "remove"; requested: number; updated: number; unchanged: number; updatedIds: string[] };
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
export type PermanentPrintfulMigrationPayload = {
  ok: boolean;
  migration: {
    id: string; status: "ready" | "running" | "waiting" | "completed" | "completed_with_blocked_products" | "blocked";
    phase: string; currentProduct: { id: string; title: string; legacySourceProductId: string; migrationStatus: string } | null;
    fileProgress: { resolved: number; total: number } | null;
    completedProducts: number; processedProducts: number; remainingProducts: number; totalProducts: number; productsCreated: number; productsAdopted: number;
    variantsMapped: number; providerFailures: number; providerRequestCount: number;
    providerState: "ready" | "waiting" | "paused" | "blocked" | "completed"; retryAt: number | null; manuallyPaused?: boolean;
    lastError: { code: string; message: string; at: string } | null;
    canResume: boolean; checkpointState: "checkpointed" | "checkpointed_resumable" | "verified";
    scopes: string[] | null; targetVerified: boolean; sourceVerified: boolean;
    updatedAt: string; completedAt: string | null;
    blockedProducts: Array<{ productId: string; title: string; sourceProductId: string; sourceFileId: string | null; code: string; reason: string; at: string }>;
  };
  catalogue: {
    plannedProductCreates: number; targetNativeKeeps: number; eligibleVariants: number; deferredVariants: number;
    d1Products: number; d1Variants: number; verifiedProducts: number; mappedVariants: number; blockedProducts: number;
    fileMappings: { unique: number; originalExact: number; targetExisting: number; printfulPreviewRehydrated: number; unresolved: number };
  };
  safety: {
    checkoutEnabled: boolean; livePaymentCaptureEnabled: boolean; fulfillmentEnabled: boolean;
    printfulOrderMode: string; commerceOrders: number; prohibitedCommerceOrders: number; wixSourceReadOnly: boolean; failClosed: boolean;
    printfulOrdersCreated: number; printfulWebhooksMutated: number;
  };
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
export function getCommerceLaunchPlan() { return adminApi<CommerceLaunchPlan>("/api/admin/commerce/launch"); }
export function applyCommerceCatalogueSellability(csrfToken: string) { return adminApi<{ ok: true }>("/api/admin/commerce/launch/catalogue-apply", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ confirmation: "APPLY ELIGIBLE SELLABILITY" }) }); }
export function activateCommerceLaunch(csrfToken: string, expectedRevision: number, confirmation: string) { return adminApi<CommerceLaunchPlan>("/api/admin/commerce/launch/activate", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ expectedRevision, confirmation }) }); }
export function pauseCommerceLaunch(csrfToken: string, expectedRevision: number, reason: string) { return adminApi<CommerceLaunchPlan>("/api/admin/commerce/launch/pause", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ expectedRevision, confirmation: "PAUSE LIVE COMMERCE", reason }) }); }
export function getPaymentsControlPlane() { return adminApi<PaymentsControlPlanePayload>("/api/admin/commerce/payments"); }
export function getFulfillmentShipping() { return adminApi<FulfillmentShippingPayload>("/api/admin/commerce/fulfillment"); }
export function verifyStripeConnection(csrfToken: string) {
  return adminApi<CommerceOverviewPayload>("/api/admin/commerce/stripe/verify", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
}
export function verifyPrintfulConnection(csrfToken: string) {
  return adminApi<CommerceOverviewPayload>("/api/admin/commerce/printful/verify", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
}
export function verifyPrintfulCatalogueSource(csrfToken: string) {
  return adminApi<PrintfulSourceVerificationPayload>("/api/admin/commerce/printful/catalogue/source/verify", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
}
export function getPermanentPrintfulMigration() {
  return adminApi<PermanentPrintfulMigrationPayload>("/api/admin/commerce/printful/catalogue/migration");
}
export function advancePermanentPrintfulMigration(csrfToken: string) {
  return adminApi<PermanentPrintfulMigrationPayload>("/api/admin/commerce/printful/catalogue/migrate", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ action: "continue_permanent_printful_migration" }) });
}
export async function executePermanentPrintfulMigration(csrfToken: string, onProgress?: (payload: PermanentPrintfulMigrationPayload) => void) {
  for (let step = 0; step < 20_000; step += 1) {
    const payload = await advancePermanentPrintfulMigration(csrfToken);
    onProgress?.(payload);
    if (["completed", "completed_with_blocked_products", "blocked"].includes(payload.migration.status)) return payload;
    const retryAt = payload.migration.retryAt || Date.now() + 750;
    await waitForMigration(retryAt, onProgress, payload);
  }
  throw new Error("The permanent Printful migration exceeded its bounded continuation budget.");
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
async function waitForMigration(retryAt: number, onProgress: ((payload: PermanentPrintfulMigrationPayload) => void) | undefined, payload: PermanentPrintfulMigrationPayload) {
  for (;;) {
    const remaining = Math.max(0, retryAt - Date.now());
    if (!remaining) return;
    onProgress?.({ ...payload, migration: { ...payload.migration, status: "waiting", providerState: "waiting", retryAt } });
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remaining)));
  }
}
export function getBusinessProfile() { return adminApi<BusinessPayload>("/api/admin/commerce/business"); }
export function saveBusinessProfile(csrfToken: string, body: Record<string, unknown>) {
  return adminApi<BusinessPayload>("/api/admin/commerce/business", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
}
export function getCommerceTemplates() { return adminApi<TemplatesPayload>("/api/admin/commerce/templates"); }
export function getCustomerEmailsControlPlane() { return adminApi<CustomerEmailsPayload>("/api/admin/commerce/emails"); }
export function getTaxRegistrations() { return adminApi<TaxPayload>("/api/admin/commerce/tax"); }
export function createTaxRegistration(csrfToken: string, body: Record<string, unknown>) { return adminApi<TaxPayload>("/api/admin/commerce/tax", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }); }
export function saveTaxRegistration(csrfToken: string, id: string, body: Record<string, unknown>) { return adminApi<TaxPayload>(`/api/admin/commerce/tax/${encodeURIComponent(id)}`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }); }
function commerceTemplateInput(template: CommerceTemplate): CommerceTemplate {
  return {
    templateKey: template.templateKey, templateKind: template.templateKind, displayName: template.displayName, subject: template.subject,
    preheader: template.preheader, heading: template.heading, introduction: template.introduction, bodyBlocks: template.bodyBlocks,
    ctaLabel: template.ctaLabel, ctaUrl: template.ctaUrl, supportText: template.supportText, footer: template.footer,
    accentColor: template.accentColor, status: template.status, enabled: template.enabled, revision: template.revision,
  };
}
export function saveCommerceTemplate(csrfToken: string, template: CommerceTemplate) {
  const body = commerceTemplateInput(template);
  return adminApi<TemplatesPayload>(`/api/admin/commerce/templates/${encodeURIComponent(template.templateKey)}`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
}
export function previewCommerceTemplate(csrfToken: string, template: CommerceTemplate, orderId?: string) { return adminApi<TemplatePreviewPayload>(`/api/admin/commerce/templates/${encodeURIComponent(template.templateKey)}/preview`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ template: commerceTemplateInput(template), ...(orderId ? { orderId } : {}) }) }); }
export function sendCommerceTemplateTest(csrfToken: string, templateKey: string, recipient: string, orderId?: string) { return adminApi<{ ok: true; duplicate: boolean; status: string; recipient: string }>(`/api/admin/commerce/templates/${encodeURIComponent(templateKey)}/send-test`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ recipient, ...(orderId ? { orderId } : {}) }) }); }
export function getMerchandisingProducts() { return adminApi<MerchandisingPayload>("/api/admin/commerce/products"); }
export function getMerchandisingProduct(productId: string) { return adminApi<MerchandisingProductPayload>(`/api/admin/commerce/products/${encodeURIComponent(productId)}`); }
export function getMerchandisingProductList(filters: ProductListFilters = {}) {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); });
  return adminApi<MerchandisingListPayload>(`/api/admin/commerce/products/list?${query.toString()}`);
}
export function bulkUpdateMerchandisingProducts(csrfToken: string, body: { operation: ProductBulkOperation; productIds: string[] } | { operation: ProductBulkOperation; matching: Omit<ProductListFilters, "page" | "pageSize">; confirmMatching: true; expectedCount: number }) {
  return adminApi<ProductBulkResult>("/api/admin/commerce/products/bulk", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
}
export function updateProductFeatured(csrfToken: string, productId: string, featured: boolean) {
  return adminApi<ProductFeaturedResult>(`/api/admin/commerce/products/${encodeURIComponent(productId)}/featured`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ featured }) });
}
export function getCollections() { return adminApi<CollectionsPayload>("/api/admin/commerce/collections"); }
export function getCollectionOptions() { return adminApi<CollectionOptionsPayload>("/api/admin/commerce/collections/options"); }
export function getCollectionList(filters: CollectionListFilters = {}) { const query = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return adminApi<CollectionListPayload>(`/api/admin/commerce/collections/list?${query.toString()}`); }
export function getCollectionDetail(collectionId: string) { return adminApi<CollectionDetailPayload>(`/api/admin/commerce/collections/${encodeURIComponent(collectionId)}`); }
export function getCollectionProducts(collectionId: string, filters: CollectionProductListFilters = {}) { const query = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return adminApi<CollectionProductListPayload>(`/api/admin/commerce/collections/${encodeURIComponent(collectionId)}/products/list?${query.toString()}`); }
export function bulkUpdateCollections(csrfToken: string, body: { operation: CollectionBulkOperation; collectionIds: string[] } | { operation: CollectionBulkOperation; matching: Omit<CollectionListFilters, "page" | "pageSize">; confirmMatching: true; expectedCount: number }) { return adminApi<CollectionBulkResult>("/api/admin/commerce/collections/bulk", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }); }
export function updateCollectionMemberships(csrfToken: string, collectionId: string, body: { operation: "add" | "remove"; productIds: string[]; revision: number }) { return adminApi<CollectionMembershipResult>(`/api/admin/commerce/collections/${encodeURIComponent(collectionId)}/products/bulk`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }); }
export function getCommerceOrders(filters: OrderListFilters = {}) { const query = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return adminApi<CommerceOrdersPayload>(`/api/admin/commerce/orders?${query.toString()}`); }
export function getCommerceOrder(orderId: string) { return adminApi<CommerceOrderDetailPayload>(`/api/admin/commerce/orders/${encodeURIComponent(orderId)}`); }
export function getCommerceCustomers(filters: CustomerListFilters = {}) { const query = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); }); return adminApi<CustomersPayload>(`/api/admin/commerce/customers?${query.toString()}`); }
export function getCommerceCustomer(customerId: string, page = 1, pageSize = 20) { return adminApi<CustomerDetailPayload>(`/api/admin/commerce/customers/${encodeURIComponent(customerId)}?page=${page}&pageSize=${pageSize}`); }
export function getOrderDocument(orderId: string, type: "receipt" | "invoice") { return adminApi<DocumentPreviewPayload>(`/api/admin/commerce/orders/${encodeURIComponent(orderId)}/documents/${type}`); }
export function generateControlledTestCheckout(csrfToken: string, body: { checkoutRequestId: string; productId: string; variantId: string; quantity: 1; recipient: { name: string; address1: string; address2?: string; city: string; region?: string; postalCode: string; countryCode: string; phone?: string }; quoteId: string; shippingOptionId: string }) {
  return adminApi<TestCheckoutPayload>("/api/admin/commerce/test-checkout", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
}
export function saveFeaturedProducts(csrfToken: string, featuredIds: string[]) {
  return adminApi<MerchandisingPayload>("/api/admin/commerce/products/featured", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ featuredIds }) });
}
export function saveMerchandisingProduct(csrfToken: string, productId: string, body: Record<string, unknown>) {
  return adminApi<MerchandisingProductPayload>(`/api/admin/commerce/products/${encodeURIComponent(productId)}`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
}
export function getCommerceMediaLimits() {
  return adminApi<{ ok: true; limits: CommerceMediaLimits }>("/api/admin/commerce/media/config");
}
export function ingestMerchandisingProductMedia(csrfToken: string, productId: string, imageUrls: string[]) {
  return adminApi<CommerceMediaIngestPayload>(`/api/admin/commerce/products/${encodeURIComponent(productId)}/media/ingest`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ imageUrls }) });
}
export function uploadMerchandisingProductMedia(csrfToken: string, productId: string, file: File) {
  const body = new FormData();
  body.set("image", file);
  return adminApi<CommerceMediaUploadPayload>(`/api/admin/commerce/products/${encodeURIComponent(productId)}/media/ingest`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body });
}
export function saveMerchandisingVariant(csrfToken: string, productId: string, variantId: string, body: Record<string, unknown>) {
  return adminApi<MerchandisingProductPayload>(`/api/admin/commerce/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
}
export function createCommerceCollection(csrfToken: string, body: Record<string, unknown>) { return adminApi<CollectionDetailPayload>("/api/admin/commerce/collections", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }); }
export function saveCommerceCollection(csrfToken: string, collectionId: string, body: Record<string, unknown>) { return adminApi<CollectionDetailPayload>(`/api/admin/commerce/collections/${encodeURIComponent(collectionId)}`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) }); }
export function saveCommerceCollectionOrder(csrfToken: string, collectionIds: string[]) { return adminApi<CollectionOptionsPayload>("/api/admin/commerce/collections/order", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ collectionIds }) }); }
export function saveCommerceCollectionProducts(csrfToken: string, collectionId: string, revision: number, productIds: string[]) { return adminApi<CollectionDetailPayload>(`/api/admin/commerce/collections/${encodeURIComponent(collectionId)}/products`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ revision, productIds }) }); }
export function saveProductCollections(csrfToken: string, productId: string, collectionIds: string[]) { return adminApi<MerchandisingProductPayload>(`/api/admin/commerce/products/${encodeURIComponent(productId)}/collections`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ collectionIds }) }); }
export function archiveCommerceCollection(csrfToken: string, collectionId: string, revision: number) { return adminApi<{ ok: true; collectionId: string; archived: true; assignmentsPreserved: true }>(`/api/admin/commerce/collections/${encodeURIComponent(collectionId)}/archive`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ revision, confirmArchive: true }) }); }
export function deleteCommerceCollection(csrfToken: string, collectionId: string) { return adminApi<{ ok: true; collectionId: string; deleted: true; productsDeleted: 0 }>(`/api/admin/commerce/collections/${encodeURIComponent(collectionId)}/delete`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ confirmDelete: true }) }); }

export function cadTextToMinorUnits(value: string) {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(normalized)) throw new Error("Enter a valid CAD amount with at most two decimal places.");
  const [whole, fraction = ""] = normalized.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100_000_000) throw new Error("Enter a CAD amount between CA$0.01 and CA$1,000,000.00.");
  return amount;
}

function chunks<T>(values: T[], size: number) {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("The catalogue snapshot returned an invalid chunk size.");
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}
