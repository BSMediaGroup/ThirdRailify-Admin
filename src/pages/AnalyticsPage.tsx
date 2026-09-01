import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, MapSourceDataEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { AdminIcon } from "../components/AdminIcon";
import { CountryFlag } from "../components/CountryFlag";
import { createCountryFlagElement } from "../components/countryFlags";
import { resetResizableTable } from "../components/resizableTableEvents";
import {
  AnalyticsApiError,
  getAnalytics,
  type AnalyticsReport,
  type Delta,
  type RangeKey,
} from "../analytics/client";

const RANGES: RangeKey[] = ["24h", "7d", "30d", "90d"];
const ANALYTICS_MAP_STYLE =
  import.meta.env.VITE_ANALYTICS_MAP_STYLE_URL ||
  "https://tiles.openfreemap.org/styles/dark";

maplibregl.setWorkerUrl(maplibreWorkerUrl);

type AnalyticsFailure = { kind: "migration" | "auth" | "query"; message: string };
export function AnalyticsPage() {
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [range, setRange] = useState<RangeKey>("7d");
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState<AnalyticsFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const stop = startLoading("Loading audience analytics");
      setLoading(true);
      setError(null);
      try {
        setReport(await getAnalytics(range, signal));
      } catch (reason) {
        if ((reason as { name?: string })?.name !== "AbortError")
          setError(analyticsFailure(reason));
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
        <div className={`analytics-state is-error is-${error.kind}`} role="alert">
          <p className="eyebrow">{error.kind === "migration" ? "Operational action required" : error.kind === "auth" ? "Admin access required" : "Reporting unavailable"}</p>
          <h2>{error.kind === "migration" ? "Analytics database migration required" : error.kind === "auth" ? "Your Admin session could not be verified" : "Audience report query failed"}</h2>
          <span>{error.message}</span>
          {error.kind === "query" ? <button type="button" onClick={() => void load()}>Try again</button> : null}
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
  const expandButton = useRef<HTMLButtonElement>(null);
  const [mapError, setMapError] = useState("");
  const [mapState, setMapState] = useState<"loading" | "ready" | "failed">(
    points.length ? "loading" : "ready",
  );
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!node.current || !points.length) return;
    if (!webGlSupported()) {
      setMapState("failed");
      setMapError(
        "WebGL mapping is unavailable; use the complete regional list below.",
      );
      return;
    }
    let cancelled = false;
    let resizeFrame = 0;
    let observer: ResizeObserver | null = null;
    let instance: MapLibreMap;
    const markers: maplibregl.Marker[] = [];
    const loadedTiles = new Set<string>();
    const probeController = new AbortController();
    let vectorProbeReady = false;
    let sourceErrors = 0;
    setMapState("loading");
    setMapError("");
    try {
      instance = new maplibregl.Map({
        container: node.current,
        style: ANALYTICS_MAP_STYLE,
        center: [15, 18],
        zoom: 1.25,
        minZoom: 1,
        maxZoom: 12,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        renderWorldCopies: true,
        scrollZoom: false,
        touchPitch: false,
        attributionControl: false,
      });
    } catch {
      setMapState("failed");
      setMapError(
        "WebGL mapping is unavailable; use the complete regional list below.",
      );
      return;
    }
    map.current = instance;
    instance.touchZoomRotate.disableRotation();
    instance.addControl(
      new maplibregl.NavigationControl({
        showCompass: false,
        visualizePitch: false,
      }),
      "top-left",
    );
    instance.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: "Audience locations are deliberately coarse",
      }),
      "bottom-right",
    );

    const markReady = () => {
      if (
        cancelled ||
        !vectorProbeReady ||
        !instance.isStyleLoaded() ||
        loadedTiles.size < 1 ||
        markers.length !== points.length
      )
        return;
      const bounds = node.current?.getBoundingClientRect();
      if (!bounds?.width || !bounds.height) return;
      if (instance.queryRenderedFeatures().length < 1) {
        if (sourceErrors > 0) {
          setMapState("failed");
          setMapError(
            "Map geography could not render; the regional list remains complete.",
          );
        }
        return;
      }
      setMapState("ready");
      setMapError("");
    };
    const onSourceData = (event: MapSourceDataEvent) => {
      if (event.sourceId !== "openmaptiles" || !event.coord) return;
      const tile = event.coord.canonical;
      loadedTiles.add(`${tile.z}/${tile.x}/${tile.y}`);
      window.requestAnimationFrame(markReady);
    };
    const onMapError = (event: maplibregl.ErrorEvent) => {
      const sourceId = "sourceId" in event ? String(event.sourceId || "") : "";
      if (sourceId === "openmaptiles") sourceErrors += 1;
      if (!sourceId && !instance.isStyleLoaded()) {
        setMapState("failed");
        setMapError(
          "Map style could not load; the regional list remains complete.",
        );
      }
    };
    instance.on("sourcedata", onSourceData);
    instance.on("idle", markReady);
    instance.on("error", onMapError);
    instance.once("load", () => {
      if (cancelled) return;
      instance.resize();
      fitAudiencePoints(instance, points);
    });

    for (const point of points) {
      const element = createAudienceMarker(point);
      const popup = new maplibregl.Popup({
        anchor: "bottom",
        className: "analytics-map-popup",
        closeButton: true,
        closeOnClick: false,
        focusAfterOpen: false,
        maxWidth: "330px",
        offset: [0, -42],
      }).setDOMContent(createAudiencePopup(point));
      const marker = new maplibregl.Marker({ element, anchor: "bottom" })
        .setLngLat([point.longitude, point.latitude])
        .addTo(instance);
      const openPopup = () => {
        markers.forEach((other) => {
          if (other !== marker) other.getPopup()?.remove();
        });
        if (!popup.isOpen()) popup.setLngLat(marker.getLngLat()).addTo(instance);
      };
      marker.setPopup(popup);
      element.addEventListener("mouseenter", openPopup);
      element.addEventListener("focus", openPopup);
      markers.push(marker);
    }
    void verifyAnalyticsVectorSource(probeController.signal)
      .then(() => {
        if (cancelled) return;
        vectorProbeReady = true;
        markReady();
      })
      .catch(() => {
        if (cancelled || probeController.signal.aborted) return;
        setMapState("failed");
        setMapError(
          "Map tiles are unavailable; the regional list remains complete.",
        );
      });

    observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        if (cancelled) return;
        instance.resize();
        markReady();
      });
    });
    observer.observe(node.current);
    return () => {
      cancelled = true;
      probeController.abort();
      observer?.disconnect();
      window.cancelAnimationFrame(resizeFrame);
      instance.off("sourcedata", onSourceData);
      instance.off("idle", markReady);
      instance.off("error", onMapError);
      markers.forEach((marker) => marker.remove());
      instance.remove();
      map.current = null;
    };
  }, [points]);
  useEffect(() => {
    const resize = window.requestAnimationFrame(() => {
      if (!map.current) return;
      map.current.resize();
      fitAudiencePoints(map.current, points);
    });
    if (!expanded) return () => window.cancelAnimationFrame(resize);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = () => {
      setExpanded(false);
      window.requestAnimationFrame(() =>
        expandButton.current?.focus({ preventScroll: true }),
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(resize);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded, points]);
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
      <div
        className={`analytics-map-shell${expanded ? " is-expanded" : ""}${mapState === "ready" ? " is-ready" : ""}`}
        data-analytics-map-engine="maplibre"
        data-analytics-map-state={mapState}
        role={expanded ? "dialog" : undefined}
        aria-modal={expanded || undefined}
        aria-label={expanded ? "Fullscreen audience activity map" : undefined}
      >
        <div
          ref={node}
          className="analytics-map"
          role="img"
          aria-label="World map of aggregated audience activity"
        />
        <div className="analytics-map-chrome">
          <span><i /> Live audience geography</span>
          <button
            ref={expandButton}
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <AdminIcon name={expanded ? "close" : "expand"} size={17} />
            {expanded ? "Close fullscreen" : "Fullscreen map"}
          </button>
        </div>
        {mapState === "loading" ? (
          <div className="analytics-map-loading" role="status">
            <span /> Rendering dark vector geography
          </div>
        ) : null}
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
            <strong className="analytics-location-label">
              <CountryFlag countryCode={point.countryCode} />
              <span>{place(point)}</span>
            </strong>
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

function createAudienceMarker(point: AnalyticsReport["geography"][number]) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "analytics-map-marker";
  element.dataset.latitude = String(point.latitude);
  element.dataset.longitude = String(point.longitude);
  element.setAttribute(
    "aria-label",
    `${place(point)}: ${number(point.views)} page views`,
  );
  element.style.setProperty(
    "--signal-scale",
    String(Math.min(1.28, 0.92 + Math.log10(Math.max(1, point.views)) * 0.14)),
  );
  const pulse = document.createElement("span");
  pulse.className = "analytics-map-marker__pulse";
  const core = document.createElement("span");
  core.className = "analytics-map-marker__core";
  const count = document.createElement("b");
  count.textContent = compactNumber(point.views);
  core.append(count);
  const stem = document.createElement("span");
  stem.className = "analytics-map-marker__stem";
  element.append(pulse, core, stem);
  return element;
}

function createAudiencePopup(point: AnalyticsReport["geography"][number]) {
  const card = document.createElement("article");
  card.className = "analytics-map-card";
  const eyebrow = document.createElement("span");
  eyebrow.className = "analytics-map-card__eyebrow";
  eyebrow.textContent = "Audience signal";
  const title = document.createElement("strong");
  title.textContent = place(point);
  const heading = document.createElement("div");
  heading.className = "analytics-map-card__location";
  heading.append(createCountryFlagElement(point.countryCode), title);
  const metrics = document.createElement("div");
  metrics.className = "analytics-map-card__metrics";
  const views = document.createElement("span");
  const viewsValue = document.createElement("b");
  viewsValue.textContent = number(point.views);
  views.append(viewsValue, " views");
  const sessions = document.createElement("span");
  const sessionsValue = document.createElement("b");
  sessionsValue.textContent = number(point.sessions);
  sessions.append(sessionsValue, " sessions");
  metrics.append(views, sessions);
  const route = document.createElement("p");
  route.textContent = point.topPath || "No route summary";
  const detail = document.createElement("small");
  detail.textContent = `${point.topSource || "direct"} · ${formatDate(point.latestAt)}`;
  card.append(eyebrow, heading, metrics, route, detail);
  return card;
}

function fitAudiencePoints(
  instance: MapLibreMap,
  points: AnalyticsReport["geography"],
) {
  if (points.length === 1) {
    instance.jumpTo({
      center: [points[0].longitude, points[0].latitude],
      zoom: 4.25,
    });
    return;
  }
  const latitudes = points.map((point) => point.latitude);
  const { west, east } = minimumLongitudeExtent(
    points.map((point) => point.longitude),
  );
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  if (east - west < 0.001 && north - south < 0.001) {
    instance.jumpTo({ center: [west, south], zoom: 4.25 });
    return;
  }
  const bounds = new maplibregl.LngLatBounds([west, south], [east, north]);
  instance.fitBounds(bounds, { padding: 76, maxZoom: 5.5, duration: 0 });
}

function minimumLongitudeExtent(longitudes: number[]) {
  const sorted = longitudes
    .map((longitude) => ((((longitude + 180) % 360) + 360) % 360) - 180)
    .sort((left, right) => left - right);
  let largestGap = -1;
  let gapStart = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const next = index === sorted.length - 1 ? sorted[0] + 360 : sorted[index + 1];
    const gap = next - sorted[index];
    if (gap > largestGap) {
      largestGap = gap;
      gapStart = index;
    }
  }
  const west = sorted[(gapStart + 1) % sorted.length];
  const rawEast = sorted[gapStart];
  return { west, east: rawEast < west ? rawEast + 360 : rawEast };
}

