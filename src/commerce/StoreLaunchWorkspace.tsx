import { CatalogueSellabilityReview } from "./CatalogueSellabilityReview";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { reconcileActiveCommerceStore, activateCommerceLaunch, getCommerceLaunchPlan, pauseCommerceLaunch, revealPrivateBusinessProfile, type CommerceLaunchPlan } from "./client";

export function StoreLaunchWorkspace({ profileDraft, onActivated }: { profileDraft?: Record<string, unknown>; onActivated?: () => void }) {
  const { csrfToken, access } = useAuth();
  const [plan, setPlan] = useState<CommerceLaunchPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [editing, setEditing] = useState(false);
  const [replacement, setReplacement] = useState<{ legalBusinessName: string; privatePhone: string; privateAddress: Record<string,string> } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const load = useCallback(async () => { try { setPlan(await getCommerceLaunchPlan()); setError(""); } catch (e) { setPlan(null); setError(e instanceof Error ? e.message : "Store readiness is unavailable."); } }, []);
  useEffect(() => { void load(); }, [load]);
  const draft = profileDraft || (editing && replacement && plan ? { revision:plan.business.revision,...replacement } : undefined);
  const hardBlockers = plan?.hardGates.filter((gate) => !gate.ready && !(gate.id === "merchant_identity" && draft)) || [];
  const canReview = access.isMasterAdmin && csrfToken && plan && !hardBlockers.length && !busy;
  const reveal = async () => {
    if (!csrfToken || !plan) return;
    setBusy(true); setError("");
    try { const value = await revealPrivateBusinessProfile(csrfToken); if (value.revision !== plan.business.revision) { await load(); throw new Error("Profile changed. Review the latest revision before editing."); } setReplacement({legalBusinessName:value.legalBusinessName,privatePhone:value.privatePhone,privateAddress:value.privateAddress}); setEditing(true); }
    catch (e) { setError(e instanceof Error ? e.message : "The private record could not be revealed."); }
    finally { setBusy(false); }
  };
  const activate = async () => {
    if (!csrfToken || !plan || !confirmed || !authorized) return;
    setBusy(true); setError("");
    try { const next = await activateCommerceLaunch(csrfToken,plan,draft); setPlan(next); setReplacement(null); setEditing(false); dialog.current?.close(); onActivated?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "Activation failed; refresh readiness before retrying."); }
    finally { setBusy(false); }
  };
  const reconcile = async () => {
    if (!csrfToken || !plan) return;
    setBusy(true); setError("");
    try { setPlan(await reconcileActiveCommerceStore(csrfToken, plan)); onActivated?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "Reconciliation failed. Refresh store readiness."); }
    finally { setBusy(false); }
  };
  const pause = async () => {
    if (!csrfToken || !plan) return;
    setBusy(true); setError("");
    try { setPlan(await pauseCommerceLaunch(csrfToken,plan.revision,"Owner emergency store pause.")); }
    catch (e) { setError(e instanceof Error ? e.message : "Emergency pause failed. Reload current store status."); }
    finally { setBusy(false); }
  };
  return <section className="store-launch-workspace commerce-section" aria-labelledby="store-launch-title">
    <p className="eyebrow">Production commerce</p><h2 id="store-launch-title">Store status: {plan?.operationalState === "degraded" ? "DEGRADED / ACTION REQUIRED" : plan?.state === "active" ? "LIVE / ACTIVE" : plan?.settings.emergencyPaused ? "PAUSED" : plan?.ready || (draft && !hardBlockers.length) ? "READY TO ENABLE" : "ACTION REQUIRED"}</h2>
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {!plan ? error ? <button type="button" className="secondary-button" onClick={() => void load()}>Refresh store readiness</button> : <p>Reading canonical store readiness…</p> : <>
      <p>{plan.business.tradingName || "Merchant identity"} · profile revision {plan.business.revision} · {hardBlockers.length} hard blockers</p>
      <dl className="store-launch-summary">
        <div><dt>Merchant facts</dt><dd>{plan.business.ownerConfirmed ? "OPERATOR ATTESTED" : plan.business.legalNameConfigured && plan.business.phoneConfigured && plan.business.addressConfigured ? "CONFIGURED" : "ACTION REQUIRED"} · encrypted phone and address</dd></div>
        <div><dt>Payment provider</dt><dd>PayPal Live · provider verified when ready</dd></div>
        <div><dt>Tax</dt><dd>NOT COLLECTING · OPERATOR ATTESTED</dd></div>
        <div><dt>Shipping & catalogue</dt><dd>Worldwide · {plan.settings.shippingStrategy === "merchant_weight_bands" ? "Merchant weight-band rates" : plan.settings.shippingStrategy === "printful_dynamic" ? "Printful dynamic rates" : "Shipping strategy requires review"} · {plan.catalogue.eligibleSellableVariants} eligible sellable variants</dd></div>
        <div><dt>Agreement & receipt</dt><dd>{plan.settings.customerDocumentAccessEnabled ? "ACTIVE" : "Enabled with launch"} · transaction-only disclosure</dd></div>
        <div><dt>Order confirmation</dt><dd>{plan.settings.transactionalEmailEnabled ? "ACTIVE" : "Enabled with launch"} · Resend</dd></div>
        <div><dt>Fulfillment operations</dt><dd>{plan.settings.fulfillmentEnabled ? "ACTIVE" : "Enabled with launch"} · draft, validate, confirm</dd></div>
        <div><dt>Delivery lifecycle</dt><dd>{plan.hardGates.find(gate => gate.id === "operations_worker")?.ready && plan.settings.fulfillmentEnabled ? "ACTIVE / AUTHENTICATED RECONCILIATION" : "ACTION REQUIRED / review fulfillment operations"}</dd></div>
        <div><dt>Optional services</dt><dd>Stripe NOT USED / DISABLED · tax invoice NOT APPLICABLE</dd></div>
      </dl>
      {!!hardBlockers.length && <ul className="store-launch-blockers">{hardBlockers.map((gate)=><li key={gate.id}><strong>ACTION REQUIRED: {gate.id.replaceAll("_"," ")}</strong> — {gate.detail} {gate.href && <a href={gate.href}>Resolve requirement</a>}</li>)}</ul>}
      {!!plan.activationDrift?.length && <div className="admin-alert"><p>Active-store settings need reconciliation: {plan.activationDrift.join(", ")}</p><button className="secondary-button" disabled={!access.isMasterAdmin || busy || !plan.ready} onClick={() => void reconcile()}>RECONCILE ACTIVE STORE</button></div>}
      <CatalogueSellabilityReview onApplied={load} disabled={busy} />
      <details><summary>Non-blocking capabilities and readiness details</summary><ul>{plan.advisories.map((gate)=><li key={gate.id}>{gate.ready ? "VERIFIED / READY" : gate.id.startsWith("printful") ? "OPTIONAL / UNVERIFIED" : "POST-LAUNCH OPTIONAL"}: {gate.detail}</li>)}</ul><ul>{plan.hardGates.map((gate)=><li key={gate.id}>{gate.ready ? "READY" : "ACTION REQUIRED"}: {gate.detail}</li>)}</ul></details>
      {!profileDraft && access.isMasterAdmin && plan.state !== "active" && <><button type="button" className="secondary-button" onClick={()=>void reveal()} disabled={busy}>Reveal / edit current private merchant record</button>{editing && replacement && <fieldset className="store-launch-edit"><legend>Private merchant record — held in this form only</legend><label>Legal name<input value={replacement.legalBusinessName} maxLength={240} onChange={(e)=>setReplacement({...replacement,legalBusinessName:e.target.value})}/></label><label>Private business phone<input value={replacement.privatePhone} maxLength={80} onChange={(e)=>setReplacement({...replacement,privatePhone:e.target.value})}/></label>{["line1","line2","city","province","postalCode","country"].map((key)=><label key={key}>Business address: {key}<input value={replacement.privateAddress[key] || ""} maxLength={key.startsWith("line")?180:key==="postalCode"?64:120} onChange={(e)=>setReplacement({...replacement,privateAddress:{...replacement.privateAddress,[key]:e.target.value}})}/></label>)}<button className="secondary-button" type="button" onClick={()=>{setReplacement(null);setEditing(false);}}>Cancel private edits</button></fieldset>}</>}
      {plan.state === "active" && !draft ? <div className="store-launch-active"><p>Activated {plan.activatedAt ? new Date(plan.activatedAt).toLocaleString() : ""} · actor {plan.activatedBy || "recorded in audit"}</p><button className="secondary-button" type="button" disabled={!access.isMasterAdmin || busy} onClick={()=>void pause()}>PAUSE STORE</button></div> : <button className="primary-button store-launch-primary" type="button" disabled={!canReview} onClick={()=>{setConfirmed(false);setAuthorized(false);dialog.current?.showModal();}}>ENABLE STORE</button>}
      {!access.isMasterAdmin && <p>Master Admin must confirm the merchant facts and production activation.</p>}
      <dialog ref={dialog} className="store-launch-dialog" onCancel={(event)=>{if(busy)event.preventDefault();}}>
        <h2>Confirm &amp; enable production store</h2><p>{draft ? "Your current profile edits will be saved, confirmed and activated together." : `Confirm the encrypted merchant record at revision ${plan.business.revision}.`}</p>
        <p>Phone: •••• · Address: encrypted private record</p>
        <p>The phone and address are used only in qualifying transaction disclosure, the retainable agreement and required order confirmation, and protected Admin order evidence. They are not added to general public pages.</p>
        <p>These remain private Admin records. Supplier phone and address are not sent to PayPal or Printful. Withdrawing authorization requires pausing new checkout; historical buyer agreement snapshots remain unchanged.</p>
        <p>PayPal is the store payment provider. Stripe remains disabled. Tax is configured as not collecting. Worldwide shipping rates and availability are confirmed for each destination. Future paid orders can trigger fulfillment and order confirmation. Existing donations remain enabled. Emergency Pause remains available.</p>
        <p>Printful fulfillment begins only after authoritative completed Live capture and follows draft, validate, then confirm.</p>
        <details><summary>Exact production settings changed by ENABLE STORE</summary><dl>{Object.entries(plan.activationSettings || {}).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl><p>The launch state becomes active. The current profile revision is attested and authorized in the same transaction.</p></details>
        <label><input type="checkbox" checked={confirmed} onChange={(event)=>setConfirmed(event.target.checked)}/> I confirm the current merchant facts as the owner.</label>
        <label><input type="checkbox" checked={authorized} onChange={(event)=>setAuthorized(event.target.checked)}/> I authorize transaction-only disclosure and production activation.</label>
        {error && <p role="alert">{error}</p>}
        <div className="commerce-form__actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>dialog.current?.close()}>Cancel</button><button type="button" className="primary-button" disabled={busy || !confirmed || !authorized} onClick={()=>void activate()}>{busy ? "Enabling store…" : "ENABLE STORE"}</button></div>
      </dialog>
    </>}
  </section>;
}
