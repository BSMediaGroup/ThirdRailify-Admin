import { useState } from "react";
import { applyProductRepair, previewProductRepair, type ProductRepairPreview } from "./client";

export function CurrentProductRepair({ productIds, csrfToken, disabled, onApplied }: { productIds: string[]; csrfToken: string | null; disabled: boolean; onApplied: () => void }) {
  const [preview, setPreview] = useState<ProductRepairPreview | null>(null);
  const [thumbnailIds, setThumbnailIds] = useState<string[]>([]), [restore, setRestore] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirmation, setConfirmation] = useState("");
  const read = async (kind: "media" | "publication", restoreOverride = false, approveThumbnails = false) => {
    if (!csrfToken) return; setBusy(true); setError(""); setPreview(null); setConfirmation("");
    setRestore(restoreOverride);
    if (!approveThumbnails) setThumbnailIds([]);
    try { setPreview(await previewProductRepair(csrfToken, kind, productIds, restoreOverride, approveThumbnails ? thumbnailIds : [])); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Preview failed."); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!csrfToken || !preview) return; setBusy(true); setError("");
    try { await applyProductRepair(csrfToken, preview.runId, confirmation); setPreview(null); setConfirmation(""); onApplied(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Apply failed. Run Preview again."); }
    finally { setBusy(false); }
  };
  return <section className="commerce-section" aria-label="Current product repair">
    <div className="commerce-section-heading-actions"><button type="button" disabled={disabled || busy || !csrfToken} onClick={() => void read("media")}>Refresh Printful mockups</button><button type="button" disabled={disabled || busy || !csrfToken} onClick={() => void read("publication")}>Publish product with eligible variants</button></div>
    <p>Preview the selected products before applying. Mockup refresh preserves prices and publication. Publishing enables the eligible variants you review; checkout settings remain separate.</p>
    {busy && <p role="status">Reading and validating the current store…</p>}{error && <p role="alert">{error}</p>}
    {preview && <div><h3>{preview.kind === "media" ? "Mockup refresh Preview" : "Publication Preview"}</h3>
      {preview.products.map((product) => <article key={product.id}><strong>{product.title}</strong>{preview.kind === "media" ? <><p>{product.beforeImages.length} saved images; {product.selectedImages.length} selected; {product.preservedImages.length} references preserved. Coverage: {product.completeness.replaceAll("_", " ")}.</p><div className="commerce-section-heading-actions">{product.selectedImages.map((url) => <img key={url} src={url} alt={`${product.title} selected mockup`} width="80" height="100" style={{ objectFit: "contain" }} />)}</div><details><summary>Saved references before refresh</summary>{product.beforeImages.map((url) => <p key={url} style={{ overflowWrap: "anywhere" }}>{url}</p>)}</details></> : <><p>{product.diagnostic.variants.filter((v) => v.eligible).length} eligible variants will be enabled.</p><details><summary>Variant decisions and exclusions</summary><ul>{product.diagnostic.variants.map((v) => <li key={v.id}>{v.id}: {v.eligible ? "Enable for publication" : v.reasons.join(", ")}{v.localReasons.length ? ` (currently ${v.localReasons.join(", ")})` : ""}</li>)}</ul></details></>}</article>)}
      {preview.blockers.map((blocker) => <p key={blocker.id} role="status">{blocker.id}: {blocker.reasons.join(", ")}</p>)}
      {preview.kind === "media" && preview.products.some((p) => p.thumbnailReviewRequired) && <fieldset><legend>Review separate product thumbnails</legend><p>These thumbnails are not linked to a preview file and may show a blank view. Include one only after checking its artwork. A selected primary stays locked while provider gallery entries refresh.</p>{preview.products.filter((p) => p.thumbnailReviewRequired && p.thumbnailCandidate).map((p) => <label key={p.id} style={{ display: "block" }}><img src={p.thumbnailCandidate!} alt={`${p.title} unverified product thumbnail`} width="80" height="100" style={{ objectFit: "contain" }} /><input type="checkbox" aria-label={`Keep reviewed thumbnail as primary: ${p.title}`} checked={thumbnailIds.includes(p.id)} onChange={(event) => setThumbnailIds((ids) => event.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id))} />Keep reviewed thumbnail as primary: {p.title}</label>)}<button type="button" disabled={busy || !thumbnailIds.length} onClick={() => void read("media", restore, true)}>Update Preview with reviewed thumbnails</button></fieldset>}
      {preview.kind === "media" && preview.blockers.some((b) => b.reasons.includes("legacy_override_intent_unknown_choose_restore_or_preserve")) && <><p>Historical override intent cannot be established. Leave it unchanged, or explicitly preview replacing it with Printful images.</p><button type="button" disabled={busy} onClick={() => void read("media", true)}>Use Printful images instead of this override</button></>}
      <label>Type {preview.confirmationText}<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} /></label>
      <div><button type="button" disabled={busy || Boolean(preview.blockers.length) || JSON.stringify(thumbnailIds) !== JSON.stringify(preview.approvedThumbnailIds || []) || confirmation !== preview.confirmationText} onClick={() => void apply()}>Apply reviewed {preview.kind === "media" ? "mockups" : "publication"}</button><button type="button" disabled={busy} onClick={() => setPreview(null)}>Cancel Preview</button></div>
    </div>}
  </section>;
}