function webGlSupported() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

async function verifyAnalyticsVectorSource(signal: AbortSignal) {
  const tileJsonResponse = await fetch("https://tiles.openfreemap.org/planet", {
    signal,
  });
  if (!tileJsonResponse.ok)
    throw new Error(`OpenFreeMap TileJSON returned ${tileJsonResponse.status}`);
  const tileJson = (await tileJsonResponse.json()) as { tiles?: string[] };
  const template = tileJson.tiles?.[0];
  if (!template) throw new Error("OpenFreeMap TileJSON has no tile template");
  const tileResponse = await fetch(
    template.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0"),
    { signal },
  );
  if (!tileResponse.ok)
    throw new Error(`OpenFreeMap tile returned ${tileResponse.status}`);
  if ((await tileResponse.arrayBuffer()).byteLength < 1)
    throw new Error("OpenFreeMap tile was empty");
}
function TrafficMatrix({ report }: { report: AnalyticsReport }) {
  return (
    <section className="analytics-matrix">
      <header>
        <div>
          <p className="eyebrow">Traffic comparison matrix</p>
          <h2>Four windows. One honest baseline.</h2>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => resetResizableTable("analytics-comparison")}
        >
          Reset columns
        </button>
      </header>
      <div className="analytics-table-scroll">
        <table data-resizable-key="analytics-comparison">
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
  const [activePoint, setActivePoint] = useState<number | null>(null);
  const rawMax = Math.max(
    1,
    ...report.series.flatMap((row) => [row.views, row.sessions]),
  );
  const max = trendAxisMax(rawMax);
  const views = trendPoints(report.series.map((row) => row.views), max);
  const sessions = trendPoints(report.series.map((row) => row.sessions), max);
  const viewsPath = smoothTrendPath(views);
  const sessionsPath = smoothTrendPath(sessions);
  const areaPath = views.length
    ? `${viewsPath} L ${views.at(-1)!.x} 218 L ${views[0].x} 218 Z`
    : "";
  const peak = Math.max(0, ...report.series.map((row) => row.views));
  const latest = report.series.at(-1);
  const chartKey = report.series.map((row) => `${row.views}:${row.sessions}`).join("|");
  const yTicks = [0, 1, 2, 3, 4].map((index) => ({ y: 44 + index * 43.5, value: Math.round(max * (1 - index / 4)) }));
  const xTicks = trendTimeTicks(report.series);
  const activeRow = activePoint === null ? null : report.series[activePoint] || null;
  const activeViewPoint = activePoint === null ? null : views[activePoint] || null;
  const activeSessionPoint = activePoint === null ? null : sessions[activePoint] || null;
  const activePrevious = activePoint === null || activePoint === 0 ? null : report.series[activePoint - 1] || null;
  return (
    <article className="analytics-card analytics-trend">
      <header>
        <div>
          <h3>Audience trend</h3>
          <span>{report.bucket}ly buckets · UTC</span>
        </div>
        <div className="analytics-trend__legend" aria-label="Chart legend">
          <span className="is-views"><i /> Views</span>
          <span className="is-sessions"><i /> Sessions</span>
        </div>
      </header>
      <div className="analytics-trend__plot">
        <svg key={chartKey} viewBox="0 0 1000 280" role="img" aria-label={`Views and sessions trend across ${report.series.length} ${report.bucket}ly buckets`} onMouseLeave={() => setActivePoint(null)}>
          <title>Audience activity trend</title>
          <desc>Interactive page-view and anonymous-session lines. Focus or hover a bucket for its timestamp and exact values.</desc>
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd83d" stopOpacity=".46" /><stop offset=".46" stopColor="#d7a900" stopOpacity=".18" /><stop offset="1" stopColor="#f3c928" stopOpacity="0" /></linearGradient>
            <linearGradient id="trend-line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#be8b00" /><stop offset=".45" stopColor="#ffe56f" /><stop offset="1" stopColor="#f3c928" /></linearGradient>
            <filter id="trend-glow" x="-20%" y="-80%" width="140%" height="260%"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          <g className="analytics-trend__grid" aria-hidden="true">{yTicks.map((tick) => <line key={tick.y} x1="72" x2="968" y1={tick.y} y2={tick.y} />)}</g>
          <g className="analytics-trend__y-axis" aria-hidden="true"><text className="analytics-trend__axis-title" x="14" y="132" transform="rotate(-90 14 132)">Events / bucket</text>{yTicks.map((tick) => <text key={tick.y} x="61" y={tick.y + 3}>{tick.value}</text>)}</g>
          <path className="analytics-trend__area" d={areaPath} fill="url(#trend-fill)" />
          <path className="analytics-trend__glow" d={viewsPath} pathLength="1" />
          <path className="analytics-trend__line is-views" d={viewsPath} pathLength="1" />
          <path className="analytics-trend__line is-sessions" d={sessionsPath} pathLength="1" />
          {activeViewPoint ? <g className="analytics-trend__crosshair" aria-hidden="true"><line x1={activeViewPoint.x} x2={activeViewPoint.x} y1="44" y2="218" /><line x1="72" x2="968" y1={activeViewPoint.y} y2={activeViewPoint.y} /></g> : null}
          <g className="analytics-trend__points">{views.map((point, index) => {
            const row = report.series[index]; const sessionPoint = sessions[index]; const selected = activePoint === index;
            return <g key={row.bucket} className={`analytics-trend__bucket${selected ? " is-active" : ""}`} role="button" tabIndex={0} aria-label={trendPointLabel(row)} aria-describedby={selected ? "analytics-trend-tooltip" : undefined} onMouseEnter={() => setActivePoint(index)} onFocus={() => setActivePoint(index)} onBlur={() => setActivePoint(null)} onClick={() => setActivePoint(index)} onKeyDown={(event) => { if (event.key === "Escape") { setActivePoint(null); event.currentTarget.blur(); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActivePoint(index); } }}><rect className="analytics-trend__hit" x={point.x - 18} y="36" width="36" height="190" rx="9" /><circle className="is-views" cx={point.x} cy={point.y} r={selected ? 6 : 4.5} /><circle className="is-sessions" cx={sessionPoint.x} cy={sessionPoint.y} r={selected ? 5 : 3.5} /></g>;
          })}</g>
          <g className="analytics-trend__x-axis" aria-hidden="true">{xTicks.map((tick) => <text key={tick.index} className={tick.position} x={views[tick.index].x} y="252">{formatTrendAxisBucket(tick.bucket, report.bucket)}</text>)}<text className="analytics-trend__axis-title" x="968" y="273">UTC · {report.bucket}ly</text></g>
        </svg>
        {activeRow && activeViewPoint && activeSessionPoint ? <div id="analytics-trend-tooltip" role="tooltip" className={`analytics-trend__tooltip${activeViewPoint.x < 230 ? " is-start" : activeViewPoint.x > 770 ? " is-end" : ""}${activeViewPoint.y < 98 ? " is-below" : ""}`} style={{ left: `${activeViewPoint.x / 10}%`, top: `${activeViewPoint.y / 2.8}%` }}><strong>{formatDate(activeRow.bucket)}</strong><dl><div><dt>Views</dt><dd>{number(activeRow.views)}</dd></div><div><dt>Sessions</dt><dd>{number(activeRow.sessions)}</dd></div><div><dt>Pages / session</dt><dd>{activeRow.sessions ? (activeRow.views / activeRow.sessions).toFixed(2) : "—"}</dd></div></dl><small>{activePrevious ? trendDelta(activeRow.views, activePrevious.views, "view") : "First retained bucket in this window"}</small></div> : null}
      </div>
      <dl className="analytics-trend__summary">
        <div><dt>Window views</dt><dd>{number(report.selected.views)}</dd></div>
        <div><dt>Peak bucket</dt><dd>{number(peak)}</dd></div>
        <div><dt>Latest signal</dt><dd>{latest ? `${number(latest.views)} / ${number(latest.sessions)}` : "—"}</dd></div>
      </dl>
    </article>
  );
}

