import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { getCommerceCustomer, getCommerceCustomers, type CommerceCustomer, type CustomerDetail, type CustomerListFilters } from "../commerce/client";
import { AdminIcon } from "../components/AdminIcon";
import { DetailDrawer } from "../components/DetailDrawer";
import { resetResizableTable } from "../components/resizableTableEvents";
import type { AdminShellOutletContext } from "../components/AdminShell";

type Filters = Required<CustomerListFilters>;
const INITIAL: Filters = { page: 1, pageSize: 20, query: "", type: "all", environment: "all", purchase: "any", sort: "latest_order" };

export function CustomersPage() {
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(INITIAL);
  const [query, setQuery] = useState("");
  const [payload, setPayload] = useState<Awaited<ReturnType<typeof getCommerceCustomers>> | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const selectedId = params.get("customer");

  useEffect(() => { const timer = window.setTimeout(() => setFilters((current) => current.query === query ? current : { ...current, query, page: 1 }), 250); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => {
    let active = true; const stop = startLoading("Loading commerce customers"); setError("");
    void getCommerceCustomers(filters).then((result) => { if (!active) return; setPayload(result); if (result.page !== filters.page) setFilters((current) => ({ ...current, page: result.page })); }).catch((reason) => { if (active) setError(message(reason, "Customers are unavailable.")); }).finally(stop);
    return () => { active = false; };
  }, [filters, startLoading]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); setDetailLoading(false); return; }
    let active = true; setDetail(null); setDetailLoading(true); setError("");
    void getCommerceCustomer(selectedId).then((result) => { if (active) setDetail(result.customer); }).catch((reason) => { if (active) { setError(message(reason, "Customer detail is unavailable.")); close(); } }).finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((current) => ({ ...current, [key]: value, ...(key === "page" ? {} : { page: 1 }) }));
  const open = (id: string) => { const next = new URLSearchParams(params); next.set("customer", id); setParams(next); };
  const close = useCallback(() => { setParams((current) => { const next = new URLSearchParams(current); next.delete("customer"); return next; }); }, [setParams]);

  return <>
    <section className="area-heading commerce-heading"><div className="area-icon"><AdminIcon name="users" size={28} /></div><div><p className="eyebrow">Commerce relationships</p><h1>Customers</h1><p>Guest and account-backed purchasers are separate from authentication Accounts. Historical order snapshots remain unchanged.</p></div><span className="commerce-status commerce-status--disabled">Protected read</span></section>
    {error && <div className="admin-alert" role="alert">{error}</div>}
    <section className="commerce-section customer-workspace" aria-labelledby="customer-list-title">
      <div className="commerce-section-heading-actions"><div><p className="eyebrow">Commerce D1 authority</p><h2 id="customer-list-title">Customer management</h2></div><button type="button" className="secondary-button table-reset-button" onClick={() => resetResizableTable("customers")}>Reset columns</button></div>
      <div className="customer-filters" aria-label="Customer filters">
        <Field label="Search"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Customer ID, exact email or linked Account" maxLength={120} /></Field>
        <Field label="Type"><select value={filters.type} onChange={(event) => update("type", event.target.value as Filters["type"])}><option value="all">All</option><option value="account">Account</option><option value="guest">Guest</option></select></Field>
        <Field label="Purchase environment"><select value={filters.environment} onChange={(event) => update("environment", event.target.value as Filters["environment"])}><option value="all">All</option><option value="live">Live</option><option value="test">Test</option></select></Field>
        <Field label="Purchase state"><select value={filters.purchase} onChange={(event) => update("purchase", event.target.value as Filters["purchase"])}><option value="any">Any</option><option value="paid">Has paid order</option><option value="unpaid">No paid order</option></select></Field>
        <Field label="Sort"><select value={filters.sort} onChange={(event) => update("sort", event.target.value as Filters["sort"])}><option value="latest_order">Latest order</option><option value="newest">Newest customer</option><option value="oldest">Oldest customer</option><option value="highest_live_spend">Highest LIVE spend</option><option value="most_orders">Most orders</option></select></Field>
      </div>
      {payload && <div className="commerce-results-bar"><p>{payload.totalMatching ? `Showing ${payload.startIndex}–${payload.endIndex} of ${payload.totalMatching} customers` : "No customers match these filters."}</p><Field label="Rows per page"><select value={filters.pageSize} onChange={(event) => update("pageSize", Number(event.target.value) as Filters["pageSize"])}>{[20, 50, 75, 100].map((size) => <option key={size}>{size}</option>)}</select></Field></div>}
      {!payload && !error ? <State>Loading protected customer records…</State> : payload?.customers.length ? <div className="customer-table-wrap"><table className="customer-table" data-resizable-key="customers"><thead><tr><Header width={190}>Customer</Header><Header width={92}>Type</Header><Header width={210}>Contact</Header><Header width={165}>Linked Account</Header><Header width={112}>Orders</Header><Header width={135}>LIVE spend</Header><Header width={145}>TEST activity</Header><Header width={110}>Last order</Header></tr></thead><tbody>{payload.customers.map((customer) => <CustomerRow key={customer.id} customer={customer} open={open} />)}</tbody></table></div> : <State><strong>0 authoritative Customers.</strong><span>Accounts without purchases do not become Customers, and no history is fabricated.</span></State>}
      {payload && payload.totalPages > 0 && <Pagination page={payload.page} total={payload.totalPages} setPage={(page) => update("page", page)} />}
    </section>
    {selectedId && <DetailDrawer titleId="customer-detail-title" onClose={close}><CustomerDrawer customer={detail} loading={detailLoading} close={close} /></DetailDrawer>}
  </>;
}

