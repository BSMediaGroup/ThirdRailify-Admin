import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { AdminIcon } from "../components/AdminIcon";
import {
  getBusinessProfile,
  getCommerceOverview,
  getCommerceTemplates,
  saveBusinessProfile,
  saveCommerceTemplate,
  type BusinessPayload,
  type CommerceOverviewPayload,
  type CommerceStatus,
  type CommerceTemplate,
  type ProviderStatus,
  type TemplatesPayload,
} from "../commerce/client";

const REQUIRED_POSTURE = [
  ["Commerce environment", "Staging"],
  ["Checkout", "Disabled"],
  ["Live payment capture", "Disabled"],
  ["Fulfillment submission", "Disabled"],
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

  return <>
    <CommerceHeading eyebrow="Admin-only control plane" title="Commerce overview" summary="Stripe-first Canadian commerce foundations with every payment, onboarding, and fulfillment action still disabled." status="disabled" />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {!payload ? <CommerceState>Loading truthful commerce status…</CommerceState> : <>
      <section className="commerce-posture" aria-label="Required safe posture">{REQUIRED_POSTURE.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
      <div className={`commerce-callout ${payload.databaseConfigured ? "is-pending" : "is-unavailable"}`} role="status">
        <AdminIcon name="shield" /><div><strong>{payload.databaseConfigured ? "Commerce D1 is locally available" : "Commerce D1 is not bound"}</strong><p>{payload.databaseConfigured ? "Persistence is available, but payment and fulfillment gates remain disabled." : "Safe defaults are visible. Private fields and every mutation fail closed until the separate Admin-only database and encryption key are configured."}</p></div>
      </div>
      <section className="commerce-section" aria-labelledby="provider-status-title"><SectionTitle id="provider-status-title" eyebrow="Provider truth" title="Connections" /><div className="provider-card-grid">{payload.providers.map((provider) => <ProviderCard key={provider.provider} provider={provider} />)}</div></section>
      <section className="commerce-section" aria-labelledby="readiness-title"><SectionTitle id="readiness-title" eyebrow="No synthetic metrics" title="Readiness" /><div className="commerce-metric-grid">
        <Metric label="Business profile" value={labelStatus(payload.completeness.businessProfile)} />
        <Metric label="Tax configuration" value={labelStatus(payload.completeness.tax)} />
        <Metric label="Email templates" value={payload.counts.templates === null ? "Unavailable" : `${payload.counts.templates} drafts`} />
        <Metric label="Products" value={payload.counts.products === null ? "Unavailable" : String(payload.counts.products)} />
        <Metric label="Orders" value={payload.counts.orders === null ? "Unavailable" : String(payload.counts.orders)} />
      </div></section>
      <section className="commerce-section" aria-labelledby="workspace-title"><SectionTitle id="workspace-title" eyebrow="Governed workspaces" title="Configure safely" /><div className="commerce-link-grid">
        <WorkspaceLink to="/commerce/payments" title="Payments & payouts" text="Stripe direct-charge ownership and deferred PayPal posture." />
        <WorkspaceLink to="/commerce/business" title="Business information" text="Public details plus encrypted private Canadian fields." />
        <WorkspaceLink to="/commerce/tax" title="Tax & documents" text="BN/GST/HST custody, invoice and receipt presentation." />
        <WorkspaceLink to="/commerce/emails" title="Customer emails" text="Structured plain-text templates; sending remains disabled." />
        <WorkspaceLink to="/commerce/fulfillment" title="Fulfillment" text="Printful draft-only migration plan and Printify uncertainty." />
      </div></section>
    </>}
  </>;
}

export function PaymentsPayoutsPage() {
  return <>
    <CommerceHeading eyebrow="Processor ownership" title="Payments & payouts" summary="The future shop uses Stripe Checkout in the connected merchant context. No account, Account Link, Checkout Session, or payment exists yet." status="setup_required" />
    <section className="provider-detail-grid">
      <DetailCard title="Stripe" status="setup_required" lead="Primary shop processor">
        <dl><Fact term="Platform operator" value="Daniel Clancy / Brainstream Media Group" /><Fact term="Merchant" value="Third Railify Official / Shawn" /><Fact term="Country / currency" value="Canada / CAD" /><Fact term="Onboarding" value="Stripe-hosted; not active" /><Fact term="Account access" value="Full Stripe Dashboard" /><Fact term="Charge model" value="Direct charges" /><Fact term="Payouts" value="Merchant-owned" /><Fact term="Methods" value="Cards; eligible Apple Pay and Google Pay" /><Fact term="Application fee" value="None by default" /></dl>
        <button type="button" className="secondary-button" disabled>Connection not available in this milestone</button>
      </DetailCard>
      <DetailCard title="PayPal" status="deferred" lead="Deferred direct-merchant REST model">
        <p>Later limited to donations and future VIP membership payments with Shawn’s PayPal Business credentials encrypted server-side. It is not the preferred shop processor.</p>
        <dl><Fact term="Credentials" value="Not configured" /><Fact term="Donations" value="Disabled" /><Fact term="VIP" value="Deferred" /><Fact term="Shop checkout" value="Not used" /></dl>
      </DetailCard>
      <DetailCard title="Wix Payments" status="legacy_production" lead="Legacy production authority">
        <p>The live Wix providers remain active and non-portable. Nothing in this Admin milestone disconnects, edits, or migrates them.</p>
      </DetailCard>
    </section>
    <div className="commerce-callout is-unavailable"><AdminIcon name="shield" /><div><strong>Mandatory off-code Connect preflight</strong><p>Inspect the existing Stripe Connect Dashboard to prove Canada onboarding, direct charges with full Dashboard access, account-paid fee posture, and Stripe-managed loss liability before any connected account is created.</p></div></div>
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
      </form></div> : !error && <CommerceState>Loading template editor…</CommerceState>}
  </>;
}

