import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import trZapColorIcon from "../../assets/icons/trzapcolorcon.svg";
import { useAuth } from "../auth/AuthProvider";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { AdminIcon } from "../components/AdminIcon";
import {
  getBusinessProfile,
  getCommerceOverview,
  getCommerceOrders,
  getCommerceTemplates,
  getMerchandisingProducts,
  saveBusinessProfile,
  saveCommerceTemplate,
  saveFeaturedProducts,
  verifyStripeConnection,
  type BusinessPayload,
  type CommerceOverviewPayload,
  type CommerceOrdersPayload,
  type CommerceStatus,
  type CommerceTemplate,
  type MerchandisingPayload,
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
  return <>
    <CommerceHeading eyebrow="Provider adapter boundary" title="Fulfillment integrations" summary="Printful is the primary future adapter. Fulfillment submission and provider API access remain disabled." status="disabled" />
    <section className="provider-detail-grid">
      <DetailCard title="Printful" status="setup_required" lead="Primary fulfillment provider"><dl><Fact term="Account authority" value="Third Railify Printful account; Daniel is Master Admin" /><Fact term="Migration" value="Separate manual/API store planned" /><Fact term="Credential" value="Environment-managed private token" /><Fact term="Store ID" value="Not configured" /><Fact term="Catalogue" value="Not synchronized" /><Fact term="Order mode" value="Draft only" /><Fact term="Submission" value="Disabled" /><Fact term="Wix integration" value="Remains active" /></dl></DetailCard>
      <DetailCard title="Printify" status="unavailable" lead="Lower-priority adapter"><p>No current public evidence proves a Printify requirement or connection. Credential custody and connectivity remain undecided until a verified audit establishes them.</p></DetailCard>
    </section>
    <section className="transaction-model" aria-labelledby="transaction-model-title"><p className="eyebrow">Two separate transactions</p><h2 id="transaction-model-title">Stripe does not pay Printful</h2><div><article><span>01</span><strong>Customer payment</strong><p>The customer pays Third Railify through the dedicated Third Railify Official Stripe account.</p></article><article><span>02</span><strong>Fulfillment billing</strong><p>Printful separately charges the Third Railify Wallet or configured billing method for product, shipping, taxes, and applicable setup costs.</p></article></div></section>
  </>;
}