function CustomerRow({ customer, open }: { customer: CommerceCustomer; open: (id: string) => void }) {
  const activate = () => open(customer.id);
  return <tr tabIndex={0} aria-label={`Open customer ${customer.contact.name}`} onClick={activate} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }}>
    <Cell label="Customer"><strong>{customer.contact.name}</strong><span title={customer.id}>{compactId(customer.id)}</span></Cell>
    <Cell label="Type"><span className={`customer-kind customer-kind--${customer.kind}`}>{customer.kind === "account" ? "Account" : "Guest"}</span></Cell>
    <Cell label="Contact"><strong>{customer.contact.email}</strong><span>Encrypted at rest</span></Cell>
    <Cell label="Linked Account">{customer.account ? <Link to={`/access?account=${encodeURIComponent(customer.account.id)}`} onClick={(event) => event.stopPropagation()}><strong>{customer.account.displayName}</strong><span>{customer.account.email || customer.account.id}</span></Link> : <span className="customer-unlinked">No Account</span>}</Cell>
    <Cell label="Orders"><strong>{customer.summary.orderCount}</strong><span>{customer.summary.paidOrderCount} paid</span></Cell>
    <Cell label="LIVE spend"><strong>{money(customer.summary.liveSpendAmount)}</strong><span>{customer.summary.livePaidOrderCount} paid LIVE</span></Cell>
    <Cell label="TEST activity">{customer.summary.testOrderCount ? <><strong className="order-environment order-environment--test">TEST · {customer.summary.testOrderCount}</strong><span>{money(customer.summary.testSpendAmount)} sandbox</span></> : <span>None</span>}</Cell>
    <Cell label="Last order"><strong>{date(customer.summary.lastOrderAt)}</strong><button type="button" className="commerce-row-action" onClick={(event) => { event.stopPropagation(); activate(); }}>Details</button></Cell>
  </tr>;
}

