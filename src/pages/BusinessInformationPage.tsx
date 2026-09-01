import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { AuthClientError } from "../auth/types";
import { getBusinessProfile, saveBusinessProfile, type BusinessAddress, type BusinessPayload, type BusinessReadinessState } from "../commerce/client";
import { AdminIcon } from "../components/AdminIcon";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { useAdminToast } from "../components/AdminToasts";
import "../styles/business-information.css";

type BusinessDraft = {
  tradingName: string; publicContactEmail: string; supportEmail: string; businessPhone: string; websiteUrl: string;
  businessAddressLine1: string; businessAddressLine2: string; businessCity: string; businessProvince: string; businessPostalCode: string; businessCountry: string;
  replaceLegalName: boolean; legalBusinessName: string; replaceRegistrationNumber: boolean; businessRegistrationNumber: string;
  replacePrivatePhone: boolean; privatePhone: string; replacePrivateAddress: boolean;
  privateAddressLine1: string; privateAddressLine2: string; privateCity: string; privateProvince: string; privatePostalCode: string; privateCountry: string;
};

type BusinessDraftUpdater = <K extends keyof BusinessDraft>(key: K, value: BusinessDraft[K]) => void;

export function BusinessInformationPage() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const { showToast } = useAdminToast();
  const [payload, setPayload] = useState<BusinessPayload | null>(null);
  const [form, setForm] = useState<BusinessDraft | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => Boolean(form && savedSnapshot && JSON.stringify(form) !== savedSnapshot), [form, savedSnapshot]);

  const load = useCallback(async () => {
    const stop = startLoading("Loading authoritative business profile"); setError("");
    try {
      const next = await getBusinessProfile(); const draft = profileToDraft(next);
      setPayload(next); setForm(draft); setSavedSnapshot(JSON.stringify(draft)); setFieldErrors({});
    } catch (reason) { setError(errorMessage(reason, "Business information is restricted or unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const canManage = Boolean(payload?.access.capabilities.includes("commerce.business.manage"));
  const canSave = Boolean(canManage && payload?.databaseConfigured && payload.encryptionConfigured && csrfToken && !busy && dirty);
  const update: BusinessDraftUpdater = (key, value) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setFieldErrors((current) => current[key] ? { ...current, [key]: "" } : current);
  };
  const discard = () => {
    if (!payload) return; const draft = profileToDraft(payload);
    setForm(draft); setSavedSnapshot(JSON.stringify(draft)); setFieldErrors({}); setError(""); showToast("Unsaved business changes discarded.", { tone: "info", title: "Draft discarded" });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!canSave || !form || !payload || !csrfToken) return;
    const validation = validateDraft(form); setFieldErrors(validation);
    if (Object.keys(validation).length) { setError("Review the highlighted business information before saving."); return; }
    const stop = startLoading("Saving encrypted business profile"); setBusy(true); setError("");
    try {
      const next = await saveBusinessProfile(csrfToken, mutationPayload(form, payload.profile.revision)); const draft = profileToDraft(next);
      setPayload(next); setForm(draft); setSavedSnapshot(JSON.stringify(draft)); setFieldErrors({});
      showToast(`Business profile revision ${next.profile.revision} saved. Sensitive replacement values are no longer present in the browser.`, { title: "Business profile saved" });
    } catch (reason) {
      const field = errorField(reason); if (field) setFieldErrors((current) => ({ ...current, [field]: errorMessage(reason, "Check this field.") }));
      setError(errorMessage(reason, "Business information could not be saved."));
    } finally { setBusy(false); stop(); }
  };

  if (!payload && !error) return <PageState>Loading authoritative business information…</PageState>;
  if (!payload || !form) return <>{error && <div className="admin-alert" role="alert">{error}</div>}</>;
  const profile = payload.profile; const summary = payload.readiness.profile;
  return <div className="business-information-page">
    <section className="business-profile-hero" aria-labelledby="business-information-title">
      <div className="business-profile-hero__main"><div className="area-icon"><AdminIcon name="business" size={28} /></div><p className="eyebrow">Authoritative business record</p><h1 id="business-information-title">Business information</h1><p>Saves operator-owned business metadata independently from commerce readiness. Transaction disclosures, document seller context, and Payments consume only their explicitly scoped projections. Saved values are configuration evidence, not external verification.</p><div className="business-profile-hero__chips"><StatusChip state={payload.readiness.overallStatus} /><StatusChip state="unverified" label="Canada · CAD" /><StatusChip state={summary.productionCommerce} label="Production commerce" /></div></div>
      <div className="business-profile-hero__completion"><span>Transaction facts configured</span><strong>{payload.readiness.completion.percent}%</strong><div role="progressbar" aria-label="Transaction disclosure fact completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={payload.readiness.completion.percent}><i style={{ width: `${payload.readiness.completion.percent}%` }} /></div><small>{payload.readiness.completion.complete} of {payload.readiness.completion.total} required configuration facts present</small></div>
      <div className="business-profile-summary" aria-label="Business profile status summary"><Summary label="Storefront identity" state={summary.coreIdentity} /><Summary label="Business contact" state={summary.publicContact} /><Summary label="Legal identity" state={summary.legalIdentity} /><Summary label="Disclosure address" state={summary.address} /><Summary label="Tax registration" state={summary.tax} /><Summary label="Document identity" state={summary.documents} /></div>
    </section>
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {!canManage && <div className="commerce-callout is-pending" role="status"><AdminIcon name="shield" /><div><strong>Read-only business authority</strong><p>Your session can view commerce. Saving requires <code>commerce.business.manage</code>.</p></div></div>}
    <form className="business-settings-form" onSubmit={(event) => void submit(event)} noValidate>
      <div className="business-settings-grid">
        <Section id="storefront-identity" eyebrow="Public-safe" title="Storefront identity" description="Customer-facing trading identity, deliberately separate from the encrypted legal entity."><div className="business-field-grid"><Field wide label="Trading / store name" hint="Projected publicly only through an intentionally sanitized boundary." error={fieldErrors.tradingName}><input value={form.tradingName} onChange={(event) => update("tradingName", event.target.value)} required maxLength={160} aria-invalid={Boolean(fieldErrors.tradingName)} /></Field></div><Privacy tone="public" label="PUBLIC-SAFE" text="Suitable for customer-facing storefront and merchant context." /></Section>
        <Section id="contact-information" eyebrow="Business operations" title="Contact information" description="Internal business and compliance contact values remain distinct from Resend sender configuration and are not published site-wide."><div className="business-field-grid"><Field label="Business contact email" error={fieldErrors.publicContactEmail}><input type="email" value={form.publicContactEmail} onChange={(event) => update("publicContactEmail", event.target.value)} maxLength={254} aria-invalid={Boolean(fieldErrors.publicContactEmail)} /></Field><Field label="Customer support email" error={fieldErrors.supportEmail}><input type="email" value={form.supportEmail} onChange={(event) => update("supportEmail", event.target.value)} maxLength={254} aria-invalid={Boolean(fieldErrors.supportEmail)} /></Field><Field label="Business phone" hint="Optional profile metadata. Free-form text; not published site-wide." error={fieldErrors.businessPhone}><input type="tel" value={form.businessPhone} onChange={(event) => update("businessPhone", event.target.value)} maxLength={80} placeholder="Not configured" aria-invalid={Boolean(fieldErrors.businessPhone)} /></Field><Field label="Website" hint="HTTPS only." error={fieldErrors.websiteUrl}><input type="url" value={form.websiteUrl} onChange={(event) => update("websiteUrl", event.target.value)} maxLength={500} placeholder="https://thirdrailify.com" aria-invalid={Boolean(fieldErrors.websiteUrl)} /></Field></div><div className="business-dependency-inline"><span>Transactional sender</span><StatusChip state={dependencyState(payload, "communications")} /><Link to="/commerce/emails">Manage Customer Emails <AdminIcon name="arrow" size={14} /></Link></div></Section>
        <Section id="legal-merchant-details" eyebrow="Sensitive · encrypted" title="Legal / merchant details" description="Values are never prefilled. Replace only when an intentional update is required.">
          <Sensitive title="Legal registered name" configured={profile.private.legalBusinessNameStored} mask={profile.private.legalBusinessNameMasked} replacing={form.replaceLegalName} onToggle={() => update("replaceLegalName", !form.replaceLegalName)}><Field label="Replacement legal name" hint="Encrypted at rest; manually entered and unverified." error={fieldErrors.legalBusinessName}><input value={form.legalBusinessName} onChange={(event) => update("legalBusinessName", event.target.value)} autoComplete="organization" maxLength={240} aria-invalid={Boolean(fieldErrors.legalBusinessName)} /></Field></Sensitive>
          <Sensitive title="Business / corporation number" configured={profile.private.businessRegistrationNumberStored} mask={profile.private.businessRegistrationNumberMasked} replacing={form.replaceRegistrationNumber} onToggle={() => update("replaceRegistrationNumber", !form.replaceRegistrationNumber)}><Field label="Replacement registration number" hint="Not GST/HST. Tax registrations remain in Tax & documents." error={fieldErrors.businessRegistrationNumber}><input value={form.businessRegistrationNumber} onChange={(event) => update("businessRegistrationNumber", event.target.value)} autoComplete="off" maxLength={100} aria-invalid={Boolean(fieldErrors.businessRegistrationNumber)} /></Field></Sensitive>
          <Sensitive title="Private business phone" configured={profile.private.privatePhoneStored} mask={profile.private.privatePhoneMasked} replacing={form.replacePrivatePhone} onToggle={() => update("replacePrivatePhone", !form.replacePrivatePhone)}><Field label="Replacement private phone" hint="ADMIN document context only; never a public fallback." error={fieldErrors.privatePhone}><input type="tel" value={form.privatePhone} onChange={(event) => update("privatePhone", event.target.value)} autoComplete="off" maxLength={40} aria-invalid={Boolean(fieldErrors.privatePhone)} /></Field></Sensitive>
          <Privacy tone="sensitive" label="SENSITIVE" text="Only configured state and bounded masks return to this browser." />
        </Section>
        <Section id="business-address" eyebrow="Operator-owned metadata" title="Business address" description="Business metadata and transaction-disclosure readiness are separate. These fields accept free text and are not a postal-verification system.">
          <div className="business-address-block"><header><div><span>Business / compliance address</span><small>INTERNAL · may be used by a scoped checkout disclosure only when required; never published site-wide automatically.</small></div><StatusChip state={addressConfigured(profile.businessAddress) ? "complete" : Object.values(profile.businessAddress).some(Boolean) ? "partial" : "not_configured"} /></header><AddressFields kind="business" form={form} errors={fieldErrors} update={update} /></div>
          <div className="business-address-block business-address-block--private"><header><div><span>Legal business address</span><small>SENSITIVE · encrypted; stored address is never returned as plaintext.</small></div><StatusChip state={profile.private.privateAddressStored ? "unverified" : "not_configured"} /></header><button className="secondary-button business-replace-button" type="button" onClick={() => update("replacePrivateAddress", !form.replacePrivateAddress)}>{form.replacePrivateAddress ? "Cancel replacement" : profile.private.privateAddressStored ? "Replace encrypted address" : "Add legal address"}</button>{form.replacePrivateAddress && <AddressFields kind="private" form={form} errors={fieldErrors} update={update} />}</div>
          <p className="business-verification-note"><AdminIcon name="shield" size={16} />Values are stored as operator-entered text after trimming edges and enforcing storage/security limits. No geocoding, postal lookup, or real-world address opinion is applied.</p>
        </Section>
        <Section id="document-seller-identity" eyebrow="Canonical dependencies" title="Document & seller identity" description="Projects the current seller context; template and tax editing stay in their authoritative workspaces."><dl className="business-fact-list"><Fact term="Trading name" value={payload.readiness.documentIdentity.tradingName || "Not configured"} /><Fact term="Legal name" value={payload.readiness.documentIdentity.legalNameStored ? "Encrypted / configured / unverified" : "Not configured"} /><Fact term="Legal address" value={payload.readiness.documentIdentity.addressStored ? "Encrypted / configured / unverified" : "Not configured"} /><Fact term="Document contact" value={payload.readiness.documentIdentity.contactEmail || "Not configured"} /><Fact term="Tax identifier" value={stateLabel(payload.readiness.documentIdentity.taxRegistrationState)} /><Fact term="Receipt template" value={stateLabel(payload.readiness.documentIdentity.receiptTemplate.state)} /><Fact term="Invoice template" value={stateLabel(payload.readiness.documentIdentity.invoiceTemplate.state)} /></dl><div className="business-link-row"><Link className="secondary-button" to="/commerce/tax">Tax &amp; documents <AdminIcon name="arrow" size={14} /></Link><Link className="secondary-button" to="/commerce/emails">Customer emails <AdminIcon name="arrow" size={14} /></Link></div></Section>
        <Section id="commerce-defaults" eyebrow="Historical commerce guardrail" title="Commerce defaults" description="The architecture and persisted history are scoped to Ontario, Canada and canonical CAD minor units."><div className="business-readonly-grid"><Readonly label="Merchant country" value="Canada" code="CA" /><Readonly label="Merchant region" value="Ontario" code="ON" /><Readonly label="Commerce currency" value="Canadian dollar" code="CAD" /></div><p className="business-verification-note"><AdminIcon name="shield" size={16} />Read-only by design. The server rejects unsupported country, region, or currency mutation.</p></Section>
      </div>
      <section className="business-readiness-section" aria-labelledby="business-readiness-title"><div className="business-section-heading"><div><p className="eyebrow">Separate server-derived assessment</p><h2 id="business-readiness-title">Readiness &amp; compliance</h2><p>Saving the profile does not claim legal compliance. These Commerce D1 checks report absent transaction facts separately and never judge whether address text is real.</p></div><StatusChip state={payload.readiness.overallStatus} /></div><div className="business-readiness-grid">{payload.readiness.groups.map((group) => <article key={group.id}><header><strong>{group.label}</strong><StatusChip state={group.state} /></header><ul>{group.items.map((item) => <li key={item.id}><i className={`is-${item.state}`} /><div><strong>{item.label}</strong><span>{item.detail}</span></div><small>{stateLabel(item.state)}</small></li>)}</ul></article>)}</div></section>
      <details className="business-advanced"><summary>Advanced authority, privacy &amp; technical metadata</summary><div className="business-advanced__grid"><FactList title="Authority" facts={[["Source", payload.authority], ["Profile ID", "primary"], ["Revision", String(profile.revision)], ["Updated", formatDate(profile.updatedAt)], ["Read access", "commerce.view"], ["Write access", "commerce.business.manage"]]} /><FactList title="Privacy boundary" facts={[["PUBLIC-SAFE", `${payload.privacy.publicSafe.length} classified fields`], ["ADMIN-ONLY", `${payload.privacy.adminOnly.length} metadata fields`], ["SENSITIVE", `${payload.privacy.sensitive.length} encrypted categories`], ["Browser secret access", "Masked state only"], ["Provider calls", "None"]]} /></div></details>
      <div className={`business-savebar${dirty ? " is-sticky" : ""}`} role="status"><div><i className={dirty ? "is-dirty" : "is-saved"} /><span>{busy ? "Saving to Commerce D1…" : dirty ? "Unsaved business changes" : "All business changes saved"}</span></div><div><button className="button-link" type="button" onClick={discard} disabled={!dirty || busy}>Discard</button><button className="primary-button" type="submit" disabled={!canSave}>{busy ? "Saving…" : "Save changes"}</button></div></div>
    </form>
  </div>;
}

function Section({ id, eyebrow, title, description, children }: { id: string; eyebrow: string; title: string; description: string; children: ReactNode }) { return <section className="business-settings-card" aria-labelledby={id}><header><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2><p>{description}</p></header>{children}</section>; }
function Field({ label, hint, error, wide = false, children }: { label: string; hint?: string; error?: string; wide?: boolean; children: ReactNode }) { return <label className={`commerce-field${wide ? " commerce-field--wide" : ""}${error ? " has-error" : ""}`}><span>{label}</span>{children}{error ? <small className="commerce-field__error" role="alert">{error}</small> : hint ? <small>{hint}</small> : null}</label>; }
function StatusChip({ state, label }: { state: BusinessReadinessState; label?: string }) { return <span className={`business-status is-${state}`}>{label || stateLabel(state)}</span>; }
function Summary({ label, state }: { label: string; state: BusinessReadinessState }) { return <div><span>{label}</span><StatusChip state={state} /></div>; }
function Privacy({ tone, label, text }: { tone: "public" | "sensitive"; label: string; text: string }) { return <div className={`business-privacy is-${tone}`}><AdminIcon name={tone === "sensitive" ? "shield" : "eye"} size={15} /><strong>{label}</strong><span>{text}</span></div>; }
function Sensitive({ title, configured, mask, replacing, onToggle, children }: { title: string; configured: boolean; mask: string; replacing: boolean; onToggle: () => void; children: ReactNode }) { return <div className="business-sensitive-row"><div><strong>{title}</strong><span>{configured ? mask || "Encrypted value configured" : "Not configured"}</span></div><StatusChip state={configured ? "unverified" : "not_configured"} /><button className="button-link" type="button" onClick={onToggle}>{replacing ? "Cancel" : configured ? "Replace" : "Add"}</button>{replacing && <div className="business-sensitive-fields">{children}</div>}</div>; }
function Readonly({ label, value, code }: { label: string; value: string; code: string }) { return <div><span>{label}</span><strong>{value}</strong><code>{code}</code></div>; }
function Fact({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function FactList({ title, facts }: { title: string; facts: Array<[string, string]> }) { return <section><h3>{title}</h3><dl>{facts.map(([term, value]) => <Fact key={term} term={term} value={value} />)}</dl></section>; }
function PageState({ children }: { children: ReactNode }) { return <div className="commerce-state" role="status">{children}</div>; }

function AddressFields({ kind, form, errors, update }: { kind: "business" | "private"; form: BusinessDraft; errors: Record<string, string>; update: BusinessDraftUpdater }) {
  const prefix = kind === "business" ? "business" : "private";
  const values = kind === "business" ? { line1: form.businessAddressLine1, line2: form.businessAddressLine2, city: form.businessCity, province: form.businessProvince, postal: form.businessPostalCode, country: form.businessCountry } : { line1: form.privateAddressLine1, line2: form.privateAddressLine2, city: form.privateCity, province: form.privateProvince, postal: form.privatePostalCode, country: form.privateCountry };
  const keys = kind === "business" ? { line1: "businessAddressLine1", line2: "businessAddressLine2", city: "businessCity", province: "businessProvince", postal: "businessPostalCode", country: "businessCountry" } as const : { line1: "privateAddressLine1", line2: "privateAddressLine2", city: "privateCity", province: "privateProvince", postal: "privatePostalCode", country: "privateCountry" } as const;
  return <div className={`business-field-grid business-address-fields is-${prefix}`}><Field wide label="Address line 1" error={errors[keys.line1]}><input value={values.line1} onChange={(event) => update(keys.line1, event.target.value)} autoComplete="off" maxLength={180} aria-invalid={Boolean(errors[keys.line1])} /></Field><Field wide label="Address line 2" hint="Optional free text."><input value={values.line2} onChange={(event) => update(keys.line2, event.target.value)} autoComplete="off" maxLength={180} /></Field><Field label="City / locality" error={errors[keys.city]}><input value={values.city} onChange={(event) => update(keys.city, event.target.value)} autoComplete="off" maxLength={120} aria-invalid={Boolean(errors[keys.city])} /></Field><Field label="Region" error={errors[keys.province]}><input value={values.province} onChange={(event) => update(keys.province, event.target.value)} autoComplete="off" maxLength={120} aria-invalid={Boolean(errors[keys.province])} /></Field><Field label="Postal text" error={errors[keys.postal]}><input value={values.postal} onChange={(event) => update(keys.postal, event.target.value)} autoComplete="off" maxLength={64} aria-invalid={Boolean(errors[keys.postal])} /></Field><Field label="Country text" error={errors[keys.country]}><input value={values.country} onChange={(event) => update(keys.country, event.target.value)} autoComplete="off" maxLength={120} aria-invalid={Boolean(errors[keys.country])} /></Field></div>;
}

function profileToDraft(payload: BusinessPayload): BusinessDraft {
  const address = payload.profile.businessAddress || payload.profile.publicAddress || {};
  return { tradingName: payload.profile.tradingName, publicContactEmail: payload.profile.publicContactEmail, supportEmail: payload.profile.supportEmail, businessPhone: payload.profile.businessPhone || payload.profile.publicPhone || "", websiteUrl: payload.profile.websiteUrl, businessAddressLine1: address.line1 || "", businessAddressLine2: address.line2 || "", businessCity: address.city || "", businessProvince: address.province || "", businessPostalCode: address.postalCode || "", businessCountry: address.country || "", replaceLegalName: false, legalBusinessName: "", replaceRegistrationNumber: false, businessRegistrationNumber: "", replacePrivatePhone: false, privatePhone: "", replacePrivateAddress: false, privateAddressLine1: "", privateAddressLine2: "", privateCity: "", privateProvince: "", privatePostalCode: "", privateCountry: "" };
}
function mutationPayload(form: BusinessDraft, revision: number) {
  const result: Record<string, unknown> = { revision, tradingName: form.tradingName, countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: form.publicContactEmail, supportEmail: form.supportEmail, businessPhone: form.businessPhone, websiteUrl: form.websiteUrl, businessAddress: addressValue(form, "business") };
  if (form.replaceLegalName) result.legalBusinessName = form.legalBusinessName;
  if (form.replaceRegistrationNumber) result.businessRegistrationNumber = form.businessRegistrationNumber;
  if (form.replacePrivatePhone) result.privatePhone = form.privatePhone;
  if (form.replacePrivateAddress) result.privateAddress = addressValue(form, "private");
  return result;
}
function addressValue(form: BusinessDraft, kind: "business" | "private") { return kind === "business" ? { line1: form.businessAddressLine1, line2: form.businessAddressLine2, city: form.businessCity, province: form.businessProvince, postalCode: form.businessPostalCode, country: form.businessCountry } : { line1: form.privateAddressLine1, line2: form.privateAddressLine2, city: form.privateCity, province: form.privateProvince, postalCode: form.privatePostalCode, country: form.privateCountry }; }
function validateDraft(form: BusinessDraft) {
  const errors: Record<string, string> = {}; const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!form.tradingName.trim()) errors.tradingName = "Trading / store name is required.";
  if (form.publicContactEmail && !email.test(form.publicContactEmail)) errors.publicContactEmail = "Enter a valid business contact email.";
  if (form.supportEmail && !email.test(form.supportEmail)) errors.supportEmail = "Enter a valid customer support email.";
  if (form.websiteUrl && !/^https:\/\//i.test(form.websiteUrl)) errors.websiteUrl = "Use a valid HTTPS website URL.";
  if (form.replaceLegalName && !form.legalBusinessName.trim()) errors.legalBusinessName = "Enter the replacement legal registered name.";
  if (form.replaceRegistrationNumber && !form.businessRegistrationNumber.trim()) errors.businessRegistrationNumber = "Enter the replacement business / corporation number.";
  return errors;
}
function errorField(reason: unknown) { if (!(reason instanceof AuthClientError)) return null; return ({ trading_name_required: "tradingName", trading_name_invalid: "tradingName", public_contact_email_invalid: "publicContactEmail", support_email_invalid: "supportEmail", website_url_invalid: "websiteUrl", business_phone_invalid: "businessPhone", business_phone_invalid_too_long: "businessPhone", private_phone_invalid: "privatePhone", business_address_invalid: "businessAddressLine1", business_address_invalid_too_long: "businessAddressLine1", private_address_invalid: "privateAddressLine1", private_value_invalid: "legalBusinessName" } as Record<string, string>)[reason.code] || null; }
function dependencyState(payload: BusinessPayload, key: string): BusinessReadinessState { const value = payload.readiness.dependencies[key]; return typeof value === "object" && value && "ready" in value ? value.ready ? "complete" : value.details.sendEnabled === false || value.details.enabled === false ? "disabled" : "action_required" : "not_configured"; }
function addressConfigured(address: BusinessAddress) { return Boolean(address.line1 && address.city && address.province && address.postalCode && address.country); }
function stateLabel(state: BusinessReadinessState) { return ({ complete: "Complete", partial: "Partial", action_required: "Action required", incomplete: "Action required", not_configured: "Not configured", not_required: "Not required", unverified: "Unverified", disabled: "Disabled" } as const)[state]; }
function formatDate(value: string | null) { const timestamp = Date.parse(String(value || "")); return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Not yet updated"; }
function errorMessage(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
