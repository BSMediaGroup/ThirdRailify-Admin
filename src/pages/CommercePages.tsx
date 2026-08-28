import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
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
  getMerchandisingProducts,
  executePermanentPrintfulMigration,
  getPermanentPrintfulMigration,
  saveBusinessProfile,
  saveCommerceTemplate,
  saveFeaturedProducts,
  saveMerchandisingProduct,
  saveMerchandisingVariant,
  cadTextToMinorUnits,
  verifyStripeConnection,
  type BusinessPayload,
  type CommerceOverviewPayload,
  type CommerceOrdersPayload,
  type CommerceStatus,
  type CommerceTemplate,
  type MerchandisingPayload,
  type MerchandisingProduct,
  type MerchandisingVariant,
  type PermanentPrintfulMigrationPayload,
  type ProviderStatus,
  type TemplatesPayload,
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
        <AdminIcon name="shield" /><div><strong>{payload.databaseConfigured ? "Commerce D1 is available to the Admin runtime" : "Commerce D1 is not bound"}</strong><p>{payload.databaseConfigured ? "Order persistence and signed payment linkage are implemented, but the zero-product catalogue and explicit activation gates keep Public checkout disabled." : "Safe defaults are visible. Private fields and every mutation fail closed until the separate Admin-only database and encryption key are configured."}</p></div>
      </div>
      <section className="commerce-section" aria-labelledby="provider-status-title"><SectionTitle id="provider-status-title" eyebrow="Provider truth" title="Connections" /><div className="provider-card-grid">{payload.providers.map((provider) => <ProviderCard key={provider.provider} provider={provider} />)}</div></section>
      <section className="commerce-section" aria-labelledby="readiness-title"><SectionTitle id="readiness-title" eyebrow="No synthetic metrics" title="Readiness" /><div className="commerce-metric-grid">
        <Metric label="Business profile" value={labelStatus(payload.completeness.businessProfile)} />
        <Metric label="Tax configuration" value={labelStatus(payload.completeness.tax)} />
        <Metric label="Email templates" value={payload.counts.templates === null ? "Unavailable" : `${payload.counts.templates} drafts`} />
        <Metric label="Products" value={payload.counts.products === null ? "Unavailable" : String(payload.counts.products)} />
        <Metric label="Orders" value={payload.counts.orders === null ? "Unavailable" : String(payload.counts.orders)} />
      </div></section>
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
export function TaxDocumentsPage() { return <BusinessEditor mode="tax" />; }

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
        <Field label="Legal business name" hint={payload?.profile.private.legalBusinessNameStored ? "A private value is already stored. Leave blank to keep it." : "Stored only as encrypted ciphertext."}><input value={form.legalBusinessName || ""} onChange={(event) => update("legalBusinessName", event.target.value)} autoComplete="off" maxLength={240} /></Field>
        <Field label="Country"><input value="Canada" disabled /></Field><Field label="Province"><input value="Ontario" disabled /></Field><Field label="Storefront currency"><input value="CAD" disabled /></Field>
        <Field label="Public contact email"><input type="email" value={form.publicContactEmail || ""} onChange={(event) => update("publicContactEmail", event.target.value)} /></Field>
        <Field label="Support email"><input type="email" value={form.supportEmail || ""} onChange={(event) => update("supportEmail", event.target.value)} /></Field>
        <Field label="Public phone"><input value={form.publicPhone || ""} onChange={(event) => update("publicPhone", event.target.value)} placeholder="Not confirmed" /></Field>
        <Field label="Website"><input type="url" value={form.websiteUrl || ""} onChange={(event) => update("websiteUrl", event.target.value)} /></Field>
        <Field label="Public address line 1"><input value={form.publicAddressLine1 || ""} onChange={(event) => update("publicAddressLine1", event.target.value)} placeholder="Not confirmed" /></Field>
        <Field label="Public address line 2"><input value={form.publicAddressLine2 || ""} onChange={(event) => update("publicAddressLine2", event.target.value)} /></Field>
        <Field label="Public city"><input value={form.publicCity || ""} onChange={(event) => update("publicCity", event.target.value)} /></Field>
        <Field label="Public postal code"><input value={form.publicPostalCode || ""} onChange={(event) => update("publicPostalCode", event.target.value)} /></Field>
        <Field className="commerce-field--wide" label="Private/legal address" hint={payload?.profile.private.privateAddressStored ? "A private address is stored. Leave blank to keep it." : "Encrypted; never exposed to Public."}><textarea value={form.privateAddress || ""} onChange={(event) => update("privateAddress", event.target.value)} autoComplete="off" rows={4} /></Field>
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