function CustomerDrawer({ customer, loading, close }: { customer: CustomerDetail | null; loading: boolean; close: () => void }) {
  if (loading || !customer) return <><DrawerHeader eyebrow="Customer detail" title="Loading customer…" close={close} /><State>Loading one bounded Customer projection…</State></>;
  return <>
    <DrawerHeader eyebrow={`${customer.kind === "account" ? "Account-backed" : "Guest"} Customer`} title={customer.contact.name} close={close} />
    <div className="detail-drawer__body">
      <DrawerSection title="Identity"><dl><Fact term="Customer ID" value={customer.id} /><Fact term="Type" value={customer.kind === "account" ? "Account-backed Customer" : "Guest Customer"} /><Fact term="Current contact" value={`${customer.contact.name} · ${customer.contact.email}`} /><Fact term="Created" value={dateTime(customer.createdAt)} /></dl></DrawerSection>
      <DrawerSection title="Connected Account">{customer.account ? <><dl><Fact term="Account" value={customer.account.displayName} /><Fact term="Provider" value={customer.account.providers.join(", ") || "Email"} /><Fact term="Status" value={human(customer.account.status)} /><Fact term="Email verification" value={customer.account.emailVerified ? "Verified" : "Unverified"} /></dl><Link className="secondary-button" to={`/access?account=${encodeURIComponent(customer.account.id)}`}>Open Account details</Link></> : <div className="order-missing"><strong>No Account linkage</strong><span>Matching email alone never links Guest history to an Account.</span></div>}</DrawerSection>
      <DrawerSection title="Commerce summary"><div className="customer-summary-grid"><Metric label="Orders" value={customer.summary.orderCount} /><Metric label="Paid" value={customer.summary.paidOrderCount} /><Metric label="LIVE orders" value={customer.summary.liveOrderCount} /><Metric label="TEST orders" value={customer.summary.testOrderCount} /><Metric label="LIVE gross" value={money(customer.summary.liveSpendAmount)} /><Metric label="TEST gross" value={money(customer.summary.testSpendAmount)} /></div><p className="order-readonly-note">TEST values are sandbox evidence and are never included in LIVE customer value.</p></DrawerSection>
      <DrawerSection title="Order history">{customer.orders.length ? <div className="customer-order-history">{customer.orders.map((order) => <article key={order.id}><div><span className={`order-environment order-environment--${order.environment}`}>{order.environment.toUpperCase()}</span><strong>{compactId(order.id)}</strong><small>{dateTime(order.createdAt)}</small></div><div><strong>{money(order.totalAmount)}</strong><span>{human(order.paymentStatus)} · {human(order.fulfillment.state)}</span></div><div><span>{order.delivery ? `${[order.delivery.regionCode, order.delivery.countryCode].filter(Boolean).join(" / ")} · historical delivery snapshot` : "No delivery snapshot"}</span><small>{order.fulfillment.shipped ? "Shipped" : "Not shipped"} · {order.fulfillment.trackingAvailable ? "tracking available" : "no tracking"} · {order.fulfillment.shipmentCount} shipment(s)</small></div><Link to={`/orders?order=${encodeURIComponent(order.id)}`}>View order</Link></article>)}</div> : <State>No linked orders.</State>}</DrawerSection>
      <details className="order-technical"><summary>Technical metadata</summary><dl><Fact term="Revision" value={String(customer.technical.revision)} /><Fact term="Linked Account ID" value={customer.technical.linkedAccountId || "Not linked"} /><Fact term="Updated" value={dateTime(customer.updatedAt)} /></dl></details>
    </div>
  </>;
}

function DrawerHeader({ eyebrow, title, close }: { eyebrow: string; title: string; close: () => void }) { return <header className="detail-drawer__header"><div><p className="eyebrow">{eyebrow}</p><h2 id="customer-detail-title">{title}</h2></div><button type="button" className="commerce-editor-close" onClick={close} data-autofocus>Close</button></header>; }
function DrawerSection({ title, children }: { title: string; children: ReactNode }) { return <section className="detail-drawer__section"><h3>{title}</h3>{children}</section>; }
function Header({ width, children }: { width: number; children: ReactNode }) { return <th data-column-width={width} data-column-min={72} data-column-max={480}>{children}</th>; }
function Cell({ label, children }: { label: string; children: ReactNode }) { return <td data-label={label}>{children}</td>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="commerce-field"><span>{label}</span>{children}</label>; }
function Fact({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <article><span>{label}</span><strong>{value}</strong></article>; }
function State({ children }: { children: ReactNode }) { return <div className="commerce-state" role="status">{children}</div>; }
function Pagination({ page, total, setPage }: { page: number; total: number; setPage: (page: number) => void }) { return <nav className="commerce-pagination" aria-label="Customer pages"><button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><div><strong>Page {page} of {total}</strong></div><button type="button" disabled={page >= total} onClick={() => setPage(page + 1)}>Next</button></nav>; }
function compactId(value: string) { return value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-5)}` : value; }
function date(value: string | null) { if (!value) return "No orders"; return new Date(value).toLocaleDateString(); }
function dateTime(value: string | null) { if (!value) return "Not recorded"; const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "Not recorded"; }
function money(value: number) { return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(value / 100); }
function human(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function message(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
