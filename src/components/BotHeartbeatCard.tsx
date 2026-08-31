import { useId } from "react";
import { Link } from "react-router-dom";
import type { AutomationPayload } from "../polls/admin-client";
import "../styles/bot-heartbeat.css";

type HeartbeatTone = "healthy" | "warning" | "critical" | "info";

type BotHeartbeatCardProps = {
  payload: AutomationPayload | null;
  error?: string;
  loading?: boolean;
  compact?: boolean;
  linkTo?: string;
};

const SIGNAL_PATHS: Record<HeartbeatTone, string> = {
  healthy: "M0 72 H118 L132 69 L143 74 L157 72 H178 L193 101 L214 20 L235 111 L254 72 H390 L404 69 L415 74 L429 72 H450 L465 101 L486 20 L507 111 L526 72 H662 L676 69 L687 74 L701 72 H800",
  warning: "M0 72 H104 L119 69 L133 76 L146 72 H168 L181 92 L196 43 L211 107 L229 60 L246 72 H339 L356 69 L371 78 L386 72 H404 L421 105 L439 31 L456 99 L474 62 L491 72 H591 L609 68 L626 79 L641 72 H660 L677 96 L692 49 L710 91 L728 72 H800",
  critical: "M0 72 H210 L224 70 L238 74 L252 72 H548 L562 70 L576 74 L590 72 H800",
  info: "M0 72 H92 C112 72 112 57 132 57 S152 87 172 87 S192 72 212 72 H350 C370 72 370 57 390 57 S430 87 450 87 S470 72 490 72 H628 C648 72 648 57 668 57 S708 87 728 87 S748 72 768 72 H800",
};

