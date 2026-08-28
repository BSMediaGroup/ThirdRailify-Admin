import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useOutletContext } from "react-router-dom";
import trZapColorIcon from "../../assets/icons/trzapcolorcon.svg";
import { useAuth } from "../auth/AuthProvider";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { AdminIcon } from "../components/AdminIcon";
import {
  getBusinessProfile,
  getCommerceOverview,
  getCommerceOrders,
  generateControlledTestCheckout,
  getCommerceTemplates,
  getTaxRegistrations,
  createTaxRegistration,
  saveTaxRegistration,
  previewCommerceTemplate,
  sendCommerceTemplateTest,
  getOrderDocument,
  getMerchandisingProductList,
  getCollectionOptions,
  bulkUpdateMerchandisingProducts,
  ingestMerchandisingProductMedia,
  getCollections,
  executePermanentPrintfulMigration,
  getPermanentPrintfulMigration,
  saveBusinessProfile,
  saveCommerceTemplate,
  saveFeaturedProducts,
  saveMerchandisingProduct,
  saveMerchandisingVariant,
  createCommerceCollection,
  saveCommerceCollection,
  saveCommerceCollectionOrder,
  saveCommerceCollectionProducts,
  archiveCommerceCollection,
  deleteCommerceCollection,
  cadTextToMinorUnits,
  verifyStripeConnection,
  type BusinessPayload,
  type CommerceOverviewPayload,
  type CommerceOrdersPayload,
  type CommerceStatus,
  type CollectionsPayload,
  type CommerceCollection,
  type CommerceTemplate,
  type MerchandisingListPayload,
  type MerchandisingProduct,
  type MerchandisingVariant,
  type ProductBulkOperation,
  type ProductListFilters,
  type PermanentPrintfulMigrationPayload,
  type ProviderStatus,
  type TemplatesPayload,
  type TaxPayload,
  type TaxRegistration,
  type TemplatePreviewPayload,
  type CommerceDocument,
} from "../commerce/client";

const REQUIRED_POSTURE = [
  ["Commerce environment", "Staging"],
  ["Checkout engine", "Implemented / gated"],
  ["Public checkout", "Disabled"],
  ["Live payment capture", "Disabled"],
  ["Fulfillment submission", "Disabled"],
] as const;

const COMMERCE_WORKSPACES = [
  { to: "/commerce/payments", eyebrow: "Processor control", title: "Payments & payouts", text: "Dedicated Stripe merchant ownership, verified test API and webhook posture, and deferred PayPal status.", icon: "payments" },
  { to: "/commerce/business", eyebrow: "Merchant profile", title: "Business information", text: "Public storefront details kept separate from encrypted private Canadian fields.", icon: "business" },
  { to: "/commerce/tax", eyebrow: "Canadian custody", title: "Tax & documents", text: "BN and GST/HST custody with controlled invoice and receipt presentation.", icon: "tax" },
  { to: "/commerce/emails", eyebrow: "Lifecycle templates", title: "Customer emails", text: "Structured plain-text templates with delivery intentionally disabled.", icon: "emails" },
  { to: "/commerce/fulfillment", eyebrow: "Provider bridge", title: "Fulfillment integrations", text: "Printful draft-only migration planning with explicit submission gates.", icon: "fulfillment" },
] as const;