export function CustomerEmailsPage() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<TemplatesPayload | null>(null);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<CommerceTemplate | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const stop = startLoading("Loading commerce templates"); setError("");
    try {
      const next = await getCommerceTemplates(); setPayload(next);
      const key = selected || next.templates[0]?.templateKey || ""; setSelected(key); setDraft(next.templates.find((item) => item.templateKey === key) || null);
    } catch (reason) { setError(errorMessage(reason, "Customer email templates are restricted or unavailable.")); }
    finally { stop(); }
  }, [selected, startLoading]);
  useEffect(() => { void load(); }, [load]);
  const choose = (key: string) => { setSelected(key); setDraft(payload?.templates.find((item) => item.templateKey === key) || null); setMessage(""); };
  const change = <K extends keyof CommerceTemplate>(key: K, value: CommerceTemplate[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!draft || !csrfToken || !payload?.databaseConfigured) return;
    const stop = startLoading("Saving structured email template"); setError(""); setMessage("");
    try { const next = await saveCommerceTemplate(csrfToken, draft); setPayload(next); setDraft(next.templates.find((item) => item.templateKey === draft.templateKey) || draft); setMessage("Draft template saved. No email was sent."); }
    catch (reason) { setError(errorMessage(reason, "The template could not be saved.")); }
    finally { stop(); }
  };
  return <>
    <CommerceHeading eyebrow="Structured plain text" title="Customer emails" summary="Edit bounded fields for seven lifecycle templates. JavaScript, executable HTML, and email delivery are not enabled." status={payload?.databaseConfigured ? "pending" : "unavailable"} />
    <div className="commerce-callout is-pending"><AdminIcon name="emails" /><div><strong>Community lifecycle templates are now first-class</strong><p>GOATS submission, Admin alert, approval, and rejection templates use their own idempotent outbox and documented variables.</p><Link className="text-link" to="/goats/emails">Open GOATS email templates <AdminIcon name="arrow" size={15} /></Link></div></div>
    {error && <div className="admin-alert" role="alert">{error}</div>}{message && <div className="auth-success" role="status">{message}</div>}
    {payload && draft ? <div className="template-workspace"><nav aria-label="Email template types">{payload.templates.map((template) => <button type="button" key={template.templateKey} className={template.templateKey === selected ? "is-active" : ""} onClick={() => choose(template.templateKey)}><span>{humanize(template.templateKey)}</span><small>{template.status}</small></button>)}</nav>
      <div className="template-workspace__editor">
        <form className="commerce-form" onSubmit={(event) => void submit(event)}>
          <Field className="commerce-field--wide" label="Subject"><input value={draft.subject} onChange={(event) => change("subject", event.target.value)} required maxLength={160} /></Field>
          <Field label="Preheader"><input value={draft.preheader} onChange={(event) => change("preheader", event.target.value)} maxLength={200} /></Field>
          <Field label="Heading"><input value={draft.heading} onChange={(event) => change("heading", event.target.value)} required maxLength={160} /></Field>
          <Field className="commerce-field--wide" label="Introduction"><textarea value={draft.introduction} onChange={(event) => change("introduction", event.target.value)} rows={3} maxLength={1000} /></Field>
          <Field className="commerce-field--wide" label="Body blocks" hint="One plain-text block per line; maximum eight."><textarea value={draft.bodyBlocks.join("\n")} onChange={(event) => change("bodyBlocks", event.target.value.split("\n").slice(0, 8))} rows={6} /></Field>
          <Field label="CTA label"><input value={draft.ctaLabel} onChange={(event) => change("ctaLabel", event.target.value)} maxLength={80} /></Field><Field label="CTA URL"><input value={draft.ctaUrl} onChange={(event) => change("ctaUrl", event.target.value)} placeholder="HTTPS or /relative" /></Field>
          <Field label="Support text"><textarea value={draft.supportText} onChange={(event) => change("supportText", event.target.value)} rows={3} /></Field><Field label="Footer"><textarea value={draft.footer} onChange={(event) => change("footer", event.target.value)} rows={3} /></Field>
          <Field label="Accent"><input type="color" value={draft.accentColor} onChange={(event) => change("accentColor", event.target.value)} /></Field><Field label="State"><select value={draft.status} onChange={(event) => change("status", event.target.value as CommerceTemplate["status"])}><option value="draft">Draft</option><option value="disabled">Disabled</option><option value="ready">Ready for later review</option></select></Field>
          <div className="commerce-form__actions commerce-field--wide"><button className="secondary-button" type="submit" disabled={!payload.databaseConfigured}>Save draft</button><span>No send, provider call, or raw HTML output occurs.</span></div>
        </form>
        <EmailTemplatePreview template={draft} />
      </div>
    </div> : !error && <CommerceState>Loading template editor…</CommerceState>}
  </>;
}

