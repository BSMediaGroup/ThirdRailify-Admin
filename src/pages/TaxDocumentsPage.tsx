import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useOutletContext } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import {
  createTaxRegistration,
  getBusinessProfile,
  getCommerceTemplates,
  getTaxRegistrations,
  previewCommerceTemplate,
  saveCommerceTemplate,
  saveTaxRegistration,
  type BusinessPayload,
  type CommerceTemplate,
  type TaxPayload,
  type TaxRegistration,
  type TemplatePreviewPayload,
  type TemplatesPayload,
} from "../commerce/client";
import { AdminIcon } from "../components/AdminIcon";
import type { AdminShellOutletContext } from "../components/AdminShell";
import "../styles/tax-documents.css";

const DOCUMENT_VARIABLES = ["order_reference", "customer_name", "merchant_name", "order_total", "currency", "product_summary", "support_email", "receipt_url", "shipping_method", "tracking_number"] as const;
type DocumentKey = "payment_receipt" | "invoice_document";
type TaxStatus = "configured" | "not_configured" | "complete" | "incomplete" | "unverified" | "disabled" | "action_required" | "not_required";
type RegistrationDraft = {
  registrationType: TaxRegistration["registrationType"]; jurisdiction: string; countryCode: string; provinceCode: string;
  identifier: string; replaceIdentifier: boolean; status: string; effectiveDate: string; expiresAt: string; notes: string; documentDisclosureEnabled: boolean; revision?: number;
};