export function CommerceProductsPage() {
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
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<CommerceOrdersPayload | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const stop = startLoading("Loading authoritative commerce orders"); setError("");
    try { setPayload(await getCommerceOrders()); }
    catch (reason) { setError(errorMessage(reason, "Commerce orders are unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  return <>
    <CommerceHeading eyebrow="Commerce record authority" title="Orders" summary="Local orders are initialized from authoritative D1 product snapshots, linked to Stripe-hosted TEST Checkout, and marked paid only by a valid signed webhook. Fulfillment remains disabled." status="disabled" />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    <section className="commerce-posture" aria-label="Order engine posture"><div><span>Checkout engine</span><strong>Implemented / gated</strong></div><div><span>Public checkout</span><strong>Disabled</strong></div><div><span>Payment mode</span><strong>Stripe TEST</strong></div><div><span>Fulfillment</span><strong>Disabled</strong></div></section>
    {!payload && !error ? <CommerceState>Loading authoritative orders…</CommerceState> : payload ? payload.orders.length ? <section className="commerce-section" aria-labelledby="orders-list-title"><SectionTitle id="orders-list-title" eyebrow="Bounded payment state" title="Latest orders" /><div className="provider-card-grid">{payload.orders.map((order) => <article className="provider-card" key={order.id}><div><span>{order.id}</span><StatusBadge status={order.paymentStatus === "paid" ? "connected" : order.checkoutStatus === "checkout_failed" ? "error" : "pending"} label={order.paymentStatus === "paid" ? "Payment confirmed" : humanize(order.checkoutStatus)} /></div><dl><Fact term="Expected total" value={formatCad(order.expectedAmount)} /><Fact term="Checkout" value={humanize(order.checkoutStatus)} /><Fact term="Payment" value={humanize(order.paymentStatus)} /><Fact term="Fulfillment" value={humanize(order.fulfillmentStatus)} /><Fact term="Created" value={formatSynchronizedAt(order.createdAt)} /></dl></article>)}</div></section> : <CommerceState><strong>0 authoritative orders.</strong><span>Public checkout is disabled and no synthetic order or revenue record has been created.</span></CommerceState> : null}
  </>;
}

function CommerceHeading({ eyebrow, title, summary, status, statusLabel }: { eyebrow: string; title: string; summary: string; status: CommerceStatus; statusLabel?: string }) {
  return <section className="area-heading commerce-heading"><div className="area-icon"><AdminIcon name="products" size={28} /></div><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{summary}</p></div><StatusBadge status={status} label={statusLabel} /></section>;
}
function SectionTitle({ id, eyebrow, title }: { id: string; eyebrow: string; title: string }) { return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div></div>; }
function StatusBadge({ status, label }: { status: CommerceStatus; label?: string }) { return <span className={`commerce-status commerce-status--${status}`}>{label || labelStatus(status)}</span>; }
function ProviderCard({ provider }: { provider: ProviderStatus }) { const stripeConnected = provider.provider === "stripe" && provider.status === "connected" && provider.environment === "test" && provider.apiConfigured; const webhookOperational = provider.provider === "stripe" && provider.webhookConfigured && provider.webhookSigningConfigured; return <article className="provider-card"><div><span>{provider.label}</span><StatusBadge status={provider.status} label={stripeConnected ? "Test API connected" : undefined} /></div><dl>{provider.integrationMode && <Fact term="Integration" value={humanize(provider.integrationMode)} />}<Fact term="Custody" value={humanize(provider.credentialCustody)} /><Fact term="Environment" value={provider.environment === "test" ? "TEST" : humanize(provider.environment)} />{provider.countryCode && <Fact term="Country" value={provider.countryCode.toUpperCase() === "CA" ? "Canada" : provider.countryCode} />}{provider.currencyCode && <Fact term="Currency" value={provider.currencyCode.toUpperCase()} />}{provider.provider === "stripe" && <><Fact term="Account" value={metadataText(provider, "accountDisplayName") || (provider.accountCreated ? "Created" : "Not confirmed")} />{provider.externalAccountId && <Fact term="Account ID" value={compactAccountId(provider.externalAccountId)} />}<Fact term="API" value={stripeConnected ? "Test API connected" : "Not configured"} /><Fact term="Webhook endpoint" value={webhookOperational ? "Operational / configured" : provider.webhookEndpointReady ? "Ready for configuration" : "Unavailable"} /><Fact term="Webhook signing" value={webhookOperational ? "Configured / verified" : provider.webhookSigningConfigured ? "Configured — awaiting verified event" : "Not configured"} /><Fact term="Checkout engine" value="Implemented / gated" /><Fact term="Public checkout" value={provider.checkoutEnabled ? "Enabled" : "Disabled"} /><Fact term="Live payments" value={provider.livePaymentsEnabled ? "Enabled" : "Disabled"} /><Fact term="Live payouts" value={provider.livePayoutReadiness === "verified" ? "Verified" : "Unverified"} />{provider.lastSynchronizedAt && <Fact term="Last synchronized" value={formatSynchronizedAt(provider.lastSynchronizedAt)} />}</>}</dl></article>; }
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
function metadataBooleanLabel(provider: ProviderStatus | undefined, key: string) { return provider?.metadata?.[key] === true ? "Enabled in test mode" : "Disabled in test mode"; }
function compactAccountId(value: string | null | undefined) { const id = String(value || ""); return /^acct_[A-Za-z0-9]+$/.test(id) ? `${id.slice(0, 9)}…${id.slice(-4)}` : "Awaiting verification"; }
function formatSynchronizedAt(value: string | null | undefined) { const timestamp = Date.parse(String(value || "")); return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Not yet synchronized"; }
function formatCad(value: number) { return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(value / 100); }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function labelStatus(value: string) { return humanize(value === "setup_required" ? "setup required" : value === "legacy_production" ? "legacy production" : value); }