function EmailTemplatePreview({ template }: { template: CommerceTemplate }) {
  const bodyBlocks = template.bodyBlocks.filter((block) => block.trim());
  const titleId = `email-template-preview-${template.templateKey}`;
  return <section className="email-template-preview" aria-labelledby={titleId}>
    <header className="email-template-preview__toolbar">
      <div><p className="eyebrow">Rendered preview</p><h2 id={titleId}>{humanize(template.templateKey)}</h2></div>
      <span>{humanize(template.status)}</span>
    </header>
    <div className="email-template-preview__inbox">
      <span>Subject</span>
      <strong>{template.subject || "Untitled customer email"}</strong>
      <small>{template.preheader || "No preheader configured."}</small>
    </div>
    <article className="email-template-preview__message" style={{ borderColor: template.accentColor }}>
      <header className="email-template-preview__brand">
        <img src={trZapColorIcon} alt="" />
        <div><strong>THIRD RAILIFY OFFICIAL</strong><span>Customer notification</span></div>
      </header>
      <div className="email-template-preview__accent" style={{ backgroundColor: template.accentColor }} />
      <div className="email-template-preview__body">
        <p className="email-template-preview__type" style={{ color: template.accentColor }}>{humanize(template.templateKey)}</p>
        <h3>{template.heading || "Email heading"}</h3>
        {template.introduction ? <p>{template.introduction}</p> : <p className="is-placeholder">Introduction not configured.</p>}
        {bodyBlocks.length ? <div className="email-template-preview__blocks">{bodyBlocks.map((block, index) => <p key={`${index}-${block}`}>{block}</p>)}</div> : <p className="is-placeholder">No body blocks configured.</p>}
        {template.ctaLabel && <div className="email-template-preview__action"><span style={{ backgroundColor: template.accentColor }}>{template.ctaLabel}</span>{template.ctaUrl && <small>{template.ctaUrl}</small>}</div>}
        {template.supportText && <p className="email-template-preview__support">{template.supportText}</p>}
      </div>
      <footer><p>{template.footer || "Third Railify Official"}</p><small>Rendered preview only — no email has been sent.</small></footer>
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
  const canExecute = Boolean(access.isMasterAdmin && csrfToken && payload?.databaseConfigured && payload.printfulSecretConfigured && state && ["ready", "running", "waiting"].includes(state.status) && !busy);
  const canResume = Boolean(access.isMasterAdmin && csrfToken && payload?.databaseConfigured && payload.printfulSecretConfigured && state?.status === "blocked" && state.canResume && !busy);
  return <>
    <CommerceHeading eyebrow="Permanent catalogue authority" title="Fulfillment integrations" summary="The accepted 49-product Wix catalogue is loaded in Commerce D1 and ready for a resumable migration to the permanent native Printful store. The legacy Wix source is read only; checkout and fulfillment remain disabled." status={migrationComplete ? "connected" : state?.status === "blocked" ? "error" : "pending"} statusLabel={migrationComplete ? "Permanent catalogue migrated" : state?.status === "blocked" ? "Migration blocked safely" : "Ready for permanent migration"} />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {message && <div className="auth-success" role="status">{message}</div>}
    <section className="provider-detail-grid">
      <DetailCard title="Permanent target" status={state?.targetVerified ? "connected" : "pending"} statusLabel={state?.targetVerified ? "Token accepted" : "Verified before first write"} lead="Third Railify API"><dl><Fact term="Store ID" value="18668025" /><Fact term="Store type" value="native" /><Fact term="Credential" value={payload?.printfulSecretConfigured ? "Configured / server only" : "Not configured"} /><Fact term="Product write scope" value={state?.scopes ? "Verified" : "Pending protected preflight"} /><Fact term="Planned creates" value={String(catalogue?.plannedProductCreates ?? 49)} /><Fact term="Existing target-native keep" value={String(catalogue?.targetNativeKeeps ?? 1)} /><Fact term="Order mode" value="Draft only" /><Fact term="Checkout" value="Disabled" /><Fact term="Fulfillment" value="Disabled" /><Fact term="Webhooks" value="Not configured" /></dl></DetailCard>
      <DetailCard title="Legacy source" status="legacy_production" statusLabel="Read only" lead="Third Railify Official"><dl><Fact term="Store ID" value="16847493" /><Fact term="Store type" value="wix" /><Fact term="Credential use" value="GET only" /><Fact term="Allowed reads" value="Sync product / Sync Variant / original file" /><Fact term="Write access used" value="None" /><Fact term="Wix storefront" value="Live / untouched" /></dl></DetailCard>
      <DetailCard title="Permanent D1 catalogue" status="connected" statusLabel="Authoritative" lead="Accepted evidence / 2026-08-28"><dl><Fact term="D1 products" value={String(catalogue?.d1Products ?? 50)} /><Fact term="D1 variants" value={String(catalogue?.d1Variants ?? 1323)} /><Fact term="Planned target creates" value={String(catalogue?.plannedProductCreates ?? 49)} /><Fact term="Eligible variants" value={String(catalogue?.eligibleVariants ?? 1317)} /><Fact term="Deferred variants" value={String(catalogue?.deferredVariants ?? 5)} /><Fact term="Manual review" value="1 — Raider's Goblet excluded" /><Fact term="Maximum variants / product" value="96 / 100" /><Fact term="My Balloon" value="Preserved private / non-sellable" /></dl></DetailCard>
      <DetailCard title="Permanent Printful migration" status={migrationComplete ? "connected" : state?.status === "blocked" ? "error" : "pending"} statusLabel={state?.manuallyPaused ? "Paused" : humanize(state?.status || "ready")} lead={state?.currentProduct?.title || "Server-owned D1 queue"}><dl>
        <Fact term="Processed" value={`${state?.completedProducts ?? 0} / ${state?.totalProducts ?? 49}`} /><Fact term="Verified" value={String(catalogue?.verifiedProducts ?? state?.productsCreated ?? 0)} /><Fact term="Remaining" value={String(Math.max(0, (state?.totalProducts ?? 49) - (state?.completedProducts ?? 0)))} /><Fact term="Current phase" value={humanize(state?.phase || "ready")} /><Fact term="File resolution" value={state?.fileProgress ? `${state.fileProgress.resolved} / ${state.fileProgress.total}` : "Awaiting current product"} /><Fact term="Provider state" value={state?.manuallyPaused ? "Paused" : humanize(state?.providerState || "ready")} />
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
  const [payload, setPayload] = useState<MerchandisingPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState("all");
  const [status, setStatus] = useState("all");
  const [migration, setMigration] = useState("all");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("display");
  const [featuredIds, setFeaturedIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savingFeatured, setSavingFeatured] = useState(false);
  const load = useCallback(async () => {
    const stop = startLoading("Loading authoritative products"); setError("");
    try { const next = await getMerchandisingProducts(); setPayload(next); setFeaturedIds(next.featured.map((product) => product.id)); }
    catch (reason) { setError(errorMessage(reason, "Product merchandising is unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  const canManage = Boolean(payload?.access?.capabilities.includes("commerce.business.manage"));
  const categories = useMemo(() => [...new Set((payload?.products || []).flatMap((product) => product.categories))].sort(), [payload]);
  const products = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const next = (payload?.products || []).filter((product) =>
      (!needle || `${product.title} ${product.slug} ${product.categories.join(" ")}`.toLowerCase().includes(needle)) &&
      (visibility === "all" || product.visibility === visibility) && (status === "all" || product.status === status) &&
      (migration === "all" || product.migrationStatus === migration) && (category === "all" || product.categories.includes(category)));
    next.sort(sort === "name" ? (a, b) => a.title.localeCompare(b.title) : sort === "price" ? (a, b) => (a.price.minimum ?? Infinity) - (b.price.minimum ?? Infinity) || a.slug.localeCompare(b.slug) : (a, b) => Number(b.featured) - Number(a.featured) || (a.featuredOrder ?? Infinity) - (b.featuredOrder ?? Infinity) || a.displayOrder - b.displayOrder || a.slug.localeCompare(b.slug));
    return next;
  }, [category, migration, payload, query, sort, status, visibility]);
  const selected = payload?.products.find((product) => product.id === selectedId) || null;
  const ordered = featuredIds.map((id) => payload?.products.find((product) => product.id === id)).filter((product): product is MerchandisingProduct => Boolean(product));
  const toggleFeatured = (id: string) => setFeaturedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const moveFeatured = (id: string, offset: -1 | 1) => setFeaturedIds((current) => { const index = current.indexOf(id); const target = index + offset; if (index < 0 || target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  const replaceProduct = (product: MerchandisingProduct) => setPayload((current) => current ? { ...current, products: current.products.map((entry) => entry.id === product.id ? product : entry), featured: current.featured.map((entry) => entry.id === product.id ? product : entry).filter((entry) => entry.featured) } : current);
  const saveFeatured = async () => { if (!csrfToken || !canManage) return; setSavingFeatured(true); setError(""); setMessage(""); try { const next = await saveFeaturedProducts(csrfToken, featuredIds); setPayload(next); setFeaturedIds(next.featured.map((product) => product.id)); setMessage("Featured order saved to Commerce D1."); } catch (reason) { setError(errorMessage(reason, "Featured products could not be saved.")); } finally { setSavingFeatured(false); } };
  return <>
    <CommerceHeading eyebrow="Commerce D1 authority" title="Shop / Products" summary="Manage the replacement catalogue, real variants, integer CAD prices, public presentation, and provider readiness. Displayability is independent from the globally disabled checkout and paused fulfillment migration." status={payload?.databaseConfigured ? "connected" : "unavailable"} />
    {error && <div className="admin-alert" role="alert">{error}</div>}{message && <div className="commerce-callout is-pending" role="status"><AdminIcon name="shield" /><div><strong>Merchandising saved</strong><p>{message}</p></div></div>}
    {!payload && !error ? <CommerceState>Loading catalogue merchandising…</CommerceState> : payload ? <div className="merchandising-workspace commerce-catalogue-manager">
      <section className="commerce-posture" aria-label="Catalogue totals"><div><span>Products</span><strong>{payload.products.length}</strong></div><div><span>Public</span><strong>{payload.products.filter((product) => product.visibility === "public" && product.status === "active").length}</strong></div><div><span>Variants</span><strong>{payload.products.reduce((total, product) => total + product.variantCount, 0)}</strong></div><div><span>Checkout</span><strong>Globally disabled</strong></div></section>
      <section className="commerce-section" aria-labelledby="catalogue-products-title"><SectionTitle id="catalogue-products-title" eyebrow="Authoritative catalogue" title="Products and readiness" />
        <div className="commerce-product-filters"><Field label="Search"><input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Title, slug, or category" /></Field><Field label="Visibility"><select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="all">All</option><option value="public">Public</option><option value="private">Hidden</option></select></Field><Field label="Status"><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All</option>{["active", "disabled", "pending", "restricted", "error"].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></Field><Field label="Migration"><select value={migration} onChange={(event) => setMigration(event.target.value)}><option value="all">All</option>{[...new Set(payload.products.map((product) => product.migrationStatus))].sort().map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></Field><Field label="Category"><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All</option>{categories.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Sort"><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="display">Featured / display</option><option value="name">Name</option><option value="price">Price</option></select></Field></div>
        <p className="commerce-action-note">Showing {products.length} of {payload.products.length} products.</p>
        <div className="commerce-product-table" role="list">{products.map((product) => <article key={product.id} role="listitem" className="commerce-product-row"><div className="commerce-product-row__image">{product.primaryImageUrl ? <img src={product.primaryImageUrl} alt="" /> : <span aria-hidden="true">TR</span>}</div><div><strong>{product.title}</strong><small>/{product.slug}</small><span>{product.categories.join(" · ") || "Uncategorized"}</span></div><div><span>Price</span><strong>{product.price.label}</strong><small>{product.activeVariantCount} / {product.variantCount} public variants</small></div><div><span>Catalogue</span><strong>{product.visibility === "public" && product.status === "active" ? "Public" : "Hidden"}</strong><small>{product.featured ? "Featured" : `Order ${product.displayOrder}`}</small></div><div><span>Fulfillment mapping</span><strong>{humanize(product.readiness.fulfillment)}</strong><small>Migration: {humanize(product.migrationStatus)}</small></div><button className="button-link" type="button" onClick={() => setSelectedId(product.id)}>Edit product</button></article>)}</div>
      </section>
      {selected && <ProductMerchandisingEditor product={selected} csrfToken={csrfToken} canManage={canManage} onClose={() => setSelectedId(null)} onSaved={(product, notice) => { replaceProduct(product); setMessage(notice); }} onError={setError} />}
      <section className="merchandising-preview" aria-labelledby="featured-manager-title"><div><p className="eyebrow">Public hero order</p><h2 id="featured-manager-title">Featured rail</h2></div>{ordered.length ? <ol>{ordered.map((product, index) => <li key={product.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{product.title}</strong><small>{product.displayData.ready ? "Image and CAD price available" : "Image or price requires attention"}</small></div><div className="merchandising-order-actions"><button type="button" onClick={() => moveFeatured(product.id, -1)} disabled={index === 0} aria-label={`Move ${product.title} up`}>↑</button><button type="button" onClick={() => moveFeatured(product.id, 1)} disabled={index === ordered.length - 1} aria-label={`Move ${product.title} down`}>↓</button></div></li>)}</ol> : <p className="merchandising-empty">No products are featured.</p>}</section>
      <section className="merchandising-products" aria-labelledby="featured-products-title"><div><p className="eyebrow">Deterministic selection</p><h2 id="featured-products-title">Featured products</h2></div><div className="merchandising-product-list">{payload.products.filter((product) => product.status === "active" && product.visibility === "public").map((product) => <label key={product.id} className={featuredIds.includes(product.id) ? "is-featured" : ""}><input type="checkbox" checked={featuredIds.includes(product.id)} onChange={() => toggleFeatured(product.id)} disabled={!canManage} /><span><strong>{product.title}</strong><small>/{product.slug}</small></span><em>{featuredIds.includes(product.id) ? `Featured ${featuredIds.indexOf(product.id) + 1}` : "Catalogue"}</em></label>)}</div></section>
      <div className="merchandising-savebar"><p>{canManage ? "Writes require commerce permission, exact Admin origin, CSRF, rate limiting, bounded validation, and audit." : "commerce.business.manage is required to edit merchandising."}</p><button className="button-link" type="button" onClick={() => void saveFeatured()} disabled={savingFeatured || !canManage || !payload.databaseConfigured}>{savingFeatured ? "Saving…" : "Save featured order"}</button></div>
    </div> : null}
  </>;
}

function ProductMerchandisingEditor({ product, csrfToken, canManage, onClose, onSaved, onError }: { product: MerchandisingProduct; csrfToken: string | null; canManage: boolean; onClose: () => void; onSaved: (product: MerchandisingProduct, message: string) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState(() => productForm(product));
  const [variantId, setVariantId] = useState(product.variants[0]?.id || "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setForm(productForm(product)); setVariantId((current) => product.variants.some((variant) => variant.id === current) ? current : product.variants[0]?.id || ""); }, [product]);
  const variant = product.variants.find((entry) => entry.id === variantId) || null;
  const update = (key: string, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const saveProduct = async (event: FormEvent) => { event.preventDefault(); if (!csrfToken || !canManage) return; setSaving(true); onError(""); try { const result = await saveMerchandisingProduct(csrfToken, product.id, { title: form.title, slug: form.slug, description: form.description, primaryImageUrl: form.primaryImageUrl, additionalImages: splitLines(form.additionalImages), categories: splitComma(form.categories), tags: splitComma(form.tags), featured: form.featured, visibility: form.visibility, status: form.status, displayOrder: Number(form.displayOrder), maxQuantity: Number(form.maxQuantity), unitAmount: product.unitAmount, currencyCode: "CAD" }); onSaved(result.product, "Product merchandising saved to Commerce D1."); } catch (reason) { onError(errorMessage(reason, "Product merchandising could not be saved.")); } finally { setSaving(false); } };
  return <section className="commerce-product-editor" aria-labelledby="product-editor-title"><header><div><p className="eyebrow">Product editor</p><h2 id="product-editor-title">{product.title}</h2></div><button type="button" className="text-button" onClick={onClose}>Close editor</button></header>
    <form onSubmit={(event) => void saveProduct(event)}><div className="commerce-form-grid"><Field label="Title"><input value={form.title} onChange={(event) => update("title", event.target.value)} maxLength={240} required /></Field><Field label="Slug"><input value={form.slug} onChange={(event) => update("slug", event.target.value)} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={180} required /></Field><Field label="Description" className="commerce-field--wide"><textarea value={form.description} onChange={(event) => update("description", event.target.value)} maxLength={12000} rows={5} /></Field><Field label="Primary image URL" className="commerce-field--wide"><input type="url" value={form.primaryImageUrl} onChange={(event) => update("primaryImageUrl", event.target.value)} /></Field><Field label="Additional image URLs" hint="One HTTPS URL per line." className="commerce-field--wide"><textarea value={form.additionalImages} onChange={(event) => update("additionalImages", event.target.value)} rows={3} /></Field><Field label="Categories" hint="Comma separated."><input value={form.categories} onChange={(event) => update("categories", event.target.value)} /></Field><Field label="Tags" hint="Comma separated."><input value={form.tags} onChange={(event) => update("tags", event.target.value)} /></Field><Field label="Public visibility"><select value={form.visibility} onChange={(event) => update("visibility", event.target.value)}><option value="public">Public</option><option value="private">Private</option></select></Field><Field label="Catalogue status"><select value={form.status} onChange={(event) => update("status", event.target.value)}><option value="active">Active</option><option value="disabled">Inactive</option></select></Field><Field label="Display order"><input type="number" min={0} max={999999} value={form.displayOrder} onChange={(event) => update("displayOrder", event.target.value)} /></Field><Field label="Maximum quantity"><input type="number" min={1} max={20} value={form.maxQuantity} onChange={(event) => update("maxQuantity", event.target.value)} /></Field><label className="commerce-toggle"><input type="checkbox" checked={form.featured} onChange={(event) => update("featured", event.target.checked)} /><span>Featured product</span></label></div><div className="merchandising-savebar"><p>Provider identity and migration provenance are read-only.</p><button className="button-link" type="submit" disabled={!canManage || !csrfToken || saving}>{saving ? "Saving…" : "Save product"}</button></div></form>
    <section className="commerce-variant-manager" aria-labelledby="variant-editor-title"><SectionTitle id="variant-editor-title" eyebrow="Variant authority" title={`Variants (${product.variants.length})`} />{product.variants.length ? <><Field label="Choose variant"><select value={variantId} onChange={(event) => setVariantId(event.target.value)}>{product.variants.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayLabel} — {formatCad(entry.unitAmount)}</option>)}</select></Field>{variant && <VariantMerchandisingEditor key={variant.id} product={product} variant={variant} csrfToken={csrfToken} canManage={canManage} onSaved={onSaved} onError={onError} />}</> : <CommerceState>No variants are attached to this product.</CommerceState>}</section>
  </section>;
}

function VariantMerchandisingEditor({ product, variant, csrfToken, canManage, onSaved, onError }: { product: MerchandisingProduct; variant: MerchandisingVariant; csrfToken: string | null; canManage: boolean; onSaved: (product: MerchandisingProduct, message: string) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState(() => variantForm(variant)); const [saving, setSaving] = useState(false);
  const update = (key: string, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const saveVariant = async (event: FormEvent) => { event.preventDefault(); if (!csrfToken || !canManage) return; setSaving(true); onError(""); try { const options = JSON.parse(form.options) as unknown; const result = await saveMerchandisingVariant(csrfToken, product.id, variant.id, { displayLabel: form.displayLabel, size: form.size, color: form.color, options, unitAmount: cadTextToMinorUnits(form.price), currencyCode: "CAD", status: form.status, visibility: form.visibility, sellable: form.sellable, availability: form.availability }); onSaved(result.product, "Variant merchandising saved to Commerce D1."); } catch (reason) { onError(errorMessage(reason, "Variant merchandising could not be saved.")); } finally { setSaving(false); } };
  return <form className="commerce-variant-form" onSubmit={(event) => void saveVariant(event)}><div className="commerce-form-grid"><Field label="Display label"><input value={form.displayLabel} onChange={(event) => update("displayLabel", event.target.value)} maxLength={240} /></Field><Field label="CAD price"><input inputMode="decimal" value={form.price} onChange={(event) => update("price", event.target.value)} required /></Field><Field label="Size"><input value={form.size} onChange={(event) => update("size", event.target.value)} /></Field><Field label="Color"><input value={form.color} onChange={(event) => update("color", event.target.value)} /></Field><Field label="Options JSON" className="commerce-field--wide"><textarea value={form.options} onChange={(event) => update("options", event.target.value)} rows={3} /></Field><Field label="Visibility"><select value={form.visibility} onChange={(event) => update("visibility", event.target.value)}><option value="public">Public</option><option value="private">Private</option></select></Field><Field label="Status"><select value={form.status} onChange={(event) => update("status", event.target.value)}><option value="active">Active</option><option value="disabled">Inactive</option></select></Field><Field label="Availability"><select value={form.availability} onChange={(event) => update("availability", event.target.value)}><option value="active">Available</option><option value="temporarily_out_of_stock">Temporarily out of stock</option><option value="discontinued">Discontinued</option></select></Field><label className="commerce-toggle"><input type="checkbox" checked={form.sellable} onChange={(event) => update("sellable", event.target.checked)} /><span>Sellable when checkout is enabled</span></label></div><dl className="commerce-integration-metadata"><Fact term="SKU" value={variant.sku || "None"} /><Fact term="Migration" value={humanize(variant.migrationStatus)} /><Fact term="Fulfillment mapping" value={humanize(variant.fulfillmentMappingStatus)} /><Fact term="Target variant" value={variant.integration.targetPrintfulVariantId || "Not mapped"} /></dl><button className="button-link" type="submit" disabled={!canManage || !csrfToken || saving}>{saving ? "Saving…" : "Save variant"}</button></form>;
}

function productForm(product: MerchandisingProduct) { return { title: product.title, slug: product.slug, description: product.description, primaryImageUrl: product.primaryImageUrl || "", additionalImages: product.additionalImages.join("\n"), categories: product.categories.join(", "), tags: product.tags.join(", "), visibility: product.visibility === "public" ? "public" : "private", status: product.status === "active" ? "active" : "disabled", displayOrder: String(product.displayOrder), maxQuantity: String(product.maxQuantity), featured: product.featured }; }
function variantForm(variant: MerchandisingVariant) { return { displayLabel: variant.displayLabel, size: variant.size || "", color: variant.color || "", options: JSON.stringify(variant.options, null, 2), price: (variant.unitAmount / 100).toFixed(2), visibility: variant.visibility === "public" ? "public" : "private", status: variant.status === "active" ? "active" : "disabled", sellable: variant.sellable, availability: variant.availability }; }
function splitComma(value: string) { return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))]; }
function splitLines(value: string) { return [...new Set(value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))]; }

export function LegacyCommerceProductsPage() {
  const { csrfToken, access } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<MerchandisingPayload | null>(null);
  const [featuredIds, setFeaturedIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    const stop = startLoading("Loading product merchandising"); setError("");
    try { const next = await getMerchandisingProducts(); setPayload(next); setFeaturedIds(next.featured.map((product) => product.id)); }
    catch (reason) { setError(errorMessage(reason, "Product merchandising is unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string) => setFeaturedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const move = (id: string, offset: -1 | 1) => setFeaturedIds((current) => {
    const index = current.indexOf(id); const target = index + offset;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next;
  });
  const save = async () => {
    if (!csrfToken || !access.isMasterAdmin) return;
    setSaving(true); setError(""); setMessage("");
    try { const next = await saveFeaturedProducts(csrfToken, featuredIds); setPayload(next); setFeaturedIds(next.featured.map((product) => product.id)); setMessage("Featured product order saved to commerce D1."); }
    catch (reason) { setError(errorMessage(reason, "Featured products could not be saved.")); }
    finally { setSaving(false); }
  };

  const ordered = featuredIds.map((id) => payload?.products.find((product) => product.id === id)).filter((product): product is NonNullable<typeof product> => Boolean(product));
  return <>
    <CommerceHeading eyebrow="Merchandising authority" title="Shop / Products" summary="Choose the displayable catalogue products that lead the public shop hero and define their stable order. Product prices, imagery, options, cart values, and checkout remain owned by the public snapshot and current Wix store." status={payload?.databaseConfigured ? "pending" : "unavailable"} />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {message && <div className="commerce-callout is-pending" role="status"><AdminIcon name="shield" /><div><strong>Merchandising saved</strong><p>{message}</p></div></div>}
    {!payload && !error ? <CommerceState>Loading catalogue merchandising…</CommerceState> : payload ? <div className="merchandising-workspace">
      <section className="merchandising-preview" aria-labelledby="featured-preview-title">
        <div><p className="eyebrow">Public hero order</p><h2 id="featured-preview-title">Featured rail</h2></div>
        {ordered.length ? <ol>{ordered.map((product, index) => <li key={product.id} className={!product.displayData.ready ? "has-warning" : ""}>
          <span>{String(index + 1).padStart(2, "0")}</span><div><strong>{product.title}</strong><small>{product.displayData.ready ? "Image and CAD price captured" : "Warning: public image or price is missing"}</small></div>
          <div className="merchandising-order-actions"><button type="button" onClick={() => move(product.id, -1)} disabled={index === 0} aria-label={`Move ${product.title} up`}>↑</button><button type="button" onClick={() => move(product.id, 1)} disabled={index === ordered.length - 1} aria-label={`Move ${product.title} down`}>↓</button></div>
        </li>)}</ol> : <p className="merchandising-empty">No products are explicitly featured. The public shop will use its deterministic displayable-product fallback.</p>}
      </section>
      <section className="merchandising-products" aria-labelledby="catalogue-products-title">
        <div><p className="eyebrow">Current bounded catalogue</p><h2 id="catalogue-products-title">Displayable products</h2></div>
        <div className="merchandising-product-list">{payload.products.map((product) => <label key={product.id} className={featuredIds.includes(product.id) ? "is-featured" : ""}>
          <input type="checkbox" checked={featuredIds.includes(product.id)} onChange={() => toggle(product.id)} disabled={!access.isMasterAdmin} />
          <span><strong>{product.title}</strong><small>/{product.slug}</small></span><em>{featuredIds.includes(product.id) ? `Featured ${featuredIds.indexOf(product.id) + 1}` : "Catalogue"}</em>
        </label>)}</div>
      </section>
      <div className="merchandising-savebar"><p>{access.isMasterAdmin ? "Changes use the existing authenticated Master Admin, CSRF, rate-limit, D1, and audit path." : "Only a Master Admin can change featured products."}</p><button className="button-link" type="button" onClick={() => void save()} disabled={saving || !access.isMasterAdmin || !payload.databaseConfigured}>{saving ? "Saving…" : "Save featured order"}</button></div>
    </div> : null}
  </>;
}
export function CommerceOrdersPage() {
  const { csrfToken, access } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<CommerceOrdersPayload | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
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
  const canGenerate = Boolean(access.isMasterAdmin && csrfToken && controlled?.enabled && !controlled.normalCheckoutEnabled && !controlled.livePaymentsEnabled && !controlled.fulfillmentEnabled && candidate?.sellable && candidate.mappingStatus === "mapped" && candidate.migrationStatus === "target_verified" && !payload?.orders.length && !busy);
  return <>
    <CommerceHeading eyebrow="Commerce record authority" title="Orders" summary="Local orders are initialized from authoritative D1 product snapshots, linked to Stripe-hosted TEST Checkout, and marked paid only by a valid signed webhook. Fulfillment remains disabled." status="disabled" />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {message && <div className="auth-success" role="status">{message}</div>}
    <section className="commerce-posture" aria-label="Order engine posture"><div><span>Checkout engine</span><strong>Implemented / gated</strong></div><div><span>Public checkout</span><strong>Disabled</strong></div><div><span>Payment mode</span><strong>Stripe TEST</strong></div><div><span>Fulfillment</span><strong>Disabled</strong></div></section>
    {payload && access.isMasterAdmin ? <section className="commerce-section test-checkout-card" aria-labelledby="test-checkout-title"><SectionTitle id="test-checkout-title" eyebrow="TEST CHECKOUT · STRIPE SANDBOX · NO REAL CHARGE" title="Pre-cutover payment acceptance" /><div className="provider-detail-grid"><DetailCard title="Controlled acceptance candidate" status={controlled?.enabled ? "pending" : "disabled"} statusLabel={controlled?.enabled ? "Master-only gate enabled" : "Gate disabled"} lead={candidate?.title || "No candidate configured"}><dl><Fact term="Product" value={candidate?.title || "Unavailable"} /><Fact term="Variant" value={candidate?.variantLabel || "Unavailable"} /><Fact term="Price" value={candidate ? formatCad(candidate.unitAmount) : "Unavailable"} /><Fact term="Stripe environment" value="TEST" /><Fact term="Target mapping" value={candidate ? humanize(candidate.mappingStatus) : "Unavailable"} /><Fact term="Normal checkout" value={controlled?.normalCheckoutEnabled ? "Unexpectedly enabled" : "Disabled"} /><Fact term="Live payments" value={controlled?.livePaymentsEnabled ? "Unexpectedly enabled" : "Disabled"} /><Fact term="Fulfillment" value={controlled?.fulfillmentEnabled ? "Unexpectedly enabled" : "Disabled"} /></dl><button className="button-link" type="button" onClick={() => void generate()} disabled={!canGenerate}>{busy ? "Generating…" : payload.orders.length ? "Single acceptance Session already created" : "Generate Test Checkout"}</button></DetailCard></div></section> : null}
    {!payload && !error ? <CommerceState>Loading authoritative orders…</CommerceState> : payload ? payload.orders.length ? <section className="commerce-section" aria-labelledby="orders-list-title"><SectionTitle id="orders-list-title" eyebrow="Bounded payment state" title="Latest orders" /><div className="provider-card-grid">{payload.orders.map((order) => <article className="provider-card" key={order.id}><div><span>{order.test ? "TEST · " : ""}{order.id}</span><StatusBadge status={order.paymentStatus === "paid" ? "connected" : order.checkoutStatus === "checkout_failed" ? "error" : "pending"} label={order.paymentStatus === "paid" ? "Payment confirmed" : humanize(order.checkoutStatus)} /></div><dl>{order.items.map((item) => <div key={`${item.productId}:${item.variantId || ""}`}><dt>Product / variant</dt><dd>{item.productName}{item.variantName ? ` · ${item.variantName}` : ""} · qty {item.quantity}</dd></div>)}<Fact term="CAD total" value={formatCad(order.expectedAmount)} /><Fact term="Checkout Session" value={order.stripeSessionId ? "Created" : "Not created"} /><Fact term="Payment" value={humanize(order.paymentStatus)} /><Fact term="Fulfillment" value={`${humanize(order.fulfillmentStatus)} / not started`} /><Fact term="Printful order" value={order.hasPrintfulOrder ? "Unexpectedly present" : "None"} /><Fact term="Created" value={formatSynchronizedAt(order.createdAt)} /></dl>{order.checkoutUrl && order.paymentStatus !== "paid" ? <a className="button-link" href={order.checkoutUrl} target="_blank" rel="noopener noreferrer">Open Stripe TEST Checkout</a> : null}</article>)}</div></section> : <CommerceState><strong>0 authoritative orders.</strong><span>Normal checkout is disabled. Only the Master-controlled Stripe TEST acceptance action can create the single pre-cutover order.</span></CommerceState> : null}
  </>;
}

function CommerceHeading({ eyebrow, title, summary, status, statusLabel }: { eyebrow: string; title: string; summary: string; status: CommerceStatus; statusLabel?: string }) {
  return <section className="area-heading commerce-heading"><div className="area-icon"><AdminIcon name="products" size={28} /></div><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{summary}</p></div><StatusBadge status={status} label={statusLabel} /></section>;
}
function SectionTitle({ id, eyebrow, title }: { id: string; eyebrow: string; title: string }) { return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div></div>; }
function StatusBadge({ status, label }: { status: CommerceStatus; label?: string }) { return <span className={`commerce-status commerce-status--${status}`}>{label || labelStatus(status)}</span>; }
function ProviderCard({ provider }: { provider: ProviderStatus }) { const stripeConnected = provider.provider === "stripe" && provider.status === "connected" && provider.environment === "test" && provider.apiConfigured; const printfulConnected = provider.provider === "printful" && provider.status === "connected" && provider.apiConfigured; const webhookOperational = provider.provider === "stripe" && provider.webhookConfigured && provider.webhookSigningConfigured; return <article className="provider-card"><div><span>{provider.label}</span><StatusBadge status={provider.status} label={stripeConnected ? "Test API connected" : printfulConnected ? "API connected" : undefined} /></div><dl>{provider.integrationMode && <Fact term="Integration" value={humanize(provider.integrationMode)} />}<Fact term="Custody" value={humanize(provider.credentialCustody)} /><Fact term="Environment" value={provider.provider === "printful" ? "Real API / pre-cutover rollout" : provider.environment === "test" ? "TEST" : humanize(provider.environment)} />{provider.countryCode && <Fact term="Country" value={provider.countryCode.toUpperCase() === "CA" ? "Canada" : provider.countryCode} />}{provider.currencyCode && <Fact term="Currency" value={provider.currencyCode.toUpperCase()} />}{provider.provider === "stripe" && <><Fact term="Account" value={metadataText(provider, "accountDisplayName") || (provider.accountCreated ? "Created" : "Not confirmed")} />{provider.externalAccountId && <Fact term="Account ID" value={compactAccountId(provider.externalAccountId)} />}<Fact term="API" value={stripeConnected ? "Test API connected" : "Not configured"} /><Fact term="Webhook endpoint" value={webhookOperational ? "Operational / configured" : provider.webhookEndpointReady ? "Ready for configuration" : "Unavailable"} /><Fact term="Webhook signing" value={webhookOperational ? "Configured / verified" : provider.webhookSigningConfigured ? "Configured — awaiting verified event" : "Not configured"} /><Fact term="Checkout engine" value="Implemented / gated" /><Fact term="Public checkout" value={provider.checkoutEnabled ? "Enabled" : "Disabled"} /><Fact term="Live payments" value={provider.livePaymentsEnabled ? "Enabled" : "Disabled"} /><Fact term="Live payouts" value={provider.livePayoutReadiness === "verified" ? "Verified" : "Unverified"} />{provider.lastSynchronizedAt && <Fact term="Last synchronized" value={formatSynchronizedAt(provider.lastSynchronizedAt)} />}</>}{provider.provider === "printful" && <><Fact term="API" value={printfulConnected ? "Connected" : "Verification pending"} /><Fact term="Store" value={metadataText(provider, "storeName") || "Awaiting verification"} /><Fact term="Store ID" value={provider.externalAccountId || "Awaiting verification"} /><Fact term="Products" value={metadataNumberText(provider, "productCount")} /><Fact term="Order mode" value="Draft only" /><Fact term="Automatic fulfillment" value="Disabled" /><Fact term="Existing Wix store" value="Unaffected" /></>}</dl></article>; }
function DetailCard({ title, status, statusLabel, lead, children }: { title: string; status: CommerceStatus; statusLabel?: string; lead: string; children: ReactNode }) { return <article className="provider-detail"><header><div><p>{lead}</p><h2>{title}</h2></div><StatusBadge status={status} label={statusLabel} /></header>{children}</article>; }
function Fact({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <article><span>{label}</span><strong>{value}</strong></article>; }
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
  const profile = payload.profile; const address = profile.publicAddress || {};
  return { tradingName: profile.tradingName, legalBusinessName: "", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: profile.publicContactEmail, supportEmail: profile.supportEmail, publicPhone: profile.publicPhone, websiteUrl: profile.websiteUrl, publicAddressLine1: address.line1 || "", publicAddressLine2: address.line2 || "", publicCity: address.city || "", publicPostalCode: address.postalCode || "", privateAddress: "", businessNumber: "", gstHstNumber: "", provincialRegistration: "", invoicePrefix: profile.invoicePrefix, documentFooter: profile.documentFooter, taxProviderState: profile.taxProviderState, invoiceAccentColor: profile.invoiceAccentColor, receiptAccentColor: profile.receiptAccentColor };
}
function formToBusinessPayload(form: Record<string, string>) { return { ...form, countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicAddress: { line1: form.publicAddressLine1, line2: form.publicAddressLine2, city: form.publicCity, province: "ON", postalCode: form.publicPostalCode, country: "CA" } }; }
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