export function TaxDocumentsPage() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [tax, setTax] = useState<TaxPayload | null>(null);
  const [templates, setTemplates] = useState<TemplatesPayload | null>(null);
  const [business, setBusiness] = useState<BusinessPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CommerceTemplate>>({});
  const [savedDrafts, setSavedDrafts] = useState<Record<string, string>>({});
  const [selectedKey, setSelectedKey] = useState<DocumentKey>("payment_receipt");
  const [preview, setPreview] = useState<TemplatePreviewPayload | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [registrationEditor, setRegistrationEditor] = useState<TaxRegistration | "new" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  const hydrateTemplates = useCallback((payload: TemplatesPayload) => {
    const documentTemplates = payload.templates.filter((template) => template.templateKind === "document");
    setTemplates(payload);
    setDrafts(Object.fromEntries(documentTemplates.map((template) => [template.templateKey, template])));
    setSavedDrafts(Object.fromEntries(documentTemplates.map((template) => [template.templateKey, JSON.stringify(template)])));
    setSelectedKey((current) => documentTemplates.some((template) => template.templateKey === current) || !documentTemplates[0] ? current : documentTemplates[0].templateKey as DocumentKey);
  }, []);

  const load = useCallback(async () => {
    const stop = startLoading("Loading authoritative tax and document controls"); setError("");
    try {
      const [nextTax, nextTemplates, nextBusiness] = await Promise.all([getTaxRegistrations(), getCommerceTemplates(), getBusinessProfile()]);
      setTax(nextTax); hydrateTemplates(nextTemplates); setBusiness(nextBusiness);
    } catch (reason) { setError(errorMessage(reason, "Tax and document controls are restricted or unavailable.")); }
    finally { stop(); }
  }, [hydrateTemplates, startLoading]);
  useEffect(() => { void load(); }, [load]);

  const anyTemplateDirty = useMemo(() => Object.entries(drafts).some(([key, value]) => savedDrafts[key] && JSON.stringify(value) !== savedDrafts[key]), [drafts, savedDrafts]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (anyTemplateDirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [anyTemplateDirty]);

  if (!tax || !templates || !business) return <>{error ? <div className="admin-alert" role="alert">{error}</div> : <PageState>Loading Commerce D1 tax and document authority…</PageState>}</>;
  const documentTemplates = templates.templates.filter((template) => template.templateKind === "document");
  const selected = drafts[selectedKey] || documentTemplates.find((template) => template.templateKey === selectedKey) || documentTemplates[0];
  const selectedDirty = Boolean(selected && savedDrafts[selected.templateKey] && JSON.stringify(selected) !== savedDrafts[selected.templateKey]);
  const canManageTax = tax.access.capabilities.includes("commerce.business.manage");
  const canManageTemplates = templates.access.capabilities.includes("commerce.templates.manage");
  const canonical = business.canonicalReadiness;
  const receipt = documentTemplates.find((template) => template.templateKey === "payment_receipt");
  const invoice = documentTemplates.find((template) => template.templateKey === "invoice_document");
  const communications = canonical?.domains.communications;
  const checkout = canonical?.domains.checkout;

  const refreshBusiness = async () => setBusiness(await getBusinessProfile());
  const saveRegistration = async (draft: RegistrationDraft, existing: TaxRegistration | null) => {
    if (!csrfToken || !canManageTax) return;
    setBusy("registration"); setError(""); setMessage("");
    try {
      const body = registrationMutation(draft, existing);
      const next = existing ? await saveTaxRegistration(csrfToken, existing.id, body) : await createTaxRegistration(csrfToken, body);
      setTax(next); await refreshBusiness(); setRegistrationEditor(null);
      setMessage(existing ? "Tax registration updated. The identifier remains masked in browser state." : "Tax registration saved with encrypted identifier custody; no external verification is implied.");
    } catch (reason) { setError(errorMessage(reason, "The tax registration could not be saved.")); throw reason; }
    finally { setBusy(""); }
  };
  const deactivate = async (registration: TaxRegistration) => {
    if (!csrfToken || !canManageTax || !window.confirm(`Deactivate ${registrationTypeLabel(registration.registrationType)} for ${registration.jurisdiction}? Historical document records will remain intact.`)) return;
    setBusy(`deactivate:${registration.id}`); setError(""); setMessage("");
    try {
      setTax(await saveTaxRegistration(csrfToken, registration.id, registrationMutation({ ...registrationToDraft(registration), status: "inactive" }, registration)));
      await refreshBusiness(); setMessage("Tax registration deactivated without deleting history or exposing its identifier.");
    } catch (reason) { setError(errorMessage(reason, "The tax registration could not be deactivated.")); }
    finally { setBusy(""); }
  };
  const changeTemplate = <K extends keyof CommerceTemplate>(key: K, value: CommerceTemplate[K]) => {
    if (!selected) return;
    setDrafts((current) => ({ ...current, [selected.templateKey]: { ...current[selected.templateKey], [key]: value } }));
    setMessage(""); if (previewKey === selected.templateKey) { setPreview(null); setPreviewKey(""); }
  };
  const discardTemplate = () => {
    const stored = documentTemplates.find((template) => template.templateKey === selected?.templateKey); if (!stored) return;
    setDrafts((current) => ({ ...current, [stored.templateKey]: stored })); setPreview(null); setPreviewKey(""); setError(""); setMessage("Unsaved document-template changes discarded.");
  };
  const saveTemplate = async (event: FormEvent) => {
    event.preventDefault(); if (!selected || !csrfToken || !canManageTemplates) return;
    const validation = validateDocumentTemplate(selected); if (validation) { setError(validation); return; }
    setBusy("template"); setError(""); setMessage("");
    try {
      const next = await saveCommerceTemplate(csrfToken, selected); hydrateTemplates(next); await refreshBusiness(); setPreview(null); setPreviewKey("");
      setMessage(`${selected.templateKey === "payment_receipt" ? "Receipt" : "Invoice"} template revision ${selected.revision + 1} saved. No document was issued or delivered.`);
    } catch (reason) { setError(errorMessage(reason, "The document template could not be saved.")); }
    finally { setBusy(""); }
  };
  const renderPreview = async () => {
    if (!selected || !csrfToken) return;
    const validation = validateDocumentTemplate(selected); if (validation) { setError(validation); return; }
    setBusy("preview"); setError("");
    try { setPreview(await previewCommerceTemplate(csrfToken, selected)); setPreviewKey(selected.templateKey); setMessage("Ephemeral SAMPLE / TEST preview rendered. Nothing was persisted or sent."); }
    catch (reason) { setError(errorMessage(reason, "The safe document preview could not be rendered.")); }
    finally { setBusy(""); }
  };

  return <div className="tax-documents-page">
    <section className="tax-documents-hero" aria-labelledby="tax-documents-title">
      <div className="tax-documents-hero__copy"><div className="area-icon"><AdminIcon name="tax" size={28} /></div><p className="eyebrow">Commerce D1 control plane</p><h1 id="tax-documents-title">Tax &amp; documents</h1><p>Configure merchant tax-registration records and safe receipt/invoice presentation. Configuration, TEST preview evidence, and external verification remain deliberately separate.</p><div className="tax-documents-hero__chips"><StatusChip state={tax.registrationState.configured ? "configured" : "not_configured"} label={tax.registrationState.configured ? "Registration configured" : "No registration"} /><StatusChip state="unverified" label="Externally unverified" /><StatusChip state="disabled" label="Production tax disabled" /></div></div>
      <div className="tax-readiness-summary" aria-label="Tax and document readiness summary">
        <Summary label="Tax profile" value={`${business.profile.countryCode || "—"} · ${business.profile.provinceCode || "—"}`} state={tax.registrationState.configured ? "configured" : "not_configured"} />
        <Summary label="Receipts" value={templateSummary(receipt)} state={templateState(receipt)} />
        <Summary label="Invoices" value={templateSummary(invoice)} state={templateState(invoice)} />
        <Summary label="Customer communications" value={communications?.summary || "Readiness unavailable"} state={domainState(communications)} />
        <Summary label="Production tax / checkout" value={checkout?.details.normalCheckoutEnabled === true ? "Checkout enabled" : "Checkout disabled"} state={checkout?.ready ? "complete" : "disabled"} />
      </div>
    </section>
    {error && <div className="admin-alert" role="alert">{error}</div>}{message && <div className="auth-success" role="status">{message}</div>}
    {(!canManageTax || !canManageTemplates) && <div className="commerce-callout is-pending" role="status"><AdminIcon name="shield" /><div><strong>Partially read-only workspace</strong><p>Tax writes require <code>commerce.business.manage</code>; template writes require <code>commerce.templates.manage</code>. Masked projections remain available with <code>commerce.view</code>.</p></div></div>}

    <section className="tax-section" aria-labelledby="tax-registrations-title"><SectionHeading id="tax-registrations-title" eyebrow="Encrypted identifier custody" title="Tax registrations" description="Operator-entered records are configuration only. They do not prove CRA registration, legal obligation, collection authority, remittance, or filing status."><button type="button" className="button-link" onClick={() => setRegistrationEditor("new")} disabled={!canManageTax || !csrfToken}><AdminIcon name="tax" size={16} />Add registration</button></SectionHeading>
      {tax.registrations.length ? <div className="tax-registration-grid">{tax.registrations.map((registration) => <article className="tax-registration-card" key={registration.id}><header><div><p>{registration.countryCode}{registration.provinceCode ? ` · ${registration.provinceCode}` : ""}</p><h3>{registrationTypeLabel(registration.registrationType)}</h3></div><StatusChip state={registrationState(registration.status)} label={registrationStatusLabel(registration.status)} /></header><dl><Fact term="Jurisdiction" value={registration.jurisdiction} /><Fact term="Identifier" value={registration.maskedIdentifier || "Masked value unavailable"} /><Fact term="Effective date" value={registration.effectiveDate || "Not configured"} /><Fact term="Expiry" value={registration.expiresAt || "Not configured"} /><Fact term="Document disclosure" value={registration.documentDisclosureEnabled ? "Enabled after operator review" : "Disabled"} /></dl>{registration.notes && <p className="tax-registration-card__notes">{registration.notes}</p>}<footer><button type="button" className="secondary-button" onClick={() => setRegistrationEditor(registration)} disabled={!canManageTax || !csrfToken}><AdminIcon name="edit" size={15} />Edit</button>{registration.status !== "inactive" && <button type="button" className="secondary-button is-danger" onClick={() => void deactivate(registration)} disabled={!canManageTax || !csrfToken || Boolean(busy)}>{busy === `deactivate:${registration.id}` ? "Deactivating…" : "Deactivate"}</button>}</footer></article>)}</div> : <PageState><strong>No tax registration configured</strong><span>This does not mean registration is legally unnecessary. Add only an authentic operator-supplied record.</span>{canManageTax && <button type="button" className="secondary-button" onClick={() => setRegistrationEditor("new")}>Add encrypted registration</button>}</PageState>}
    </section>

    <section className="tax-section" aria-labelledby="tax-boundary-title"><SectionHeading id="tax-boundary-title" eyebrow="Architecture truth" title="Registration is not collection" description="Three separate responsibilities are shown without tax advice or assumed percentages." /><div className="tax-boundary-grid"><Boundary index="01" title="Business registration" state={tax.registrationState.configured ? "configured" : "not_configured"}>Encrypted operator records with masked browser projections. External verification is not integrated.</Boundary><Boundary index="02" title="Checkout calculation / collection" state="disabled">Automatic checkout tax calculation is not enabled. Stripe Tax is {humanize(tax.calculation.stripeTax)} and no rates are configured here.</Boundary><Boundary index="03" title="Remittance / filing" state="not_required">Not implemented in Third Railify Admin. No filing, remittance, accounting, or compliance claim is made.</Boundary></div></section>

    <section className="tax-section document-configuration" aria-labelledby="document-configuration-title"><SectionHeading id="document-configuration-title" eyebrow="Safe structured templates" title="Receipt &amp; invoice configuration" description="Switch between the two existing singleton authorities. Plain text and approved merge variables are rendered server-side; executable HTML and scripts are rejected." />
      {!documentTemplates.length ? <PageState><strong>No document templates configured</strong><span>Receipt configuration is action required. No fallback document content has been invented.</span></PageState> : <>
        <div className="document-switcher" role="group" aria-label="Document template type">{(["payment_receipt", "invoice_document"] as DocumentKey[]).map((key) => { const item = documentTemplates.find((template) => template.templateKey === key); return <button key={key} type="button" aria-pressed={selectedKey === key} className={selectedKey === key ? "is-active" : ""} onClick={() => { setSelectedKey(key); setPreview(null); setPreviewKey(""); }} disabled={!item}><span>{key === "payment_receipt" ? "Receipt" : "Invoice"}</span><small>{item ? `${templateSummary(item)} · r${item.revision}` : "Not configured"}</small></button>; })}</div>
        {selected && <div className="document-editor-layout"><form className="document-template-editor" onSubmit={(event) => void saveTemplate(event)} noValidate><header><div><p className="eyebrow">{selectedKey === "payment_receipt" ? "Payment receipt" : "Invoice / sales document"}</p><h3>{selected.displayName}</h3></div><StatusChip state={templateState(selected)} /></header><div className="document-field-grid"><Field label="Template display name" hint={`${selected.displayName.length}/120`}><input value={selected.displayName} onChange={(event) => changeTemplate("displayName", event.target.value)} maxLength={120} required disabled={!canManageTemplates} /></Field><Field label="Document heading" hint={`${selected.heading.length}/160`}><input value={selected.heading} onChange={(event) => changeTemplate("heading", event.target.value)} maxLength={160} required disabled={!canManageTemplates} /></Field><Field wide label="Customer-facing introduction" hint={`${selected.introduction.length}/1000`}><textarea value={selected.introduction} onChange={(event) => changeTemplate("introduction", event.target.value)} maxLength={1000} rows={3} disabled={!canManageTemplates} /></Field><Field wide label="Structured content blocks" hint="One block per line · maximum 8 · approved variables only"><textarea value={selected.bodyBlocks.join("\n")} onChange={(event) => changeTemplate("bodyBlocks", event.target.value.split(/\r?\n/).slice(0, 8))} rows={5} disabled={!canManageTemplates} /></Field><Field wide label="Support text" hint={`${selected.supportText.length}/500`}><textarea value={selected.supportText} onChange={(event) => changeTemplate("supportText", event.target.value)} maxLength={500} rows={2} disabled={!canManageTemplates} /></Field><Field wide label="Footer" hint={`${selected.footer.length}/1000`}><textarea value={selected.footer} onChange={(event) => changeTemplate("footer", event.target.value)} maxLength={1000} rows={3} disabled={!canManageTemplates} /></Field><Field label="Configuration status"><select value={selected.status} onChange={(event) => changeTemplate("status", event.target.value as CommerceTemplate["status"])} disabled={!canManageTemplates}><option value="draft">Draft</option><option value="ready">Ready</option><option value="disabled">Disabled</option></select></Field><Field label="Accent colour"><input type="color" value={selected.accentColor} onChange={(event) => changeTemplate("accentColor", event.target.value)} disabled={!canManageTemplates} /></Field><label className="document-enabled-toggle"><input type="checkbox" checked={selected.enabled} onChange={(event) => changeTemplate("enabled", event.target.checked)} disabled={!canManageTemplates || selected.status === "disabled"} /><span><strong>Template enabled</strong><small>Configuration only; this does not enable document delivery.</small></span></label></div><div className="document-editor-actions"><div><button type="submit" className="button-link" disabled={!canManageTemplates || !csrfToken || !selectedDirty || Boolean(busy)}>{busy === "template" ? "Saving…" : "Save template"}</button><button type="button" className="secondary-button" onClick={discardTemplate} disabled={!selectedDirty || Boolean(busy)}>Discard</button><button type="button" className="secondary-button" onClick={() => void renderPreview()} disabled={!csrfToken || Boolean(busy)}>{busy === "preview" ? "Rendering…" : "Render SAMPLE preview"}</button></div><span>{selectedDirty ? "Unsaved template changes" : `Saved revision ${selected.revision}`}</span></div><VariableHelp /></form><DocumentPreview template={selected} preview={previewKey === selected.templateKey ? preview : null} /></div>}
      </>}
    </section>

    <section className="tax-section" aria-labelledby="document-identity-title"><SectionHeading id="document-identity-title" eyebrow="Canonical dependencies" title="Seller identity &amp; delivery boundaries" description="Tax & Documents owns content readiness; Business Information owns seller identity; Customer Emails owns delivery configuration." /><div className="tax-dependency-grid"><DependencyCard icon="business" title="Seller / document identity" state={business.readiness.profile.legalIdentity === "complete" && business.readiness.profile.address === "complete" ? "complete" : "action_required"}><dl><Fact term="Storefront name" value={business.readiness.documentIdentity.tradingName || "Not configured"} /><Fact term="Legal name" value={business.readiness.documentIdentity.legalNameStored ? "Encrypted · configured · unverified" : "Not configured"} /><Fact term="Business address" value={business.readiness.documentIdentity.addressStored ? "Encrypted · configured · unverified" : "Not configured"} /><Fact term="Public contact" value={business.readiness.documentIdentity.contactEmail || "Not configured"} /><Fact term="Tax registration" value={tax.registrationState.configured ? "Configured · externally unverified" : "Not configured"} /></dl><Link to="/commerce/business">Manage Business Information <AdminIcon name="arrow" size={14} /></Link></DependencyCard><DependencyCard icon="emails" title="Customer email delivery" state={domainState(communications)}><dl><Fact term="Transactional provider" value={detailBoolean(communications, "providerConfigured", "Configured server-side", "Incomplete")} /><Fact term="Ready customer templates" value={String(communications?.details.readyTemplates ?? "Unavailable")} /><Fact term="Customer sends" value={communications?.details.sendEnabled === true ? "Enabled" : "Disabled"} /><Fact term="Receipt / invoice delivery" value={tax.documents.deliveryEnabled ? "Enabled by canonical gate" : "Disabled"} /></dl><Link to="/commerce/emails">Manage Customer Emails <AdminIcon name="arrow" size={14} /></Link></DependencyCard><DependencyCard icon="shield" title="Customer document access" state={tax.documents.customerAccessEnabled ? "configured" : "disabled"}><dl><Fact term="Opaque token support" value={tax.documents.tokenizedAccessSupported ? "Supported · SHA-256 hashes stored" : "Unavailable"} /><Fact term="Customer links" value={tax.documents.customerAccessEnabled ? "Enabled" : "Disabled"} /><Fact term="Issued documents" value={String(tax.documents.issuedCount)} /><Fact term="Raw token hashes" value="Never exposed" /></dl><p>Loading this page creates no customer token, document, URL, or delivery.</p></DependencyCard></div></section>

    <section className="tax-section" aria-labelledby="readiness-dependencies-title"><SectionHeading id="readiness-dependencies-title" eyebrow="Shared with Payments" title="Readiness dependencies" description="The server-owned production readiness engine remains authoritative. Deferred PayPal and optional invoice capability are not invented as checkout requirements." /><div className="tax-readiness-grid">{["business", "tax", "documents", "communications", "payments", "fulfillment", "checkout"].map((key) => { const domain = canonical?.domains[key]; return <article key={key}><header><strong>{humanize(key)}</strong><StatusChip state={domainState(domain)} /></header><p>{domain?.summary || "Canonical readiness unavailable."}</p>{dependencyHref(key) && <Link to={dependencyHref(key)!}>Open dependency <AdminIcon name="arrow" size={13} /></Link>}</article>; })}</div></section>

    <details className="tax-technical"><summary>Advanced / technical evidence</summary><div className="tax-technical-grid"><Technical title="Registration authority" facts={[["Authority", tax.authority], ["Rows", String(tax.registrations.length)], ["Active / operator-approved", String(tax.registrationState.activeCount)], ["External verification", "Not integrated"], ["Identifier projection", "Masked only"]]} /><Technical title="Template authority" facts={documentTemplates.flatMap((template) => [[`${template.templateKey} ID`, template.templateKey], [`${template.templateKey} revision`, String(template.revision)], [`${template.templateKey} state`, templateSummary(template)]])} /><Technical title="Document evidence" facts={[["Ephemeral preview", "No persistence or send"], ["Persisted preview rows", String(tax.documents.previewCount)], ["Issued rows", String(tax.documents.issuedCount)], ["Revoked rows", String(tax.documents.revokedCount)], ["Last generated", tax.documents.lastGeneratedAt ? `${humanize(tax.documents.lastGeneratedType || "document")} · ${formatDate(tax.documents.lastGeneratedAt)}` : "No persisted evidence"]]} /></div></details>
    {registrationEditor && <RegistrationDialog registration={registrationEditor === "new" ? null : registrationEditor} busy={busy === "registration"} onClose={() => setRegistrationEditor(null)} onSave={saveRegistration} />}
  </div>;
}