export function FulfillmentIntegrationsPage() {
  return <>
    <CommerceHeading eyebrow="Provider adapter boundary" title="Fulfillment integrations" summary="Printful is the primary future adapter. Fulfillment submission and provider API access remain disabled." status="disabled" />
    <section className="provider-detail-grid">
      <DetailCard title="Printful" status="setup_required" lead="Primary fulfillment provider"><dl><Fact term="Account authority" value="Third Railify Printful account; Daniel is Master Admin" /><Fact term="Migration" value="Separate manual/API store planned" /><Fact term="Credential" value="Environment-managed private token" /><Fact term="Store ID" value="Not configured" /><Fact term="Catalogue" value="Not synchronized" /><Fact term="Order mode" value="Draft only" /><Fact term="Submission" value="Disabled" /><Fact term="Wix integration" value="Remains active" /></dl></DetailCard>
      <DetailCard title="Printify" status="unavailable" lead="Lower-priority adapter"><p>No current public evidence proves a Printify requirement or connection. Credential custody and connectivity remain undecided until a verified audit establishes them.</p></DetailCard>
    </section>
    <section className="transaction-model" aria-labelledby="transaction-model-title"><p className="eyebrow">Two separate transactions</p><h2 id="transaction-model-title">Stripe does not pay Printful</h2><div><article><span>01</span><strong>Customer payment</strong><p>The customer pays Third Railify through Stripe on the connected merchant account.</p></article><article><span>02</span><strong>Fulfillment billing</strong><p>Printful separately charges the Third Railify Wallet or configured billing method for product, shipping, taxes, and applicable setup costs.</p></article></div></section>
  </>;
}

export function CommerceProductsPage() { return <CommerceDeferredPage kind="Products" summary="The existing route is reserved for a provider-neutral catalogue. No Wix snapshot was copied into commerce D1 and no Printful or Printify synchronization ran." />; }
export function CommerceOrdersPage() { return <CommerceDeferredPage kind="Orders" summary="No synthetic orders or revenue are shown. Future orders require authoritative Stripe webhook completion, idempotent persistence, and explicit draft-only fulfillment gates." />; }