type TrendPoint = { x: number; y: number };

function trendPoints(values: number[], max: number): TrendPoint[] {
  if (!values.length) return [];
  if (values.length === 1) {
    const y = 218 - (values[0] / max) * 174;
    return [{ x: 520, y }];
  }
  return values.map((value, index) => ({
    x: 72 + (index / (values.length - 1)) * 896,
    y: 218 - (value / max) * 174,
  }));
}

function smoothTrendPath(points: TrendPoint[]) {
  if (!points.length) return "";
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const middle = (previous.x + point.x) / 2;
    return `${path} C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}
function trendAxisMax(value: number) { const roughStep = Math.max(value, 1) / 4; const magnitude = 10 ** Math.floor(Math.log10(roughStep)); const normalized = roughStep / magnitude; const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10; return step * magnitude * 4; }
function trendTimeTicks(series: AnalyticsReport["series"]) { if (!series.length) return []; const count = Math.min(5, series.length); const indices = Array.from({ length: count }, (_, index) => Math.round(index * (series.length - 1) / Math.max(count - 1, 1))); return [...new Set(indices)].map((index) => ({ index, bucket: series[index].bucket, position: index === 0 ? "is-start" : index === series.length - 1 ? "is-end" : "is-secondary" })); }
function formatTrendAxisBucket(value: string, bucket: AnalyticsReport["bucket"]) { const date = new Date(value); if (Number.isNaN(date.valueOf())) return "Unknown"; return bucket === "hour" ? new Intl.DateTimeFormat("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(date) : new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: "UTC" }).format(date); }
function trendPointLabel(row: AnalyticsReport["series"][number]) { return `${formatDate(row.bucket)}: ${row.views} views, ${row.sessions} sessions, ${row.sessions ? (row.views / row.sessions).toFixed(2) : "no"} pages per session`; }
function trendDelta(value: number, previous: number, noun: string) { const delta = value - previous; return delta === 0 ? `No change in ${noun}s from the previous bucket` : `${delta > 0 ? "+" : ""}${delta} ${noun}${Math.abs(delta) === 1 ? "" : "s"} from the previous bucket`; }
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
        <Link to="/commerce/analytics">Open Commerce Intelligence</Link>
      </header>
      {!report.revenue.available ? (
        <p>{report.revenue.unavailableReason}</p>
      ) : report.revenue.currencies.length ? (
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
      {report.revenue.partial ? <small>Revenue Pulse is partial because one commerce collection source is unavailable.</small> : null}
      <small>{report.revenue.profitUnavailableReason}</small>
    </article>
  );
}
function analyticsFailure(reason: unknown): AnalyticsFailure {
  if (reason instanceof AnalyticsApiError) {
    if (reason.code === "analytics_migration_required" || reason.code === "service_schema_mismatch") return { kind: "migration", message: "Apply the required Analytics schema migration before collection and reporting can begin. No traffic has been reported as zero." };
    if (reason.status === 401 || reason.status === 403) return { kind: "auth", message: "Sign in again with an authorized Admin account, then return to Audience Analytics." };
    return { kind: "query", message: reason.message };
  }
  return { kind: "query", message: reason instanceof Error ? reason.message : "Audience analytics are unavailable." };
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
function compactNumber(value: number) {
  return new Intl.NumberFormat("en-AU", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
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