function RegistrationDialog({ registration, busy, onClose, onSave }: { registration: TaxRegistration | null; busy: boolean; onClose: () => void; onSave: (draft: RegistrationDraft, existing: TaxRegistration | null) => Promise<void> }) {
  const initial = useMemo(() => registration ? registrationToDraft(registration) : newRegistrationDraft(), [registration]);
  const [draft, setDraft] = useState(initial); const [errors, setErrors] = useState<Record<string, string>>({}); const dialog = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const close = useCallback(() => { if (!dirtyRef.current || window.confirm("Discard unsaved tax-registration changes?")) onClose(); }, [onClose]);
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; const previous = document.body.style.overflow; document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus());
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    document.addEventListener("keydown", keydown); return () => { cancelAnimationFrame(frame); document.body.style.overflow = previous; document.removeEventListener("keydown", keydown); returnFocus?.focus(); };
  }, [close]);
  const update = (key: keyof RegistrationDraft, value: string | boolean) => { setDraft((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: "" })); };
  const submit = async (event: FormEvent) => { event.preventDefault(); const nextErrors = validateRegistration(draft, Boolean(registration)); setErrors(nextErrors); if (Object.keys(nextErrors).length) return; try { await onSave(draft, registration); } catch { /* Parent alert preserves server detail. */ } };
  return createPortal(<div className="tax-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div ref={dialog} className="tax-dialog" role="dialog" aria-modal="true" aria-labelledby="tax-registration-dialog-title" tabIndex={-1}><header><div><p className="eyebrow">Encrypted Commerce D1 record</p><h2 id="tax-registration-dialog-title">{registration ? "Edit tax registration" : "Add tax registration"}</h2><p>Values are operator-supplied and externally unverified. Saving does not enable calculation, collection, remittance, or filing.</p></div><button type="button" className="icon-button" aria-label="Close tax registration editor" onClick={close}><AdminIcon name="close" /></button></header><form onSubmit={(event) => void submit(event)} noValidate><div className="tax-dialog-grid"><Field label="Registration type" error={errors.registrationType}><select value={draft.registrationType} onChange={(event) => update("registrationType", event.target.value)}><option value="gst_hst">GST/HST</option><option value="qst">QST</option><option value="pst">PST</option><option value="rst">RST</option><option value="other">Other</option></select></Field><Field label="Status" error={errors.status}><select value={draft.status} onChange={(event) => update("status", event.target.value)}><option value="unverified">Unverified</option><option value="pending">Pending operator review</option><option value="active">Active per operator</option>{draft.status === "verified" && <option value="verified">Operator marked verified · evidence unavailable</option>}<option value="inactive">Inactive</option><option value="expired">Expired</option><option value="not_registered">Not registered</option><option value="unavailable">Unavailable</option></select></Field><Field label="Jurisdiction" error={errors.jurisdiction}><input value={draft.jurisdiction} onChange={(event) => update("jurisdiction", event.target.value.toUpperCase())} maxLength={80} placeholder="ON" aria-invalid={Boolean(errors.jurisdiction)} /></Field><Field label="Country code" error={errors.countryCode}><input value={draft.countryCode} onChange={(event) => update("countryCode", event.target.value.toUpperCase())} maxLength={2} placeholder="CA" aria-invalid={Boolean(errors.countryCode)} /></Field><Field label="Province / region" hint="Optional two- or three-letter code." error={errors.provinceCode}><input value={draft.provinceCode} onChange={(event) => update("provinceCode", event.target.value.toUpperCase())} maxLength={3} placeholder="ON" aria-invalid={Boolean(errors.provinceCode)} /></Field><Field label="Effective date" error={errors.effectiveDate}><input type="date" value={draft.effectiveDate} onChange={(event) => update("effectiveDate", event.target.value)} aria-invalid={Boolean(errors.effectiveDate)} /></Field><Field label="End / expiry date" error={errors.expiresAt}><input type="date" value={draft.expiresAt} onChange={(event) => update("expiresAt", event.target.value)} aria-invalid={Boolean(errors.expiresAt)} /></Field><div className="tax-sensitive-field"><header><div><span>Registration identifier</span><small>{registration ? `${registration.maskedIdentifier} · plaintext is not in browser state` : "Required · encrypted immediately after save"}</small></div>{registration && <button type="button" className="secondary-button" onClick={() => update("replaceIdentifier", !draft.replaceIdentifier)}>{draft.replaceIdentifier ? "Cancel replacement" : "Replace identifier"}</button>}</header>{(!registration || draft.replaceIdentifier) && <Field label={registration ? "Replacement identifier" : "Registration identifier"} error={errors.identifier}><input value={draft.identifier} onChange={(event) => update("identifier", event.target.value)} autoComplete="off" maxLength={100} aria-invalid={Boolean(errors.identifier)} /></Field>}</div><Field wide label="Internal notes" hint={`${draft.notes.length}/1000 · never include secrets beyond the identifier field.`}><textarea value={draft.notes} onChange={(event) => update("notes", event.target.value)} rows={3} maxLength={1000} /></Field><label className="document-enabled-toggle is-wide"><input type="checkbox" checked={draft.documentDisclosureEnabled} onChange={(event) => update("documentDisclosureEnabled", event.target.checked)} /><span><strong>Permit configured registration disclosure on documents</strong><small>This flag does not expose plaintext in this Admin projection and does not replace legal review.</small></span></label></div><footer><span>{dirty ? "Unsaved registration changes" : registration ? `Revision ${registration.revision}` : "New encrypted record"}</span><div><button type="button" className="secondary-button" onClick={close}>Cancel</button><button type="submit" className="button-link" disabled={busy || !dirty}>{busy ? "Saving…" : registration ? "Save registration" : "Add registration"}</button></div></footer></form></div></div>, document.body);
}

