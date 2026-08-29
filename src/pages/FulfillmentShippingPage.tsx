import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { AdminIcon } from "../components/AdminIcon";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { getFulfillmentShipping, type FulfillmentGate, type FulfillmentShippingPayload, type FulfillmentStatusProjection } from "../commerce/client";
import "../styles/fulfillment-shipping.css";

const READINESS_LABELS: Array<[keyof FulfillmentShippingPayload["readiness"], string]> = [
  ["provider", "Provider"], ["catalogue", "Catalogue"], ["customerShippingData", "Customer shipping data"],
  ["paymentAuthority", "Payment authority"], ["printfulOrderMode", "Printful order mode"], ["fulfillment", "Fulfillment"],
  ["tracking", "Tracking"], ["production", "Production"],
];

export function FulfillmentShippingPage() {
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<FulfillmentShippingPayload | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const stop = startLoading("Loading fulfillment and shipping authority"); setError("");
    try { setPayload(await getFulfillmentShipping()); }
    catch (reason) { setError(errorMessage(reason, "Fulfillment and shipping authority is restricted or unavailable.")); }
    finally { stop(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);

  return <main className="fulfillment-workspace">
    <header className="fulfillment-heading">
      <div><p className="eyebrow">Commerce operations control plane</p><h1>Fulfillment &amp; Shipping</h1><p>Local readiness, Printful mapping, delivery dependencies, draft preparation, and production locks. This workspace cannot submit, fulfill, poll, or activate anything.</p></div>
      <span className="fulfillment-lock"><AdminIcon name="shield" size={16} /> Read only / locked</span>
    </header>
    {error && <div className="admin-alert" role="alert">{error}</div>}
    {!payload && !error && <div className="commerce-state" role="status">Loading authoritative fulfillment state…</div>}
    {payload && <>
      <section className="fulfillment-hero" aria-labelledby="fulfillment-readiness-title">
        <div className="fulfillment-hero__intro">
          <p className="eyebrow">Server-derived readiness</p><h2 id="fulfillment-readiness-title">Production remains blocked</h2>
          <p>Provider submission is unavailable. A real customer order cannot be fulfilled until customer delivery capture, a shipping-rate strategy, eligible sellable mappings, and the canonical activation gates are complete.</p>
          <div className="fulfillment-hero__answers"><Answer label="Create a provider order?" value="Controlled TEST draft only" /><Answer label="Fulfill a customer order?" value="No — confirmation unavailable" /><Answer label="Provider evidence" value={payload.operations.counts.total ? `${payload.operations.counts.total} normalized provider order(s)` : "No provider orders recorded"} /></div>
        </div>
        <div className="fulfillment-readiness-grid">
          {READINESS_LABELS.map(([key, label]) => <Readiness key={key} label={label} value={payload.readiness[key]} />)}
        </div>
      </section>

      <section className="fulfillment-section fulfillment-two-up" aria-label="Provider and shipping state">
        <Panel eyebrow="Provider boundary" title="Printful provider" state={payload.provider.configured ? "configured" : "incomplete"}>
          <dl className="fulfillment-facts">
            <Fact term="Provider" value={payload.provider.name} /><Fact term="Connection state" value={humanize(payload.provider.state)} />
            <Fact term="Target store" value={payload.provider.targetStoreConfigured ? "Configured" : "Incomplete"} /><Fact term="Store type" value={payload.provider.storeType || "Not recorded"} />
            <Fact term="Server token" value={payload.provider.credentialConfigured ? "Configured / never projected" : "Not configured"} /><Fact term="Scope evidence" value={payload.provider.scopes.evidenceRecorded ? "Persisted prior evidence" : "Not recorded"} />
            <Fact term="Order mode" value={humanize(payload.provider.orderMode)} /><Fact term="Fulfillment gate" value={payload.provider.fulfillmentEnabled ? "Enabled" : "Disabled"} />
            <Fact term="Local provider orders" value={String(payload.provider.localProviderOrderCount)} /><Fact term="Last provider-order evidence" value={formatTimestamp(payload.provider.lastProviderOrderAt)} />
          </dl>
          <p className="fulfillment-boundary"><AdminIcon name="shield" size={15} /> Page reads never call Printful. No credential, header, encrypted envelope, or raw provider response reaches the browser.</p>
        </Panel>
        <Panel eyebrow="Delivery dependency" title="Shipping data & rates" state="blocked">
          <div className="fulfillment-capability-list">
            <Capability title="Encrypted customer delivery snapshots" state={payload.shipping.customerData.state} detail={payload.shipping.customerData.persistedFields.length ? "Schema capability is implemented; order-specific PII is never projected here." : "No normalized recipient snapshot authority exists."} />
            <Capability title="Shipping-rate strategy" state={payload.shipping.rates.state} detail={payload.shipping.rates.strategy === "unconfigured" ? "The quote adapter is implemented, but the canonical strategy remains unconfigured and fail-closed." : `Configured strategy: ${humanize(payload.shipping.rates.strategy)}.`} />
            <Capability title="Printful quote adapter" state={payload.shipping.rates.providerQuotePathImplemented ? "available" : "not_implemented"} detail="Implemented with server-only provider identity. No quote request is made on page load or from this workspace, and no real provider quote is evidenced." />
            <Capability title="Tracking & shipment records" state={payload.tracking.state} detail={payload.tracking.persistedFields.length ? `${payload.tracking.persistedFields.length} normalized fields detected.` : "No tracking number, carrier, URL, shipment ID, shipped timestamp, or delivered timestamp is persisted."} />
          </div>
        </Panel>
      </section>

      <section className="fulfillment-section" aria-labelledby="lifecycle-capabilities-title">
        <SectionHeading eyebrow="Normalized local authority" title="Lifecycle capabilities" id="lifecycle-capabilities-title" text="Local order, provider order, shipment, and tracking evidence are separate D1 authorities. Code capability is not provider verification." />
        <div className="fulfillment-capability-grid">
          <Capability title="Lifecycle schema" state={payload.lifecycle.schema.state} detail={`Authority migration: ${payload.lifecycle.schema.migration}.`} />
          <Capability title="Printful order model" state={payload.lifecycle.providerOrderModel.state} detail="Normalized provider state is stored separately from payment and legacy order fields." />
          <Capability title="Draft recording" state={payload.lifecycle.draftRecording.state} detail="The controlled confirm=false response reconciles idempotently by local external ID and provider order ID." />
          <Capability title="Webhook receiver" state={payload.lifecycle.webhookReceiver.state} detail="Signed V2 beta HMAC receiver is deployed fail-closed; it never relies on an Admin session." />
          <Capability title="Webhook verification configuration" state={payload.lifecycle.webhookVerification.state} detail="Verification keys are server-only and are not configured or provider-verified in this deployment." />
          <Capability title="Provider webhook subscription" state={payload.lifecycle.providerSubscription.state} detail="No Printful webhook configuration was created, queried, changed, or simulated in this milestone." />
          <Capability title="Shipment normalization" state={payload.lifecycle.shipmentNormalization.state} detail="Packages, split item coverage, reshipments, returned packages, and delivered evidence remain distinct." />
          <Capability title="Tracking storage" state={payload.lifecycle.trackingStorage.state} detail="Tracking references and URLs are encrypted; list projections expose availability only." />
          <Capability title="Carrier delivery polling" state={payload.lifecycle.carrierDeliveryPolling.state} detail="No carrier polling or automatic Printful reconciliation loop exists." />
        </div>
      </section>

      <section className="fulfillment-section" aria-labelledby="provider-orders-title">
        <SectionHeading eyebrow="Commerce D1 operations" title="Provider orders" id="provider-orders-title" text="Bounded normalized rows only. TEST evidence is visually distinct and never inflates LIVE shipment metrics." action={<Link className="fulfillment-link" to="/orders">Open Orders <AdminIcon name="arrow" size={14} /></Link>} />
        <div className="fulfillment-metrics">
          <Metric label="TEST provider orders" value={payload.operations.counts.testOrders} /><Metric label="LIVE provider orders" value={payload.operations.counts.liveOrders} />
          <Metric label="TEST shipments" value={payload.operations.counts.testShipments} /><Metric label="LIVE shipments" value={payload.operations.counts.liveShipments} />
          <Metric label="LIVE partial" value={payload.operations.counts.livePartial} tone="warn" /><Metric label="LIVE shipped" value={payload.operations.counts.liveShipped} tone="good" />
        </div>
        {payload.operations.rows.length ? <div className="fulfillment-provider-orders" role="list">{payload.operations.rows.map((row) => <article key={row.id} role="listitem" className={`is-${row.environment}`}>
          <header><span className={`order-environment order-environment--${row.environment}`}>{row.environment.toUpperCase()}</span><StatusChip state={row.fulfillmentState} /></header>
          <strong className="fulfillment-provider-orders__id">{row.providerOrderId}</strong>
          <dl className="fulfillment-facts"><Fact term="Local order" value={row.orderId} /><Fact term="Provider" value={humanize(row.provider)} /><Fact term="Confirmation" value={humanize(row.confirmationState)} /><Fact term="Provider lifecycle" value={humanize(row.providerState)} /><Fact term="Provider status" value={humanize(row.providerStatus)} /><Fact term="Shipments" value={String(row.shipmentCount)} /><Fact term="Tracking" value={row.trackingAvailable ? "Available in protected order detail" : "Not available"} /><Fact term="Last evidence" value={formatTimestamp(row.lastProviderEvidenceAt)} /></dl>
          <Link className="fulfillment-link" to="/orders">View order <AdminIcon name="arrow" size={14} /></Link>
        </article>)}</div> : <div className="fulfillment-empty"><AdminIcon name="fulfillment" size={24} /><div><strong>No provider orders</strong><p>The lifecycle is implemented, but the unfinished controlled acceptance has not created a Printful draft. There are zero normalized shipments and tracking records.</p></div></div>}
      </section>

      <section className="fulfillment-section" aria-labelledby="pipeline-title">
        <SectionHeading eyebrow="Separated authorities" title="Order fulfillment pipeline" id="pipeline-title" text="A signed Stripe webhook owns payment confirmation. Local Commerce D1 and a future Printful workflow would own fulfillment; a success redirect never does." />
        <ol className="fulfillment-pipeline">
          {payload.pipeline.map((stage, index) => <li key={stage.id} className={stage.implemented ? "is-implemented" : "is-missing"}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{stage.label}</strong><small>{stage.implemented ? "Implemented authority" : "Not implemented"}</small><p>{stage.detail}</p><dl><Fact term="Persisted authority" value={stage.authority} /><Fact term="Transition" value={stage.transition} /></dl></div></li>)}
        </ol>
      </section>

      <section className="fulfillment-section" aria-labelledby="mapping-title">
        <SectionHeading eyebrow="Provider eligibility" title="Product & variant mapping health" id="mapping-title" text={`Provider-ready means exactly: ${payload.mapping.contract}. Sellability and active storefront state remain separate requirements.`} action={<Link className="fulfillment-link" to="/products">Manage Products <AdminIcon name="arrow" size={14} /></Link>} />
        <div className="fulfillment-metrics">
          <Metric label="Storefront products" value={payload.mapping.storefrontProducts} /><Metric label="Storefront variants" value={payload.mapping.storefrontVariants} />
          <Metric label="Mapped products" value={payload.mapping.mappedProviderProducts} /><Metric label="Mapped variants" value={payload.mapping.mappedProviderVariants} />
          <Metric label="Unmapped variants" value={payload.mapping.unmappedVariants} tone="warn" /><Metric label="Blocked products" value={payload.mapping.blockedProducts} tone="bad" />
          <Metric label="Deferred variants" value={payload.mapping.deferredVariants} tone="warn" /><Metric label="Non-sellable variants" value={payload.mapping.nonSellableVariants} tone="muted" />
          <Metric label="Potentially fulfillable" value={payload.mapping.potentiallyFulfillableVariants} tone={payload.mapping.potentiallyFulfillableVariants ? "good" : "bad"} />
        </div>
        <div className="fulfillment-migration-note"><div><p className="eyebrow">Separate catalogue workflow</p><strong>{humanize(payload.migration.status)} · {humanize(payload.migration.phase)}</strong><p>{payload.migration.verifiedProducts} verified products, {payload.migration.mappedVariants} mapped variants, {payload.migration.blockedProducts} blocked products, and {payload.migration.deferredVariants} deferred variants. This page cannot resume, retry, or change that checkpoint.</p></div><span>{payload.migration.manuallyPaused ? "Manually paused" : "Read-only evidence"}</span></div>
      </section>

      <section className="fulfillment-section fulfillment-draft" aria-labelledby="draft-title">
        <SectionHeading eyebrow="Pure server preparation" title="Draft order preview" id="draft-title" text="The server selected the preview item from authoritative D1 mappings. The recipient is deterministic synthetic sample data; no browser-provided provider ID is accepted." />
        <div className="fulfillment-draft__labels">{payload.draftPreview.labels.map((label) => <span key={label}>{label}</span>)}</div>
        <div className="fulfillment-draft__grid">
          <article>
            <dl className="fulfillment-facts"><Fact term="Reference" value={payload.draftPreview.reference} /><Fact term="Environment" value={payload.draftPreview.environment.toUpperCase()} /><Fact term="Product" value={payload.draftPreview.item?.product || "No mapped candidate"} /><Fact term="Variant" value={payload.draftPreview.item?.variant || "Unavailable"} /><Fact term="Mapped provider variant" value={payload.draftPreview.item?.mappedProviderVariant || "Unavailable"} /><Fact term="Quantity" value={String(payload.draftPreview.item?.quantity ?? "Unavailable")} /><Fact term="Recipient" value={payload.draftPreview.requirements.recipient.complete ? "Synthetic sample / structurally complete" : "Missing required fields"} /><Fact term="Shipping" value={payload.draftPreview.requirements.shipping.configured ? humanize(payload.draftPreview.requirements.shipping.strategy) : "Not configured"} /></dl>
            <button type="button" disabled aria-describedby="provider-submit-reason">Submit to Printful — unavailable</button><p id="provider-submit-reason">This workspace exposes no provider-write control. The separate Master-only acceptance path can create one TEST draft, but confirmation and fulfillment remain unavailable.</p>
          </article>
          <article className="fulfillment-draft__preview"><header><div><span>Safe high-level preview</span><strong>{payload.draftPreview.eligible ? "Structurally eligible" : `${payload.draftPreview.blockers.length} blocker${payload.draftPreview.blockers.length === 1 ? "" : "s"}`}</strong></div><StatusChip state={payload.draftPreview.eligible ? "ready" : "blocked"} /></header>
            {payload.draftPreview.blockers.length ? <ul>{payload.draftPreview.blockers.map((blocker) => <li key={blocker.code}><code>{blocker.code}</code><span>{blocker.message}</span></li>)}</ul> : <p>No structural blocker was found in this synthetic fixture; submission authority is still absent.</p>}
            <pre aria-label="Safe Printful draft payload preview">{JSON.stringify(payload.draftPreview.safePayloadPreview, null, 2)}</pre>
          </article>
        </div>
      </section>

      <section className="fulfillment-section fulfillment-two-up" aria-label="Production gates and dependencies">
        <Panel eyebrow="Canonical locks" title="Production gates" state="blocked"><div className="fulfillment-gates">{payload.gates.map((gate) => <Gate key={gate.id} gate={gate} />)}</div></Panel>
        <Panel eyebrow="Adjacent owners" title="Dependencies" state="incomplete">
          <nav className="fulfillment-dependencies" aria-label="Fulfillment dependencies">
            <Dependency to={payload.dependencies.business.href} title="Business Information" text="Merchant identity and address readiness only; no shipping-origin assumption." />
            <Dependency to={payload.dependencies.taxDocuments.href} title="Tax & Documents" text="Receipt/invoice readiness; no document is created here." />
            <Dependency to={payload.dependencies.customerEmails.href} title="Customer Emails" text={`Shipment notification: ${humanize(payload.dependencies.customerEmails.shipmentTemplate.state)}. No sends.`} />
            <Dependency to={payload.dependencies.payments.href} title="Payments & Payouts" text="Signed webhook evidence and live-payment locks." />
            <Dependency to={payload.dependencies.orders.href} title="Orders" text="Order-specific state and any future customer PII belong here." />
          </nav>
        </Panel>
      </section>

      <section className="fulfillment-section" aria-labelledby="evidence-title">
        <SectionHeading eyebrow="Local persisted authority only" title="Recent fulfillment evidence" id="evidence-title" text="TEST and LIVE evidence remain distinct. TEST rows never contribute to production fulfillment claims." />
        <div className="fulfillment-metrics"><Metric label="TEST delivery snapshots" value={payload.evidence.counts.testShippingSnapshots} /><Metric label="LIVE delivery snapshots" value={payload.evidence.counts.liveShippingSnapshots} /><Metric label="Provider orders" value={payload.evidence.counts.providerOrders} tone="muted" /></div>
        {payload.evidence.recent.length ? <div className="fulfillment-evidence" role="list">{payload.evidence.recent.map((item) => <article key={item.id} role="listitem" className={`is-${item.environment}`}><span className={`order-environment order-environment--${item.environment}`}>{item.environment.toUpperCase()}</span><div><strong>{item.id}</strong><small>{formatTimestamp(item.updatedAt)}</small></div><div><span>Payment</span><strong>{humanize(item.paymentStatus)}</strong></div><div><span>Provider order</span><strong>{item.providerOrderStatus ? `${humanize(item.providerOrderStatus)} / ${humanize(item.providerConfirmationStatus || "unconfirmed")}` : "Not recorded"}</strong></div><div><span>Fulfillment</span><strong>{humanize(item.fulfillmentStatus)}</strong></div><Link to="/orders">View order <AdminIcon name="arrow" size={13} /></Link></article>)}</div> : <div className="fulfillment-empty"><AdminIcon name="fulfillment" size={24} /><div><strong>No fulfillment evidence</strong><p>No Printful drafts, shipments, or tracking evidence have been recorded.</p></div></div>}
      </section>

      <details className="fulfillment-advanced"><summary>Advanced / technical</summary><div><dl className="fulfillment-facts"><Fact term="Authority" value={payload.authority} /><Fact term="Draft builder" value={payload.technical.builderVersion} /><Fact term="Printful order mode" value={payload.safety.orderMode} /><Fact term="Checkout" value={payload.safety.checkoutEnabled ? "Enabled" : "Disabled"} /><Fact term="Live payment capture" value={payload.safety.livePaymentCaptureEnabled ? "Enabled" : "Disabled"} /><Fact term="Fulfillment" value={payload.safety.fulfillmentEnabled ? "Enabled" : "Disabled"} /><Fact term="Shipping data capability" value={humanize(payload.technical.shippingDataCapability)} /><Fact term="Shipping rate capability" value={humanize(payload.technical.shippingRateCapability)} /><Fact term="Tracking capability" value={humanize(payload.technical.trackingCapability)} /><Fact term="Provider calls on read / preview" value={`${payload.technical.providerCallsOnRead} / ${payload.technical.providerCallsOnPreview}`} /><Fact term="Preview persistence" value={String(payload.technical.previewPersists)} /><Fact term="Checked" value={formatTimestamp(payload.checkedAt)} /></dl></div></details>
    </>}
  </main>;
}

function Readiness({ label, value }: { label: string; value: FulfillmentStatusProjection }) { return <article><div><span>{label}</span><StatusChip state={value.state} /></div><strong>{humanize(value.state)}</strong><p>{value.detail}</p></article>; }
function StatusChip({ state }: { state: string }) { return <span className={`fulfillment-chip is-${tone(state)}`}>{humanize(state)}</span>; }
function Answer({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Panel({ eyebrow, title, state, children }: { eyebrow: string; title: string; state: string; children: ReactNode }) { return <article className="fulfillment-panel"><header><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><StatusChip state={state} /></header>{children}</article>; }
function Fact({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function Capability({ title, state, detail }: { title: string; state: string; detail: string }) { return <article><div><strong>{title}</strong><StatusChip state={state} /></div><p>{detail}</p></article>; }
function SectionHeading({ eyebrow, title, id, text, action }: { eyebrow: string; title: string; id: string; text: string; action?: ReactNode }) { return <header className="fulfillment-section-heading"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2><p>{text}</p></div>{action}</header>; }
function Metric({ label, value, tone: valueTone = "" }: { label: string; value: number; tone?: string }) { return <article className={valueTone ? `is-${valueTone}` : ""}><span>{label}</span><strong>{value.toLocaleString()}</strong></article>; }
function Gate({ gate }: { gate: FulfillmentGate }) { const content = <><div><strong>{gate.label}</strong><p>{gate.detail}</p></div><StatusChip state={gate.state} /></>; return gate.href ? <Link to={gate.href}>{content}</Link> : <article>{content}</article>; }
function Dependency({ to, title, text }: { to: string; title: string; text: string }) { return <Link to={to}><div><strong>{title}</strong><p>{text}</p></div><AdminIcon name="arrow" size={15} /></Link>; }
function tone(state: string) { if (["ready", "configured", "available", "enabled"].includes(state)) return "good"; if (["partial", "incomplete", "unverified", "no_evidence", "implemented_no_evidence", "implemented_disabled", "test_evidence_only", "draft_only"].includes(state)) return "warn"; if (["blocked", "not_implemented", "not_configured", "disabled", "production_disabled", "live"].includes(state)) return "bad"; return "neutral"; }
function humanize(value: string) { return String(value || "Not recorded").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatTimestamp(value: string | null) { if (!value) return "No evidence"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }); }
function errorMessage(reason: unknown, fallback: string) { return reason instanceof Error && reason.message ? reason.message : fallback; }
