import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { AuthClientError } from "../auth/types";
import { getBusinessProfile, saveBusinessProfile, type BusinessPayload, type BusinessReadinessState, type PublicAddress } from "../commerce/client";
import { AdminIcon } from "../components/AdminIcon";
import type { AdminShellOutletContext } from "../components/AdminShell";
import "../styles/business-information.css";

type BusinessDraft = {
  tradingName: string; publicContactEmail: string; supportEmail: string; publicPhone: string; websiteUrl: string;
  publicAddressLine1: string; publicAddressLine2: string; publicCity: string; publicProvince: string; publicPostalCode: string; publicCountry: string;
  replaceLegalName: boolean; legalBusinessName: string; replaceRegistrationNumber: boolean; businessRegistrationNumber: string;
  replacePrivatePhone: boolean; privatePhone: string; replacePrivateAddress: boolean;
  privateAddressLine1: string; privateAddressLine2: string; privateCity: string; privateProvince: string; privatePostalCode: string; privateCountry: string;
};

type BusinessDraftUpdater = <K extends keyof BusinessDraft>(key: K, value: BusinessDraft[K]) => void;

export function BusinessInformationPage() {
  const { csrfToken } = useAuth();
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<BusinessPayload | null>(null);
  const [form, setForm] = useState<BusinessDraft | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
    setFieldErrors((current) => current[key] ? { ...current, [key]: "" } : current); setMessage("");
  };
  const discard = () => {
    if (!payload) return; const draft = profileToDraft(payload);
    setForm(draft); setSavedSnapshot(JSON.stringify(draft)); setFieldErrors({}); setError(""); setMessage("Unsaved changes discarded.");
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!canSave || !form || !payload || !csrfToken) return;
    const validation = validateDraft(form); setFieldErrors(validation);
    if (Object.keys(validation).length) { setError("Review the highlighted business information before saving."); return; }
    const stop = startLoading("Saving encrypted business profile"); setBusy(true); setError(""); setMessage("");
    try {
      const next = await saveBusinessProfile(csrfToken, mutationPayload(form, payload.profile.revision)); const draft = profileToDraft(next);
      setPayload(next); setForm(draft); setSavedSnapshot(JSON.stringify(draft)); setFieldErrors({});
      setMessage(`Business profile revision ${next.profile.revision} saved. Sensitive replacement values are no longer present in the browser.`);
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
      <div className="business-profile-hero__main"><div className="area-icon"><AdminIcon name="business" size={28} /></div><p className="eyebrow">Authoritative merchant profile</p><h1 id="business-information-title">Business information</h1><p>Controls Third Railify’s storefront identity, merchant readiness, document seller context, and the business dependency consumed by Payments. Saved values are configuration evidence, not external verification.</p><div className="business-profile-hero__chips"><StatusChip state={payload.readiness.overallStatus} /><StatusChip state="unverified" label="Canada · CAD" /><StatusChip state={summary.productionCommerce} label="Production commerce" /></div></div>
      <div className="business-profile-hero__completion"><span>Profile completion</span><strong>{payload.readiness.completion.percent}%</strong><div role="progressbar" aria-label="Business profile completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={payload.readiness.completion.percent}><i style={{ width: `${payload.readiness.completion.percent}%` }} /></div><small>{payload.readiness.completion.complete} of {payload.readiness.completion.total} required profile gates configured</small></div>
      <div className="business-profile-summary" aria-label="Business profile status summary"><Summary label="Storefront identity" state={summary.coreIdentity} /><Summary label="Public contact" state={summary.publicContact} /><Summary label="Legal identity" state={summary.legalIdentity} /><Summary label="Business address" state={summary.address} /><Summary label="Tax registration" state={summary.tax} /><Summary label="Document identity" state={summary.documents} /></div>
    </section>
    {error && <div className="admin-alert" role="alert">{error}</div>}{message && <div className="auth-success" role="status">{message}</div>}
    {!canManage && <div className="commerce-callout is-pending" role="status"><AdminIcon name="shield" /><div><strong>Read-only business authority</strong><p>Your session can view commerce. Saving requires <code>commerce.business.manage</code>.</p></div></div>}
    <form className="business-settings-form" onSubmit={(event) => void submit(event)} noValidate>
      <div className="business-settings-grid">
        <Section id="storefront-identity" eyebrow="Public-safe" title="Storefront identity" description="Customer-facing trading identity, deliberately separate from the encrypted legal entity."><div className="business-field-grid"><Field wide label="Trading / store name" hint="Projected publicly only through an intentionally sanitized boundary." error={fieldErrors.tradingName}><input value={form.tradingName} onChange={(event) => update("tradingName", event.target.value)} required maxLength={160} aria-invalid={Boolean(fieldErrors.tradingName)} /></Field></div><Privacy tone="public" label="PUBLIC-SAFE" text="Suitable for customer-facing storefront and merchant context." /></Section>
        <Section id="contact-information" eyebrow="Customer communications" title="Contact information" description="Business contact values remain distinct from Resend sender configuration."><div className="business-field-grid"><Field label="Public contact email" error={fieldErrors.publicContactEmail}><input type="email" value={form.publicContactEmail} onChange={(event) => update("publicContactEmail", event.target.value)} maxLength={254} aria-invalid={Boolean(fieldErrors.publicContactEmail)} /></Field><Field label="Customer support email" error={fieldErrors.supportEmail}><input type="email" value={form.supportEmail} onChange={(event) => update("supportEmail", event.target.value)} maxLength={254} aria-invalid={Boolean(fieldErrors.supportEmail)} /></Field><Field label="Public phone" hint="Optional; no verification is implied." error={fieldErrors.publicPhone}><input type="tel" value={form.publicPhone} onChange={(event) => update("publicPhone", event.target.value)} maxLength={40} placeholder="Not configured" aria-invalid={Boolean(fieldErrors.publicPhone)} /></Field><Field label="Website" hint="HTTPS only." error={fieldErrors.websiteUrl}><input type="url" value={form.websiteUrl} onChange={(event) => update("websiteUrl", event.target.value)} maxLength={500} placeholder="https://thirdrailify.com" aria-invalid={Boolean(fieldErrors.websiteUrl)} /></Field></div><div className="business-dependency-inline"><span>Transactional sender</span><StatusChip state={dependencyState(payload, "communications")} /><Link to="/commerce/emails">Manage Customer Emails <AdminIcon name="arrow" size={14} /></Link></div></Section>
        <Section id="legal-merchant-details" eyebrow="Sensitive · encrypted" title="Legal / merchant details" description="Values are never prefilled. Replace only when an intentional update is required.">
          <Sensitive title="Legal registered name" configured={profile.private.legalBusinessNameStored} mask={profile.private.legalBusinessNameMasked} replacing={form.replaceLegalName} onToggle={() => update("replaceLegalName", !form.replaceLegalName)}><Field label="Replacement legal name" hint="Encrypted at rest; manually entered and unverified." error={fieldErrors.legalBusinessName}><input value={form.legalBusinessName} onChange={(event) => update("legalBusinessName", event.target.value)} autoComplete="organization" maxLength={240} aria-invalid={Boolean(fieldErrors.legalBusinessName)} /></Field></Sensitive>
          <Sensitive title="Business / corporation number" configured={profile.private.businessRegistrationNumberStored} mask={profile.private.businessRegistrationNumberMasked} replacing={form.replaceRegistrationNumber} onToggle={() => update("replaceRegistrationNumber", !form.replaceRegistrationNumber)}><Field label="Replacement registration number" hint="Not GST/HST. Tax registrations remain in Tax & documents." error={fieldErrors.businessRegistrationNumber}><input value={form.businessRegistrationNumber} onChange={(event) => update("businessRegistrationNumber", event.target.value)} autoComplete="off" maxLength={100} aria-invalid={Boolean(fieldErrors.businessRegistrationNumber)} /></Field></Sensitive>
          <Sensitive title="Private business phone" configured={profile.private.privatePhoneStored} mask={profile.private.privatePhoneMasked} replacing={form.replacePrivatePhone} onToggle={() => update("replacePrivatePhone", !form.replacePrivatePhone)}><Field label="Replacement private phone" hint="ADMIN document context only; never a public fallback." error={fieldErrors.privatePhone}><input type="tel" value={form.privatePhone} onChange={(event) => update("privatePhone", event.target.value)} autoComplete="off" maxLength={40} aria-invalid={Boolean(fieldErrors.privatePhone)} /></Field></Sensitive>
          <Privacy tone="sensitive" label="SENSITIVE" text="Only configured state and bounded masks return to this browser." />
        </Section>
        <Section id="business-address" eyebrow="Structured addresses" title="Business address" description="Public and legal address concepts already exist in the profile and remain deliberately separate.">
          <div className="business-address-block"><header><div><span>Customer-facing address</span><small>PUBLIC-SAFE · leave every field blank when no public address is approved.</small></div><StatusChip state={addressConfigured(profile.publicAddress) ? "complete" : "not_configured"} /></header><AddressFields kind="public" form={form} errors={fieldErrors} update={update} /></div>
          <div className="business-address-block business-address-block--private"><header><div><span>Legal business address</span><small>SENSITIVE · encrypted; stored address is never returned as plaintext.</small></div><StatusChip state={profile.private.privateAddressStored ? "unverified" : "not_configured"} /></header><button className="secondary-button business-replace-button" type="button" onClick={() => update("replacePrivateAddress", !form.replacePrivateAddress)}>{form.replacePrivateAddress ? "Cancel replacement" : profile.private.privateAddressStored ? "Replace encrypted address" : "Add legal address"}</button>{form.replacePrivateAddress && <AddressFields kind="private" form={form} errors={fieldErrors} update={update} />}</div>
          <p className="business-verification-note"><AdminIcon name="shield" size={16} />Basic Canadian formatting is validated. No geocoding or address-verification provider is called.</p>
        </Section>
        <Section id="document-seller-identity" eyebrow="Canonical dependencies" title="Document & seller identity" description="Projects the current seller context; template and tax editing stay in their authoritative workspaces."><dl className="business-fact-list"><Fact term="Trading name" value={payload.readiness.documentIdentity.tradingName || "Not configured"} /><Fact term="Legal name" value={payload.readiness.documentIdentity.legalNameStored ? "Encrypted / configured / unverified" : "Not configured"} /><Fact term="Legal address" value={payload.readiness.documentIdentity.addressStored ? "Encrypted / configured / unverified" : "Not configured"} /><Fact term="Document contact" value={payload.readiness.documentIdentity.contactEmail || "Not configured"} /><Fact term="Tax identifier" value={stateLabel(payload.readiness.documentIdentity.taxRegistrationState)} /><Fact term="Receipt template" value={stateLabel(payload.readiness.documentIdentity.receiptTemplate.state)} /><Fact term="Invoice template" value={stateLabel(payload.readiness.documentIdentity.invoiceTemplate.state)} /></dl><div className="business-link-row"><Link className="secondary-button" to="/commerce/tax">Tax &amp; documents <AdminIcon name="arrow" size={14} /></Link><Link className="secondary-button" to="/commerce/emails">Customer emails <AdminIcon name="arrow" size={14} /></Link></div></Section>
        <Section id="commerce-defaults" eyebrow="Historical commerce guardrail" title="Commerce defaults" description="The architecture and persisted history are scoped to Ontario, Canada and canonical CAD minor units."><div className="business-readonly-grid"><Readonly label="Merchant country" value="Canada" code="CA" /><Readonly label="Merchant region" value="Ontario" code="ON" /><Readonly label="Commerce currency" value="Canadian dollar" code="CAD" /></div><p className="business-verification-note"><AdminIcon name="shield" size={16} />Read-only by design. The server rejects unsupported country, region, or currency mutation.</p></Section>
      </div>
      <section className="business-readiness-section" aria-labelledby="business-readiness-title"><div className="business-section-heading"><div><p className="eyebrow">Server-derived · shared with Payments</p><h2 id="business-readiness-title">Readiness &amp; dependencies</h2><p>No browser checklist can override these canonical Commerce D1 gates. Deferred PayPal is explicitly not required.</p></div><StatusChip state={payload.readiness.overallStatus} /></div><div className="business-readiness-grid">{payload.readiness.groups.map((group) => <article key={group.id}><header><strong>{group.label}</strong><StatusChip state={group.state} /></header><ul>{group.items.map((item) => <li key={item.id}><i className={`is-${item.state}`} /><div><strong>{item.label}</strong><span>{item.detail}</span></div><small>{stateLabel(item.state)}</small></li>)}</ul></article>)}</div></section>
      <details className="business-advanced"><summary>Advanced authority, privacy &amp; technical metadata</summary><div className="business-advanced__grid"><FactList title="Authority" facts={[["Source", payload.authority], ["Profile ID", "primary"], ["Revision", String(profile.revision)], ["Updated", formatDate(profile.updatedAt)], ["Read access", "commerce.view"], ["Write access", "commerce.business.manage"]]} /><FactList title="Privacy boundary" facts={[["PUBLIC-SAFE", `${payload.privacy.publicSafe.length} classified fields`], ["ADMIN-ONLY", `${payload.privacy.adminOnly.length} metadata fields`], ["SENSITIVE", `${payload.privacy.sensitive.length} encrypted categories`], ["Browser secret access", "Masked state only"], ["Provider calls", "None"]]} /></div></details>
      <div className={`business-savebar${dirty ? " is-sticky" : ""}`} role="status"><div><i className={dirty ? "is-dirty" : message ? "is-saved" : ""} /><span>{busy ? "Saving to Commerce D1…" : dirty ? "Unsaved business changes" : message || "All business changes saved"}</span></div><div><button className="button-link" type="button" onClick={discard} disabled={!dirty || busy}>Discard</button><button className="primary-button" type="submit" disabled={!canSave}>{busy ? "Saving…" : "Save changes"}</button></div></div>
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

function AddressFields({ kind, form, errors, update }: { kind: "public" | "private"; form: BusinessDraft; errors: Record<string, string>; update: BusinessDraftUpdater }) {
  const prefix = kind === "public" ? "public" : "private";
  const values = kind === "public" ? { line1: form.publicAddressLine1, line2: form.publicAddressLine2, city: form.publicCity, province: form.publicProvince, postal: form.publicPostalCode, country: form.publicCountry } : { line1: form.privateAddressLine1, line2: form.privateAddressLine2, city: form.privateCity, province: form.privateProvince, postal: form.privatePostalCode, country: form.privateCountry };
  const keys = kind === "public" ? { line1: "publicAddressLine1", line2: "publicAddressLine2", city: "publicCity", province: "publicProvince", postal: "publicPostalCode", country: "publicCountry" } as const : { line1: "privateAddressLine1", line2: "privateAddressLine2", city: "privateCity", province: "privateProvince", postal: "privatePostalCode", country: "privateCountry" } as const;
  return <div className={`business-field-grid business-address-fields is-${prefix}`}><Field wide label="Address line 1" error={errors[keys.line1]}><input value={values.line1} onChange={(event) => update(keys.line1, event.target.value)} autoComplete={kind === "public" ? "street-address" : "off"} maxLength={180} aria-invalid={Boolean(errors[keys.line1])} /></Field><Field wide label="Address line 2" hint="Optional unit or suite."><input value={values.line2} onChange={(event) => update(keys.line2, event.target.value)} autoComplete="off" maxLength={180} /></Field><Field label="City" error={errors[keys.city]}><input value={values.city} onChange={(event) => update(keys.city, event.target.value)} autoComplete="off" maxLength={120} aria-invalid={Boolean(errors[keys.city])} /></Field><Field label="Province" error={errors[keys.province]}><input value={values.province} onChange={(event) => update(keys.province, event.target.value.toUpperCase())} autoComplete="off" maxLength={3} placeholder="ON" aria-invalid={Boolean(errors[keys.province])} /></Field><Field label="Postal code" error={errors[keys.postal]}><input value={values.postal} onChange={(event) => update(keys.postal, event.target.value.toUpperCase())} autoComplete="off" maxLength={12} placeholder="M5V 1A1" aria-invalid={Boolean(errors[keys.postal])} /></Field><Field label="Country code" error={errors[keys.country]}><input value={values.country} onChange={(event) => update(keys.country, event.target.value.toUpperCase())} autoComplete="off" maxLength={2} placeholder="CA" aria-invalid={Boolean(errors[keys.country])} /></Field></div>;
}

function profileToDraft(payload: BusinessPayload): BusinessDraft {
  const address = payload.profile.publicAddress || {};
  return { tradingName: payload.profile.tradingName, publicContactEmail: payload.profile.publicContactEmail, supportEmail: payload.profile.supportEmail, publicPhone: payload.profile.publicPhone, websiteUrl: payload.profile.websiteUrl, publicAddressLine1: address.line1 || "", publicAddressLine2: address.line2 || "", publicCity: address.city || "", publicProvince: address.province || "", publicPostalCode: address.postalCode || "", publicCountry: address.country || "", replaceLegalName: false, legalBusinessName: "", replaceRegistrationNumber: false, businessRegistrationNumber: "", replacePrivatePhone: false, privatePhone: "", replacePrivateAddress: false, privateAddressLine1: "", privateAddressLine2: "", privateCity: "", privateProvince: "ON", privatePostalCode: "", privateCountry: "CA" };
}
function mutationPayload(form: BusinessDraft, revision: number) {
  const result: Record<string, unknown> = { revision, tradingName: form.tradingName, countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: form.publicContactEmail, supportEmail: form.supportEmail, publicPhone: form.publicPhone, websiteUrl: form.websiteUrl, publicAddress: addressValue(form, "public") };
  if (form.replaceLegalName) result.legalBusinessName = form.legalBusinessName;
  if (form.replaceRegistrationNumber) result.businessRegistrationNumber = form.businessRegistrationNumber;
  if (form.replacePrivatePhone) result.privatePhone = form.privatePhone;
  if (form.replacePrivateAddress) result.privateAddress = addressValue(form, "private");
  return result;
}
function addressValue(form: BusinessDraft, kind: "public" | "private") { return kind === "public" ? { line1: form.publicAddressLine1, line2: form.publicAddressLine2, city: form.publicCity, province: form.publicProvince, postalCode: form.publicPostalCode, country: form.publicCountry } : { line1: form.privateAddressLine1, line2: form.privateAddressLine2, city: form.privateCity, province: form.privateProvince, postalCode: form.privatePostalCode, country: form.privateCountry }; }
function validateDraft(form: BusinessDraft) {
  const errors: Record<string, string> = {}; const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; const phone = /^\+?[0-9][0-9 ()\-.]{5,38}$/; const postal = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTVWXYZ][ -]?\d[ABCEGHJ-NPRSTVWXYZ]\d$/i;
  if (!form.tradingName.trim()) errors.tradingName = "Trading / store name is required.";
  if (form.publicContactEmail && !email.test(form.publicContactEmail)) errors.publicContactEmail = "Enter a valid public contact email.";
  if (form.supportEmail && !email.test(form.supportEmail)) errors.supportEmail = "Enter a valid customer support email.";
  if (form.publicPhone && !phone.test(form.publicPhone)) errors.publicPhone = "Enter a valid business phone number.";
  if (form.websiteUrl && !/^https:\/\//i.test(form.websiteUrl)) errors.websiteUrl = "Use a valid HTTPS website URL.";
  validateAddressFields(form, "public", errors, postal);
  if (form.replaceLegalName && !form.legalBusinessName.trim()) errors.legalBusinessName = "Enter the replacement legal registered name.";
  if (form.replaceRegistrationNumber && !form.businessRegistrationNumber.trim()) errors.businessRegistrationNumber = "Enter the replacement business / corporation number.";
  if (form.replacePrivatePhone && !phone.test(form.privatePhone)) errors.privatePhone = "Enter the replacement private business phone.";
  if (form.replacePrivateAddress) validateAddressFields(form, "private", errors, postal, true);
  return errors;
}
function validateAddressFields(form: BusinessDraft, kind: "public" | "private", errors: Record<string, string>, postalPattern: RegExp, required = false) {
  const a = addressValue(form, kind); const prefix = kind === "public" ? "public" : "private"; const any = Object.values(a).some((value) => String(value).trim()); if (!any && !required) return;
  const fieldNames = { line1: `${prefix}AddressLine1`, city: `${prefix}City`, province: `${prefix}Province`, postalCode: `${prefix}PostalCode`, country: `${prefix}Country` };
  for (const [key, field] of Object.entries(fieldNames)) if (!String(a[key as keyof typeof a]).trim()) errors[field] = "Required when an address is configured.";
  if (a.country.toUpperCase() === "CA" && a.postalCode && !postalPattern.test(a.postalCode)) errors[`${prefix}PostalCode`] = "Use a Canadian postal format such as M5V 1A1.";
  if (a.country && !/^[A-Z]{2}$/i.test(a.country)) errors[`${prefix}Country`] = "Use a two-letter country code.";
  if (a.province && !/^[A-Z]{2,3}$/i.test(a.province)) errors[`${prefix}Province`] = "Use a two- or three-letter region code.";
}
function errorField(reason: unknown) { if (!(reason instanceof AuthClientError)) return null; return ({ trading_name_required: "tradingName", trading_name_invalid: "tradingName", public_contact_email_invalid: "publicContactEmail", support_email_invalid: "supportEmail", website_url_invalid: "websiteUrl", public_phone_invalid: "publicPhone", private_phone_invalid: "privatePhone", public_address_invalid: "publicAddressLine1", public_address_incomplete: "publicAddressLine1", public_address_postal_invalid: "publicPostalCode", private_address_invalid: "privateAddressLine1", private_address_incomplete: "privateAddressLine1", private_address_postal_invalid: "privatePostalCode", private_value_invalid: "legalBusinessName" } as Record<string, string>)[reason.code] || null; }
function dependencyState(payload: BusinessPayload, key: string): BusinessReadinessState { const value = payload.readiness.dependencies[key]; return typeof value === "object" && value && "ready" in value ? value.ready ? "complete" : value.details.sendEnabled === false || value.details.enabled === false ? "disabled" : "action_required" : "not_configured"; }
function addressConfigured(address: PublicAddress) { return Boolean(address.line1 && address.city && address.province && address.postalCode && address.country); }
function stateLabel(state: BusinessReadinessState) { return ({ complete: "Complete", partial: "Partial", action_required: "Action required", incomplete: "Action required", not_configured: "Not configured", not_required: "Not required", unverified: "Unverified", disabled: "Disabled" } as const)[state]; }
function formatDate(value: string | null) { const timestamp = Date.parse(String(value || "")); return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Not yet updated"; }
function errorMessage(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