function DocumentPreview({ template, preview }: { template: CommerceTemplate; preview: TemplatePreviewPayload | null }) {
  const label = template.templateKey === "payment_receipt" ? "Receipt" : "Invoice";
  return <aside className="document-preview-panel" aria-label={`${label} preview`}><header><div><span className="document-sample-marker">SAMPLE · TEST · NOT ISSUED</span><small>{preview ? "Production renderer output" : "Preview not rendered"}</small></div><StatusChip state={preview ? "complete" : "unverified"} label={preview ? "Rendered" : "Render required"} /></header>{preview ? <iframe title={`${label} canonical SAMPLE / TEST preview`} sandbox="allow-same-origin" srcDoc={preview.preview.html} /> : <div className="document-preview-empty"><strong>Render required</strong><p>Render the synthetic fixture to inspect the canonical branded document. Nothing will be persisted or sent.</p></div>}<footer><strong>Synthetic fixture only</strong><p>Preview uses the canonical server document renderer. No payment, persistence, token, email, provider order, or customer delivery occurs.</p></footer></aside>;
}

function VariableHelp() { return <details className="document-variable-help"><summary>Approved merge variables</summary><p>Unknown or malformed variables fail server validation. Variables cannot execute code, traverse objects, inject HTML, or fetch external resources.</p><div>{DOCUMENT_VARIABLES.map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}</div></details>; }
function SectionHeading({ id, eyebrow, title, description, children }: { id: string; eyebrow: string; title: string; description: string; children?: ReactNode }) { return <div className="tax-section-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2><p>{description}</p></div>{children}</div>; }
function Summary({ label, value, state }: { label: string; value: string; state: TaxStatus }) { return <div><span>{label}</span><strong>{value}</strong><StatusChip state={state} /></div>; }
function StatusChip({ state, label }: { state: TaxStatus; label?: string }) { return <span className={`tax-status is-${state}`}>{label || statusLabel(state)}</span>; }
function Boundary({ index, title, state, children }: { index: string; title: string; state: TaxStatus; children: ReactNode }) { return <article><header><span>{index}</span><StatusChip state={state} /></header><h3>{title}</h3><p>{children}</p></article>; }
function DependencyCard({ icon, title, state, children }: { icon: "business" | "emails" | "shield"; title: string; state: TaxStatus; children: ReactNode }) { return <article className="tax-dependency-card"><header><div><span><AdminIcon name={icon} size={18} /></span><h3>{title}</h3></div><StatusChip state={state} /></header>{children}</article>; }
function Field({ label, hint, error, wide, children }: { label: string; hint?: string; error?: string; wide?: boolean; children: ReactNode }) { return <label className={`tax-field${wide ? " is-wide" : ""}`}><span>{label}</span>{children}{error ? <small className="is-error" role="alert">{error}</small> : hint ? <small>{hint}</small> : null}</label>; }
function Fact({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function Technical({ title, facts }: { title: string; facts: string[][] }) { return <section><h3>{title}</h3><dl>{facts.map(([term, value]) => <Fact key={term} term={term} value={value} />)}</dl></section>; }
function PageState({ children }: { children: ReactNode }) { return <div className="commerce-state" role="status">{children}</div>; }

function newRegistrationDraft(): RegistrationDraft { return { registrationType: "gst_hst", jurisdiction: "ON", countryCode: "CA", provinceCode: "ON", identifier: "", replaceIdentifier: true, status: "unverified", effectiveDate: "", expiresAt: "", notes: "", documentDisclosureEnabled: false }; }
function registrationToDraft(registration: TaxRegistration): RegistrationDraft { return { registrationType: registration.registrationType, jurisdiction: registration.jurisdiction, countryCode: registration.countryCode, provinceCode: registration.provinceCode || "", identifier: "", replaceIdentifier: false, status: registration.status, effectiveDate: registration.effectiveDate || "", expiresAt: registration.expiresAt || "", notes: registration.notes || "", documentDisclosureEnabled: registration.documentDisclosureEnabled, revision: registration.revision }; }
function registrationMutation(draft: RegistrationDraft, existing: TaxRegistration | null) { return { registrationType: draft.registrationType, jurisdiction: draft.jurisdiction, countryCode: draft.countryCode, provinceCode: draft.provinceCode, identifier: !existing || draft.replaceIdentifier ? draft.identifier : "", status: draft.status, effectiveDate: draft.effectiveDate, expiresAt: draft.expiresAt, notes: draft.notes, documentDisclosureEnabled: draft.documentDisclosureEnabled, ...(existing ? { revision: existing.revision } : {}) }; }
function validateRegistration(draft: RegistrationDraft, editing: boolean) { const errors: Record<string, string> = {}; if (!/^[A-Z0-9][A-Z0-9 ._/-]{1,79}$/.test(draft.jurisdiction.trim().toUpperCase())) errors.jurisdiction = "Enter a valid jurisdiction such as ON or CA."; if (!/^[A-Z]{2}$/.test(draft.countryCode)) errors.countryCode = "Use a two-letter country code."; if (draft.provinceCode && !/^[A-Z]{2,3}$/.test(draft.provinceCode)) errors.provinceCode = "Use a two- or three-letter region code."; if ((!editing || draft.replaceIdentifier) && !draft.identifier.trim()) errors.identifier = "Enter the operator-supplied registration identifier."; if (draft.expiresAt && draft.effectiveDate && draft.expiresAt < draft.effectiveDate) errors.expiresAt = "The expiry date cannot precede the effective date."; return errors; }
function validateDocumentTemplate(template: CommerceTemplate) { if (!template.displayName.trim() || !template.heading.trim()) return "Template display name and document heading are required."; if (template.bodyBlocks.length > 8 || template.bodyBlocks.some((block) => !block.trim())) return "Use one to eight non-empty structured content blocks."; const values = [template.displayName, template.heading, template.introduction, ...template.bodyBlocks, template.supportText, template.footer]; if (values.some((value) => /<\/?[a-z][^>]*>|javascript\s*:|on[a-z]+\s*=|<script/i.test(value))) return "Templates accept structured plain text only; HTML, scripts, and executable attributes are prohibited."; const unknown = new Set<string>(); for (const value of values) for (const match of value.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) if (!DOCUMENT_VARIABLES.includes(match[1].toLowerCase() as typeof DOCUMENT_VARIABLES[number])) unknown.add(match[1].toLowerCase()); return unknown.size ? `Unsupported template variables: ${[...unknown].join(", ")}.` : ""; }
function templateState(template?: CommerceTemplate): TaxStatus { return !template ? "not_configured" : template.status === "ready" && template.enabled ? "complete" : template.status === "disabled" ? "disabled" : "incomplete"; }
function templateSummary(template?: CommerceTemplate) { return !template ? "Not configured" : template.status === "ready" && template.enabled ? "Configured" : template.status === "disabled" ? "Disabled" : "Incomplete"; }
function domainState(domain?: { ready: boolean; details: Record<string, unknown> }): TaxStatus { return !domain ? "not_configured" : domain.ready ? "complete" : domain.details.sendEnabled === false || domain.details.enabled === false || domain.details.normalCheckoutEnabled === false ? "disabled" : "action_required"; }
function registrationState(status: string): TaxStatus { return status === "active" ? "configured" : status === "inactive" || status === "expired" ? "disabled" : status === "not_registered" ? "not_configured" : "unverified"; }
function registrationStatusLabel(status: string) { return status === "verified" ? "Operator marked verified · external evidence absent" : status === "active" ? "Active per operator · unverified" : humanize(status); }
function registrationTypeLabel(value: string) { return ({ gst_hst: "GST/HST", qst: "QST", pst: "PST", rst: "RST", other: "Other registration" } as Record<string, string>)[value] || humanize(value); }
function detailBoolean(domain: { details: Record<string, unknown> } | undefined, key: string, yes: string, no: string) { return domain?.details[key] === true ? yes : no; }
function dependencyHref(key: string) { return ({ business: "/commerce/business", tax: "/commerce/tax", documents: "/commerce/tax", communications: "/commerce/emails", payments: "/commerce/payments", fulfillment: "/commerce/fulfillment" } as Record<string, string>)[key] || null; }
function statusLabel(state: TaxStatus) { return ({ configured: "Configured", not_configured: "Not configured", complete: "Complete", incomplete: "Incomplete", unverified: "Unverified", disabled: "Disabled", action_required: "Action required", not_required: "Not required" } as const)[state]; }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function formatDate(value: string) { const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Unavailable"; }
function errorMessage(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
