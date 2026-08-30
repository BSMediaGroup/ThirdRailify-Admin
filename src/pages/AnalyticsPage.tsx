import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { AdminShellOutletContext } from "../components/AdminShell";
import {
  getAnalytics,
  type AnalyticsReport,
  type Delta,
  type RangeKey,
} from "../analytics/client";

const RANGES: RangeKey[] = ["24h", "7d", "30d", "90d"];
export function AnalyticsPage() {
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [range, setRange] = useState<RangeKey>("7d");
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const stop = startLoading("Loading audience analytics");
      setLoading(true);
      setError("");
      try {
        setReport(await getAnalytics(range, signal));
      } catch (reason) {
        if ((reason as { name?: string })?.name !== "AbortError")
          setError(
            reason instanceof Error
              ? reason.message
              : "Audience analytics are unavailable.",
          );
      } finally {
        setLoading(false);
        stop();
      }
    },
    [range, startLoading],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const stale = report?.coverage.lastIngestedAt
    ? Date.now() - Date.parse(report.coverage.lastIngestedAt) > 6 * 3_600_000
    : false;
  return (
    <div className="analytics-page">
      <header className="analytics-heading">
        <div>
          <p className="eyebrow">Audience intelligence</p>
          <h1>Signals across the rail.</h1>
          <p>
            Exact first-party page views and anonymous sessions for the trailing{" "}
            {label(range)}, calculated in UTC.
          </p>
        </div>
        <div className="analytics-heading__controls">
          <div
            className="analytics-range"
            role="group"
            aria-label="Reporting range"
          >
            {RANGES.map((key) => (
              <button
                key={key}
                type="button"
                className={range === key ? "is-active" : ""}
                aria-pressed={range === key}
                onClick={() => setRange(key)}
              >
                {key}
              </button>
            ))}
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      {error ? (
        <div className="analytics-state is-error" role="alert">
          <strong>Analytics query failed.</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}
      {loading && !report ? (
        <AnalyticsSkeleton />
      ) : report ? (
        <>
          <div
            className={`analytics-health ${!report.configured ? "is-unavailable" : stale ? "is-stale" : !report.coverage.totalEvents ? "is-awaiting" : "is-live"}`}
          >
            <span />
            <strong>
              {!report.configured
                ? "Collection not configured"
                : !report.coverage.totalEvents
                  ? "Configured · awaiting first activity"
                  : stale
                    ? "Ingestion is stale"
                    : "Collection active"}
            </strong>
            <small>
              {report.coverage.lastIngestedAt
                ? `Last event ${formatDate(report.coverage.lastIngestedAt)}`
                : "No events retained yet"}
            </small>
          </div>
          {!report.coverage.totalEvents ? (
            <div className="analytics-state">
              <strong>
                {report.configured
                  ? "The collector is ready for its first signal."
                  : "Analytics remains fail-closed."}
              </strong>
              <span>
                {report.configured
                  ? "No production or test fixture data has been invented."
                  : "Add the dedicated ingestion secret to both Pages projects, apply migration 0024, then deploy Admin before Public."}
              </span>
            </div>
          ) : (
            <Dashboard report={report} />
          )}
        </>
      ) : null}
    </div>
  );
}
function Dashboard({ report }: { report: AnalyticsReport }) {
  const selected = report.selected;
  return (
    <>
      <section className="analytics-kpis" aria-label="Selected range signals">
        <Kpi
          label="Page views"
          value={number(selected.views)}
          delta={selected.deltas.views}
        />
        <Kpi
          label="Anonymous sessions"
          value={number(selected.sessions)}
          delta={selected.deltas.sessions}
        />
        <Kpi
          label="Pages / session"
          value={selected.pagesPerSession?.toFixed(2) || "—"}
          note="Mathematically valid sessions only"
        />
        <Kpi
          label="Coverage"
          value={coverage(report)}
          note={
            selected.comparisonComplete
              ? "Full preceding period available"
              : "Comparison history incomplete"
          }
        />
      </section>
      <AudienceMap points={report.geography} />
      <TrafficMatrix report={report} />
      <section className="analytics-insights">
        <Trend report={report} />
        <Ranking
          title="Top public pages"
          rows={report.pages.map((row) => ({
            label: row.path,
            value: row.views,
            sub: `${number(row.sessions)} sessions`,
          }))}
        />
        <Ranking
          title="Traffic sources"
          rows={report.sources.map((row) => ({
            label: row.source,
            value: row.views,
            sub: `${number(row.sessions)} sessions`,
          }))}
        />
        <DeviceSplit report={report} />
        <RevenuePulse report={report} />
      </section>
    </>
  );
}
function Kpi({
  label,
  value,
  delta,
  note,
}: {
  label: string;
  value: string;
  delta?: Delta;
  note?: string;
}) {
  return (
    <article className="analytics-kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      {delta ? <DeltaView delta={delta} /> : <small>{note}</small>}
    </article>
  );
}
function DeltaView({ delta }: { delta: Delta }) {
  if (!delta.available)
    return <small className="is-muted">Preceding period unavailable</small>;
  if (delta.direction === "new")
    return <small className="is-up">New activity vs zero</small>;
  const value =
    delta.value == null
      ? "—"
      : `${delta.value >= 0 ? "+" : ""}${(delta.value * 100).toFixed(1)}%`;
  return (
    <small className={`is-${delta.direction}`}>
      {value} vs preceding period
    </small>
  );
}
function AudienceMap({ points }: { points: AnalyticsReport["geography"] }) {
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapError, setMapError] = useState("");
  useEffect(() => {
    if (!node.current || !points.length) return;
    let cancelled = false;
    const markers: Marker[] = [];
    void import("maplibre-gl")
      .then((maplibregl) => {
        if (cancelled || !node.current) return;
        const instance = new maplibregl.Map({
          container: node.current,
          style:
            import.meta.env.VITE_ANALYTICS_MAP_STYLE_URL ||
            "https://tiles.openfreemap.org/styles/dark",
          center: [15, 18],
          zoom: 1.25,
          attributionControl: {},
        });
        map.current = instance;
        instance.addControl(
          new maplibregl.NavigationControl({ showCompass: false }),
          "top-right",
        );
        instance.on("error", () =>
          setMapError(
            "Map tiles are unavailable; the regional list remains complete.",
          ),
        );
        for (const point of points) {
          const element = document.createElement("button");
          element.type = "button";
          element.className = "analytics-map-marker";
          element.setAttribute(
            "aria-label",
            `${place(point)}: ${point.views} page views`,
          );
          element.style.setProperty(
            "--marker-scale",
            String(
              Math.min(2.2, 1 + Math.log10(Math.max(1, point.views)) * 0.45),
            ),
          );
          const popup = new maplibregl.Popup({
            offset: 18,
            closeButton: false,
          }).setHTML(
            `<strong>${escapeHtml(place(point))}</strong><span>${number(point.views)} views · ${number(point.sessions)} sessions</span><span>${escapeHtml(point.topPath || "No route summary")}</span><small>${escapeHtml(point.topSource || "direct")} · ${escapeHtml(formatDate(point.latestAt))}</small>`,
          );
          const marker = new maplibregl.Marker({ element })
            .setLngLat([point.longitude, point.latitude])
            .setPopup(popup)
            .addTo(instance);
          element.addEventListener("focus", () => marker.togglePopup());
          markers.push(marker);
        }
        instance.on("load", () => {
          if (points.length > 1) {
            const bounds = new maplibregl.LngLatBounds();
            points.forEach((point) =>
              bounds.extend([point.longitude, point.latitude]),
            );
            instance.fitBounds(bounds, {
              padding: 70,
              maxZoom: 5,
              duration: 0,
            });
          }
        });
      })
      .catch(() =>
        setMapError(
          "WebGL mapping is unavailable; use the complete regional list below.",
        ),
      );
    return () => {
      cancelled = true;
      markers.forEach((marker) => marker.remove());
      map.current?.remove();
      map.current = null;
    };
  }, [points]);
  return (
    <section className="analytics-map-panel">
      <header>
        <div>
          <p className="eyebrow">Audience activity map</p>
          <h2>Where the signal lands.</h2>
          <p>
            Coarse city/region aggregates only. No IPs, event IDs, session IDs,
            or household coordinates reach this view.
          </p>
        </div>
        <strong>
          {number(points.reduce((sum, point) => sum + point.views, 0))} mapped
          views
        </strong>
      </header>
      <div className="analytics-map-shell">
        <div
          ref={node}
          className="analytics-map"
          role="img"
          aria-label="World map of aggregated audience activity"
        />
        {mapError ? (
          <div className="analytics-map-error" role="status">
            {mapError}
          </div>
        ) : null}
        {!points.length ? (
          <div className="analytics-map-empty">
            No coarse geographic points exist for this range.
          </div>
        ) : null}
      </div>
      <div
        className="analytics-region-list"
        aria-label="Regional activity fallback"
      >
        {points.slice(0, 12).map((point) => (
          <article key={`${point.latitude}:${point.longitude}`}>
            <strong>{place(point)}</strong>
            <span>{number(point.views)} views</span>
            <small>
              {number(point.sessions)} sessions ·{" "}
              {point.topPath || "No route summary"}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}
function TrafficMatrix({ report }: { report: AnalyticsReport }) {
  return (
    <section className="analytics-matrix">
      <header>
        <p className="eyebrow">Traffic comparison matrix</p>
        <h2>Four windows. One honest baseline.</h2>
      </header>
      <div className="analytics-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {RANGES.map((key) => (
                <th scope="col" key={key}>
                  {key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Page views</th>
              {RANGES.map((key) => (
                <MetricCell
                  key={key}
                  value={report.windows[key].views}
                  delta={report.windows[key].deltas.views}
                />
              ))}
            </tr>
            <tr>
              <th scope="row">Anonymous sessions</th>
              {RANGES.map((key) => (
                <MetricCell
                  key={key}
                  value={report.windows[key].sessions}
                  delta={report.windows[key].deltas.sessions}
                />
              ))}
            </tr>
            <tr>
              <th scope="row">Pages / session</th>
              {RANGES.map((key) => (
                <td key={key}>
                  <strong>
                    {report.windows[key].pagesPerSession?.toFixed(2) || "—"}
                  </strong>
                  <small>
                    {report.windows[key].comparisonComplete
                      ? "Complete window"
                      : "Partial history"}
                  </small>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
function MetricCell({ value, delta }: { value: number; delta: Delta }) {
  return (
    <td>
      <strong>{number(value)}</strong>
      <DeltaView delta={delta} />
    </td>
  );
}
function Trend({ report }: { report: AnalyticsReport }) {
  const max = Math.max(1, ...report.series.map((row) => row.views));
  const points = report.series
    .map(
      (row, index) =>
        `${report.series.length === 1 ? 50 : (index / (report.series.length - 1)) * 100},${92 - (row.views / max) * 80}`,
    )
    .join(" ");
  return (
    <article className="analytics-card analytics-trend">
      <header>
        <h3>Audience trend</h3>
        <span>{report.bucket}ly buckets · UTC</span>
      </header>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Page-view trend across ${report.series.length} ${report.bucket}ly buckets`}
      >
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f3c928" stopOpacity=".38" />
            <stop offset="1" stopColor="#f3c928" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,100 ${points} 100,100`} fill="url(#trend-fill)" />
        <polyline
          points={points}
          fill="none"
          stroke="#f3c928"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="analytics-trend__axis">
        <span>
          {report.series[0] ? shortDate(report.series[0].bucket) : "—"}
        </span>
        <span>
          {report.series.at(-1) ? shortDate(report.series.at(-1)!.bucket) : "—"}
        </span>
      </div>
    </article>
  );
}
function Ranking({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: number; sub: string }>;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <article className="analytics-card analytics-ranking">
      <header>
        <h3>{title}</h3>
        <span>{rows.length} retained leaders</span>
      </header>
      {rows.length ? (
        rows.slice(0, 8).map((row) => (
          <div key={row.label}>
            <span title={row.label}>{row.label}</span>
            <b style={{ width: `${Math.max(4, (row.value / max) * 100)}%` }} />
            <strong>{number(row.value)}</strong>
            <small>{row.sub}</small>
          </div>
        ))
      ) : (
        <p>No activity in this range.</p>
      )}
    </article>
  );
}
function DeviceSplit({ report }: { report: AnalyticsReport }) {
  const total = report.devices.reduce((sum, row) => sum + row.views, 0);
  return (
    <article className="analytics-card analytics-devices">
      <header>
        <h3>Device mix</h3>
        <span>Page-view distribution</span>
      </header>
      {report.devices.map((row) => (
        <div key={row.device}>
          <span>{row.device}</span>
          <strong>
            {total ? `${((row.views / total) * 100).toFixed(1)}%` : "0%"}
          </strong>
          <small>{number(row.views)} views</small>
        </div>
      ))}
    </article>
  );
}
function RevenuePulse({ report }: { report: AnalyticsReport }) {
  return (
    <article className="analytics-card analytics-revenue">
      <header>
        <div>
          <p className="eyebrow">Revenue pulse</p>
          <h3>Collected, not profit.</h3>
        </div>
        <Link to="/commerce">Open Commerce</Link>
      </header>
      {report.revenue.currencies.length ? (
        report.revenue.currencies.map((currency) => {
          const window = currency.windows[report.range];
          return (
            <div
              className="analytics-revenue__currency"
              key={currency.currencyCode}
            >
              <strong>{money(window.net, currency.currencyCode)}</strong>
              <span>Net collected</span>
              <dl>
                <div>
                  <dt>Merchandise</dt>
                  <dd>{money(window.merchandise, currency.currencyCode)}</dd>
                </div>
                <div>
                  <dt>Donations</dt>
                  <dd>{money(window.donations, currency.currencyCode)}</dd>
                </div>
                <div>
                  <dt>Gross</dt>
                  <dd>{money(window.gross, currency.currencyCode)}</dd>
                </div>
                <div>
                  <dt>Refunded / reversed</dt>
                  <dd>{money(window.refunded, currency.currencyCode)}</dd>
                </div>
              </dl>
            </div>
          );
        })
      ) : (
        <p>No successful LIVE collections exist in this range.</p>
      )}
      <small>{report.revenue.profitUnavailableReason}</small>
    </article>
  );
}
function AnalyticsSkeleton() {
  return (
    <div className="analytics-skeleton" role="status">
      <span>Loading exact audience signals…</span>
      {Array.from({ length: 8 }, (_, index) => (
        <i key={index} />
      ))}
    </div>
  );
}
function number(value: number) {
  return new Intl.NumberFormat("en-AU").format(value);
}
function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(
    value / 100,
  );
}
function label(range: RangeKey) {
  return range === "24h" ? "24 hours" : range.slice(0, -1) + " days";
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unknown"
    : new Intl.DateTimeFormat("en-AU", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date) + " UTC";
}
function shortDate(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-AU", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    timeZone: "UTC",
  }).format(date);
}
function coverage(report: AnalyticsReport) {
  if (!report.coverage.start) return "No history";
  const days = Math.max(
    0,
    (Date.parse(report.generatedAt) - Date.parse(report.coverage.start)) /
      86_400_000,
  );
  return days < 1
    ? `${Math.max(1, Math.round(days * 24))}h`
    : `${Math.floor(days)}d`;
}
function place(point: AnalyticsReport["geography"][number]) {
  return (
    [point.city, point.region, point.countryName || point.countryCode]
      .filter(Boolean)
      .join(", ") || "Unknown region"
  );
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ]!,
  );
}
