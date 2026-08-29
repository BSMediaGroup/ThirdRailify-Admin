import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { AdminIcon } from "../components/AdminIcon";
import type { AdminShellOutletContext } from "../components/AdminShell";
import {
  getCustomerEmailsControlPlane,
  previewCommerceTemplate,
  saveCommerceTemplate,
  type CommerceTemplate,
  type CustomerEmailDelivery,
  type CustomerEmailsPayload,
  type CustomerEmailTemplate,
  type TemplatePreviewPayload,
} from "../commerce/client";

type TextField = "displayName" | "subject" | "preheader" | "heading" | "introduction" | "ctaLabel" | "ctaUrl" | "supportText" | "footer";
type FieldErrors = Partial<Record<TextField | "bodyBlocks" | "form", string>>;

export function CustomerEmailsPage() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<CustomerEmailsPayload | null>(null);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<CustomerEmailTemplate | null>(null);
  const [preview, setPreview] = useState<TemplatePreviewPayload | null>(null);
  const [previewRevision, setPreviewRevision] = useState("");
  const [activeField, setActiveField] = useState<TextField | "bodyBlocks">("subject");
  const [busy, setBusy] = useState<"load" | "save" | "preview" | "">("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const selectedPersisted = useMemo(() => payload?.templates.find((template) => template.templateKey === selected) || null, [payload, selected]);
  const dirty = Boolean(draft && selectedPersisted && templateFingerprint(draft) !== templateFingerprint(selectedPersisted));
  const fieldErrors = useMemo(() => draft ? validateDraft(draft, payload?.mergeVariables.map((item) => item.key) || []) : {}, [draft, payload]);
  const canManage = Boolean(payload?.access.capabilities.includes("commerce.templates.manage"));
  const canSave = Boolean(canManage && csrfToken && payload?.databaseConfigured && dirty && !Object.keys(fieldErrors).length && !busy);

  const renderPreview = useCallback(async (template: CustomerEmailTemplate, announce = false) => {
    if (!csrfToken) return;
    setBusy("preview"); setError("");
    try {
      const rendered = await previewCommerceTemplate(csrfToken, template);
      setPreview(rendered); setPreviewRevision(templateFingerprint(template));
      if (announce) setMessage("Preview refreshed with unmistakably synthetic sample data. No delivery or document record was created.");
    } catch (reason) { setError(errorMessage(reason, "The canonical non-mutating preview could not be rendered.")); }
    finally { setBusy(""); }
  }, [csrfToken]);

  const load = useCallback(async () => {
    const stop = startLoading("Loading customer email authority"); setBusy("load"); setError("");
    try {
      const next = await getCustomerEmailsControlPlane();
      const key = next.templates.find((item) => item.validity?.state !== "invalid")?.templateKey || next.templates[0]?.templateKey || "";
      const template = next.templates.find((item) => item.templateKey === key) || null;
      setPayload(next); setSelected(key); setDraft(template); setPreview(null); setPreviewRevision("");
      if (template && template.validity?.state !== "invalid" && csrfToken) await renderPreview(template);
    } catch (reason) { setError(errorMessage(reason, "Customer email authority is restricted or unavailable.")); }
    finally { setBusy(""); stop(); }
  }, [csrfToken, renderPreview, startLoading]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const warnOnNavigation = (event: MouseEvent) => {
      if (!dirty || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest("a[href]");
      if (link && !window.confirm("Discard unsaved changes and leave Customer Emails?")) event.preventDefault();
    };
    document.addEventListener("click", warnOnNavigation, true);
    return () => document.removeEventListener("click", warnOnNavigation, true);
  }, [dirty]);

  const choose = async (key: string) => {
    if (key === selected || !payload) return;
    if (dirty && !window.confirm("Discard unsaved changes and open another template?")) return;
    const template = payload.templates.find((item) => item.templateKey === key) || null;
    setSelected(key); setDraft(template); setPreview(null); setPreviewRevision(""); setError(""); setMessage("");
    if (template && template.validity?.state !== "invalid") await renderPreview(template);
  };

  const change = <K extends keyof CustomerEmailTemplate>(key: K, value: CustomerEmailTemplate[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const discard = () => {
    if (!selectedPersisted) return;
    setDraft(selectedPersisted); setError(""); setMessage("Unsaved changes discarded.");
    void renderPreview(selectedPersisted);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !canSave || !csrfToken) return;
    const stop = startLoading("Saving customer email template"); setBusy("save"); setError(""); setMessage("");
    try {
      await saveCommerceTemplate(csrfToken, draft);
      const next = await getCustomerEmailsControlPlane(); const saved = next.templates.find((item) => item.templateKey === draft.templateKey) || null;
      setPayload(next); setDraft(saved); setMessage("Template saved with a new server revision. No email was sent.");
      if (saved) await renderPreview(saved);
    } catch (reason) { setError(errorMessage(reason, "The template could not be saved.")); }
    finally { setBusy(""); stop(); }
  };
  const insertVariable = (key: string) => {
    if (!draft) return;
    const token = `{{${key}}}`;
    if (activeField === "bodyBlocks") change("bodyBlocks", draft.bodyBlocks.length ? draft.bodyBlocks.map((block, index) => index === draft.bodyBlocks.length - 1 ? `${block}${block ? " " : ""}${token}` : block) : [token]);
    else change(activeField, `${String(draft[activeField] || "")}${draft[activeField] ? " " : ""}${token}`);
    setMessage(`${token} inserted into ${fieldLabel(activeField)}.`);
  };

  return <div className="customer-emails-page">
    <EmailHero payload={payload} />
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {message && <div className="auth-success" role="status">{message}</div>}
    {!payload && !error ? <EmailState title="Loading customer email authority" detail="Reading templates, sender configuration, dependencies, and persisted delivery evidence." /> : payload ? <>
      {!payload.databaseConfigured && <div className="commerce-callout is-unavailable" role="status"><AdminIcon name="shield" /><div><strong>Commerce D1 unavailable</strong><p>Template and delivery authority cannot be verified. All customer delivery remains fail-closed.</p></div></div>}
      <SenderProvider payload={payload} />
      {draft ? <section className="email-control-section" aria-labelledby="template-editor-title">
        <SectionHeading eyebrow="Structured templates" title="Template editor & preview" id="template-editor-title" detail="Edit one supported lifecycle at a time. Preview uses the canonical server renderer and synthetic data only." />
        <div className="customer-email-template-picker">
          <label htmlFor="customer-email-template-select">Email type</label>
          <select id="customer-email-template-select" value={selected} onChange={(event) => void choose(event.target.value)}>{payload.templates.map((template) => <option key={template.templateKey} value={template.templateKey}>{template.displayName} — {template.status}</option>)}</select>
        </div>
        <div className="customer-email-workspace">
          <nav aria-label="Customer email template types">{payload.templates.map((template) => <button type="button" key={template.templateKey} className={template.templateKey === selected ? "is-active" : ""} onClick={() => void choose(template.templateKey)} aria-current={template.templateKey === selected ? "page" : undefined}><span><strong>{template.displayName}</strong><small>{template.purpose}</small></span><EmailChip tone={template.validity?.state === "invalid" ? "bad" : template.status === "ready" && template.enabled ? "good" : template.status === "disabled" ? "quiet" : "warn"}>{template.validity?.state === "invalid" ? "Action required" : template.status === "ready" && template.enabled ? "Configured" : humanize(template.status)}</EmailChip></button>)}</nav>
          <div className="customer-email-editor-shell">
            <header className="customer-email-editor-head"><div><p className="eyebrow">{humanize(draft.templateKey)}</p><h3>{draft.displayName}</h3><p>{draft.validity?.state === "invalid" ? draft.validity.message : draft.purpose}</p></div><div className="customer-email-editor-meta"><EmailChip tone={draft.validity?.state === "invalid" ? "bad" : dirty ? "warn" : "quiet"}>{draft.validity?.state === "invalid" ? "Action required" : dirty ? "Unsaved" : "Saved"}</EmailChip><span>Revision {draft.revision}</span><span>{draft.updatedAt ? `Updated ${formatTimestamp(draft.updatedAt)}` : "No update timestamp"}</span></div></header>
            <div className="customer-email-editor-grid">
              <form className="customer-email-form" onSubmit={(event) => void save(event)} noValidate>
                {fieldErrors.form && <div className="customer-email-form-error" role="alert">{fieldErrors.form}</div>}
                <EditorField label="Display name" error={fieldErrors.displayName}><input value={draft.displayName} onFocus={() => setActiveField("displayName")} onChange={(event) => change("displayName", event.target.value)} maxLength={120} required /></EditorField>
                <div className="customer-email-field-row"><EditorField label="Template state" hint="Ready is a template state, not a production-send switch."><select value={draft.status} onChange={(event) => change("status", event.target.value as CommerceTemplate["status"])}><option value="draft">Draft</option><option value="ready">Ready for later delivery</option><option value="disabled">Disabled</option></select></EditorField><EditorField label="Template enabled" hint="Still subordinate to the global delivery gate."><select value={draft.enabled ? "enabled" : "disabled"} onChange={(event) => change("enabled", event.target.value === "enabled")}><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select></EditorField></div>
                <EditorField label="Subject" hint={`${draft.subject.length}/160 · single line`} error={fieldErrors.subject}><input value={draft.subject} onFocus={() => setActiveField("subject")} onChange={(event) => change("subject", event.target.value)} maxLength={160} aria-invalid={Boolean(fieldErrors.subject)} required /></EditorField>
                <EditorField label="Preheader" hint={`${draft.preheader.length}/200 · single line`} error={fieldErrors.preheader}><input value={draft.preheader} onFocus={() => setActiveField("preheader")} onChange={(event) => change("preheader", event.target.value)} maxLength={200} aria-invalid={Boolean(fieldErrors.preheader)} /></EditorField>
                <EditorField label="Heading" error={fieldErrors.heading}><input value={draft.heading} onFocus={() => setActiveField("heading")} onChange={(event) => change("heading", event.target.value)} maxLength={160} required /></EditorField>
                <EditorField label="Opening copy" error={fieldErrors.introduction}><textarea value={draft.introduction} onFocus={() => setActiveField("introduction")} onChange={(event) => change("introduction", event.target.value)} rows={4} maxLength={1000} /></EditorField>
                <EditorField label="Body blocks" hint="One plain-text block per line; maximum eight." error={fieldErrors.bodyBlocks}><textarea value={draft.bodyBlocks.join("\n")} onFocus={() => setActiveField("bodyBlocks")} onChange={(event) => change("bodyBlocks", event.target.value.split("\n").slice(0, 8))} rows={6} /></EditorField>
                <div className="customer-email-field-row"><EditorField label="CTA label" error={fieldErrors.ctaLabel}><input value={draft.ctaLabel} onFocus={() => setActiveField("ctaLabel")} onChange={(event) => change("ctaLabel", event.target.value)} maxLength={80} /></EditorField><EditorField label="CTA URL" hint="HTTPS, a relative path, or {{receipt_url}}." error={fieldErrors.ctaUrl}><input value={draft.ctaUrl} onFocus={() => setActiveField("ctaUrl")} onChange={(event) => change("ctaUrl", event.target.value)} maxLength={500} /></EditorField></div>
                <EditorField label="Support copy" error={fieldErrors.supportText}><textarea value={draft.supportText} onFocus={() => setActiveField("supportText")} onChange={(event) => change("supportText", event.target.value)} rows={3} maxLength={500} /></EditorField>
                <EditorField label="Footer" error={fieldErrors.footer}><textarea value={draft.footer} onFocus={() => setActiveField("footer")} onChange={(event) => change("footer", event.target.value)} rows={3} maxLength={1000} /></EditorField>
                <EditorField label="Accent colour"><div className="customer-email-colour"><input type="color" value={draft.accentColor} onChange={(event) => change("accentColor", event.target.value)} /><code>{draft.accentColor}</code></div></EditorField>
                <div className="customer-email-form-actions"><button type="submit" className="secondary-button" disabled={!canSave}>{busy === "save" ? "Saving…" : "Save template"}</button><button type="button" className="secondary-button" disabled={!dirty || Boolean(busy)} onClick={discard}>Discard</button><button type="button" className="secondary-button" disabled={Boolean(Object.keys(fieldErrors).length) || Boolean(busy)} onClick={() => void renderPreview(draft, true)}>{busy === "preview" ? "Rendering…" : "Refresh preview"}</button><span>{canManage ? "Manual save · optimistic revision check" : "View only · commerce.templates.manage required"}</span></div>
              </form>
              <CanonicalPreview payload={payload} template={draft} preview={preview} stale={Boolean(preview && previewRevision !== templateFingerprint(draft))} />
            </div>
            <MergeVariables payload={payload} activeField={activeField} onInsert={insertVariable} />
          </div>
        </div>
      </section> : <EmailState title="No customer email template" detail="No supported persisted email template is available to edit." />}
      <DependenciesAndBoundary payload={payload} />
      <DeliveryEvidence payload={payload} />
      <AdvancedEvidence payload={payload} />
    </> : null}
  </div>;
}

function EmailHero({ payload }: { payload: CustomerEmailsPayload | null }) {
  const state = payload?.readiness.state || "action_required";
  return <section className="customer-email-hero" aria-labelledby="customer-emails-title"><div><div className="area-icon"><AdminIcon name="emails" size={28} /></div><p className="eyebrow">Authoritative customer communications</p><h1 id="customer-emails-title">Customer emails</h1><p>Transactional sender readiness, revisioned lifecycle templates, canonical previews, and persisted delivery evidence—without a production send control.</p><div className="customer-email-hero__chips"><EmailChip tone={payload?.provider.configured ? "good" : "warn"}>Sender {payload?.provider.configured ? "configured" : "not configured"}</EmailChip><EmailChip tone={payload?.readiness.configurationReady ? "good" : "warn"}>Templates {payload ? `${payload.readiness.configuredTemplates}/${payload.readiness.totalTemplates}` : "—"}</EmailChip><EmailChip tone="bad">Production sends disabled</EmailChip></div></div><div className="customer-email-readiness-mark"><span>Control-plane state</span><strong>{humanize(state)}</strong><p>{payload?.readiness.configurationReady ? "Configuration dependencies meet the current threshold, but actual customer delivery remains separate and disabled." : "One or more sender or template dependencies still require action. Customer delivery remains disabled."}</p></div></section>;
}

function SenderProvider({ payload }: { payload: CustomerEmailsPayload }) {
  return <section className="email-control-section" aria-labelledby="sender-provider-title"><SectionHeading eyebrow="Server projection" title="Sender identity & provider" id="sender-provider-title" detail="These values come from the server environment and Business Information. Provider secrets and raw responses never reach the browser." /><div className="customer-email-summary-grid"><SummaryMetric label="Provider" value={payload.provider.name} state={payload.provider.configured ? "good" : "warn"} /><SummaryMetric label="Sender" value={payload.sender.fromAddressConfigured ? "Configured" : "Action required"} state={payload.sender.fromAddressConfigured ? "good" : "warn"} /><SummaryMetric label="Reply-To" value={payload.sender.replyToConfigured ? "Configured" : "Not configured"} state={payload.sender.replyToConfigured ? "good" : "warn"} /><SummaryMetric label="Templates" value={`${payload.readiness.configuredTemplates}/${payload.readiness.totalTemplates} configured`} state={payload.readiness.configuredTemplates >= payload.readiness.minimumReadyTemplates ? "good" : "warn"} /><SummaryMetric label="Delivery engine" value={payload.provider.configured ? "Configured" : "Incomplete"} state={payload.provider.configured ? "good" : "warn"} /><SummaryMetric label="Customer sends" value={payload.readiness.customerSendsEnabled ? "Enabled" : "Disabled"} state={payload.readiness.customerSendsEnabled ? "warn" : "bad"} /></div><div className="customer-email-card-grid"><article className="customer-email-card"><header><div><p className="eyebrow">Configured in server environment</p><h3>Sender identity</h3></div><EmailChip tone={payload.sender.fromAddressConfigured ? "good" : "warn"}>{payload.sender.fromAddressConfigured ? "Configured" : "Incomplete"}</EmailChip></header><dl><Fact term="From display name" value={payload.sender.fromDisplayName || "Not configured"} /><Fact term="From address" value={payload.sender.fromAddress || "Not configured"} /><Fact term="Reply-To" value={payload.sender.replyToAddress || "Not configured"} /><Fact term="Sending domain" value={payload.sender.sendingDomain || "Not configured"} /><Fact term="Domain verification" value="Unverified — provider was not queried" /></dl><p>Merchant-facing name and support contact remain owned by Business Information.</p><Link to="/commerce/business">Manage Business Information <AdminIcon name="arrow" size={14} /></Link></article><article className="customer-email-card"><header><div><p className="eyebrow">Transactional provider</p><h3>{payload.provider.name}</h3></div><EmailChip tone={payload.provider.configured ? "good" : "warn"}>{payload.provider.configured ? "Configured" : "Not configured"}</EmailChip></header><dl><Fact term="Credential" value={payload.provider.credentialConfigured ? "Configured server-side" : "Not configured"} /><Fact term="Sender" value={payload.provider.senderConfigured ? "Configured server-side" : "Not configured"} /><Fact term="Reply-To" value={payload.provider.replyToConfigured ? "Configured server-side" : "Not configured"} /><Fact term="External verification" value="Unverified" /><Fact term="Provider health" value="Not queried" /><Fact term="Last persisted success" value={payload.provider.lastSuccessful ? formatTimestamp(payload.provider.lastSuccessful.sentAt || payload.provider.lastSuccessful.updatedAt) : "No recorded delivery"} /><Fact term="Last persisted failure" value={payload.provider.lastFailed ? formatTimestamp(payload.provider.lastFailed.updatedAt) : "No recorded failure"} /></dl><p>No Connect, reconnect, domain-check, or provider-send action is available here.</p></article></div></section>;
}

function CanonicalPreview({ payload, template, preview, stale }: { payload: CustomerEmailsPayload; template: CustomerEmailTemplate; preview: TemplatePreviewPayload | null; stale: boolean }) {
  return <section className="customer-email-preview" aria-labelledby="canonical-preview-title"><header><div><p className="eyebrow">Canonical renderer</p><h3 id="canonical-preview-title">Email preview</h3></div><EmailChip tone={stale ? "warn" : preview ? "good" : "quiet"}>{stale ? "Refresh required" : preview ? "Sample data" : "Not rendered"}</EmailChip></header>{preview ? <><div className="customer-email-inbox"><span>From</span><strong>{[payload.sender.fromDisplayName, payload.sender.fromAddress && `<${payload.sender.fromAddress}>`].filter(Boolean).join(" ") || "Sender not configured"}</strong><span>Subject</span><strong>{preview.preview.subject}</strong><small>{preview.preview.preheader || "No preheader configured."}</small></div><div className="customer-email-preview-label"><span>PREVIEW</span><span>SAMPLE DATA</span><span>NO DELIVERY</span></div><iframe title={`${template.displayName} canonical sample preview`} sandbox="allow-same-origin" srcDoc={preview.preview.html} /><footer><strong>Synthetic fixture only</strong><p>The server rendered this HTML with deterministic sample values. Preview does not call Resend, create a delivery, mint a document token, or mutate an order.</p></footer></> : <EmailState title="Preview unavailable" detail="Refresh the preview after resolving validation errors." />}</section>;
}

function MergeVariables({ payload, activeField, onInsert }: { payload: CustomerEmailsPayload; activeField: TextField | "bodyBlocks"; onInsert: (key: string) => void }) {
  const groups = payload.mergeVariables.reduce<Record<string, typeof payload.mergeVariables>>((result, variable) => { (result[variable.group] ||= []).push(variable); return result; }, {});
  return <section className="customer-email-variables" aria-labelledby="merge-variables-title"><header><div><p className="eyebrow">Renderer allowlist</p><h3 id="merge-variables-title">Merge variables</h3></div><span>Insert into {fieldLabel(activeField)}</span></header><p>Only these exact placeholders are accepted. Unknown or malformed variables fail server validation; traversal, script, raw HTML, and remote-fetch directives are unsupported.</p><div>{Object.entries(groups).map(([group, variables]) => <article key={group}><strong>{group}</strong><div>{variables?.map((variable) => <button type="button" key={variable.key} title={variable.description} onClick={() => onInsert(variable.key)}><code>{`{{${variable.key}}}`}</code><span>{variable.description}</span></button>)}</div></article>)}</div></section>;
}

function DependenciesAndBoundary({ payload }: { payload: CustomerEmailsPayload }) {
  return <section className="email-control-section" aria-labelledby="delivery-boundary-title"><SectionHeading eyebrow="Authority boundaries" title="Dependencies & delivery status" id="delivery-boundary-title" detail="Document content, merchant identity, order history, template state, and global sending remain separate authorities." /><div className="customer-email-card-grid customer-email-card-grid--three"><article className="customer-email-card"><header><div><p className="eyebrow">Business Information owns identity</p><h3>Merchant & support</h3></div><EmailChip tone={payload.dependencies.business.complete ? "good" : "warn"}>{payload.dependencies.business.complete ? "Complete" : "Action required"}</EmailChip></header><dl><Fact term="Storefront name" value={payload.dependencies.business.displayName || "Not configured"} /><Fact term="Support contact" value={payload.dependencies.business.supportEmail || "Not configured"} /><Fact term="Canonical business readiness" value={payload.dependencies.business.canonicalReady ? "Ready" : "Incomplete"} /></dl><Link to={payload.dependencies.business.href}>Manage Business Information <AdminIcon name="arrow" size={14} /></Link></article><article className="customer-email-card"><header><div><p className="eyebrow">Tax & Documents owns content</p><h3>Receipt & invoice</h3></div><EmailChip tone={payload.dependencies.documents.receipt.configured ? "good" : "warn"}>{payload.dependencies.documents.receipt.configured ? "Receipt configured" : "Action required"}</EmailChip></header><dl><Fact term="Receipt document" value={dependencyLabel(payload.dependencies.documents.receipt)} /><Fact term="Invoice document" value={dependencyLabel(payload.dependencies.documents.invoice)} /><Fact term="Customer document access" value={payload.dependencies.documents.customerAccessEnabled ? "Enabled" : "Disabled"} /></dl><Link to={payload.dependencies.documents.href}>Manage Tax & Documents <AdminIcon name="arrow" size={14} /></Link></article><article className="customer-email-card customer-email-delivery-boundary"><header><div><p className="eyebrow">Global delivery authority</p><h3>Customer sending</h3></div><EmailChip tone="bad">{payload.readiness.customerSendsEnabled ? "Enabled" : "Disabled"}</EmailChip></header><dl><Fact term="Provider" value={payload.provider.configured ? "Configured" : "Incomplete"} /><Fact term="Template threshold" value={`${payload.readiness.configuredTemplates}/${payload.readiness.minimumReadyTemplates} minimum ready`} /><Fact term="Canonical production commerce" value={payload.canonicalReadiness?.productionReady ? "Ready" : "Blocked"} /><Fact term="Production lifecycle trigger" value="Not implemented" /><Fact term="Mutable from this page" value="No" /></dl><p>Template enablement cannot bypass the global delivery gate. This page provides no test-send, retry, resend, or production-enable control.</p></article></div></section>;
}

function DeliveryEvidence({ payload }: { payload: CustomerEmailsPayload }) {
  return <section className="email-control-section" aria-labelledby="delivery-evidence-title"><SectionHeading eyebrow="Persisted read-only authority" title="Recent delivery evidence" id="delivery-evidence-title" detail="A bounded ledger projection. TEST evidence is visually distinct and never presented as production proof." /><div className="customer-email-delivery-metrics"><SummaryMetric label="All records" value={String(payload.deliveries.counts.total)} state="quiet" /><SummaryMetric label="TEST" value={String(payload.deliveries.counts.test)} state="warn" /><SummaryMetric label="LIVE" value={String(payload.deliveries.counts.live)} state="quiet" /><SummaryMetric label="Sent" value={String(payload.deliveries.counts.sent)} state="good" /><SummaryMetric label="Failed" value={String(payload.deliveries.counts.failed)} state={payload.deliveries.counts.failed ? "bad" : "quiet"} /></div>{payload.deliveries.recent.length ? <div className="customer-email-delivery-list" role="list">{payload.deliveries.recent.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} />)}</div> : <EmailState title="No delivery history" detail="No persisted customer email delivery records have been recorded. Empty authoritative output is valid." />}</section>;
}

