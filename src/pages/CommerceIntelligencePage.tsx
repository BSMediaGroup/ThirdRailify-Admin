import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { AdminShellOutletContext } from "../components/AdminShell";
import {
  CommerceIntelligenceError,
  getCommerceIntelligence,
  type CommerceIntelligenceRange,
  type CommerceIntelligenceReport,
  type CurrencySummary,
  type FinancialMetric,
} from "../commerce/intelligence-client";

const RANGES: CommerceIntelligenceRange[] = ["24h", "7d", "30d", "90d"];
const EXECUTIVE_METRICS = [
  ["merchandiseSales", "Merchandise sales"], ["donations", "Donations"], ["grossCollected", "Gross collected"],
  ["refundsReversals", "Refunds / reversals"], ["netCollected", "Net collected"], ["knownDirectCosts", "Known direct costs"],
  ["processorFees", "Processor fees"], ["contributionMargin", "Contribution margin"], ["averageOrderValue", "Average order value"],
] as const;

export function CommerceIntelligencePage() {
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [range, setRange] = useState<CommerceIntelligenceRange>("30d");
  const [page, setPage] = useState(1);
  const [report, setReport] = useState<CommerceIntelligenceReport | null>(null);
  const [error, setError] = useState<{ kind: "migration" | "auth" | "query"; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (signal?: AbortSignal) => {
    const stop = startLoading("Loading Commerce Intelligence");
    setLoading(true); setError(null);
    try { setReport(await getCommerceIntelligence(range, page, 20, signal)); }
    catch (reason) { if ((reason as { name?: string })?.name !== "AbortError") { setReport(null); setError(failure(reason)); } }
    finally { setLoading(false); stop(); }
  }, [page, range, startLoading]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  return <div className="intelligence-page">
    <header className="intelligence-hero">
      <div><p className="eyebrow">Commerce / financial reporting</p><h1>Commerce Intelligence</h1><p>LIVE transaction evidence, separated by currency and bounded to authoritative persisted records.</p></div>
      <div className="intelligence-hero__controls">
        <span className="intelligence-live"><i />LIVE ONLY</span>
        <div className="analytics-range" role="group" aria-label="Commerce reporting range">{RANGES.map((key) => <button key={key} type="button" className={range === key ? "is-active" : ""} aria-pressed={range === key} onClick={() => { setPage(1); setRange(key); }}>{key}</button>)}</div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>{loading ? "Refreshingâ€¦" : "Refresh"}</button>
      </div>
    </header>

    {error ? <section className={`intelligence-error is-${error.kind}`} role="alert"><p className="eyebrow">{error.kind === "migration" ? "Operational action required" : error.kind === "auth" ? "Admin access required" : "Read-only reporting unavailable"}</p><h2>{error.kind === "migration" ? "Commerce Intelligence database migration required" : error.kind === "auth" ? "Your Admin session could not be verified" : "Financial report query failed"}</h2><p>{error.message}</p>{error.kind === "query" ? <button type="button" onClick={() => void load()}>Try again</button> : null}</section> : null}
    {loading && !report ? <IntelligenceSkeleton /> : null}
    {report ? <Report report={report} onPage={setPage} /> : null}
  </div>;
}

function Report({ report, onPage }: { report: CommerceIntelligenceReport; onPage: (page: number) => void }) {
  const anyTransactions = report.currencies.some((entry) => entry.counts.transactions > 0);
  return <>
    <section className="intelligence-status" aria-label="Report status">
      <div><span>Selected period</span><strong>{rangeLabel(report.range)}</strong><small>Compared with the preceding equivalent UTC period</small></div>
      <div><span>Freshness</span><strong>{formatDate(report.coverage.latestFinancialUpdateAt)}</strong><small>Generated {formatDate(report.generatedAt)}</small></div>
      <div><span>Currency context</span><strong>{report.coverage.currencies.length ? report.coverage.currencies.join(" / ") : "No LIVE currency"}</strong><small>{report.currencyMode === "multiple" ? "Never aggregated across currencies" : "Original transaction currency"}</small></div>
      <div><span>Data completeness</span><strong>{coverageState(report)}</strong><small>{report.coverage.complete ? "Bounded read complete" : "Known values shown without extrapolation"}</small></div>
    </section>
    {!anyTransactions ? <section className="intelligence-empty"><p className="eyebrow">No activity in range</p><h2>No successfully collected LIVE transactions.</h2><p>Pending, failed, canceled, TEST, and sandbox records are intentionally excluded. No financial activity has been invented.</p></section> : null}
    {report.currencies.map((currency) => <ExecutiveRail key={currency.currencyCode} currency={currency} />)}
    {report.currencies.map((currency) => <MoneyFlow key={`flow-${currency.currencyCode}`} currency={currency} />)}
    <Trend report={report} />
    <ProductPerformance report={report} />
    <OrderEconomics report={report} onPage={onPage} />
    <section className="intelligence-split"><DonationPanel report={report} /><RefundPanel report={report} /></section>
    <CoveragePanel report={report} />
    <section className="intelligence-method"><p className="eyebrow">Reporting basis</p><h2>Definitions travel with the numbers.</h2><div>{Object.entries(report.semantics).map(([key, value]) => <article key={key}><strong>{humanize(key)}</strong><p>{value}</p></article>)}</div><p>“Contribution margin” is limited to fully evidenced direct transaction inputs. It is not a complete business earnings measure.</p></section>
  </>;
}

function ExecutiveRail({ currency }: { currency: CurrencySummary }) {
  return <section className="intelligence-executive" aria-label={`${currency.currencyCode} executive financial rail`}>
    <header><div><p className="eyebrow">Executive financial rail</p><h2>{currency.currencyCode}</h2></div><span>{currency.counts.orders} orders Â· {currency.counts.donations} donations</span></header>
    <div className="intelligence-kpis">{EXECUTIVE_METRICS.map(([key, label]) => <FinancialKpi key={key} label={label} metric={currency.metrics[key]} previous={currency.previous.metrics[key]} delta={currency.deltas[key]} currency={currency.currencyCode} />)}</div>
  </section>;
}

function FinancialKpi({ label, metric, previous, delta, currency }: { label: string; metric: FinancialMetric; previous: FinancialMetric; delta: CurrencySummary["deltas"][string]; currency: string }) {
  return <article className={`intelligence-kpi${metric.complete ? "" : " is-incomplete"}`}><span>{label}</span><strong>{metric.complete ? money(metric.value, currency) : metric.knownValue ? money(metric.knownValue, currency) : "Unknown"}</strong><small>{metric.complete ? "Complete for selected cohort" : metric.knownValue ? "Known subset only" : "Authoritative input unavailable"}</small><div><span>Prior {previous.complete ? money(previous.value, currency) : "incomplete"}</span><b className={delta.direction === "up" ? "is-up" : delta.direction === "down" ? "is-down" : ""}>{deltaLabel(delta)}</b></div></article>;
}

function MoneyFlow({ currency }: { currency: CurrencySummary }) {
  const m = currency.metrics;
  return <section className="money-flow"><header><div><p className="eyebrow">Money flow</p><h2>{currency.currencyCode} collection path</h2></div><span>Unknown inputs remain open circuits</span></header><div className="money-flow__rail">
    <FlowNode label="Customer payments" value={m.grossCollected} currency={currency.currencyCode}><span>Merchandise {metricMoney(m.merchandiseSales, currency.currencyCode)}</span><span>Donations {metricMoney(m.donations, currency.currencyCode)}</span><span>Shipping {metricMoney(m.customerShipping, currency.currencyCode)}</span><span>Tax {metricMoney(m.taxCollected, currency.currencyCode)}</span></FlowNode>
    <i aria-hidden="true">âˆ’</i><FlowNode label="Refunds / reversals" value={m.refundsReversals} currency={currency.currencyCode} />
    <i aria-hidden="true">=</i><FlowNode label="Net collected" value={m.netCollected} currency={currency.currencyCode} accent />
    <i aria-hidden="true">âˆ’</i><FlowNode label="Known direct costs + fees" value={combineKnown(m.knownDirectCosts, m.processorFees)} currency={currency.currencyCode} />
    <i aria-hidden="true">=</i><FlowNode label="Contribution margin" value={m.contributionMargin} currency={currency.currencyCode} accent />
  </div></section>;
}
function FlowNode({ label, value, currency, accent = false, children }: { label: string; value: FinancialMetric; currency: string; accent?: boolean; children?: ReactNode }) { return <article className={accent ? "is-accent" : ""}><span>{label}</span><strong>{metricMoney(value, currency)}</strong>{children ? <small>{children}</small> : <small>{value.complete ? "Authoritative" : "Incomplete evidence"}</small>}</article>; }

function Trend({ report }: { report: CommerceIntelligenceReport }) {
  if (!report.trend.length) return <section className="intelligence-panel"><header><div><p className="eyebrow">Revenue trend</p><h2>No LIVE trend points in range.</h2></div></header></section>;
  return <section className="intelligence-panel intelligence-trends"><header><div><p className="eyebrow">Revenue trend</p><h2>Collected value without interpolation.</h2></div><span>Merchandise Â· Donations Â· Refunds Â· Net</span></header>{[...new Set(report.trend.map((row) => row.currencyCode))].map((currency) => <TrendChart key={currency} currency={currency} rows={report.trend.filter((row) => row.currencyCode === currency)} />)}</section>;
}
function TrendChart({ currency, rows }: { currency: string; rows: CommerceIntelligenceReport["trend"] }) {
  const values = rows.flatMap((row) => [row.merchandise, row.donations, row.refundsReversals, row.netCollected || 0]); const max = Math.max(1, ...values);
  const points = (field: "merchandise" | "donations" | "refundsReversals" | "netCollected") => rows.map((row, index) => `${rows.length === 1 ? 50 : (index / (rows.length - 1)) * 100},${96 - (Number(row[field] || 0) / max) * 88}`).join(" ");
  return <article className="trend-chart"><div><strong>{currency}</strong><span><i className="is-merch" />Merchandise</span><span><i className="is-donation" />Donations</span><span><i className="is-refund" />Refunds</span><span><i className="is-net" />Net</span></div><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${currency} financial trend`}><polyline className="is-merch" points={points("merchandise")} /><polyline className="is-donation" points={points("donations")} /><polyline className="is-refund" points={points("refundsReversals")} /><polyline className="is-net" points={points("netCollected")} /></svg><small><span>{shortDate(rows[0].bucket)}</span><span>{shortDate(rows.at(-1)?.bucket || rows[0].bucket)}</span></small></article>;
}

function ProductPerformance({ report }: { report: CommerceIntelligenceReport }) { return <section className="intelligence-panel"><header><div><p className="eyebrow">Product performance</p><h2>Historical line snapshots, not today’s catalogue price.</h2></div><span>Top 50 variants</span></header><div className="intelligence-table-scroll"><table><thead><tr><th>Product / variant</th><th>Qty</th><th>Gross merch</th><th>Refunded</th><th>Net merch</th><th>Fulfillment cost</th><th>Cost coverage</th></tr></thead><tbody>{report.products.length ? report.products.map((row) => <tr key={`${row.productId}:${row.variantId}`}><th><strong>{row.product}</strong><small>{row.variant || "No variant label"}</small></th><td>{number(row.quantity)}</td><td>{money(row.grossMerchandise, row.currencyCode)}</td><td>{moneyOrUnknown(row.refundedValue, row.currencyCode)}</td><td>{moneyOrUnknown(row.netMerchandise, row.currencyCode)}</td><td>{moneyOrUnknown(row.fulfillmentCost, row.currencyCode)}</td><td>{row.costCoverage.knownOrders}/{row.costCoverage.totalOrders} orders</td></tr>) : <tr><td colSpan={7}>No paid merchandise lines in this range.</td></tr>}</tbody></table></div></section>; }

function OrderEconomics({ report, onPage }: { report: CommerceIntelligenceReport; onPage: (page: number) => void }) { return <section className="intelligence-panel"><header><div><p className="eyebrow">Order economics</p><h2>Analytical transaction ledger.</h2></div><span>{report.orders.total} LIVE orders</span></header><div className="intelligence-table-scroll"><table><thead><tr><th>Order</th><th>Captured</th><th>Status</th><th>Charged</th><th>Refund / reversal</th><th>Net</th><th>Shipping</th><th>Tax</th><th>Fulfillment cost</th><th>Processor fee</th><th>Contribution margin</th><th>Coverage</th></tr></thead><tbody>{report.orders.items.length ? report.orders.items.map((row) => <tr key={row.id}><th><Link to={`/orders?query=${encodeURIComponent(row.id)}`}>{row.id}</Link><small>{row.provider} Â· {row.currencyCode}</small></th><td>{formatDate(row.capturedAt)}</td><td><span className="intelligence-status-chip">{humanize(row.status)}</span></td><td>{money(row.charged, row.currencyCode)}</td><td>{moneyOrUnknown(row.refundReversal, row.currencyCode)}</td><td>{moneyOrUnknown(row.netCollected, row.currencyCode)}</td><td>{moneyOrUnknown(row.customerShipping, row.currencyCode)}</td><td>{moneyOrUnknown(row.tax, row.currencyCode)}</td><td>{moneyOrUnknown(row.fulfillmentCost, row.currencyCode)}</td><td>{moneyOrUnknown(row.processorFee, row.currencyCode)}</td><td>{moneyOrUnknown(row.contributionMargin, row.currencyCode)}</td><td>{humanize(row.completeness)}</td></tr>) : <tr><td colSpan={12}>No successfully collected LIVE orders in this range.</td></tr>}</tbody></table></div>{report.orders.totalPages > 1 ? <footer className="intelligence-pagination"><button type="button" disabled={report.orders.page <= 1} onClick={() => onPage(report.orders.page - 1)}>Previous</button><span>Page {report.orders.page} / {report.orders.totalPages}</span><button type="button" disabled={report.orders.page >= report.orders.totalPages} onClick={() => onPage(report.orders.page + 1)}>Next</button></footer> : null}</section>; }

function DonationPanel({ report }: { report: CommerceIntelligenceReport }) { return <section className="intelligence-panel"><header><div><p className="eyebrow">Donation intelligence</p><h2>Private by design.</h2></div></header>{report.donations.length ? report.donations.map((row) => <article className="intelligence-mini-rail" key={row.currencyCode}><strong>{row.currencyCode}</strong><dl><div><dt>Count</dt><dd>{row.count}</dd></div><div><dt>Gross</dt><dd>{money(row.gross, row.currencyCode)}</dd></div><div><dt>Refunded / reversed</dt><dd>{moneyOrUnknown(row.refundsReversals, row.currencyCode)}</dd></div><div><dt>Net</dt><dd>{moneyOrUnknown(row.net, row.currencyCode)}</dd></div><div><dt>Average</dt><dd>{money(row.average, row.currencyCode)}</dd></div></dl></article>) : <p>No successfully collected LIVE donations in this range.</p>}</section>; }
function RefundPanel({ report }: { report: CommerceIntelligenceReport }) { return <section className="intelligence-panel"><header><div><p className="eyebrow">Refund / reversal intelligence</p><h2>Completed evidence only.</h2></div></header>{report.refunds.length ? report.refunds.map((row) => <article className="intelligence-mini-rail" key={row.currencyCode}><strong>{row.currencyCode}</strong><dl><div><dt>Order refunds</dt><dd>{row.orderRefunds}</dd></div><div><dt>Full / partial</dt><dd>{row.fullOrderRefunds} / {row.partialOrderRefunds}</dd></div><div><dt>Refund value</dt><dd>{moneyOrUnknown(row.refundValue, row.currencyCode)}</dd></div><div><dt>Refund rate</dt><dd>{row.refundRate === null ? "Unknown" : percent(row.refundRate)}</dd></div><div><dt>Donation refund / reversal</dt><dd>{row.donationRefunds} / {row.donationReversals}</dd></div><div><dt>Unresolved disputes</dt><dd>{row.unresolvedDisputes}</dd></div></dl><small>{row.refundRateBasis}</small></article>) : <p>No refund, reversal, or dispute evidence in this range.</p>}</section>; }

function CoveragePanel({ report }: { report: CommerceIntelligenceReport }) { const c = report.coverage; return <section className="intelligence-panel coverage-panel"><header><div><p className="eyebrow">Financial data coverage</p><h2>Precision has a provenance.</h2></div><span>{c.complete ? "Bounded read complete" : "Partial read"}</span></header><div className="coverage-grid"><Coverage label="Fulfillment costs" known={c.fulfillmentCost.known} unknown={c.fulfillmentCost.unknown} /><Coverage label="Processor fees" known={c.processorFees.known} unknown={c.processorFees.unknown} /><Coverage label="Order allocations" known={c.allocation.complete} unknown={c.allocation.incomplete} /><Coverage label="Donation reversals" known={c.donationReversals.complete} unknown={c.donationReversals.incomplete} /></div><dl className="coverage-freshness"><div><dt>Oldest authoritative transaction</dt><dd>{formatDate(c.oldestTransactionAt)}</dd></div><div><dt>Latest transaction</dt><dd>{formatDate(c.latestTransactionAt)}</dd></div><div><dt>Latest financial update</dt><dd>{formatDate(c.latestFinancialUpdateAt)}</dd></div><div><dt>Latest provider evidence</dt><dd>{formatDate(c.latestProviderUpdateAt)}</dd></div></dl>{c.unresolvedDisputes ? <p className="coverage-warning">{c.unresolvedDisputes} dispute record(s) lack a complete authoritative reversal amount. Net collected remains incomplete where affected.</p> : null}</section>; }
function Coverage({ label, known, unknown }: { label: string; known: number; unknown: number }) { const total = known + unknown; const ratio = total ? known / total : 1; return <article><span>{label}</span><strong>{known} / {total}</strong><div><i style={{ width: `${ratio * 100}%` }} /></div><small>{unknown ? `${unknown} unknown` : "Complete for represented records"}</small></article>; }

function IntelligenceSkeleton() { return <div className="intelligence-skeleton" role="status"><span>Loading authoritative LIVE financial evidenceâ€¦</span>{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</div>; }
function failure(reason: unknown) { if (reason instanceof CommerceIntelligenceError) { if (reason.code === "commerce_intelligence_migration_required" || reason.code === "service_schema_mismatch") return { kind: "migration" as const, message: "The required additive commerce schema must be present before this read-only report can run." }; if (reason.status === 401 || reason.status === 403) return { kind: "auth" as const, message: "Sign in again with an Admin account that has Commerce view access." }; return { kind: "query" as const, message: reason.message }; } return { kind: "query" as const, message: reason instanceof Error ? reason.message : "Commerce Intelligence is unavailable." }; }
function combineKnown(a: FinancialMetric, b: FinancialMetric): FinancialMetric { return { value: a.complete && b.complete ? (a.value || 0) + (b.value || 0) : null, knownValue: a.knownValue + b.knownValue, complete: a.complete && b.complete }; }
function metricMoney(metric: FinancialMetric, currency: string) { return metric.complete ? money(metric.value, currency) : metric.knownValue ? `${money(metric.knownValue, currency)} known` : "Unknown"; }
function deltaLabel(delta: CurrencySummary["deltas"][string]) { if (!delta?.available) return "Comparison unavailable"; if (delta.direction === "new") return "New activity"; return `${delta.value !== null && delta.value > 0 ? "+" : ""}${percent(delta.value || 0)} vs prior`; }
function coverageState(report: CommerceIntelligenceReport) { const c = report.coverage; if (Object.values(c.truncated).some(Boolean)) return "Bounded / truncated"; if (c.unresolvedDisputes || c.fulfillmentCost.unknown || c.processorFees.unknown || c.allocation.incomplete) return "Partial evidence"; return "Complete evidence"; }
function money(value: number | null, currency: string) { return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format((value || 0) / 100); }
function moneyOrUnknown(value: number | null, currency: string) { return value === null ? "Unknown" : money(value, currency); }
function number(value: number) { return new Intl.NumberFormat("en-AU").format(value); }
function percent(value: number) { return new Intl.NumberFormat("en-AU", { style: "percent", maximumFractionDigits: 1 }).format(value); }
function formatDate(value: string | null) { if (!value) return "No evidence"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown" : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC"; }
function shortDate(value: string) { const date = new Date(value); return new Intl.DateTimeFormat("en-AU", { month: "short", day: "numeric", hour: "numeric", timeZone: "UTC" }).format(date); }
function rangeLabel(range: CommerceIntelligenceRange) { return range === "24h" ? "Trailing 24 hours" : `Trailing ${range.slice(0, -1)} days`; }
function humanize(value: string) { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase()); }
