import { useId, useRef } from "react";
import { Link } from "react-router-dom";
import type { AutomationPayload } from "../polls/admin-client";
import { classifyRuntimeHealth, runtimeHealthObservation, type RuntimeHealthObservation, type RuntimeOverallState } from "../runtime-health";
import "../styles/bot-heartbeat.css";

type BotHeartbeatCardProps = { payload: AutomationPayload | null; error?: string; loading?: boolean; compact?: boolean; linkTo?: string };

const SIGNAL_PATHS: Record<RuntimeOverallState, string> = {
  healthy: "M0 72 H118 L132 69 L143 74 L157 72 H178 L193 101 L214 20 L235 111 L254 72 H390 L404 69 L415 74 L429 72 H450 L465 101 L486 20 L507 111 L526 72 H662 L676 69 L687 74 L701 72 H800",
  catching_up: "M0 72 H82 L96 68 L110 77 L124 72 H143 L157 97 L173 35 L190 105 L208 56 L225 72 H296 L311 68 L326 79 L341 72 H361 L377 103 L394 27 L412 102 L430 58 L448 72 H520 L535 67 L551 78 L567 72 H586 L603 99 L620 37 L638 94 L656 72 H800",
  recovering: "M0 72 H92 C112 72 112 57 132 57 S152 87 172 87 S192 72 212 72 H350 C370 72 370 57 390 57 S430 87 450 87 S470 72 490 72 H628 C648 72 648 57 668 57 S708 87 728 87 S748 72 768 72 H800",
  warning: "M0 72 H104 L119 69 L133 76 L146 72 H168 L181 92 L196 43 L211 107 L229 60 L246 72 H339 L356 69 L371 78 L386 72 H404 L421 105 L439 31 L456 99 L474 62 L491 72 H591 L609 68 L626 79 L641 72 H660 L677 96 L692 49 L710 91 L728 72 H800",
  degraded: "M0 72 H142 L157 70 L172 76 L187 72 H222 L238 94 L253 45 L269 102 L286 65 L303 72 H479 L495 69 L511 77 L527 72 H562 L578 95 L594 44 L610 102 L627 64 L644 72 H800",
  offline: "M0 72 H210 L224 70 L238 74 L252 72 H548 L562 70 L576 74 L590 72 H800",
  unknown: "M0 72 H150 C175 72 175 66 200 66 S225 78 250 78 S275 72 300 72 H500 C525 72 525 66 550 66 S575 78 600 78 S625 72 650 72 H800",
};

export function BotHeartbeatCard({ payload, error, loading = false, compact = false, linkTo }: BotHeartbeatCardProps) {
  const signalId = useId().replace(/:/g, "");
  const history = useRef<RuntimeHealthObservation[]>([]);
  if (payload) {
    const observation = runtimeHealthObservation(payload);
    if (observation && history.current.at(-1)?.sampledAt !== observation.sampledAt) history.current = [...history.current.slice(-23), observation];
  }
  const status = classifyRuntimeHealth(payload, history.current, Date.now(), error ? "error" : loading ? "loading" : "ready");
  const runtime = payload?.runtime;
  const desired = payload?.config.desiredRevision;
  const applied = optionalNumber(runtime?.appliedRevision);
  const heartbeatAt = stringValue(runtime?.heartbeatAt);
  const path = SIGNAL_PATHS[status.visualTone];

  return <section className={`bot-heartbeat bot-heartbeat--${status.visualTone}${compact ? " bot-heartbeat--compact" : ""}`} data-heartbeat-tone={status.visualTone} data-heartbeat-state={status.heartbeatState} data-pipeline-state={status.pipelineState} data-provider-state={status.providerState} aria-labelledby={`${signalId}-title`}>
    <div className="bot-heartbeat__aura" aria-hidden="true" />
    <div className="bot-heartbeat__main">
      <header className="bot-heartbeat__header">
        <div className="bot-heartbeat__identity"><span className="bot-heartbeat__glyph" aria-hidden="true"><i /><i /></span><div><span>Bot runtime signal</span><strong>{status.level}</strong></div></div>
        <span className="bot-heartbeat__badge"><i aria-hidden="true" />{status.chip}</span>
      </header>
      <div className="bot-heartbeat__copy"><p>{status.kicker}</p><h2 id={`${signalId}-title`}>{status.headline}</h2><span>{status.summary}</span></div>
      <div className="bot-heartbeat__signal" aria-hidden="true">
        <div className="bot-heartbeat__grid" />
        <svg viewBox="0 0 800 132" preserveAspectRatio="none"><defs><linearGradient id={`${signalId}-signal`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="currentColor" stopOpacity="0" /><stop offset=".16" stopColor="currentColor" stopOpacity=".88" /><stop offset=".78" stopColor="currentColor" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient><filter id={`${signalId}-glow`} x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs><path className="bot-heartbeat__baseline" d="M0 72 H800" /><path className="bot-heartbeat__track" d={path} /><path className="bot-heartbeat__trace" d={path} pathLength="1" stroke={`url(#${signalId}-signal)`} filter={`url(#${signalId}-glow)`} /></svg>
        <span className="bot-heartbeat__sweep" /><span className="bot-heartbeat__readout">{status.readout}</span>
      </div>
      {!compact ? <p className="bot-heartbeat__disclaimer">Heartbeat, event-window, provider, revision, and delivery states are classified independently. Credential presence never implies provider health.</p> : null}
    </div>
    <dl className="bot-heartbeat__telemetry">
      <HeartbeatFact label="Last heartbeat" value={heartbeatAt ? formatDateTime(heartbeatAt) : loading ? "Reading" : "Never"} subvalue={heartbeatAge(runtime?.ageSeconds, heartbeatAt)} />
      <HeartbeatFact label="Bot version" value={stringValue(runtime?.botVersion) || "Not reported"} subvalue="Runtime release" />
      <HeartbeatFact label="Discord runtime" value={status.providerLabel} subvalue={status.providerDetail} state={status.providerState} />
      <HeartbeatFact label="Revision state" value={revisionLabel(status.revisionState)} subvalue={desired !== undefined && applied !== null ? `Desired ${desired} / applied ${applied}` : "No revision signal"} state={status.revisionState} />
      <HeartbeatFact label="Event pipeline" value={status.pipelineLabel} subvalue={status.pipelineDetail} state={status.pipelineState} wide={compact} />
      {!compact ? <HeartbeatFact label="Publish delivery" value={status.publicationLabel} subvalue={status.publicationDetail} state={status.publicationState} /> : null}
      {linkTo ? <div className="bot-heartbeat__link"><Link to={linkTo}>Open Automations <span aria-hidden="true">→</span></Link></div> : null}
    </dl>
  </section>;
}

function HeartbeatFact({ label, value, subvalue, state, wide = false }: { label: string; value: string; subvalue: string; state?: string; wide?: boolean }) { return <div className={wide ? "is-wide" : undefined} data-runtime-fact-state={state}><dt>{label}</dt><dd>{value}</dd><small>{subvalue}</small></div>; }
function revisionLabel(state: string) { return state === "synchronized" ? "Synchronized" : state === "drifted" ? "Drifted" : "Not reported"; }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function optionalNumber(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : null; }
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown" : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function heartbeatAge(value: unknown, heartbeatAt: string) { const reported = optionalNumber(value); const seconds = reported ?? (heartbeatAt ? Math.max(0, Math.round((Date.now() - new Date(heartbeatAt).valueOf()) / 1000)) : 0); if (!heartbeatAt) return "No pulse recorded"; if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; return `${Math.floor(seconds / 3600)}h ago`; }