function DeliveryRow({ delivery }: { delivery: CustomerEmailDelivery }) {
  return <article className={`customer-email-delivery-row is-${delivery.environment}`} role="listitem"><div><span className={`order-environment order-environment--${delivery.environment === "live" ? "live" : "test"}`}>{delivery.environment.toUpperCase()}</span><strong>{humanize(delivery.templateKey)}</strong><small>{formatTimestamp(delivery.createdAt)}</small></div><div><span>Recipient</span><strong>{delivery.maskedRecipient}</strong><small>{delivery.purpose === "test_preview" ? "TEST / PREVIEW" : "Transactional ledger"}</small></div><div><span>Status</span><EmailChip tone={delivery.status === "sent" ? "good" : delivery.status === "failed" ? "bad" : "warn"}>{humanize(delivery.status)}</EmailChip><small>{delivery.attemptCount} attempt{delivery.attemptCount === 1 ? "" : "s"}</small></div><div><span>Order</span><strong>{delivery.orderId || "No order bound"}</strong>{delivery.orderId && <Link to="/orders">Open Orders <AdminIcon name="arrow" size={12} /></Link>}</div>{delivery.failure && <p>{delivery.failure}</p>}</article>;
}

function AdvancedEvidence({ payload }: { payload: CustomerEmailsPayload }) {
  return <details className="customer-email-advanced"><summary>Advanced / technical evidence</summary><div><FactList title="Provider & renderer" facts={[["Authority", payload.authority], ["Provider", payload.provider.name], ["Credential", payload.provider.credentialConfigured ? "Configured server-side" : "Not configured"], ["Domain verification", "Unverified"], ["Global customer-send gate", payload.readiness.customerSendsEnabled ? "Enabled" : "Disabled"], ["Lifecycle trigger", "Not implemented"]]} /><FactList title="Delivery ledger" facts={[["Idempotency", payload.deliveries.idempotency.implemented ? "Implemented" : "Unavailable"], ["Key authority", payload.deliveries.idempotency.authority], ["Browser-generated keys", "Not trusted"], ["Retries from page", "Unavailable"], ["TEST records", String(payload.deliveries.counts.test)], ["LIVE records", String(payload.deliveries.counts.live)]]} /><FactList title="Safety assertions" facts={[["Preview mutates", "No"], ["Provider calls on read", "No"], ["Provider calls on preview", "No"], ["Test send exposed", "No"], ["Production control exposed", "No"], ["PayPal dependency", payload.dependencies.paypalRequired ? "Unexpected" : "Not required"]]} /></div></details>;
}