function CommerceDeferredPage({ kind, summary }: { kind: string; summary: string }) {
  return <><CommerceHeading eyebrow="Commerce record authority" title={kind} summary={summary} status="unavailable" /><CommerceState><strong>No records available.</strong><span>The separate commerce database is not bound and no provider call has been made.</span></CommerceState></>;
}

function CommerceHeading({ eyebrow, title, summary, status }: { eyebrow: string; title: string; summary: string; status: CommerceStatus }) {
  return <section className="area-heading commerce-heading"><div className="area-icon"><AdminIcon name="products" size={28} /></div><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{summary}</p></div><StatusBadge status={status} /></section>;
}
function SectionTitle({ id, eyebrow, title }: { id: string; eyebrow: string; title: string }) { return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div></div>; }
function StatusBadge({ status }: { status: CommerceStatus }) { return <span className={`commerce-status commerce-status--${status}`}>{labelStatus(status)}</span>; }
function ProviderCard({ provider }: { provider: ProviderStatus }) { return <article className="provider-card"><div><span>{provider.label}</span><StatusBadge status={provider.status} /></div><dl><Fact term="Custody" value={humanize(provider.credentialCustody)} /><Fact term="Environment" value={humanize(provider.environment)} />{provider.countryCode && <Fact term="Country" value={provider.countryCode} />}{provider.currencyCode && <Fact term="Currency" value={provider.currencyCode} />}</dl></article>; }
function DetailCard({ title, status, lead, children }: { title: string; status: CommerceStatus; lead: string; children: ReactNode }) { return <article className="provider-detail"><header><div><p>{lead}</p><h2>{title}</h2></div><StatusBadge status={status} /></header>{children}</article>; }
function Fact({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <article><span>{label}</span><strong>{value}</strong></article>; }
function WorkspaceLink({ to, title, text }: { to: string; title: string; text: string }) { return <Link to={to}><strong>{title}</strong><span>{text}</span><AdminIcon name="arrow" size={16} /></Link>; }
function CommerceState({ children }: { children: ReactNode }) { return <div className="commerce-state" role="status">{children}</div>; }
function Field({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: ReactNode }) { return <label className={`commerce-field ${className}`.trim()}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }

function profileToForm(payload: BusinessPayload) {
  const profile = payload.profile; const address = profile.publicAddress || {};
  return { tradingName: profile.tradingName, legalBusinessName: "", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: profile.publicContactEmail, supportEmail: profile.supportEmail, publicPhone: profile.publicPhone, websiteUrl: profile.websiteUrl, publicAddressLine1: address.line1 || "", publicAddressLine2: address.line2 || "", publicCity: address.city || "", publicPostalCode: address.postalCode || "", privateAddress: "", businessNumber: "", gstHstNumber: "", provincialRegistration: "", invoicePrefix: profile.invoicePrefix, documentFooter: profile.documentFooter, taxProviderState: profile.taxProviderState, invoiceAccentColor: profile.invoiceAccentColor, receiptAccentColor: profile.receiptAccentColor };
}
function formToBusinessPayload(form: Record<string, string>) { return { ...form, countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicAddress: { line1: form.publicAddressLine1, line2: form.publicAddressLine2, city: form.publicCity, province: "ON", postalCode: form.publicPostalCode, country: "CA" } }; }
function maskedRegistration(payload: BusinessPayload | null, type: string) { const match = payload?.profile.private.registrations.find((item) => item.type === type); return match ? `Stored as ${match.maskedIdentifier}; leave blank to preserve.` : "Not confirmed or stored."; }
function errorMessage(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function labelStatus(value: string) { return humanize(value === "setup_required" ? "setup required" : value === "legacy_production" ? "legacy production" : value); }