export function CommerceOverviewPage() {
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<CommerceOverviewPayload | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const stop = startLoading("Loading commerce posture"); setError("");
    try { setPayload(await getCommerceOverview()); }
    catch (reason) { setError(errorMessage(reason, "Commerce posture is unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  const stripe = payload?.providers.find((provider) => provider.provider === "stripe");
  const stripeOperational = Boolean(stripe?.status === "connected" && stripe.apiConfigured && stripe.webhookConfigured && stripe.webhookSigningConfigured);

  return <>
    <CommerceHeading eyebrow="Admin-only control plane" title="Commerce overview" summary={stripeOperational ? "The sandbox Checkout engine is implemented behind authoritative product and payment gates. The Canadian Stripe TEST API and signed webhook path are verified; Public checkout, live payments, and fulfillment remain disabled." : "The sandbox Checkout engine is implemented but remains fail-closed until its Stripe TEST API and signed webhook path are verified. Public checkout, live payments, and fulfillment remain disabled."} status="disabled" />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    <section className="commerce-section commerce-workspace-section" aria-labelledby="workspace-title">
      <SectionTitle id="workspace-title" eyebrow="Governed workspaces" title="Commerce control rooms" />
      <div className="commerce-link-grid">
        {COMMERCE_WORKSPACES.map((workspace, index) => <WorkspaceLink key={workspace.to} {...workspace} index={index + 1} />)}
      </div>
    </section>
    {!payload && !error ? <CommerceState>Loading truthful commerce status…</CommerceState> : payload ? <>
      <section className="commerce-posture" aria-label="Required safe posture">{REQUIRED_POSTURE.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
      <div className={`commerce-callout ${payload.databaseConfigured ? "is-pending" : "is-unavailable"}`} role="status">
        <AdminIcon name="shield" /><div><strong>{payload.databaseConfigured ? "Permanent commerce authority: Connected" : "Commerce D1 is not bound"}</strong><p>{payload.databaseConfigured ? "The replacement shop catalogue, order records, business controls, templates, and derived readiness gates use permanent Commerce D1 authority. This remains PRE-CUTOVER." : "Safe defaults are visible. Private fields and every mutation fail closed until the separate Admin-only database and encryption key are configured."}</p></div>
      </div>
      <section className="commerce-section" aria-labelledby="provider-status-title"><SectionTitle id="provider-status-title" eyebrow="Provider truth" title="Connections" /><div className="provider-card-grid">{payload.providers.map((provider) => <ProviderCard key={provider.provider} provider={provider} />)}</div></section>
      <section className="commerce-section" aria-labelledby="readiness-title"><SectionTitle id="readiness-title" eyebrow="Derived from actual configuration" title="Production readiness" />
        <div className={`commerce-callout ${payload.readiness?.productionReady ? "is-connected" : "is-unavailable"}`}><AdminIcon name="shield" /><div><strong>{payload.readiness?.productionReady ? "Production commerce is ready" : "Production commerce remains blocked"}</strong><p>Stripe TEST acceptance is permanent evidence, but it does not enable live payments, normal checkout, shipping, Printful fulfillment, or tax readiness.</p></div></div>
        <div className="provider-card-grid">{payload.readiness ? Object.entries(payload.readiness.domains).map(([key, domain]) => <article className="provider-card" key={key}><div><span>{humanize(key)}</span><StatusBadge status={domain.ready ? "connected" : "disabled"} label={domain.ready ? "Ready" : "Blocked"} /></div><p>{domain.summary}</p></article>) : null}</div>
        <div className="commerce-metric-grid"><Metric label="Catalogue" value={payload.readiness ? `${String(payload.readiness.domains.catalogue.details.publicProducts || 0)} public products` : "Unavailable"} /><Metric label="Stripe TEST acceptance" value={payload.readiness?.domains.payments.details.testAcceptancePassed === true ? "Passed" : "Not verified"} /><Metric label="Normal checkout" value="Disabled" /><Metric label="Live payments" value="Disabled" /><Metric label="Fulfillment" value="Disabled" /></div>
      </section>
    </> : null}
  </>;
}

export function PaymentsPayoutsPage() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<CommerceOverviewPayload | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const stop = startLoading("Loading Stripe connection status"); setError("");
    try { setPayload(await getCommerceOverview()); }
    catch (reason) { setError(errorMessage(reason, "Stripe connection status is unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  const stripe = payload?.providers.find((provider) => provider.provider === "stripe");
  const canManagePayments = Boolean(payload?.access.capabilities.includes("commerce.payments.manage"));
  const canVerify = Boolean(canManagePayments && payload?.databaseConfigured && payload.stripeSecretConfigured && csrfToken && !busy);
  const verify = async () => {
    if (!canVerify) return;
    const stop = startLoading("Verifying the Stripe test account"); setBusy(true); setError(""); setMessage("");
    try {
      const next = await verifyStripeConnection(csrfToken); setPayload(next); setMessage("Stripe test API connection verified for the Canadian CAD merchant account.");
    } catch (reason) { setError(errorMessage(reason, "Stripe account verification failed closed.")); }
    finally { setBusy(false); stop(); }
  };
  const connected = Boolean(stripe?.status === "connected" && stripe.apiConfigured && stripe.environment === "test");
  const webhookOperational = Boolean(stripe?.webhookConfigured && stripe.webhookSigningConfigured);
  const accountName = metadataText(stripe, "accountDisplayName") || "Third Railify Official";
  return <>
    <CommerceHeading eyebrow="Processor ownership" title="Payments & payouts" summary={connected && webhookOperational ? "The Canadian Stripe merchant test API is connected and a valid signed sandbox event has verified the webhook path. Checkout, live payments, fulfillment, and live payout readiness remain disabled or unverified." : connected ? "The Canadian Stripe merchant account is connected to the test API. The signed sandbox webhook path is not yet verified; Checkout, live payments, fulfillment, and live payout readiness remain disabled or unverified." : "The dedicated Third Railify Official Stripe account exists. Test API verification is available only through the protected server action; Checkout Sessions, live activation, fulfillment, and payout readiness remain unavailable."} status={connected ? "connected" : "setup_required"} statusLabel={connected ? "Test API connected" : undefined} />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {message && <div className="auth-success" role="status">{message}</div>}
    <section className="provider-detail-grid">
      <DetailCard title="Stripe" status={connected ? "connected" : "setup_required"} statusLabel={connected ? "Test API connected" : undefined} lead="Primary shop processor">
        <dl><Fact term="Dedicated merchant" value={accountName} /><Fact term="Account ID" value={compactAccountId(stripe?.externalAccountId)} /><Fact term="Country" value={stripe?.countryCode?.toUpperCase() === "CA" ? "Canada" : "Canada — awaiting verification"} /><Fact term="Currency" value={(stripe?.currencyCode || "CAD").toUpperCase()} /><Fact term="Stripe test API" value={connected ? "Connected" : "Verification pending"} /><Fact term="Environment" value="TEST" /><Fact term="Charges (test)" value={connected ? metadataBooleanLabel(stripe, "chargesEnabled") : "Not yet verified"} /><Fact term="Payouts (test)" value={connected ? metadataBooleanLabel(stripe, "payoutsEnabled") : "Not yet verified"} /><Fact term="Details submitted" value={connected ? metadataBooleanLabel(stripe, "detailsSubmitted") : "Not yet verified"} /><Fact term="Last synchronized" value={formatSynchronizedAt(stripe?.lastSynchronizedAt)} /><Fact term="Webhook endpoint" value={webhookOperational ? "Operational / configured" : stripe?.webhookEndpointReady ? "Ready for configuration" : "Unavailable"} /><Fact term="Webhook signing" value={webhookOperational ? "Configured / verified" : stripe?.webhookSigningConfigured ? "Configured — awaiting verified event" : "Not configured"} /><Fact term="Checkout engine" value="Implemented / gated" /><Fact term="Public checkout" value="Disabled" /><Fact term="Live payments" value="Disabled" /><Fact term="Live payout readiness" value="Unverified" /><Fact term="Fulfillment" value="Disabled" /></dl>
        {canManagePayments && <button type="button" className="secondary-button" onClick={() => void verify()} disabled={!canVerify}>{busy ? "Verifying…" : "Verify Stripe connection"}</button>}
        {canManagePayments && !payload?.databaseConfigured && <p className="commerce-action-note">Commerce D1 is required before verification.</p>}
        {canManagePayments && payload?.databaseConfigured && !payload.stripeSecretConfigured && <p className="commerce-action-note">A valid Stripe test server credential must be configured before verification.</p>}
      </DetailCard>
      <DetailCard title="PayPal" status="deferred" lead="Deferred direct-merchant REST model">
        <p>Later limited to donations and future VIP membership payments with Shawn’s PayPal Business credentials encrypted server-side. It is not the preferred shop processor.</p>
        <dl><Fact term="Credentials" value="Not configured" /><Fact term="Donations" value="Disabled" /><Fact term="VIP" value="Deferred" /><Fact term="Shop checkout" value="Not used" /></dl>
      </DetailCard>
      <DetailCard title="Wix Payments" status="legacy_production" lead="Legacy production authority">
        <p>The live Wix providers remain active and non-portable. Nothing in this Admin milestone disconnects, edits, or migrates them.</p>
      </DetailCard>
    </section>
    <div className={`commerce-callout ${connected ? "is-pending" : "is-unavailable"}`}><AdminIcon name="shield" /><div><strong>{connected && webhookOperational ? "Test API and signed webhook verified; activation remains disabled" : connected ? "Test identity verified; production remains disabled" : "Dedicated account confirmed; test verification pending"}</strong><p>{connected && webhookOperational ? "The server confirmed Canada/CAD and accepted a valid signed sandbox event. These configuration proofs do not enable Checkout, live charges, payout readiness, or fulfillment." : connected ? "The read-only test API check confirmed Canada and CAD. This does not establish live charges, payout readiness, a verified webhook, or Checkout." : "The server will verify only the configured test credential against Stripe’s current-account endpoint. Checkout remains disabled."}</p></div></div>
  </>;
}

export function BusinessInformationPage() { return <BusinessEditor mode="business" />; }
export function TaxDocumentsPage() { return <TaxDocumentsControlPlane />; }

function BusinessEditor({ mode }: { mode: "business" | "tax" }) {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<BusinessPayload | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const stop = startLoading("Loading commerce business profile"); setError("");
    try {
      const next = await getBusinessProfile(); setPayload(next); setForm(profileToForm(next));
    } catch (reason) { setError(errorMessage(reason, "Business configuration is restricted or unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  const canSave = Boolean(payload?.databaseConfigured && payload.encryptionConfigured && csrfToken && !busy);
  const update = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!canSave) return;
    const stop = startLoading("Saving encrypted commerce profile"); setBusy(true); setError(""); setMessage("");
    try {
      const next = await saveBusinessProfile(csrfToken, formToBusinessPayload(form));
      setPayload(next); setForm(profileToForm(next)); setMessage("Commerce business configuration saved with private fields encrypted.");
    } catch (reason) { setError(errorMessage(reason, "Business configuration could not be saved.")); }
    finally { setBusy(false); stop(); }
  };

  const taxMode = mode === "tax";
  return <>
    <CommerceHeading eyebrow={taxMode ? "Canadian identifiers and presentation" : "Merchant profile"} title={taxMode ? "Tax & documents" : "Business information"} summary={taxMode ? "Configure identifier custody and invoice/receipt presentation without custom tax calculations or compliance claims." : "Maintain public storefront details separately from encrypted legal, address, and tax information."} status={payload?.databaseConfigured ? "pending" : "unavailable"} />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {message && <div className="auth-success" role="status">{message}</div>}
    {!payload && !error ? <CommerceState>Loading business configuration…</CommerceState> : <form className="commerce-form" onSubmit={(event) => void submit(event)}>
      {!taxMode ? <>
        <Field label="Public trading name"><input value={form.tradingName || ""} onChange={(event) => update("tradingName", event.target.value)} required maxLength={160} /></Field>
        <Field label="Legal business name" hint="PRIVATE / DOCUMENT-ONLY — encrypted at rest."><input value={form.legalBusinessName || ""} onChange={(event) => update("legalBusinessName", event.target.value)} autoComplete="organization" maxLength={240} /></Field>
        <Field label="Country"><input value="Canada" disabled /></Field><Field label="Province"><input value="Ontario" disabled /></Field><Field label="Storefront currency"><input value="CAD" disabled /></Field>
        <Field label="Public contact email"><input type="email" value={form.publicContactEmail || ""} onChange={(event) => update("publicContactEmail", event.target.value)} /></Field>
        <Field label="Support email"><input type="email" value={form.supportEmail || ""} onChange={(event) => update("supportEmail", event.target.value)} /></Field>
        <Field label="Public phone"><input value={form.publicPhone || ""} onChange={(event) => update("publicPhone", event.target.value)} placeholder="Not confirmed" /></Field>
        <Field label="Website"><input type="url" value={form.websiteUrl || ""} onChange={(event) => update("websiteUrl", event.target.value)} /></Field>
        <Field label="Public address line 1"><input value={form.publicAddressLine1 || ""} onChange={(event) => update("publicAddressLine1", event.target.value)} placeholder="Not confirmed" /></Field>
        <Field label="Public address line 2"><input value={form.publicAddressLine2 || ""} onChange={(event) => update("publicAddressLine2", event.target.value)} /></Field>
        <Field label="Public city"><input value={form.publicCity || ""} onChange={(event) => update("publicCity", event.target.value)} /></Field>
        <Field label="Public postal code"><input value={form.publicPostalCode || ""} onChange={(event) => update("publicPostalCode", event.target.value)} /></Field>
        <Field label="Private business phone" hint="PRIVATE / DOCUMENT-ONLY"><input value={form.privatePhone || ""} onChange={(event) => update("privatePhone", event.target.value)} autoComplete="tel" maxLength={80} /></Field>
        <Field label="Business / registration number" hint="PRIVATE / DOCUMENT-ONLY"><input value={form.businessRegistrationNumber || ""} onChange={(event) => update("businessRegistrationNumber", event.target.value)} autoComplete="off" maxLength={100} /></Field>
        <Field label="Private address line 1" hint="PRIVATE / DOCUMENT-ONLY"><input value={form.privateAddressLine1 || ""} onChange={(event) => update("privateAddressLine1", event.target.value)} autoComplete="street-address" maxLength={180} /></Field>
        <Field label="Private address line 2"><input value={form.privateAddressLine2 || ""} onChange={(event) => update("privateAddressLine2", event.target.value)} maxLength={180} /></Field>
        <Field label="Private city"><input value={form.privateCity || ""} onChange={(event) => update("privateCity", event.target.value)} maxLength={120} /></Field>
        <Field label="Private province"><input value={form.privateProvince || ""} onChange={(event) => update("privateProvince", event.target.value)} maxLength={3} /></Field>
        <Field label="Private postal code"><input value={form.privatePostalCode || ""} onChange={(event) => update("privatePostalCode", event.target.value)} maxLength={12} /></Field>
        <Field label="Private country"><input value={form.privateCountry || ""} onChange={(event) => update("privateCountry", event.target.value)} maxLength={2} /></Field>
      </> : <>
        <Field label="Canadian Business Number" hint={maskedRegistration(payload, "business_number")}><input value={form.businessNumber || ""} onChange={(event) => update("businessNumber", event.target.value)} autoComplete="off" placeholder="Leave blank to preserve" /></Field>
        <Field label="GST/HST number" hint={maskedRegistration(payload, "gst_hst")}><input value={form.gstHstNumber || ""} onChange={(event) => update("gstHstNumber", event.target.value)} autoComplete="off" placeholder="Not confirmed" /></Field>
        <Field label="Ontario registration" hint={maskedRegistration(payload, "provincial")}><input value={form.provincialRegistration || ""} onChange={(event) => update("provincialRegistration", event.target.value)} autoComplete="off" placeholder="Optional" /></Field>
        <Field label="Tax provider state" hint="No provider or custom tax calculation is configured."><input value="Unavailable" disabled /></Field>
        <Field label="Invoice prefix"><input value={form.invoicePrefix || ""} onChange={(event) => update("invoicePrefix", event.target.value)} maxLength={24} placeholder="Not configured" /></Field>
        <Field label="Invoice accent"><input type="color" value={form.invoiceAccentColor || "#f3c928"} onChange={(event) => update("invoiceAccentColor", event.target.value)} /></Field>
        <Field label="Receipt accent"><input type="color" value={form.receiptAccentColor || "#f3c928"} onChange={(event) => update("receiptAccentColor", event.target.value)} /></Field>
        <Field className="commerce-field--wide" label="Invoice / receipt footer"><textarea value={form.documentFooter || ""} onChange={(event) => update("documentFooter", event.target.value)} rows={5} maxLength={1000} /></Field>
        <section className="document-preview" style={{ borderColor: form.invoiceAccentColor || "#f3c928" }} aria-label="Invoice branding preview"><p className="eyebrow">Invoice preview</p><h2>{form.tradingName || "Third Railify Official"}</h2><p>{form.invoicePrefix ? `${form.invoicePrefix}-[number assigned later]` : "Invoice numbering not configured"}</p><p>{form.documentFooter || "No legal or document footer has been approved."}</p><small>No tax calculation or compliance determination is performed.</small></section>
        <section className="document-preview" style={{ borderColor: form.receiptAccentColor || "#f3c928" }} aria-label="Receipt branding preview"><p className="eyebrow">Receipt preview</p><h2>{form.tradingName || "Third Railify Official"}</h2><p>Payment receipt number assigned by the authoritative payment workflow.</p><p>{form.documentFooter || "No legal or document footer has been approved."}</p><small>Branding only; payment truth remains provider-authoritative.</small></section>
      </>}
      <div className="commerce-form__actions commerce-field--wide"><button className="secondary-button" type="submit" disabled={!canSave}>{busy ? "Saving…" : "Save configuration"}</button><span>{!payload?.databaseConfigured ? "Unavailable until THIRDRAILIFY_COMMERCE_DB is bound." : !payload.encryptionConfigured ? "Unavailable until the 256-bit encryption key is configured." : "Authenticated, CSRF-protected, rate-limited, and audited."}</span></div>
    </form>}
  </>;
}

function TaxDocumentsControlPlane() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [tax, setTax] = useState<TaxPayload | null>(null);
  const [templates, setTemplates] = useState<TemplatesPayload | null>(null);
  const [form, setForm] = useState({ registrationType: "gst_hst", jurisdiction: "CA", countryCode: "CA", provinceCode: "", identifier: "", status: "unverified", effectiveDate: "", expiresAt: "", notes: "", documentDisclosureEnabled: false });
  const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { const stop = startLoading("Loading tax and document controls"); setError(""); try { const [nextTax, nextTemplates] = await Promise.all([getTaxRegistrations(), getCommerceTemplates()]); setTax(nextTax); setTemplates(nextTemplates); } catch (reason) { setError(errorMessage(reason, "Tax and document controls are unavailable.")); } finally { stop(); } }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!csrfToken || busy) return; setBusy(true); setError(""); setMessage(""); try { setTax(await createTaxRegistration(csrfToken, form)); setForm((current) => ({ ...current, identifier: "", notes: "", effectiveDate: "", expiresAt: "" })); setMessage("Tax registration saved with its identifier encrypted and masked."); } catch (reason) { setError(errorMessage(reason, "The tax registration could not be saved.")); } finally { setBusy(false); } };
  const deactivate = async (registration: TaxRegistration) => { if (!csrfToken || busy) return; setBusy(true); setError(""); try { setTax(await saveTaxRegistration(csrfToken, registration.id, { registrationType: registration.registrationType, jurisdiction: registration.jurisdiction, countryCode: registration.countryCode, provinceCode: registration.provinceCode || "", identifier: "", status: "inactive", effectiveDate: registration.effectiveDate || "", expiresAt: registration.expiresAt || "", notes: registration.notes, documentDisclosureEnabled: registration.documentDisclosureEnabled, revision: registration.revision })); setMessage("Tax registration deactivated without exposing its identifier."); } catch (reason) { setError(errorMessage(reason, "The tax registration could not be updated.")); } finally { setBusy(false); } };
  const saveDocument = async (template: CommerceTemplate) => { if (!csrfToken) return; setError(""); try { const next = await saveCommerceTemplate(csrfToken, template); setTemplates(next); setMessage(`${template.displayName} template saved.`); } catch (reason) { setError(errorMessage(reason, "The document template could not be saved.")); } };
  return <>
    <CommerceHeading eyebrow="Operator configuration authority" title="Tax & documents" summary="Manage encrypted tax registrations and structured receipt/invoice templates without guessed rates or tax-compliance claims." status={tax?.readiness.ready ? "connected" : "disabled"} statusLabel={tax?.readiness.ready ? "Configured" : "Production blocked"} />
    {error && <div className="admin-alert" role="alert">{error}</div>}{message && <div className="auth-success" role="status">{message}</div>}
    <section className="commerce-posture" aria-label="Tax readiness"><div><span>Tax registrations</span><strong>{tax?.registrations.length ? "Configured by operator" : "Not configured"}</strong></div><div><span>Tax calculation provider</span><strong>Unconfigured</strong></div><div><span>Stripe Tax</span><strong>Not enabled / unverified</strong></div><div><span>Production tax readiness</span><strong>Blocked</strong></div></section>
    <section className="commerce-section" aria-labelledby="tax-registration-title"><SectionTitle id="tax-registration-title" eyebrow="Encrypted identifier custody" title="Tax registrations" />
      {tax?.registrations.length ? <div className="provider-card-grid">{tax.registrations.map((registration) => <article className="provider-card" key={registration.id}><div><span>{humanize(registration.registrationType)}</span><StatusBadge status={["active", "verified"].includes(registration.status) ? "connected" : "pending"} label={humanize(registration.status)} /></div><dl><Fact term="Jurisdiction" value={registration.jurisdiction} /><Fact term="Identifier" value={registration.maskedIdentifier} /><Fact term="Effective" value={registration.effectiveDate || "Not configured"} /><Fact term="Expiry" value={registration.expiresAt || "Not configured"} /><Fact term="Document disclosure" value={registration.documentDisclosureEnabled ? "Operator enabled" : "Disabled"} /></dl>{registration.status !== "inactive" && <button type="button" className="secondary-button" disabled={busy} onClick={() => void deactivate(registration)}>Deactivate</button>}</article>)}</div> : <CommerceState><strong>No tax registrations configured.</strong><span>No registration status, identifier, or tax rate has been invented.</span></CommerceState>}
      <form className="commerce-form" onSubmit={(event) => void submit(event)}>
        <Field label="Registration type"><select value={form.registrationType} onChange={(event) => setForm({ ...form, registrationType: event.target.value })}><option value="gst_hst">GST/HST</option><option value="qst">QST</option><option value="pst">PST</option><option value="rst">RST</option><option value="other">Other</option></select></Field>
        <Field label="Jurisdiction"><input value={form.jurisdiction} onChange={(event) => setForm({ ...form, jurisdiction: event.target.value })} required maxLength={80} /></Field><Field label="Country code"><input value={form.countryCode} onChange={(event) => setForm({ ...form, countryCode: event.target.value })} required maxLength={2} /></Field><Field label="Province / state"><input value={form.provinceCode} onChange={(event) => setForm({ ...form, provinceCode: event.target.value })} maxLength={3} /></Field>
        <Field label="Registration identifier" hint="Encrypted after save; ordinary projections show only a mask."><input value={form.identifier} onChange={(event) => setForm({ ...form, identifier: event.target.value })} required autoComplete="off" maxLength={100} /></Field><Field label="Status"><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="unverified">Unverified</option><option value="pending">Pending</option><option value="verified">Verified by operator</option><option value="active">Active per operator</option><option value="not_registered">Not registered</option></select></Field>
        <Field label="Effective date"><input type="date" value={form.effectiveDate} onChange={(event) => setForm({ ...form, effectiveDate: event.target.value })} /></Field><Field label="End / expiry date"><input type="date" value={form.expiresAt} onChange={(event) => setForm({ ...form, expiresAt: event.target.value })} /></Field><Field className="commerce-field--wide" label="Notes / reference"><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={3} maxLength={1000} /></Field>
        <label className="commerce-toggle commerce-field--wide"><input type="checkbox" checked={form.documentDisclosureEnabled} onChange={(event) => setForm({ ...form, documentDisclosureEnabled: event.target.checked })} /><span>Allow this registration’s masked disclosure state on documents after legal review</span></label>
        <div className="commerce-form__actions commerce-field--wide"><button className="secondary-button" type="submit" disabled={!csrfToken || busy}>{busy ? "Saving…" : "Add encrypted registration"}</button><span>This configuration does not calculate rates or determine legal obligations.</span></div>
      </form>
    </section>
    <section className="commerce-section" aria-labelledby="document-template-title"><SectionTitle id="document-template-title" eyebrow="Structured document authority" title="Receipt and invoice templates" /><div className="provider-detail-grid">{templates?.templates.filter((template) => template.templateKind === "document").map((template) => <DocumentTemplateEditor key={template.templateKey} template={template} onSave={saveDocument} />)}</div></section>
  </>;
}

function DocumentTemplateEditor({ template, onSave }: { template: CommerceTemplate; onSave: (template: CommerceTemplate) => Promise<void> }) {
  const [draft, setDraft] = useState(template); useEffect(() => setDraft(template), [template]);
  const change = <K extends keyof CommerceTemplate>(key: K, value: CommerceTemplate[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return <form className="provider-detail commerce-form" onSubmit={(event) => { event.preventDefault(); void onSave(draft); }}><header><div><p>Structured · revision {draft.revision}</p><h2>{draft.displayName}</h2></div><StatusBadge status={draft.enabled && draft.status === "ready" ? "connected" : "pending"} label={draft.enabled && draft.status === "ready" ? "Ready" : "Draft"} /></header><Field label="Display name"><input value={draft.displayName} onChange={(event) => change("displayName", event.target.value)} required /></Field><Field label="Document title"><input value={draft.heading} onChange={(event) => change("heading", event.target.value)} required /></Field><Field className="commerce-field--wide" label="Introduction"><textarea value={draft.introduction} onChange={(event) => change("introduction", event.target.value)} rows={3} /></Field><Field className="commerce-field--wide" label="Structured line blocks" hint="Allowed variables include order_reference, product_summary, order_total, currency, merchant_name, and support_email."><textarea value={draft.bodyBlocks.join("\n")} onChange={(event) => change("bodyBlocks", event.target.value.split("\n").slice(0, 8))} rows={4} /></Field><Field className="commerce-field--wide" label="Footer"><textarea value={draft.footer} onChange={(event) => change("footer", event.target.value)} rows={3} /></Field><Field label="Status"><select value={draft.status} onChange={(event) => change("status", event.target.value as CommerceTemplate["status"])}><option value="draft">Draft</option><option value="ready">Ready</option><option value="disabled">Disabled</option></select></Field><label className="commerce-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => change("enabled", event.target.checked)} /><span>Enabled</span></label><button className="secondary-button" type="submit">Save document template</button><small>{draft.templateKey === "invoice_document" ? "Invoice readiness remains blocked until legal business and tax configuration are complete." : "Receipt rendering uses the immutable paid-order snapshot."}</small></form>;
}

export function CustomerEmailsPage() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<TemplatesPayload | null>(null);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<CommerceTemplate | null>(null);
  const [preview, setPreview] = useState<TemplatePreviewPayload | null>(null);
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const stop = startLoading("Loading commerce templates"); setError("");
    try {
      const next = await getCommerceTemplates(); setPayload(next);
      const emailTemplates = next.templates.filter((item) => item.templateKind === "email");
      const key = selected || emailTemplates[0]?.templateKey || ""; setSelected(key); setDraft(emailTemplates.find((item) => item.templateKey === key) || null);
    } catch (reason) { setError(errorMessage(reason, "Customer email templates are restricted or unavailable.")); }
    finally { stop(); }
  }, [selected, startLoading]);
  useEffect(() => { void load(); }, [load]);
  const choose = (key: string) => { setSelected(key); setDraft(payload?.templates.find((item) => item.templateKey === key) || null); setPreview(null); setMessage(""); };
  const change = <K extends keyof CommerceTemplate>(key: K, value: CommerceTemplate[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!draft || !csrfToken || !payload?.databaseConfigured) return;
    const stop = startLoading("Saving structured email template"); setError(""); setMessage("");
    try { const next = await saveCommerceTemplate(csrfToken, draft); setPayload(next); setDraft(next.templates.find((item) => item.templateKey === draft.templateKey) || draft); setMessage("Draft template saved. No email was sent."); }
    catch (reason) { setError(errorMessage(reason, "The template could not be saved.")); }
    finally { stop(); }
  };
  const renderPreview = async (orderId?: string) => { if (!draft || !csrfToken) return; setError(""); try { setPreview(await previewCommerceTemplate(csrfToken, draft, orderId)); } catch (reason) { setError(errorMessage(reason, "The safe template preview could not be rendered.")); } };
  const sendTest = async () => { if (!draft || !csrfToken || !recipient) return; setError(""); setMessage(""); try { const result = await sendCommerceTemplateTest(csrfToken, draft.templateKey, recipient); setMessage(result.duplicate ? "The deterministic TEST/PREVIEW delivery had already been sent; no duplicate was created." : `TEST/PREVIEW email sent to ${result.recipient}.`); } catch (reason) { setError(errorMessage(reason, "The protected test email could not be sent.")); } };
  return <>
    <CommerceHeading eyebrow="Structured plain text" title="Customer emails" summary="Edit seven permanent lifecycle templates with an explicit merge-variable allowlist, same-engine preview, and protected idempotent TEST/PREVIEW delivery." status={payload?.databaseConfigured ? "pending" : "unavailable"} />
    <div className="commerce-callout is-pending"><AdminIcon name="emails" /><div><strong>Community lifecycle templates are now first-class</strong><p>GOATS submission, Admin alert, approval, and rejection templates use their own idempotent outbox and documented variables.</p><Link className="text-link" to="/goats/emails">Open GOATS email templates <AdminIcon name="arrow" size={15} /></Link></div></div>
    {error && <div className="admin-alert" role="alert">{error}</div>}{message && <div className="auth-success" role="status">{message}</div>}
    {payload && draft ? <div className="template-workspace"><nav aria-label="Email template types">{payload.templates.filter((template) => template.templateKind === "email").map((template) => <button type="button" key={template.templateKey} className={template.templateKey === selected ? "is-active" : ""} onClick={() => choose(template.templateKey)}><span>{template.displayName}</span><small>{template.enabled ? `${template.status} · enabled` : template.status}</small></button>)}</nav>
      <div className="template-workspace__editor">
        <form className="commerce-form" onSubmit={(event) => void submit(event)}>
          <Field label="Display name"><input value={draft.displayName} onChange={(event) => change("displayName", event.target.value)} required maxLength={120} /></Field><Field label="Enabled"><select value={draft.enabled ? "enabled" : "disabled"} onChange={(event) => change("enabled", event.target.value === "enabled")}><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select></Field>
          <Field className="commerce-field--wide" label="Subject"><input value={draft.subject} onChange={(event) => change("subject", event.target.value)} required maxLength={160} /></Field>
          <Field label="Preheader"><input value={draft.preheader} onChange={(event) => change("preheader", event.target.value)} maxLength={200} /></Field>
          <Field label="Heading"><input value={draft.heading} onChange={(event) => change("heading", event.target.value)} required maxLength={160} /></Field>
          <Field className="commerce-field--wide" label="Introduction"><textarea value={draft.introduction} onChange={(event) => change("introduction", event.target.value)} rows={3} maxLength={1000} /></Field>
          <Field className="commerce-field--wide" label="Body blocks" hint="One plain-text block per line; maximum eight."><textarea value={draft.bodyBlocks.join("\n")} onChange={(event) => change("bodyBlocks", event.target.value.split("\n").slice(0, 8))} rows={6} /></Field>
          <Field label="CTA label"><input value={draft.ctaLabel} onChange={(event) => change("ctaLabel", event.target.value)} maxLength={80} /></Field><Field label="CTA URL"><input value={draft.ctaUrl} onChange={(event) => change("ctaUrl", event.target.value)} placeholder="HTTPS or /relative" /></Field>
          <Field label="Support text"><textarea value={draft.supportText} onChange={(event) => change("supportText", event.target.value)} rows={3} /></Field><Field label="Footer"><textarea value={draft.footer} onChange={(event) => change("footer", event.target.value)} rows={3} /></Field>
          <Field label="Accent"><input type="color" value={draft.accentColor} onChange={(event) => change("accentColor", event.target.value)} /></Field><Field label="State"><select value={draft.status} onChange={(event) => change("status", event.target.value as CommerceTemplate["status"])}><option value="draft">Draft</option><option value="disabled">Disabled</option><option value="ready">Ready for later review</option></select></Field>
          <div className="commerce-form__actions commerce-field--wide"><button className="secondary-button" type="submit" disabled={!payload.databaseConfigured}>Save template</button><button className="secondary-button" type="button" onClick={() => void renderPreview()}>Preview synthetic fixture</button><button className="secondary-button" type="button" onClick={() => void renderPreview("ord_e47b94a4-4252-438b-8ca7-c47470029940")}>Preview paid TEST order</button><span>Allowed variables: order_reference, customer_name, merchant_name, order_total, currency, product_summary, support_email, receipt_url, shipping_method, tracking_number.</span></div>
          <Field className="commerce-field--wide" label="Explicit test recipient" hint="Authenticated, capability-checked, CSRF and exact-origin protected, rate-limited, audited, and deterministic."><input type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="admin@example.com" /></Field><div className="commerce-form__actions commerce-field--wide"><button className="secondary-button" type="button" disabled={!recipient} onClick={() => void sendTest()}>Send TEST/PREVIEW email</button><span>No email is sent during preview or save.</span></div>
        </form>
        <EmailTemplatePreview template={draft} preview={preview} />
      </div>
    </div> : !error && <CommerceState>Loading template editor…</CommerceState>}
  </>;
}

function EmailTemplatePreview({ template, preview }: { template: CommerceTemplate; preview: TemplatePreviewPayload | null }) {
  const rendered = preview?.preview || template;
  const bodyBlocks = rendered.bodyBlocks.filter((block) => block.trim());
  const titleId = `email-template-preview-${template.templateKey}`;
  return <section className="email-template-preview" aria-labelledby={titleId}>
    <header className="email-template-preview__toolbar">
      <div><p className="eyebrow">Rendered preview</p><h2 id={titleId}>{humanize(template.templateKey)}</h2></div>
      <span>{preview ? `${preview.test ? "TEST" : "LIVE"} · ${humanize(preview.source)}` : "Preview not rendered"}</span>
    </header>
    <div className="email-template-preview__inbox">
      <span>Subject</span>
      <strong>{rendered.subject || "Render a preview to merge variables"}</strong>
      <small>{rendered.preheader || "No preheader configured."}</small>
    </div>
    <article className="email-template-preview__message" style={{ borderColor: rendered.accentColor }}>
      <header className="email-template-preview__brand">
        <img src={trZapColorIcon} alt="" />
        <div><strong>THIRD RAILIFY OFFICIAL</strong><span>Customer notification</span></div>
      </header>
      <div className="email-template-preview__accent" style={{ backgroundColor: rendered.accentColor }} />
      <div className="email-template-preview__body">
        <p className="email-template-preview__type" style={{ color: rendered.accentColor }}>{template.displayName}</p>
        <h3>{rendered.heading || "Email heading"}</h3>
        {rendered.introduction ? <p>{rendered.introduction}</p> : <p className="is-placeholder">Introduction not configured.</p>}
        {bodyBlocks.length ? <div className="email-template-preview__blocks">{bodyBlocks.map((block, index) => <p key={`${index}-${block}`}>{block}</p>)}</div> : <p className="is-placeholder">No body blocks configured.</p>}
        {rendered.ctaLabel && <div className="email-template-preview__action"><span style={{ backgroundColor: rendered.accentColor }}>{rendered.ctaLabel}</span>{rendered.ctaUrl && <small>{rendered.ctaUrl}</small>}</div>}
        {rendered.supportText && <p className="email-template-preview__support">{rendered.supportText}</p>}
      </div>
      <footer><p>{rendered.footer || "Third Railify Official"}</p><small>{preview ? "Rendered by the production template engine — no email has been sent." : "Choose a safe preview source to render variables."}</small></footer>
    </article>
  </section>;
}

export function FulfillmentIntegrationsPage() {
  const { csrfToken, access } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<CommerceOverviewPayload | null>(null);
  const [migration, setMigration] = useState<PermanentPrintfulMigrationPayload | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const migrationLoopRunning = useRef(false);
  const load = useCallback(async () => {
    const stop = startLoading("Loading Printful connection status"); setError("");
    try {
      setPayload(await getCommerceOverview());
      if (access.isMasterAdmin) setMigration(await getPermanentPrintfulMigration());
    }
    catch (reason) { setError(errorMessage(reason, "Printful connection status is unavailable.")); }
    finally { stop(); }
  }, [access.isMasterAdmin, startLoading]);
  useEffect(() => { void load(); }, [load]);
  const continueMigration = useCallback(async () => {
    if (!csrfToken || !access.isMasterAdmin || migrationLoopRunning.current) return;
    migrationLoopRunning.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await executePermanentPrintfulMigration(csrfToken, setMigration);
      setMigration(next);
      if (["completed", "completed_with_blocked_products"].includes(next.migration.status)) setMessage(next.migration.status === "completed" ? "PERMANENT CATALOGUE MIGRATED" : "CATALOGUE MIGRATED WITH BLOCKED PRODUCTS RECORDED");
      else if (next.migration.status === "blocked") setError(next.migration.lastError?.message || "The migration stopped safely on a provider or identity conflict.");
    }
    catch (reason) { setError(errorMessage(reason, "The permanent Printful migration paused safely. Reload this page to resume from D1.")); }
    finally { migrationLoopRunning.current = false; setBusy(false); }
  }, [access.isMasterAdmin, csrfToken]);
  const state = migration?.migration;
  const catalogue = migration?.catalogue;
  const safety = migration?.safety;
  const migrationComplete = Boolean(state && ["completed", "completed_with_blocked_products"].includes(state.status));
  const canExecute = Boolean(access.isMasterAdmin && csrfToken && payload?.databaseConfigured && payload.printfulSecretConfigured && safety?.failClosed && state && ["ready", "running", "waiting"].includes(state.status) && !busy);
  const canResume = Boolean(access.isMasterAdmin && csrfToken && payload?.databaseConfigured && payload.printfulSecretConfigured && state?.status === "blocked" && state.canResume && !busy);
  return <>
    <CommerceHeading eyebrow="Permanent catalogue authority" title="Fulfillment integrations" summary="The accepted 49-product Wix catalogue is loaded in Commerce D1 and ready for a resumable migration to the permanent native Printful store. The legacy Wix source is read only; checkout and fulfillment remain disabled." status={migrationComplete ? "connected" : state?.status === "blocked" ? "error" : "pending"} statusLabel={migrationComplete ? "Permanent catalogue migrated" : state?.status === "blocked" ? "Migration blocked safely" : "Ready for permanent migration"} />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {message && <div className="auth-success" role="status">{message}</div>}
    <section className="provider-detail-grid">
      <DetailCard title="Permanent target" status={state?.targetVerified ? "connected" : "pending"} statusLabel={state?.targetVerified ? "Token accepted" : "Verified before first write"} lead="Third Railify API"><dl><Fact term="Store ID" value="18668025" /><Fact term="Store type" value="native" /><Fact term="Credential" value={payload?.printfulSecretConfigured ? "Configured / server only" : "Not configured"} /><Fact term="Product write scope" value={state?.scopes ? "Verified" : "Pending protected preflight"} /><Fact term="Planned creates" value={String(catalogue?.plannedProductCreates ?? 49)} /><Fact term="Existing target-native keep" value={String(catalogue?.targetNativeKeeps ?? 1)} /><Fact term="Order mode" value={safety?.printfulOrderMode === "draft_only" ? "Draft only" : "Unsafe / unknown"} /><Fact term="Checkout" value={safety?.checkoutEnabled ? "Unsafe / unknown" : "Disabled"} /><Fact term="Fulfillment" value={safety?.fulfillmentEnabled ? "Unsafe / unknown" : "Disabled"} /><Fact term="Webhooks" value="Not configured" /></dl></DetailCard>
      <DetailCard title="Legacy source" status="legacy_production" statusLabel="Read only" lead="Third Railify Official"><dl><Fact term="Store ID" value="16847493" /><Fact term="Store type" value="wix" /><Fact term="Credential use" value="GET only" /><Fact term="Allowed reads" value="Sync product / Sync Variant / original file" /><Fact term="Write access used" value="None" /><Fact term="Wix storefront" value="Live / untouched" /></dl></DetailCard>
      <DetailCard title="Permanent D1 catalogue" status="connected" statusLabel="Authoritative" lead="Accepted evidence / 2026-08-28"><dl><Fact term="D1 products" value={String(catalogue?.d1Products ?? 50)} /><Fact term="D1 variants" value={String(catalogue?.d1Variants ?? 1323)} /><Fact term="Planned target creates" value={String(catalogue?.plannedProductCreates ?? 49)} /><Fact term="Eligible variants" value={String(catalogue?.eligibleVariants ?? 1317)} /><Fact term="Deferred variants" value={String(catalogue?.deferredVariants ?? 5)} /><Fact term="Manual review" value="1 — Raider's Goblet excluded" /><Fact term="Maximum variants / product" value="96 / 100" /><Fact term="My Balloon" value="Preserved private / non-sellable" /></dl></DetailCard>
      <DetailCard title="Permanent Printful migration" status={migrationComplete ? "connected" : state?.status === "blocked" ? "error" : "pending"} statusLabel={state?.manuallyPaused ? "Paused" : humanize(state?.status || "ready")} lead={state?.currentProduct?.title || "Server-owned D1 queue"}><dl>
        <Fact term="Processed" value={`${state?.processedProducts ?? state?.completedProducts ?? 0} / ${state?.totalProducts ?? 49}`} /><Fact term="Verified" value={String(catalogue?.verifiedProducts ?? state?.productsCreated ?? 0)} /><Fact term="Remaining" value={String(state?.remainingProducts ?? Math.max(0, (state?.totalProducts ?? 49) - (state?.completedProducts ?? 0)))} /><Fact term="Current phase" value={humanize(state?.phase || "ready")} /><Fact term="File resolution" value={state?.fileProgress ? `${state.fileProgress.resolved} / ${state.fileProgress.total}` : "Awaiting current product"} /><Fact term="Provider state" value={state?.manuallyPaused ? "Paused" : humanize(state?.providerState || "ready")} />
        <Fact term="Products created" value={String(state?.productsCreated ?? 0)} /><Fact term="Products adopted" value={String(state?.productsAdopted ?? 0)} /><Fact term="Blocked" value={String(catalogue?.blockedProducts ?? 0)} /><Fact term="Variants mapped" value={String(state?.variantsMapped ?? 0)} />
        <Fact term="Unique file mappings" value={String(catalogue?.fileMappings?.unique ?? 0)} /><Fact term="Original / exact artwork" value={String(catalogue?.fileMappings?.originalExact ?? 0)} /><Fact term="Target-existing files" value={String(catalogue?.fileMappings?.targetExisting ?? 0)} /><Fact term="Printful previews rehydrated" value={String(catalogue?.fileMappings?.printfulPreviewRehydrated ?? 0)} /><Fact term="Unresolved artwork" value={String(catalogue?.fileMappings?.unresolved ?? 0)} />
        <Fact term="Provider failures" value={String(state?.providerFailures ?? 0)} /><Fact term="Error code" value={state?.lastError?.code || "None"} /><Fact term="D1 mapping state" value={state?.checkpointState ? humanize(state.checkpointState) : "Checkpointed"} />
      </dl>
        <div className={`catalogue-snapshot-state is-${state?.status || "ready"}`} aria-live="polite"><strong>{migrationComplete ? "PERMANENT CATALOGUE MIGRATED" : state?.status === "blocked" && state.canResume ? "PERMANENT MIGRATION — BLOCKED — CHECKPOINTED" : state?.status === "blocked" ? "MIGRATION STOPPED SAFELY" : ["running", "waiting"].includes(state?.status || "") ? "PERMANENT MIGRATION — CHECKPOINTED" : "READY FOR PERMANENT MIGRATION"}</strong><p>{state?.lastError?.message || (migrationComplete ? "All provider-accepted products and active variants are verified and mapped in Commerce D1; any individual artwork blocks are recorded for review. Checkout and fulfillment remain disabled." : "The server resolves source artwork through target IDs, original provider URLs, exact local recovery, or target-side Printful preview rehydration, and checkpoints all progress in D1.")}</p></div>
        {access.isMasterAdmin && state && ["ready", "running", "waiting"].includes(state.status) && <button type="button" className="secondary-button" onClick={() => void continueMigration()} disabled={!canExecute}>{state.status === "ready" ? "EXECUTE PERMANENT PRINTFUL CATALOGUE MIGRATION" : "CONTINUE PERMANENT PRINTFUL MIGRATION FROM CHECKPOINT"}</button>}
        {access.isMasterAdmin && state?.status === "blocked" && state.canResume && <button type="button" className="secondary-button" onClick={() => void continueMigration()} disabled={!canResume}>RESUME PERMANENT PRINTFUL CATALOGUE MIGRATION</button>}
        {busy && <p className="commerce-action-note">This browser run is continuing automatically. Rate limits and file-processing waits are honored until it completes or the page is closed.</p>}
        {!access.isMasterAdmin && <p className="commerce-action-note">Master Admin authority is required for this provider-write migration.</p>}
      </DetailCard>
    </section>
    {!payload && !error && <CommerceState>Loading truthful Printful status…</CommerceState>}
    <section className="transaction-model" aria-labelledby="transaction-model-title"><p className="eyebrow">Safety remains locked</p><h2 id="transaction-model-title">Catalogue migration does not activate orders</h2><div><article><span>01</span><strong>Customer checkout</strong><p>{safety?.checkoutEnabled ? "Unexpectedly enabled" : "Disabled"}; live payment capture remains {safety?.livePaymentCaptureEnabled ? "unexpectedly enabled" : "disabled"}.</p></article><article><span>02</span><strong>Printful fulfillment</strong><p>{safety?.fulfillmentEnabled ? "Unexpectedly enabled" : "Disabled"}; no order or webhook mutation is part of this migration.</p></article></div></section>
  </>;
}

export function CommerceProductsPage() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<MerchandisingListPayload | null>(null);
  const [featuredBrowser, setFeaturedBrowser] = useState<MerchandisingListPayload | null>(null);
  const [collections, setCollections] = useState<CommerceCollection[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<MerchandisingProduct | null>(null);
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState("all");
  const [status, setStatus] = useState("all");
  const [migration, setMigration] = useState("all");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<ProductListFilters["sort"]>("display");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 75 | 100>(20);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [allMatching, setAllMatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingVisibility, setPendingVisibility] = useState<string[]>([]);
  const [featuredIds, setFeaturedIds] = useState<string[]>([]);
  const [featuredQuery, setFeaturedQuery] = useState("");
  const [featuredFilter, setFeaturedFilter] = useState<"all" | "featured" | "not_featured">("not_featured");
  const [featuredPage, setFeaturedPage] = useState(1);
  const [savingFeatured, setSavingFeatured] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mainRequest = useRef(0);
  const featuredRequest = useRef(0);
  const featuredAuthority = useRef("");
  const mainFilters = useMemo<ProductListFilters>(() => ({ page, pageSize, query, visibility, status, migration, category, sort }), [category, migration, page, pageSize, query, sort, status, visibility]);
  const matchingFilters = useMemo<Omit<ProductListFilters, "page" | "pageSize">>(() => ({ query, visibility, status, migration, category, featured: "all", sort }), [category, migration, query, sort, status, visibility]);

  const loadMain = useCallback(async () => {
    const requestId = ++mainRequest.current;
    const stop = startLoading("Loading authoritative products");
    setError("");
    try {
      const next = await getMerchandisingProductList(mainFilters);
      if (requestId === mainRequest.current) {
        setPayload(next);
        if (next.page !== page) setPage(next.page);
      }
    } catch (reason) {
      if (requestId === mainRequest.current) setError(errorMessage(reason, "Product merchandising is unavailable."));
    } finally {
      stop();
    }
  }, [mainFilters, page, startLoading]);
  const loadFeaturedBrowser = useCallback(async () => {
    const requestId = ++featuredRequest.current;
    try {
      const next = await getMerchandisingProductList({ page: featuredPage, pageSize: 20, query: featuredQuery, featured: featuredFilter, sort: "display" });
      if (requestId === featuredRequest.current) {
        setFeaturedBrowser(next);
        if (next.page !== featuredPage) setFeaturedPage(next.page);
      }
    } catch (reason) {
      if (requestId === featuredRequest.current) setError(errorMessage(reason, "The featured catalogue browser is unavailable."));
    }
  }, [featuredFilter, featuredPage, featuredQuery]);
  useEffect(() => { void loadMain(); }, [loadMain, refreshKey]);
  useEffect(() => { void loadFeaturedBrowser(); }, [loadFeaturedBrowser, refreshKey]);
  useEffect(() => {
    let active = true;
    void getCollectionOptions().then((next) => { if (active) setCollections(next.collections); }).catch((reason) => { if (active) setError(errorMessage(reason, "Product collections are unavailable.")); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const signature = (payload?.featured || []).map((product) => product.id + ":" + String(product.featuredOrder)).join("\u0000");
    if (signature !== featuredAuthority.current) {
      featuredAuthority.current = signature;
      setFeaturedIds((payload?.featured || []).map((product) => product.id));
    }
  }, [payload?.featured]);
  useEffect(() => { setSelectedIds([]); setAllMatching(false); }, [category, migration, pageSize, query, sort, status, visibility]);

  const canManage = Boolean(payload?.access?.capabilities.includes("commerce.business.manage"));
  const authoritativeFeaturedIds = payload?.featured.map((product) => product.id) || [];
  const orderedFeatured = featuredIds.map((id) => payload?.featured.find((product) => product.id === id) || featuredBrowser?.featured.find((product) => product.id === id)).filter((product): product is MerchandisingProduct => Boolean(product));
  const featuredDirty = featuredIds.join("\u0000") !== authoritativeFeaturedIds.join("\u0000");
  const selectedCount = allMatching ? payload?.totalItems || 0 : selectedIds.length;
  const resultStart = payload?.totalItems ? (payload.page - 1) * payload.pageSize + 1 : 0;
  const resultEnd = payload?.totalItems ? Math.min(payload.page * payload.pageSize, payload.totalItems) : 0;
  const refresh = () => setRefreshKey((value) => value + 1);
  const moveFeatured = (id: string, offset: -1 | 1) => setFeaturedIds((current) => {
    const index = current.indexOf(id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const replaceProduct = (product: MerchandisingProduct) => {
    setSelectedProduct(product);
    setPayload((current) => current ? {
      ...current,
      items: current.items.map((entry) => entry.id === product.id ? product : entry),
      featured: product.featured
        ? [...current.featured.filter((entry) => entry.id !== product.id), product].sort((a, b) => (a.featuredOrder ?? Infinity) - (b.featuredOrder ?? Infinity))
        : current.featured.filter((entry) => entry.id !== product.id),
    } : current);
    refresh();
  };
  const saveFeatured = async () => {
    if (!csrfToken || !canManage) return;
    setSavingFeatured(true); setError(""); setMessage("");
    try {
      const next = await saveFeaturedProducts(csrfToken, featuredIds);
      setFeaturedIds(next.featured.map((product) => product.id));
      setMessage("Featured order saved to Commerce D1.");
      refresh();
    } catch (reason) {
      setError(errorMessage(reason, "Featured products could not be saved."));
    } finally {
      setSavingFeatured(false);
    }
  };
  const mutateExplicit = async (operation: ProductBulkOperation, ids: string[], successPrefix: string) => {
    if (!csrfToken || !canManage || !ids.length || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await bulkUpdateMerchandisingProducts(csrfToken, { operation, productIds: ids });
      setMessage(successPrefix + " " + String(result.updated) + " updated; " + String(result.unchanged) + " unchanged.");
      refresh();
    } catch (reason) {
      setError(errorMessage(reason, "The product state could not be updated."));
    } finally {
      setBusy(false);
    }
  };
  const toggleVisibility = async (product: MerchandisingProduct) => {
    if (!csrfToken || !canManage || pendingVisibility.includes(product.id)) return;
    const operation: ProductBulkOperation = product.visibility === "public" ? "hide" : "show";
    setPendingVisibility((current) => [...current, product.id]); setError("");
    try {
      const result = await bulkUpdateMerchandisingProducts(csrfToken, { operation, productIds: [product.id] });
      setPayload((current) => current ? { ...current, items: current.items.map((entry) => entry.id === product.id ? { ...entry, visibility: operation === "show" ? "public" : "private" } : entry) } : current);
      setMessage((operation === "show" ? "Shown in store. " : "Hidden from store. ") + String(result.updated) + " product updated.");
      refresh();
    } catch (reason) {
      setError(errorMessage(reason, "Storefront visibility could not be updated."));
    } finally {
      setPendingVisibility((current) => current.filter((id) => id !== product.id));
    }
  };
  const applyBulk = async (operation: ProductBulkOperation) => {
    if (!csrfToken || !canManage || !payload || !selectedCount || busy) return;
    if (allMatching && !window.confirm("Apply “" + bulkOperationLabel(operation) + "” to all " + String(payload.totalItems) + " products matching the current filters?")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = allMatching
        ? await bulkUpdateMerchandisingProducts(csrfToken, { operation, matching: matchingFilters, confirmMatching: true, expectedCount: payload.totalItems })
        : await bulkUpdateMerchandisingProducts(csrfToken, { operation, productIds: selectedIds });
      setMessage(bulkOperationLabel(operation) + " completed: " + String(result.updated) + " updated; " + String(result.unchanged) + " unchanged; " + String(result.rejected) + " rejected.");
      setSelectedIds([]); setAllMatching(false); refresh();
    } catch (reason) {
      setError(errorMessage(reason, "The bulk product update could not be applied."));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return <>
    <CommerceHeading eyebrow="Commerce D1 authority" title="Shop / Products" summary="Manage the replacement catalogue, real variants, integer CAD prices, public presentation, and provider readiness. Displayability is independent from the globally disabled checkout and paused fulfillment migration." status={payload?.databaseConfigured ? "connected" : "unavailable"} />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {message && <div className="commerce-callout is-pending" role="status"><AdminIcon name="shield" /><div><strong>Merchandising saved</strong><p>{message}</p></div></div>}
    {!payload && !error ? <CommerceState>Loading catalogue merchandising…</CommerceState> : payload ? <div className="merchandising-workspace commerce-catalogue-manager">
      <section className="commerce-posture" aria-label="Catalogue totals"><div><span>Products</span><strong>{payload.totals.products}</strong></div><div><span>Public</span><strong>{payload.totals.publicProducts}</strong></div><div><span>Variants</span><strong>{payload.totals.variants}</strong></div><div><span>Checkout</span><strong>Globally disabled</strong></div></section>
      <section className="commerce-section" aria-labelledby="catalogue-products-title">
        <div className="commerce-section-heading-actions"><SectionTitle id="catalogue-products-title" eyebrow="Authoritative catalogue" title="Products and readiness" /><button className={bulkMode ? "button-link" : "secondary-button"} type="button" onClick={() => { setBulkMode((value) => !value); setSelectedIds([]); setAllMatching(false); }} disabled={!canManage}>{bulkMode ? "Exit bulk edit" : "Bulk edit"}</button></div>
        <div className="commerce-product-filters"><Field label="Search"><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} type="search" placeholder="Title, slug, category, or tag" /></Field><Field label="Visibility"><select value={visibility} onChange={(event) => { setVisibility(event.target.value); setPage(1); }}><option value="all">All</option><option value="public">Public</option><option value="private">Hidden</option></select></Field><Field label="Status"><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">All</option>{["active", "disabled", "pending", "restricted", "error"].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></Field><Field label="Migration"><select value={migration} onChange={(event) => { setMigration(event.target.value); setPage(1); }}><option value="all">All</option>{payload.facets.migrationStatuses.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></Field><Field label="Category"><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="all">All</option>{payload.facets.categories.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Sort"><select value={sort} onChange={(event) => { setSort(event.target.value as ProductListFilters["sort"]); setPage(1); }}><option value="display">Featured / display</option><option value="name">Name</option><option value="price">Price</option></select></Field></div>
        {bulkMode && <div className="commerce-bulk-toolbar" aria-label="Bulk product actions"><strong aria-live="polite">{selectedCount} selected</strong><div><button type="button" className="text-button" onClick={() => { setAllMatching(false); setSelectedIds((current) => [...new Set([...current, ...payload.items.map((product) => product.id)])]); }}>Select current page</button><button type="button" className="text-button" onClick={() => { setSelectedIds([]); setAllMatching(false); }}>Clear selection</button><button type="button" className="text-button" onClick={() => { setSelectedIds([]); setAllMatching(true); }}>Select all {payload.totalItems} matching</button></div><div className="commerce-bulk-toolbar__actions"><button type="button" onClick={() => void applyBulk("show")} disabled={!selectedCount || busy}>Show in store</button><button type="button" onClick={() => void applyBulk("hide")} disabled={!selectedCount || busy}>Hide from store</button><button type="button" onClick={() => void applyBulk("feature")} disabled={!selectedCount || busy}>Feature</button><button type="button" onClick={() => void applyBulk("unfeature")} disabled={!selectedCount || busy}>Unfeature</button></div>{allMatching && <small>All {payload.totalItems} products matching the current search and filters will be affected. You’ll confirm before applying.</small>}</div>}
        <div className="commerce-results-bar"><p>Showing {resultStart}–{resultEnd} of {payload.totalItems} products</p><Field label="Rows per page"><select aria-label="Rows per page" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value) as 20 | 50 | 75 | 100); setPage(1); }}>{[20, 50, 75, 100].map((value) => <option key={value} value={value}>{value}</option>)}</select></Field></div>
        <div className="commerce-product-table" role="list">{payload.items.map((product) => {
          const visible = product.visibility === "public";
          const selected = allMatching || selectedIds.includes(product.id);
          const pending = pendingVisibility.includes(product.id);
          return <article key={product.id} role="listitem" className={"commerce-product-row" + (bulkMode ? " is-bulk" : "") + (selected ? " is-selected" : "")}>{bulkMode && <label className="commerce-product-row__select"><input type="checkbox" aria-label={"Select " + product.title} checked={selected} disabled={allMatching} onChange={() => setSelectedIds((current) => current.includes(product.id) ? current.filter((id) => id !== product.id) : [...current, product.id])} /></label>}<div className="commerce-product-row__image">{product.primaryImageUrl ? <img src={product.primaryImageUrl} alt="" /> : <span aria-hidden="true">TR</span>}</div><div><strong>{product.title}</strong><small>/{product.slug}</small><span>{product.categories.join(" · ") || "Uncategorized"}{product.tags.length ? " · " + product.tags.join(" · ") : ""}</span></div><div><span>Price</span><strong>{product.price.label}</strong><small>{product.activeVariantCount} / {product.variantCount} public variants</small></div><div><span>Storefront</span><strong>{visible && product.status === "active" ? "Public" : "Hidden"}</strong><small>{product.featured ? "Featured" : "Order " + String(product.displayOrder)}</small></div><div><span>Fulfillment mapping</span><strong>{humanize(product.readiness.fulfillment)}</strong><small>Migration: {humanize(product.migrationStatus)}</small></div><div className="commerce-product-row__actions"><button className="commerce-icon-action" type="button" title={visible ? "Hide from store" : "Show in store"} aria-label={(visible ? "Hide " : "Show ") + product.title + (visible ? " from store" : " in store")} aria-pressed={visible} onClick={() => void toggleVisibility(product)} disabled={!canManage || pending}>{pending ? <span className="commerce-icon-action__pending" aria-hidden="true" /> : <AdminIcon name={visible ? "eye" : "eyeOff"} size={18} />}</button><button className={"commerce-icon-action" + (product.featured ? " is-featured" : "")} type="button" title={product.featured ? "Remove from featured" : "Add to featured"} aria-label={(product.featured ? "Remove " : "Add ") + product.title + (product.featured ? " from featured products" : " to featured products")} aria-pressed={product.featured} onClick={() => void mutateExplicit(product.featured ? "unfeature" : "feature", [product.id], product.featured ? "Featured product removed." : "Featured product added.")} disabled={!canManage || busy}><AdminIcon name="star" size={18} /></button><button className="commerce-row-action commerce-row-action--icon" type="button" title="Edit product" aria-label="Edit product" onClick={() => setSelectedProduct(product)}><AdminIcon name="edit" size={18} /></button></div></article>;
        })}</div>
        {!payload.items.length && <CommerceState>No products match the current search and filters.</CommerceState>}
        <ProductPagination page={payload.page} totalPages={payload.totalPages} onPage={setPage} label="Product pages" />
      </section>
      {selectedProduct && <ProductMerchandisingEditor product={selectedProduct} collections={collections} csrfToken={csrfToken} canManage={canManage} onClose={() => setSelectedProduct(null)} onSaved={(product, notice) => { replaceProduct(product); setMessage(notice); }} onError={setError} />}
      <section className="commerce-section featured-products-manager" aria-labelledby="featured-manager-title">
        <div className="featured-products-manager__heading"><div><p className="eyebrow">Storefront priority</p><h2 id="featured-manager-title">Featured Products Manager</h2><p>See the current storefront rail, set its order, or find another catalogue product without scanning the full list.</p></div><strong>{orderedFeatured.length} featured</strong></div>
        <div className="featured-products-manager__grid">
          <section className="featured-current" aria-labelledby="current-featured-title"><div><p className="eyebrow">Current featured products</p><h3 id="current-featured-title">Storefront order</h3></div>{orderedFeatured.length ? <ol>{orderedFeatured.map((product, index) => <li key={product.id}><span className="featured-current__position">{String(index + 1).padStart(2, "0")}</span><span className="commerce-product-row__image">{product.primaryImageUrl ? <img src={product.primaryImageUrl} alt="" /> : <i aria-hidden="true">TR</i>}</span><span className="featured-current__identity"><strong>{product.title}</strong><small>/{product.slug} · {product.visibility === "public" ? "Public" : "Hidden"}</small></span><span className="merchandising-order-actions"><button type="button" onClick={() => moveFeatured(product.id, -1)} disabled={index === 0 || savingFeatured} aria-label={"Move " + product.title + " up"}>↑</button><button type="button" onClick={() => moveFeatured(product.id, 1)} disabled={index === orderedFeatured.length - 1 || savingFeatured} aria-label={"Move " + product.title + " down"}>↓</button></span><button className="commerce-icon-action is-featured" type="button" title="Remove from featured" aria-label={"Remove " + product.title + " from featured products"} aria-pressed={true} onClick={() => void mutateExplicit("unfeature", [product.id], "Featured product removed.")} disabled={!canManage || busy}><AdminIcon name="star" size={18} /></button></li>)}</ol> : <p className="merchandising-empty">No products are featured. Use the catalogue finder to add one.</p>}{featuredDirty && <div className="featured-order-save" role="status"><p><strong>Featured order changed</strong><span>Save to publish this deterministic order.</span></p><div><button className="text-button" type="button" onClick={() => setFeaturedIds(authoritativeFeaturedIds)} disabled={savingFeatured}>Discard</button><button className="button-link" type="button" onClick={() => void saveFeatured()} disabled={savingFeatured || !canManage || !payload.databaseConfigured}>{savingFeatured ? "Saving…" : "Save order"}</button></div></div>}</section>
          <section className="featured-finder" aria-labelledby="featured-finder-title"><div><p className="eyebrow">Add / find products</p><h3 id="featured-finder-title">Catalogue finder</h3></div><div className="featured-finder__tools"><Field label="Search title or slug"><input type="search" value={featuredQuery} onChange={(event) => { setFeaturedQuery(event.target.value); setFeaturedPage(1); }} placeholder="Find a product" /></Field><Field label="Featured state"><select value={featuredFilter} onChange={(event) => { setFeaturedFilter(event.target.value as typeof featuredFilter); setFeaturedPage(1); }}><option value="all">All</option><option value="featured">Featured</option><option value="not_featured">Not featured</option></select></Field></div><div className="featured-finder__results" role="list">{featuredBrowser?.items.map((product) => { const eligible = ["active", "legacy_production"].includes(product.status); return <article key={product.id} role="listitem"><span className="commerce-product-row__image">{product.primaryImageUrl ? <img src={product.primaryImageUrl} alt="" /> : <i aria-hidden="true">TR</i>}</span><span><strong>{product.title}</strong><small>/{product.slug} · {product.visibility === "public" ? "Public" : "Hidden"}</small></span><button className={"commerce-icon-action" + (product.featured ? " is-featured" : "")} type="button" title={product.featured ? "Remove from featured" : "Add to featured"} aria-label={(product.featured ? "Remove " : "Add ") + product.title + (product.featured ? " from featured products" : " to featured products")} aria-pressed={product.featured} onClick={() => void mutateExplicit(product.featured ? "unfeature" : "feature", [product.id], product.featured ? "Featured product removed." : "Featured product added.")} disabled={!canManage || busy || (!product.featured && !eligible)}><AdminIcon name="star" size={18} /></button></article>; })}</div>{featuredBrowser && !featuredBrowser.items.length && <p className="merchandising-empty">No catalogue products match this finder.</p>}{featuredBrowser && <ProductPagination page={featuredBrowser.page} totalPages={featuredBrowser.totalPages} onPage={setFeaturedPage} label="Featured catalogue pages" />}</section>
        </div>
      </section>
    </div> : null}
  </>;
}

function ProductPagination({ page, totalPages, onPage, label }: { page: number; totalPages: number; onPage: (page: number) => void; label: string }) {
  if (totalPages <= 1) return null;
  return <nav className="commerce-pagination" aria-label={label}><button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}>Previous</button><div>{paginationItems(page, totalPages).map((item) => typeof item === "number" ? <button key={item} type="button" className={item === page ? "is-current" : ""} aria-current={item === page ? "page" : undefined} onClick={() => onPage(item)}>{item}</button> : <span key={item} aria-hidden="true">…</span>)}</div><span>Page {page} of {totalPages}</span><button type="button" onClick={() => onPage(page + 1)} disabled={page >= totalPages}>Next</button></nav>;
}
function paginationItems(page: number, totalPages: number): Array<number | string> { if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1); const pages = new Set([1, totalPages, page - 1, page, page + 1].filter((value) => value > 0 && value <= totalPages)); const sorted = [...pages].sort((a, b) => a - b); const result: Array<number | string> = []; sorted.forEach((value, index) => { if (index && value - sorted[index - 1] > 1) result.push("ellipsis-" + String(value)); result.push(value); }); return result; }
function bulkOperationLabel(operation: ProductBulkOperation) { return operation === "show" ? "Show in store" : operation === "hide" ? "Hide from store" : operation === "feature" ? "Feature" : "Unfeature"; }


export function CommerceCollectionsPage() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<CollectionsPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const [savingOrder, setSavingOrder] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const stop = startLoading("Loading authoritative collections"); setError("");
    try { const next = await getCollections(); setPayload(next); setOrderIds(next.collections.map((collection) => collection.id)); }
    catch (reason) { setError(errorMessage(reason, "Collections are unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  const canManage = Boolean(payload?.access?.capabilities.includes("commerce.business.manage"));
  const authoritativeOrder = payload?.collections.map((collection) => collection.id) || [];
  const orderDirty = orderIds.join("\u0000") !== authoritativeOrder.join("\u0000");
  const ordered = orderIds.map((id) => payload?.collections.find((collection) => collection.id === id)).filter((collection): collection is CommerceCollection => Boolean(collection));
  const move = (id: string, offset: -1 | 1) => setOrderIds((current) => { const index = current.indexOf(id); const target = index + offset; if (index < 0 || target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  const saveOrder = async () => { if (!csrfToken || !canManage) return; setSavingOrder(true); setError(""); try { const next = await saveCommerceCollectionOrder(csrfToken, orderIds); setPayload(next); setOrderIds(next.collections.map((collection) => collection.id)); setMessage("Collection display order saved."); } catch (reason) { setError(errorMessage(reason, "Collection order could not be saved.")); } finally { setSavingOrder(false); } };
  const selected = payload?.collections.find((collection) => collection.id === selectedId) || null;
  return <>
    <CommerceHeading eyebrow="Commerce D1 authority" title="Shop / Collections" summary="Create, describe, order, hide, archive, and assign the stable collections projected to the Public shop. All Products remains a virtual aggregate." status={payload?.databaseConfigured ? "connected" : "unavailable"} />
    {error && <div className="admin-alert" role="alert">{error}</div>}{message && <div className="auth-success" role="status">{message}</div>}
    {!payload && !error ? <CommerceState>Loading collection authority…</CommerceState> : payload ? <div className="collection-admin-workspace">
      <section className="commerce-posture" aria-label="Collection totals"><div><span>Active collections</span><strong>{payload.collections.length}</strong></div><div><span>Public</span><strong>{payload.collections.filter((collection) => collection.visibility === "public").length}</strong></div><div><span>Assignments</span><strong>{payload.collections.reduce((total, collection) => total + collection.assignedProductCount, 0)}</strong></div><div><span>All Products</span><strong>Virtual</strong></div></section>
      <section className="commerce-section" aria-labelledby="collection-list-title"><div className="collection-admin-heading"><SectionTitle id="collection-list-title" eyebrow="Stable Public discovery" title="Collections" /><button className="button-link" type="button" onClick={() => { setCreating(true); setSelectedId(null); setMessage(""); }} disabled={!canManage}>Create collection</button></div>
        <ol className="collection-admin-list">{ordered.map((collection, index) => <li key={collection.id}><span className="collection-admin-list__order">{String(index + 1).padStart(2, "0")}</span><div><strong>{collection.title}</strong><small>/{collection.slug} · {collection.visibility === "public" ? "Visible" : "Hidden"}</small></div><dl><div><dt>Assigned</dt><dd>{collection.assignedProductCount}</dd></div><div><dt>Public</dt><dd>{collection.publicProductCount}</dd></div></dl><div className="merchandising-order-actions"><button type="button" onClick={() => move(collection.id, -1)} disabled={index === 0 || !canManage} aria-label={`Move ${collection.title} up`}>↑</button><button type="button" onClick={() => move(collection.id, 1)} disabled={index === ordered.length - 1 || !canManage} aria-label={`Move ${collection.title} down`}>↓</button></div><button className="commerce-row-action" type="button" onClick={() => { setSelectedId(collection.id); setCreating(false); setMessage(""); }}>Manage</button></li>)}</ol>
        {orderDirty ? <div className="featured-dirty-rail" role="status"><p><strong>Collection order changed</strong><span>Public discovery will keep the current order until saved.</span></p><div><button className="text-button" type="button" onClick={() => setOrderIds(authoritativeOrder)} disabled={savingOrder}>Discard changes</button><button className="button-link" type="button" onClick={() => void saveOrder()} disabled={savingOrder || !canManage}>{savingOrder ? "Saving…" : "Save order"}</button></div></div> : null}
      </section>
      {(creating || selected) ? <CollectionEditor key={selected?.id || "new"} collection={selected} products={payload.products} csrfToken={csrfToken} canManage={canManage} onClose={() => { setCreating(false); setSelectedId(null); }} onPayload={(next, notice, selectId) => { setPayload(next); setOrderIds(next.collections.map((collection) => collection.id)); setMessage(notice); if (selectId) setSelectedId(selectId); setCreating(false); }} onError={setError} /> : null}
    </div> : null}
  </>;
}

function CollectionEditor({ collection, products, csrfToken, canManage, onClose, onPayload, onError }: { collection: CommerceCollection | null; products: MerchandisingProduct[]; csrfToken: string | null; canManage: boolean; onClose: () => void; onPayload: (payload: CollectionsPayload, message: string, selectId?: string) => void; onError: (message: string) => void }) {
  const initial = collectionDraft(collection);
  const [form, setForm] = useState(initial);
  const [query, setQuery] = useState(""); const [filter, setFilter] = useState("all"); const [saving, setSaving] = useState(false);
  const update = (key: string, value: string | string[]) => setForm((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const filteredProducts = products.filter((product) => { const assigned = form.productIds.includes(product.id); const needle = query.trim().toLowerCase(); return (!needle || `${product.title} ${product.slug}`.toLowerCase().includes(needle)) && (filter === "all" || (filter === "assigned" ? assigned : !assigned)); });
  const save = async (event: FormEvent) => { event.preventDefault(); if (!csrfToken || !canManage) return; setSaving(true); onError(""); try {
    if (!collection) { const next = await createCommerceCollection(csrfToken, { title: form.title, slug: form.slug, description: form.description, visibility: form.visibility, displayOrder: Number(form.displayOrder) }); const created = next.collections.find((item) => item.slug === form.slug); onPayload(next, "Collection created with a stable Public slug.", created?.id); return; }
    let next = await saveCommerceCollection(csrfToken, collection.id, { title: form.title, description: form.description, visibility: form.visibility, displayOrder: Number(form.displayOrder), revision: collection.revision });
    const updated = next.collections.find((item) => item.id === collection.id); if (!updated) throw new Error("Collection was not returned after save.");
    next = await saveCommerceCollectionProducts(csrfToken, collection.id, updated.revision, form.productIds); onPayload(next, "Collection details and product assignments saved.", collection.id);
  } catch (reason) { onError(errorMessage(reason, "Collection changes could not be saved.")); } finally { setSaving(false); } };
  const archive = async () => { if (!collection || !csrfToken || !canManage || !window.confirm(`Archive ${collection.title}? Product assignments will be preserved.`)) return; setSaving(true); try { onPayload(await archiveCommerceCollection(csrfToken, collection.id, collection.revision), "Collection archived; products were preserved."); onClose(); } catch (reason) { onError(errorMessage(reason, "Collection could not be archived.")); } finally { setSaving(false); } };
  const hardDelete = async () => { if (!collection || collection.assignedProductCount || !csrfToken || !canManage || !window.confirm(`Permanently delete the empty collection ${collection.title}?`)) return; setSaving(true); try { onPayload(await deleteCommerceCollection(csrfToken, collection.id), "Empty collection permanently deleted."); onClose(); } catch (reason) { onError(errorMessage(reason, "Collection could not be deleted.")); } finally { setSaving(false); } };
  return <CommerceEditorModal titleId="collection-editor-title" onClose={onClose}><section className="commerce-product-editor collection-editor"><header><div><p className="eyebrow">{collection ? "Collection editor" : "New collection"}</p><h2 id="collection-editor-title">{collection?.title || "Create a collection"}</h2></div><button className="commerce-editor-close" type="button" onClick={onClose} data-autofocus>Close editor</button></header>
    <form onSubmit={(event) => void save(event)}><div className="commerce-form-grid"><Field label="Title"><input value={form.title} onChange={(event) => { const title = event.target.value; setForm((current) => ({ ...current, title, slug: collection ? current.slug : collectionSlugFromTitle(title) })); }} maxLength={160} required /></Field>{collection ? <Field label="Stable Public slug" hint="Title edits never change this deep-link slug."><code>/{collection.slug}</code></Field> : <Field label="Stable Public slug"><input value={form.slug} onChange={(event) => update("slug", collectionSlugFromTitle(event.target.value))} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required /></Field>}<Field label="Description" className="commerce-field--wide"><textarea value={form.description} onChange={(event) => update("description", event.target.value)} rows={4} maxLength={2000} /></Field><Field label="Public discovery"><select value={form.visibility} onChange={(event) => update("visibility", event.target.value)}><option value="public">Shown</option><option value="hidden">Hidden (assignments preserved)</option></select></Field><Field label="Display order"><input type="number" min={0} max={999999} value={form.displayOrder} onChange={(event) => update("displayOrder", event.target.value)} /></Field></div>
      {collection ? <fieldset className="collection-assignment"><legend>Product assignments</legend><div className="collection-assignment__tools"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search products" aria-label="Search products for assignment" /><select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter product assignments"><option value="all">All products</option><option value="assigned">Assigned</option><option value="available">Available</option></select></div><div className="collection-assignment__list">{filteredProducts.map((product) => <label key={product.id} className={form.productIds.includes(product.id) ? "is-selected" : ""}><input type="checkbox" checked={form.productIds.includes(product.id)} onChange={() => update("productIds", form.productIds.includes(product.id) ? form.productIds.filter((id) => id !== product.id) : [...form.productIds, product.id])} /><span className="commerce-product-row__image">{product.primaryImageUrl ? <img src={product.primaryImageUrl} alt="" /> : <i>TR</i>}</span><span><strong>{product.title}</strong><small>{product.visibility === "public" && product.status === "active" ? "Public" : "Hidden"} · {product.price.label}</small></span></label>)}</div></fieldset> : <p className="commerce-action-note">Save the collection before assigning products.</p>}
      <div className="collection-editor__actions"><span>{dirty ? "Unsaved collection changes" : "Collection is up to date"}</span><button className="button-link" type="submit" disabled={!dirty || !canManage || !csrfToken || saving}>{saving ? "Saving…" : collection ? "Save collection" : "Create collection"}</button>{collection ? <button className="commerce-editor-secondary" type="button" onClick={() => void archive()} disabled={saving}>Archive collection</button> : null}{collection && collection.assignedProductCount === 0 ? <button className="commerce-editor-danger" type="button" onClick={() => void hardDelete()} disabled={saving}>Delete empty collection</button> : null}</div>
    </form>
  </section></CommerceEditorModal>;
}

function collectionDraft(collection: CommerceCollection | null) { return collection ? { title: collection.title, slug: collection.slug, description: collection.description, visibility: collection.visibility, displayOrder: String(collection.displayOrder), productIds: [...collection.productIds] } : { title: "", slug: "", description: "", visibility: "public", displayOrder: "1000", productIds: [] as string[] }; }
function collectionSlugFromTitle(value: string) { return value.toLowerCase().replace(/™/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 180); }

function ProductMerchandisingEditor({ product, collections, csrfToken, canManage, onClose, onSaved, onError }: { product: MerchandisingProduct; collections: CommerceCollection[]; csrfToken: string | null; canManage: boolean; onClose: () => void; onSaved: (product: MerchandisingProduct, message: string) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState(() => productForm(product));
  const [variantId, setVariantId] = useState(product.variants[0]?.id || "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setForm(productForm(product)); setVariantId((current) => product.variants.some((variant) => variant.id === current) ? current : product.variants[0]?.id || ""); }, [product]);
  const variant = product.variants.find((entry) => entry.id === variantId) || null;
  const update = (key: string, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const saveProduct = async (event: FormEvent) => { event.preventDefault(); if (!csrfToken || !canManage) return; setSaving(true); onError(""); try { const selectedCollections = collections.filter((collection) => form.collectionIds.includes(collection.id)); const media = await ingestMerchandisingProductMedia(csrfToken, product.id, [form.primaryImageUrl, ...splitLines(form.additionalImages)].filter(Boolean)); const result = await saveMerchandisingProduct(csrfToken, product.id, { title: form.title, slug: form.slug, description: form.description, primaryImageUrl: media.primaryImageUrl, additionalImages: media.additionalImages, categories: selectedCollections.map((collection) => collection.title), tags: splitComma(form.tags), featured: form.featured, visibility: form.visibility, status: form.status, displayOrder: Number(form.displayOrder), maxQuantity: Number(form.maxQuantity), unitAmount: product.unitAmount, currencyCode: "CAD" }); onSaved(result.product, "Product merchandising, first-party media, and collection memberships saved to Commerce D1."); } catch (reason) { onError(errorMessage(reason, "Product merchandising could not be saved.")); } finally { setSaving(false); } };
  return <CommerceEditorModal titleId="product-editor-title" onClose={onClose}><section className="commerce-product-editor"><header><div><p className="eyebrow">Product editor</p><h2 id="product-editor-title">{product.title}</h2></div><button type="button" className="commerce-editor-close" onClick={onClose} data-autofocus>Close editor</button></header>
    <form onSubmit={(event) => void saveProduct(event)}>
      <div className="commerce-form-grid">
        <Field label="Title"><input value={form.title} onChange={(event) => update("title", event.target.value)} maxLength={240} required /></Field>
        <Field label="Slug"><input value={form.slug} onChange={(event) => update("slug", event.target.value)} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={180} required /></Field>
        <Field label="Description" className="commerce-field--wide"><textarea value={form.description} onChange={(event) => update("description", event.target.value)} maxLength={12000} rows={5} /></Field>
        <Field label="Primary image source" hint="External HTTPS sources are copied into first-party commerce media when saved." className="commerce-field--wide"><input type="url" value={form.primaryImageUrl} onChange={(event) => update("primaryImageUrl", event.target.value)} /></Field>
        <Field label="Additional image sources" hint="One HTTPS source per line. Stored catalogue URLs are replaced with immutable first-party media URLs." className="commerce-field--wide"><textarea value={form.additionalImages} onChange={(event) => update("additionalImages", event.target.value)} rows={3} /></Field>
        <fieldset className="commerce-collection-picker commerce-field--wide"><legend>Collections</legend><p>Choose every active collection this product belongs to.</p><div>{collections.map((collection) => <label key={collection.id} className={form.collectionIds.includes(collection.id) ? "is-selected" : ""}><input type="checkbox" checked={form.collectionIds.includes(collection.id)} onChange={() => setForm((current) => ({ ...current, collectionIds: current.collectionIds.includes(collection.id) ? current.collectionIds.filter((id) => id !== collection.id) : [...current.collectionIds, collection.id] }))} /><span>{collection.title}<small>{collection.visibility === "public" ? "Public" : "Hidden"}</small></span></label>)}</div></fieldset>
        <Field label="Tags" hint="Comma separated."><input value={form.tags} onChange={(event) => update("tags", event.target.value)} /></Field>
        <fieldset className="commerce-presentation-controls commerce-field--wide"><legend>Storefront presentation</legend><p>Control whether this product is visible and whether it receives prioritized storefront placement.</p><div><Field label="Public visibility"><select value={form.visibility} onChange={(event) => update("visibility", event.target.value)}><option value="public">Public</option><option value="private">Private</option></select></Field><Field label="Catalogue status"><select value={form.status} onChange={(event) => update("status", event.target.value)}><option value="active">Active</option><option value="disabled">Inactive</option></select></Field></div><label className="commerce-featured-switch"><input type="checkbox" role="switch" checked={form.featured} onChange={(event) => update("featured", event.target.checked)} /><span className="commerce-featured-switch__track" aria-hidden="true"><i /></span><span><strong>Featured product</strong><small>Featured products receive prioritized placement in the storefront rail.</small></span></label></fieldset>
        <Field label="Display order"><input type="number" min={0} max={999999} value={form.displayOrder} onChange={(event) => update("displayOrder", event.target.value)} /></Field>
        <Field label="Maximum quantity"><input type="number" min={1} max={20} value={form.maxQuantity} onChange={(event) => update("maxQuantity", event.target.value)} /></Field>
      </div>
      <div className="merchandising-savebar"><p>Provider identity and migration provenance are read-only.</p><button className="button-link" type="submit" disabled={!canManage || !csrfToken || saving}>{saving ? "Saving…" : "Save product"}</button></div>
    </form>
    <section className="commerce-variant-manager" aria-labelledby="variant-editor-title"><SectionTitle id="variant-editor-title" eyebrow="Variant authority" title={`Variants (${product.variants.length})`} />{product.variants.length ? <><Field label="Choose variant"><select value={variantId} onChange={(event) => setVariantId(event.target.value)}>{product.variants.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayLabel} — {formatCad(entry.unitAmount)}</option>)}</select></Field>{variant && <VariantMerchandisingEditor key={variant.id} product={product} variant={variant} csrfToken={csrfToken} canManage={canManage} onSaved={onSaved} onError={onError} />}</> : <CommerceState>No variants are attached to this product.</CommerceState>}</section>
  </section></CommerceEditorModal>;
}

function CommerceEditorModal({ titleId, onClose, children }: { titleId: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scrollX = window.scrollX; const scrollY = window.scrollY;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => { dialog.current?.querySelector<HTMLElement>("[data-autofocus],input,select,textarea,button")?.focus({ preventScroll: true }); window.scrollTo(scrollX, scrollY); });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); dialog.current.focus(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { window.cancelAnimationFrame(frame); document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKeyDown); returnFocus?.focus({ preventScroll: true }); window.scrollTo(scrollX, scrollY); };
  }, [onClose]);
  return createPortal(<div className="commerce-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialog} className="commerce-editor-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>{children}</div></div>, document.body);
}

function VariantMerchandisingEditor({ product, variant, csrfToken, canManage, onSaved, onError }: { product: MerchandisingProduct; variant: MerchandisingVariant; csrfToken: string | null; canManage: boolean; onSaved: (product: MerchandisingProduct, message: string) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState(() => variantForm(variant)); const [saving, setSaving] = useState(false);
  const update = (key: string, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const saveVariant = async (event: FormEvent) => { event.preventDefault(); if (!csrfToken || !canManage) return; setSaving(true); onError(""); try { const options = JSON.parse(form.options) as unknown; const result = await saveMerchandisingVariant(csrfToken, product.id, variant.id, { displayLabel: form.displayLabel, size: form.size, color: form.color, options, unitAmount: cadTextToMinorUnits(form.price), currencyCode: "CAD", status: form.status, visibility: form.visibility, sellable: form.sellable, availability: form.availability }); onSaved(result.product, "Variant merchandising saved to Commerce D1."); } catch (reason) { onError(errorMessage(reason, "Variant merchandising could not be saved.")); } finally { setSaving(false); } };
  return <form className="commerce-variant-form" onSubmit={(event) => void saveVariant(event)}><div className="commerce-form-grid"><Field label="Display label"><input value={form.displayLabel} onChange={(event) => update("displayLabel", event.target.value)} maxLength={240} /></Field><Field label="CAD price"><input inputMode="decimal" value={form.price} onChange={(event) => update("price", event.target.value)} required /></Field><Field label="Size"><input value={form.size} onChange={(event) => update("size", event.target.value)} /></Field><Field label="Color"><input value={form.color} onChange={(event) => update("color", event.target.value)} /></Field><Field label="Options JSON" className="commerce-field--wide"><textarea value={form.options} onChange={(event) => update("options", event.target.value)} rows={3} /></Field><Field label="Visibility"><select value={form.visibility} onChange={(event) => update("visibility", event.target.value)}><option value="public">Public</option><option value="private">Private</option></select></Field><Field label="Status"><select value={form.status} onChange={(event) => update("status", event.target.value)}><option value="active">Active</option><option value="disabled">Inactive</option></select></Field><Field label="Availability"><select value={form.availability} onChange={(event) => update("availability", event.target.value)}><option value="active">Available</option><option value="temporarily_out_of_stock">Temporarily out of stock</option><option value="discontinued">Discontinued</option></select></Field><label className="commerce-toggle"><input type="checkbox" checked={form.sellable} onChange={(event) => update("sellable", event.target.checked)} /><span>Sellable when checkout is enabled</span></label></div><dl className="commerce-integration-metadata"><Fact term="SKU" value={variant.sku || "None"} /><Fact term="Migration" value={humanize(variant.migrationStatus)} /><Fact term="Fulfillment mapping" value={humanize(variant.fulfillmentMappingStatus)} /><Fact term="Target variant" value={variant.integration.targetPrintfulVariantId || "Not mapped"} /></dl><button className="button-link" type="submit" disabled={!canManage || !csrfToken || saving}>{saving ? "Saving…" : "Save variant"}</button></form>;
}

function productForm(product: MerchandisingProduct) { return { title: product.title, slug: product.slug, description: product.description, primaryImageUrl: product.primaryImageUrl || "", additionalImages: product.additionalImages.join("\n"), collectionIds: [...product.collectionIds], tags: product.tags.join(", "), visibility: product.visibility === "public" ? "public" : "private", status: product.status === "active" ? "active" : "disabled", displayOrder: String(product.displayOrder), maxQuantity: String(product.maxQuantity), featured: product.featured }; }
function variantForm(variant: MerchandisingVariant) { return { displayLabel: variant.displayLabel, size: variant.size || "", color: variant.color || "", options: JSON.stringify(variant.options, null, 2), price: (variant.unitAmount / 100).toFixed(2), visibility: variant.visibility === "public" ? "public" : "private", status: variant.status === "active" ? "active" : "disabled", sellable: variant.sellable, availability: variant.availability }; }
function splitComma(value: string) { return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))]; }
function splitLines(value: string) { return [...new Set(value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))]; }

export function CommerceOrdersPage() {
  const { csrfToken, access } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<CommerceOrdersPayload | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [document, setDocument] = useState<CommerceDocument | null>(null);
  const load = useCallback(async () => {
    const stop = startLoading("Loading authoritative commerce orders"); setError("");
    try { setPayload(await getCommerceOrders()); }
    catch (reason) { setError(errorMessage(reason, "Commerce orders are unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  const generate = useCallback(async () => {
    const candidate = payload?.controlledTest?.candidate;
    if (!csrfToken || !access.isMasterAdmin || !candidate || busy || payload.orders.length) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await generateControlledTestCheckout(csrfToken, { checkoutRequestId: crypto.randomUUID(), productId: candidate.productId, variantId: candidate.variantId, quantity: 1 });
      setMessage(`Stripe TEST Checkout created for ${result.orderId}.`);
      await load();
    } catch (reason) { setError(errorMessage(reason, "The controlled Stripe TEST Checkout could not be created.")); }
    finally { setBusy(false); }
  }, [access.isMasterAdmin, busy, csrfToken, load, payload]);
  const controlled = payload?.controlledTest;
  const candidate = controlled?.candidate;
  const acceptedOrder = payload?.orders.find((order) => order.test && order.paymentStatus === "paid" && order.webhookVerified);
  const canGenerate = Boolean(access.isMasterAdmin && csrfToken && controlled?.enabled && !controlled.normalCheckoutEnabled && !controlled.livePaymentsEnabled && !controlled.fulfillmentEnabled && candidate?.sellable && candidate.mappingStatus === "mapped" && candidate.migrationStatus === "target_verified" && !payload?.orders.length && !busy);
  const viewDocument = async (orderId: string, type: "receipt" | "invoice") => { setError(""); try { setDocument((await getOrderDocument(orderId, type)).document); } catch (reason) { setError(errorMessage(reason, "The order document is unavailable.")); } };
  return <>
    <CommerceHeading eyebrow="Commerce record authority" title="Orders" summary="Local orders are initialized from authoritative D1 product snapshots, linked to Stripe-hosted TEST Checkout, and marked paid only by a valid signed webhook. Fulfillment remains disabled." status="disabled" />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {message && <div className="auth-success" role="status">{message}</div>}
    <section className="commerce-posture" aria-label="Order engine posture"><div><span>Checkout engine</span><strong>Implemented / gated</strong></div><div><span>Public checkout</span><strong>Disabled</strong></div><div><span>Payment mode</span><strong>Stripe TEST</strong></div><div><span>Fulfillment</span><strong>Disabled</strong></div></section>
    {acceptedOrder ? <section className="commerce-section" aria-labelledby="stripe-acceptance-title"><SectionTitle id="stripe-acceptance-title" eyebrow="STRIPE TEST ACCEPTANCE" title="Passed" /><div className="provider-detail-grid"><DetailCard title="Signed payment acceptance" status="connected" statusLabel="Passed" lead={`Order ${compactOrderId(acceptedOrder.id)}`}><dl><Fact term="Amount" value={formatCad(acceptedOrder.expectedAmount)} /><Fact term="Payment" value="Confirmed" /><Fact term="Webhook" value={acceptedOrder.webhookReceiptCount === 1 ? "Verified" : "Unexpected receipt count"} /><Fact term="Fulfillment" value="Disabled" /><Fact term="Test gate" value={controlled?.enabled ? "Unexpectedly open" : "Closed"} /></dl></DetailCard></div></section> : null}
    {payload && access.isMasterAdmin ? <section className="commerce-section test-checkout-card" aria-labelledby="test-checkout-title"><SectionTitle id="test-checkout-title" eyebrow="TEST CHECKOUT · STRIPE SANDBOX · NO REAL CHARGE" title="Pre-cutover payment acceptance" /><div className="provider-detail-grid"><DetailCard title="Controlled acceptance candidate" status={controlled?.enabled ? "pending" : "disabled"} statusLabel={controlled?.enabled ? "Master-only gate enabled" : "Gate disabled"} lead={candidate?.title || "No candidate configured"}><dl><Fact term="Product" value={candidate?.title || "Unavailable"} /><Fact term="Variant" value={candidate?.variantLabel || "Unavailable"} /><Fact term="Price" value={candidate ? formatCad(candidate.unitAmount) : "Unavailable"} /><Fact term="Stripe environment" value="TEST" /><Fact term="Target mapping" value={candidate ? humanize(candidate.mappingStatus) : "Unavailable"} /><Fact term="Normal checkout" value={controlled?.normalCheckoutEnabled ? "Unexpectedly enabled" : "Disabled"} /><Fact term="Live payments" value={controlled?.livePaymentsEnabled ? "Unexpectedly enabled" : "Disabled"} /><Fact term="Fulfillment" value={controlled?.fulfillmentEnabled ? "Unexpectedly enabled" : "Disabled"} /></dl><button className="button-link" type="button" onClick={() => void generate()} disabled={!canGenerate}>{busy ? "Generating…" : payload.orders.length ? "Single acceptance Session already created" : "Generate Test Checkout"}</button></DetailCard></div></section> : null}
    {!payload && !error ? <CommerceState>Loading authoritative orders…</CommerceState> : payload ? payload.orders.length ? <section className="commerce-section" aria-labelledby="orders-list-title"><SectionTitle id="orders-list-title" eyebrow="Bounded payment state" title="Latest orders" /><div className="provider-card-grid">{payload.orders.map((order) => <article className="provider-card" key={order.id}><div><span>{order.test ? "TEST · " : ""}{order.id}</span><StatusBadge status={order.paymentStatus === "paid" ? "connected" : order.checkoutStatus === "checkout_failed" ? "error" : "pending"} label={order.paymentStatus === "paid" ? "Payment confirmed" : humanize(order.checkoutStatus)} /></div><dl>{order.items.map((item) => <div key={`${item.productId}:${item.variantId || ""}`}><dt>Product / variant</dt><dd>{item.productName}{item.variantName ? ` · ${item.variantName}` : ""} · qty {item.quantity}</dd></div>)}<Fact term="CAD total" value={formatCad(order.expectedAmount)} /><Fact term="Checkout Session" value={order.stripeSessionId ? "Created" : "Not created"} /><Fact term="Payment" value={humanize(order.paymentStatus)} /><Fact term="Fulfillment" value={`${humanize(order.fulfillmentStatus)} / not started`} /><Fact term="Printful order" value={order.hasPrintfulOrder ? "Unexpectedly present" : "None"} /><Fact term="Created" value={formatSynchronizedAt(order.createdAt)} /></dl>{order.paymentStatus === "paid" && <div className="commerce-form__actions"><button type="button" className="button-link" onClick={() => void viewDocument(order.id, "receipt")}>View receipt</button><button type="button" className="button-link" onClick={() => void viewDocument(order.id, "invoice")}>View invoice / document preview</button></div>}{order.checkoutUrl && order.paymentStatus !== "paid" ? <a className="button-link" href={order.checkoutUrl} target="_blank" rel="noopener noreferrer">Open Stripe TEST Checkout</a> : null}</article>)}</div></section> : <CommerceState><strong>0 authoritative orders.</strong><span>Normal checkout is disabled. Only the Master-controlled Stripe TEST acceptance action can create the single pre-cutover order.</span></CommerceState> : null}
    {document && <OrderDocumentPreview document={document} />}
  </>;
}

function OrderDocumentPreview({ document }: { document: CommerceDocument }) { return <section className="commerce-section document-preview" aria-labelledby="order-document-title"><p className="eyebrow">{document.marker}</p><h2 id="order-document-title">{document.type === "receipt" ? "Payment receipt" : "Invoice / sales document preview"}</h2>{!document.available && <div className="admin-alert" role="status">Not ready — {document.reason}</div>}<dl><Fact term="Merchant" value={document.merchantName} /><Fact term="Order reference" value={document.orderReference} /><Fact term="Payment" value={document.payment} /><Fact term="Fulfillment" value={document.fulfillment} /></dl>{document.items.map((item, index) => <article key={`${item.productName}-${index}`}><strong>{item.productName}</strong><p>{item.variantName || "Standard"} · quantity {item.quantity} · {formatCad(item.lineTotalAmount)}</p></article>)}<dl><Fact term="Subtotal" value={formatCad(document.subtotal)} /><Fact term="Shipping" value={document.shipping === null ? "Not configured / omitted" : formatCad(document.shipping)} /><Fact term="Tax" value={document.tax === null ? "Not configured / omitted" : formatCad(document.tax)} /><Fact term="Total" value={`${document.currency} ${(document.total / 100).toFixed(2)}`} /></dl>{!document.legalName && <small>No legal entity name, business address, or registration number has been fabricated.</small>}</section>; }

function CommerceHeading({ eyebrow, title, summary, status, statusLabel }: { eyebrow: string; title: string; summary: string; status: CommerceStatus; statusLabel?: string }) {
  return <section className="area-heading commerce-heading"><div className="area-icon"><AdminIcon name="products" size={28} /></div><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{summary}</p></div><StatusBadge status={status} label={statusLabel} /></section>;
}
function SectionTitle({ id, eyebrow, title }: { id: string; eyebrow: string; title: string }) { return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div></div>; }
function StatusBadge({ status, label }: { status: CommerceStatus; label?: string }) { return <span className={`commerce-status commerce-status--${status}`}>{label || labelStatus(status)}</span>; }
function ProviderCard({ provider }: { provider: ProviderStatus }) { const stripeConnected = provider.provider === "stripe" && provider.status === "connected" && provider.environment === "test" && provider.apiConfigured; const printfulConnected = provider.provider === "printful" && provider.status === "connected" && provider.apiConfigured; const webhookOperational = provider.provider === "stripe" && provider.webhookConfigured && provider.webhookSigningConfigured; return <article className="provider-card"><div><span>{provider.label}</span><StatusBadge status={provider.status} label={stripeConnected ? "Test API connected" : printfulConnected ? "API connected" : undefined} /></div><dl>{provider.integrationMode && <Fact term="Integration" value={humanize(provider.integrationMode)} />}<Fact term="Custody" value={humanize(provider.credentialCustody)} /><Fact term="Environment" value={provider.provider === "printful" ? "Real API / pre-cutover rollout" : provider.environment === "test" ? "TEST" : humanize(provider.environment)} />{provider.countryCode && <Fact term="Country" value={provider.countryCode.toUpperCase() === "CA" ? "Canada" : provider.countryCode} />}{provider.currencyCode && <Fact term="Currency" value={provider.currencyCode.toUpperCase()} />}{provider.provider === "stripe" && <><Fact term="Account" value={metadataText(provider, "accountDisplayName") || (provider.accountCreated ? "Created" : "Not confirmed")} />{provider.externalAccountId && <Fact term="Account ID" value={compactAccountId(provider.externalAccountId)} />}<Fact term="API" value={stripeConnected ? "Test API connected" : "Not configured"} /><Fact term="Webhook endpoint" value={webhookOperational ? "Operational / configured" : provider.webhookEndpointReady ? "Ready for configuration" : "Unavailable"} /><Fact term="Webhook signing" value={webhookOperational ? "Configured / verified" : provider.webhookSigningConfigured ? "Configured — awaiting verified event" : "Not configured"} /><Fact term="Checkout engine" value="Implemented / gated" /><Fact term="Public checkout" value={provider.checkoutEnabled ? "Enabled" : "Disabled"} /><Fact term="Live payments" value={provider.livePaymentsEnabled ? "Enabled" : "Disabled"} /><Fact term="Live payouts" value={provider.livePayoutReadiness === "verified" ? "Verified" : "Unverified"} />{provider.lastSynchronizedAt && <Fact term="Last synchronized" value={formatSynchronizedAt(provider.lastSynchronizedAt)} />}</>}{provider.provider === "printful" && <><Fact term="API" value={printfulConnected ? "Connected" : "Verification pending"} /><Fact term="Store" value={metadataText(provider, "storeName") || "Awaiting verification"} /><Fact term="Store ID" value={provider.externalAccountId || "Awaiting verification"} /><Fact term="Products" value={metadataNumberText(provider, "productCount")} /><Fact term="Order mode" value="Draft only" /><Fact term="Automatic fulfillment" value="Disabled" /><Fact term="Existing Wix store" value="Unaffected" /></>}</dl></article>; }
function DetailCard({ title, status, statusLabel, lead, children }: { title: string; status: CommerceStatus; statusLabel?: string; lead: string; children: ReactNode }) { return <article className="provider-detail"><header><div><p>{lead}</p><h2>{title}</h2></div><StatusBadge status={status} label={statusLabel} /></header>{children}</article>; }
function Fact({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <article><span>{label}</span><strong>{value}</strong></article>; }
function compactOrderId(value: string) { return value.length > 20 ? `${value.slice(0, 16)}…${value.slice(-4)}` : value; }
function WorkspaceLink({ to, eyebrow, title, text, icon, index }: { to: string; eyebrow: string; title: string; text: string; icon: "payments" | "business" | "tax" | "emails" | "fulfillment"; index: number }) {
  return <Link className="commerce-workspace-card" to={to}>
    <span className="commerce-workspace-card__top"><span className="commerce-workspace-card__icon"><AdminIcon name={icon} size={19} /></span><span className="commerce-workspace-card__index">0{index}</span></span>
    <span className="commerce-workspace-card__eyebrow">{eyebrow}</span>
    <strong>{title}</strong>
    <span className="commerce-workspace-card__copy">{text}</span>
    <span className="commerce-workspace-card__action">Open workspace <AdminIcon name="arrow" size={16} /></span>
  </Link>;
}
function CommerceState({ children }: { children: ReactNode }) { return <div className="commerce-state" role="status">{children}</div>; }
function Field({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: ReactNode }) { return <label className={`commerce-field ${className}`.trim()}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }

function profileToForm(payload: BusinessPayload) {
  const profile = payload.profile; const address = profile.publicAddress || {}; const privateAddress = profile.private.privateAddress || {};
  return { tradingName: profile.tradingName, legalBusinessName: profile.private.legalBusinessName || "", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: profile.publicContactEmail, supportEmail: profile.supportEmail, publicPhone: profile.publicPhone, websiteUrl: profile.websiteUrl, publicAddressLine1: address.line1 || "", publicAddressLine2: address.line2 || "", publicCity: address.city || "", publicPostalCode: address.postalCode || "", privatePhone: profile.private.privatePhone || "", businessRegistrationNumber: profile.private.businessRegistrationNumber || "", privateAddressLine1: privateAddress.line1 || "", privateAddressLine2: privateAddress.line2 || "", privateCity: privateAddress.city || "", privateProvince: privateAddress.province || "", privatePostalCode: privateAddress.postalCode || "", privateCountry: privateAddress.country || "", invoicePrefix: profile.invoicePrefix, documentFooter: profile.documentFooter, taxProviderState: profile.taxProviderState, invoiceAccentColor: profile.invoiceAccentColor, receiptAccentColor: profile.receiptAccentColor };
}
function formToBusinessPayload(form: Record<string, string>) { return { tradingName: form.tradingName, legalBusinessName: form.legalBusinessName, countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: form.publicContactEmail, supportEmail: form.supportEmail, publicPhone: form.publicPhone, websiteUrl: form.websiteUrl, publicAddress: { line1: form.publicAddressLine1, line2: form.publicAddressLine2, city: form.publicCity, province: "ON", postalCode: form.publicPostalCode, country: "CA" }, privateAddress: { line1: form.privateAddressLine1, line2: form.privateAddressLine2, city: form.privateCity, province: form.privateProvince, postalCode: form.privatePostalCode, country: form.privateCountry }, privatePhone: form.privatePhone, businessRegistrationNumber: form.businessRegistrationNumber, invoicePrefix: form.invoicePrefix, documentFooter: form.documentFooter, taxProviderState: "unavailable", invoiceAccentColor: form.invoiceAccentColor, receiptAccentColor: form.receiptAccentColor };
}
function maskedRegistration(payload: BusinessPayload | null, type: string) { const match = payload?.profile.private.registrations.find((item) => item.type === type); return match ? `Stored as ${match.maskedIdentifier}; leave blank to preserve.` : "Not confirmed or stored."; }
function errorMessage(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
function metadataText(provider: ProviderStatus | undefined, key: string) { const value = provider?.metadata?.[key]; return typeof value === "string" ? value : ""; }
function metadataNumberText(provider: ProviderStatus | undefined, key: string) { const value = provider?.metadata?.[key]; return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "Awaiting verification"; }
function metadataBooleanLabel(provider: ProviderStatus | undefined, key: string) { return provider?.metadata?.[key] === true ? "Enabled in test mode" : "Disabled in test mode"; }
function compactAccountId(value: string | null | undefined) { const id = String(value || ""); return /^acct_[A-Za-z0-9]+$/.test(id) ? `${id.slice(0, 9)}…${id.slice(-4)}` : "Awaiting verification"; }
function formatSynchronizedAt(value: string | null | undefined) { const timestamp = Date.parse(String(value || "")); return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Not yet synchronized"; }
function formatCad(value: number) { return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(value / 100); }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function labelStatus(value: string) { return humanize(value === "setup_required" ? "setup required" : value === "legacy_production" ? "legacy production" : value); }