function SectionHeading({ eyebrow, title, id, detail }: { eyebrow: string; title: string; id: string; detail: string }) { return <header className="customer-email-section-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div><p>{detail}</p></header>; }
function SummaryMetric({ label, value, state }: { label: string; value: string; state: "good" | "warn" | "bad" | "quiet" }) { return <article className={`customer-email-metric is-${state}`}><span>{label}</span><strong>{value}</strong><i /></article>; }
function EmailChip({ tone, children }: { tone: "good" | "warn" | "bad" | "quiet"; children: ReactNode }) { return <span className={`customer-email-chip is-${tone}`}>{children}</span>; }
function EditorField({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) { return <label className="customer-email-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}{error && <em role="alert">{error}</em>}</label>; }
function Fact({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function FactList({ title, facts }: { title: string; facts: string[][] }) { return <article><h3>{title}</h3><dl>{facts.map(([term, value]) => <Fact key={term} term={term} value={value} />)}</dl></article>; }
function EmailState({ title, detail }: { title: string; detail: string }) { return <div className="customer-email-empty"><AdminIcon name="emails" /><div><strong>{title}</strong><p>{detail}</p></div></div>; }

function validateDraft(template: CustomerEmailTemplate, allowedVariables: string[]): FieldErrors {
  const errors: FieldErrors = {}; const allowed = new Set(allowedVariables);
  if (!template.displayName.trim()) errors.displayName = "Display name is required.";
  if (!template.subject.trim()) errors.subject = "Subject is required.";
  if (!template.heading.trim()) errors.heading = "Heading is required.";
  if (template.subject.length > 160) errors.subject = "Subject cannot exceed 160 characters.";
  if (template.preheader.length > 200) errors.preheader = "Preheader cannot exceed 200 characters.";
  if (hasHeaderControl(template.subject)) errors.subject = "Subject cannot contain line breaks or control characters.";
  if (hasHeaderControl(template.preheader)) errors.preheader = "Preheader cannot contain line breaks or control characters.";
  const fields: Array<[TextField | "bodyBlocks", string]> = [
    ["subject", template.subject], ["preheader", template.preheader], ["heading", template.heading], ["introduction", template.introduction],
    ["bodyBlocks", template.bodyBlocks.join("\n")], ["ctaLabel", template.ctaLabel], ["ctaUrl", template.ctaUrl], ["supportText", template.supportText], ["footer", template.footer],
  ];
  for (const [field, value] of fields) {
    if (/<\/?[a-z][^>]*>|javascript\s*:|on[a-z]+\s*=|<script/i.test(value)) errors[field] = "Structured plain text only; markup and executable content are rejected.";
    const remainder = value.replace(/\{\{[^{}]*\}\}/g, "");
    if (remainder.includes("{{") || remainder.includes("}}")) errors[field] = "A merge variable is malformed.";
    for (const match of value.matchAll(/\{\{([^{}]*)\}\}/g)) { const key = match[1].trim().toLowerCase(); if (!/^[a-z0-9_]+$/i.test(key) || !allowed.has(key)) errors[field] = `Unsupported merge variable: ${key || "invalid"}.`; }
  }
  if (template.ctaLabel && !isSafeCta(template.ctaUrl)) errors.ctaUrl = "A CTA label requires HTTPS, a relative path, or {{receipt_url}}.";
  return errors;
}

function isSafeCta(value: string) { if (value === "{{receipt_url}}" || (value.startsWith("/") && !value.startsWith("//"))) return true; try { return new URL(value).protocol === "https:"; } catch { return false; } }
function hasHeaderControl(value: string) { return [...value].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }); }
function templateFingerprint(template: CustomerEmailTemplate) { return JSON.stringify({ templateKey: template.templateKey, displayName: template.displayName, subject: template.subject, preheader: template.preheader, heading: template.heading, introduction: template.introduction, bodyBlocks: template.bodyBlocks, ctaLabel: template.ctaLabel, ctaUrl: template.ctaUrl, supportText: template.supportText, footer: template.footer, accentColor: template.accentColor, status: template.status, enabled: template.enabled, revision: template.revision }); }
function fieldLabel(value: TextField | "bodyBlocks") { return humanize(value); }
function humanize(value: string) { return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatTimestamp(value: string | null) { if (!value) return "Not recorded"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function dependencyLabel(value: { configured: boolean; status: string; enabled: boolean }) { return value.configured ? "Configured" : value.status === "not_configured" ? "Not configured" : `${humanize(value.status)} · ${value.enabled ? "enabled" : "disabled"}`; }
function errorMessage(reason: unknown, fallback: string) { return reason instanceof Error && reason.message ? reason.message : fallback; }