export function BotHeartbeatCard({ payload, error, loading = false, compact = false, linkTo }: BotHeartbeatCardProps) {
  const signalId = useId().replace(/:/g, "");
  const status = heartbeatPresentation(payload, error, loading);
  const runtime = payload?.runtime;
  const desired = payload?.config.desiredRevision ?? 0;
  const applied = numberValue(runtime?.appliedRevision);
  const heartbeatAt = stringValue(runtime?.heartbeatAt);
  const discordConnected = runtime?.discordConnected;
  const configWarning = stringValue(runtime?.configSyncState);
  const warning = stringValue(runtime?.errorCode) || (status.pending ? configWarning && configWarning !== "synchronized" ? configWarning : "Revision pending" : "None");

  return <section className={`bot-heartbeat bot-heartbeat--${status.tone}${compact ? " bot-heartbeat--compact" : ""}`} data-heartbeat-tone={status.tone} aria-labelledby={`${signalId}-title`}>
    <div className="bot-heartbeat__aura" aria-hidden="true" />
    <div className="bot-heartbeat__main">
      <header className="bot-heartbeat__header">
        <div className="bot-heartbeat__identity"><span className="bot-heartbeat__glyph" aria-hidden="true"><i /><i /></span><div><span>Bot runtime signal</span><strong>{status.level}</strong></div></div>
        <span className="bot-heartbeat__badge"><i aria-hidden="true" />{status.badge}</span>
      </header>
      <div className="bot-heartbeat__copy">
        <p>{status.kicker}</p>
        <h2 id={`${signalId}-title`}>{status.title}</h2>
        <span>{status.detail}</span>
      </div>
      <div className="bot-heartbeat__signal" aria-hidden="true">
        <div className="bot-heartbeat__grid" />
        <svg viewBox="0 0 800 132" preserveAspectRatio="none">
          <defs>
            <linearGradient id={`${signalId}-signal`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="currentColor" stopOpacity="0" /><stop offset=".16" stopColor="currentColor" stopOpacity=".88" /><stop offset=".78" stopColor="currentColor" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient>
            <filter id={`${signalId}-glow`} x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          <path className="bot-heartbeat__baseline" d="M0 72 H800" />
          <path className="bot-heartbeat__track" d={SIGNAL_PATHS[status.tone]} />
          <path className="bot-heartbeat__trace" d={SIGNAL_PATHS[status.tone]} pathLength="1" stroke={`url(#${signalId}-signal)`} filter={`url(#${signalId}-glow)`} />
        </svg>
        <span className="bot-heartbeat__sweep" />
        <span className="bot-heartbeat__readout">{status.readout}</span>
      </div>
      {!compact ? <p className="bot-heartbeat__disclaimer">Credential presence is reported independently and never implies provider health.</p> : null}
    </div>
    <dl className="bot-heartbeat__telemetry">
      <HeartbeatFact label="Last heartbeat" value={heartbeatAt ? formatDateTime(heartbeatAt) : loading ? "Reading" : "Never"} subvalue={heartbeatAge(runtime?.ageSeconds, heartbeatAt)} />
      <HeartbeatFact label="Bot version" value={stringValue(runtime?.botVersion) || "Not reported"} subvalue="Runtime release" />
      <HeartbeatFact label="Discord runtime" value={typeof discordConnected === "boolean" ? discordConnected ? "Connected" : "Disconnected" : "Not reported"} subvalue={typeof discordConnected === "boolean" ? "Provider socket" : "No provider signal"} />
      <HeartbeatFact label="Revision state" value={status.pending ? "Pending apply" : payload ? "Synchronized" : "Unavailable"} subvalue={payload ? `Desired ${desired} / applied ${applied}` : "No revision signal"} />
      {!compact ? <HeartbeatFact label="Safe warning" value={warning} subvalue="Sanitized runtime state" wide /> : null}
      {linkTo ? <div className="bot-heartbeat__link"><Link to={linkTo}>Open Automations <span aria-hidden="true">→</span></Link></div> : null}
    </dl>
  </section>;
}

function heartbeatPresentation(payload: AutomationPayload | null, error?: string, loading?: boolean) {
  const runtime = payload?.runtime;
  const state = runtime?.state;
  const desired = payload?.config.desiredRevision ?? 0;
  const applied = numberValue(runtime?.appliedRevision);
  const configState = stringValue(runtime?.configSyncState);
  const pending = Boolean(payload && (desired !== applied || new Set(["local_pending", "conflict", "conflict_resolved_remote"]).has(configState)));
  const hasFault = Boolean(stringValue(runtime?.errorCode) || runtime?.discordConnected === false);
  const backlogWarning = runtime?.backlogMayBeTruncated === true;

  if (error) return { tone: "critical" as const, level: "Error", badge: "Fault", kicker: "Signal unavailable", title: "Bot heartbeat could not be read", detail: "The control-plane request failed. Runtime state has not been inferred from cached or placeholder data.", readout: "NO SIGNAL", pending };
  if (!payload) return { tone: "info" as const, level: "Information", badge: loading ? "Reading" : "Unavailable", kicker: "Awaiting authority", title: loading ? "Reading bot heartbeat" : "Bot heartbeat is unavailable", detail: loading ? "Requesting the signed runtime signal and desired revision state." : "No current runtime report is available for this role or request.", readout: loading ? "ACQUIRING" : "NO DATA", pending };
  if (state === "offline") return { tone: "critical" as const, level: "Critical", badge: "Flatline", kicker: "Runtime offline", title: "Bot heartbeat has flatlined", detail: "No current bot pulse is available. Treat provider delivery and automation execution as unavailable.", readout: "FLATLINE", pending };
  if (hasFault) return { tone: "critical" as const, level: "Error", badge: "Fault", kicker: "Runtime fault", title: "Bot heartbeat reports a fault", detail: "The process is reporting, but a sanitized runtime or Discord connection fault requires attention.", readout: "FAULT", pending };
  if (state === "stale") return { tone: "warning" as const, level: "Warning", badge: "Stale", kicker: "Delayed runtime signal", title: "Bot heartbeat is stale", detail: "The last signed pulse is outside the current window. Verify the runtime before relying on automation delivery.", readout: "DEGRADED", pending };
  if (pending || backlogWarning) return { tone: "warning" as const, level: "Warning", badge: pending ? "Syncing" : "Backlog", kicker: pending ? "Revision convergence" : "Runtime delivery warning", title: pending ? "Bot heartbeat is current; configuration is pending" : "Bot heartbeat is current with a warning", detail: pending ? "The runtime is alive while desired and applied revisions converge." : "The runtime is alive, but the reported event backlog may be incomplete.", readout: pending ? "CONVERGING" : "DEGRADED", pending };
  return { tone: "healthy" as const, level: "Healthy", badge: "Current", kicker: "Live signed pulse", title: "Bot heartbeat is current", detail: "The signed runtime pulse is current and the desired configuration revision is synchronized.", readout: "LIVE SIGNAL", pending };
}

function HeartbeatFact({ label, value, subvalue, wide = false }: { label: string; value: string; subvalue: string; wide?: boolean }) {
  return <div className={wide ? "is-wide" : ""}><dt>{label}</dt><dd>{value}</dd><small>{subvalue}</small></div>;
}

function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : 0; }
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown" : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function heartbeatAge(value: unknown, heartbeatAt: string) {
  const reported = numberValue(value);
  const seconds = reported || (heartbeatAt ? Math.max(0, Math.round((Date.now() - new Date(heartbeatAt).valueOf()) / 1000)) : 0);
  if (!heartbeatAt) return "No pulse recorded";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
