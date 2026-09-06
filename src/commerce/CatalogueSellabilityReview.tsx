import { useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { applyCommerceCatalogueSellability, previewCommerceCatalogueSellability, type CatalogueRepairScope, type CatalogueRepairReview } from "./client";

const labels = { enable: "Eligible variants to enable", disable: "Unsafe flags to disable", correct: "Already correct", unpublished: "Intentionally unpublished", blockers: "Unresolved data blockers" };
export function CatalogueSellabilityReview({ scope = { kind: "all_current" }, label = "Review and fix catalogue", disabled = false, onApplied }: { scope?: CatalogueRepairScope; label?: string; disabled?: boolean; onApplied?: () => void | Promise<void> }) {
  const { csrfToken, hasCapability } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const [review, setReview] = useState<CatalogueRepairReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = async (page = 1, group: keyof typeof labels = "enable") => {
    if (!csrfToken) return;
    setBusy(true); setError("");
    try { setReview(await previewCommerceCatalogueSellability(csrfToken, scope, page, group)); }
    catch (e) { setReview(null); setError(e instanceof Error ? e.message : "Catalogue review unavailable."); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!csrfToken || !review) return;
    setBusy(true); setError("");
    try {
      const result = await applyCommerceCatalogueSellability(csrfToken, review);
      setMessage(`Catalogue fixes applied: ${result.enabled} enabled; ${result.disabled} disabled. Publication choices preserved.`);
      setReview(null); dialog.current?.close(); await onApplied?.();
    } catch (e) { setReview(null); setError(e instanceof Error ? e.message : "Apply failed. Refresh the review."); }
    finally { setBusy(false); }
  };
  return <div className="catalogue-repair-control">
    <button type="button" className="secondary-button" disabled={disabled || busy || !csrfToken || !hasCapability("commerce.operations.manage")} onClick={() => { setReview(null); dialog.current?.showModal(); void load(); }}>{label}</button>
    {message && <p role="status">{message}</p>}
    <dialog ref={dialog} className="store-launch-dialog catalogue-repair-dialog" aria-label="Review catalogue fixes" onCancel={e => { if (busy) e.preventDefault(); }}>
      <h2>Review catalogue fixes</h2>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Reading or applying stored catalogue state…</p>}
      {review && <>
        <p>{review.counts.currentProducts} current products · {review.counts.currentVariants} current variants. {review.selectedProducts} products in the enablement scope ({review.scope.kind.replaceAll("_", " ")}).</p>
        <p><strong>{review.enable} to enable; {review.disable} to disable.</strong> Disabling unsafe flags covers the entire catalogue, including archived records: {review.disableOutsideScope} outside the enablement scope.</p>
        <p>{review.counts.eligibleSellableVariants} of {review.counts.eligibleVariants} eligible published variants already sellable; {review.counts.excludedUnavailableVariants} excluded variants correctly unavailable.</p>
        <p>{review.counts.intentionallyUnpublishedProducts} unpublished products; {review.counts.intentionallyUnpublishedVariants} unpublished variants. {review.counts.dataBlockedVariants} variants have data blockers.</p>
        {!review.counts.eligibleVariants && <p role="status">No eligible published variants. Review the data blockers or explicitly publish intended valid products.</p>}
        <p>Only sellability flags needing correction change. Prices, imagery, Featured preferences, publication choices and store activation settings remain unchanged.</p>
        <p>Publication is separate: in <a href="/products">Products → Bulk edit</a>, select intended products and choose “Publish with eligible variants”. Data blockers require correction in the product editor.</p>
        <label>Diagnostics group<select value={review.diagnostics.group} disabled={busy} onChange={e => void load(1, e.target.value as keyof typeof labels)}>{Object.entries(labels).map(([key, text]) => <option key={key} value={key}>{text} ({review.groups[key as keyof typeof labels]})</option>)}</select></label>
        <ul className="catalogue-repair-records">{review.diagnostics.rows.map(row => <li key={`${row.productId}:${row.variantId}`}><a href={row.href}>{row.label}</a><small>Product: {row.productId}{row.variantId ? ` · Variant: ${row.variantId}` : ""}</small><small>{row.reasons.join(", ")}</small></li>)}</ul>
        <p>{review.diagnostics.total} records · page {review.diagnostics.page} of {Math.max(1, Math.ceil(review.diagnostics.total / 20))}</p>
        <div className="commerce-form__actions"><button type="button" disabled={busy || review.diagnostics.page === 1} onClick={() => void load(review.diagnostics.page - 1, review.diagnostics.group)}>Previous</button><button type="button" disabled={busy || review.diagnostics.page * 20 >= review.diagnostics.total} onClick={() => void load(review.diagnostics.page + 1, review.diagnostics.group)}>Next</button></div>
      </>}
      <div className="commerce-form__actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void load()}>Refresh review</button><button type="button" className="primary-button" disabled={busy || !review || (!review.enable && !review.disable)} onClick={() => void apply()}>Apply catalogue fixes</button></div>
    </dialog>
  </div>;
}
