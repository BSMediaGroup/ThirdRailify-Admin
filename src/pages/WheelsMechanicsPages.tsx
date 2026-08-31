import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { useAdminToast } from "../components/AdminToasts";
import { getStageLibrary, getWheelLibrary, getWheelResults, getWheelSettings, saveSettings } from "../wheels/client";
import {
  CURVE_PRESETS,
  MECHANICS_BOUNDS,
  calculateNaturalnessDiagnostics,
  cloneDefaultWheelMechanics,
  compileVelocityProfile,
  decelerationAt,
  estimatedFullTurnRange,
  normalizeWheelMechanics,
  progressAt,
  velocityAt,
  type CompiledWheelMechanics,
  type CustomShapePoint,
  type WheelCurveProfile,
  type WheelMechanics,
} from "../wheels/mechanics.mjs";
import "../styles/wheels-admin.css";
import "../styles/wheels-mechanics.css";

const TABS = [{ to: "/wheels", label: "Overview" }, { to: "/wheels/library", label: "Library" }, { to: "/wheels/stages", label: "Stages" }, { to: "/wheels/mechanics", label: "Mechanics" }, { to: "/wheels/access", label: "Access" }, { to: "/wheels/results", label: "Results" }];
const PROFILE_IDS: WheelCurveProfile[] = ["natural-hybrid", "heavy-flywheel", "suspense-tail", "quick-draw", "mechanical-clicker", "classic-linear", "legacy-broadcast-smooth", "custom-physics", "custom-shape"];

type PolicyDraft = Record<string, unknown> & { mechanics: WheelMechanics };
type LoadedPolicy = { values: PolicyDraft; revision: number; updatedAt: string | null };

export function WheelsOverviewPage() {
  const { startLoading } = useOutletContext<AdminShellOutletContext>(); const [data, setData] = useState<null | { wheels: Awaited<ReturnType<typeof getWheelLibrary>>["items"]; stages: Awaited<ReturnType<typeof getStageLibrary>>["items"]; results: Awaited<ReturnType<typeof getWheelResults>>["items"]; policy: Awaited<ReturnType<typeof getWheelSettings>> }>(null); const [error, setError] = useState("");
  const load = useCallback(() => { const stop = startLoading("Loading Wheels overview"); return Promise.all([getWheelLibrary(), getStageLibrary(), getWheelResults(), getWheelSettings()]).then(([wheels, stages, results, policy]) => setData({ wheels: wheels.items, stages: stages.items, results: results.items, policy })).catch((reason) => setError(message(reason))).finally(stop); }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  const mechanics = data ? normalizeWheelMechanics(data.policy.settings.mechanics) : cloneDefaultWheelMechanics();
  return <><Heading title="Wheels Overview" summary="One operational view of Wheel inventory, Stages, official result history, access, and global spin mechanics." /><Tabs />{error ? <Alert>{error}</Alert> : null}{data ? <><section className="wheels-admin-metrics wheels-overview-metrics"><Metric label="Total Wheels" value={data.wheels.length} /><Metric label="Active" value={data.wheels.filter((item) => item.lifecycle === "active").length} /><Metric label="Public" value={data.wheels.filter((item) => item.lifecycle === "active" && item.visibility === "public").length} /><Metric label="Hidden / private" value={data.wheels.filter((item) => item.visibility !== "public").length} /><Metric label="Archived" value={data.wheels.filter((item) => item.lifecycle === "archived").length} /><Metric label="Participants" value={data.wheels.reduce((sum, item) => sum + item.participantCount, 0)} /><Metric label="Stages" value={data.stages.length} /><Metric label="Official results" value={data.results.length} /></section><section className="wheels-overview-mechanics"><div><p className="eyebrow">GLOBAL MECHANICS Â· POLICY REVISION {data.policy.revision}</p><h2>{profileName(mechanics.curveProfile)}</h2><p>{mechanics.launchRpsMin.toFixed(1)}â€“{mechanics.launchRpsMax.toFixed(1)} RPS launch Â· {(mechanics.minimumSpinDurationMs / 1000).toFixed(0)}â€“{(mechanics.maximumSpinDurationMs / 1000).toFixed(0)} second duration range Â· {Number(data.policy.settings.officialSpinCooldownSeconds || 2)} second official cooldown</p></div><Link className="primary-button" to="/wheels/mechanics">Tune mechanics</Link></section><section className="wheels-overview-jumps"><Jump to="/wheels/library" eyebrow="INVENTORY" title="Wheel Library" copy="Lifecycle, visibility, locks, owners and participant counts." /><Jump to="/wheels/stages" eyebrow="MULTI-WHEEL" title="Wheel Stages" copy="Ordered Stage membership and lifecycle authority." /><Jump to="/wheels/mechanics" eyebrow="GLOBAL POLICY" title="Mechanics" copy="Decay curves, launch envelope, duration rules and preview." /><Jump to="/wheels/access" eyebrow="AUTHORITY" title="Wheel Access" copy="Creator grants and least-privilege Wheel roles." /><Jump to="/wheels/results" eyebrow="IMMUTABLE HISTORY" title="Official Results" copy="Recorded winners, snapshots, revisions and audited voids." /><a className="wheels-overview-jump" href="https://thirdrailify.com/wheels" target="_blank" rel="noreferrer"><span>PUBLIC</span><strong>Wheels directory â†—</strong><p>Open the live Public discovery experience.</p></a></section><WheelAutomationScaffold /></> : <Loading>Loading real Wheels authorityâ€¦</Loading>}</>;
}

export function WheelsMechanicsPage() {
  const { csrfToken, hasCapability } = useAuth();
  const canManage = hasCapability("wheels.manage");
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const { showToast } = useAdminToast();
  const [loaded, setLoaded] = useState<LoadedPolicy | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    const stop = startLoading("Loading global Wheel mechanics");
    setError("");
    return getWheelSettings()
      .then((payload) => {
        const values = { ...payload.settings, mechanics: normalizeWheelMechanics(payload.settings.mechanics) } as PolicyDraft;
        setLoaded({ values, revision: payload.revision, updatedAt: payload.updatedAt });
        setDraft(structuredClone(values));
      })
      .catch((reason) => setError(message(reason)))
      .finally(stop);
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);

  const dirty = Boolean(loaded && draft && JSON.stringify(loaded.values) !== JSON.stringify(draft));
  const mechanics = draft?.mechanics || cloneDefaultWheelMechanics();
  const currentMechanics = loaded?.values.mechanics || mechanics;
  const compiled = useMemo(() => compileVelocityProfile(mechanics), [mechanics]);
  const currentCompiled = useMemo(() => compileVelocityProfile(currentMechanics), [currentMechanics]);
  const diagnostics = useMemo(() => calculateNaturalnessDiagnostics(compiled), [compiled]);
  const ranges = useMemo(() => [10_000, 60_000].map((duration) => estimatedFullTurnRange(duration, mechanics)), [mechanics]);
  const updateMechanics = (next: Partial<WheelMechanics>) => setDraft((current) => current ? { ...current, mechanics: { ...current.mechanics, ...next } as WheelMechanics } : current);
  const updatePolicy = (key: string, value: unknown) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !loaded || !csrfToken || !canManage) return;
    setSaving(true);
    setError("");
    try {
      const valid = normalizeWheelMechanics(draft.mechanics, { strict: true });
      const payload = await saveSettings(csrfToken, { ...draft, mechanics: valid, revision: loaded.revision });
      const values = { ...payload.settings, mechanics: normalizeWheelMechanics(payload.settings.mechanics) } as PolicyDraft;
      setLoaded({ values, revision: payload.revision, updatedAt: payload.updatedAt });
      setDraft(structuredClone(values));
      showToast("Mechanics saved at policy revision " + payload.revision + ".", { title: "Wheel mechanics saved" });
    } catch (reason) { setError(message(reason)); }
    finally { setSaving(false); }
  };
  const discard = () => {
    if (!loaded) return;
    setDraft(structuredClone(loaded.values));
    setError("");
    showToast("Unsaved changes discarded.", { tone: "info", title: "Draft discarded" });
  };
  const reset = () => {
    setDraft((current) => current ? { ...current, mechanics: cloneDefaultWheelMechanics() } : current);
    showToast("Natural Hybrid defaults loaded into the unsaved draft.", { tone: "info", title: "Defaults loaded" });
  };

  if (!draft || !loaded) return <><Heading title="Wheel Mechanics" summary="Global visual spin policy and bounded fairness-preserving defaults." /><Tabs />{error ? <Alert>{error}</Alert> : <Loading>Loading revisioned mechanics authority…</Loading>}</>;

  return <form className="wheel-mechanics-page" onSubmit={save}>
    <Heading title="Wheel Mechanics" summary="Compile one frame-rate-independent velocity trajectory for regular, Presentation, Stage, Practice, Demo and Official visual spins." />
    <Tabs />
    {error ? <Alert>{error}</Alert> : null}
    {!canManage ? <div className="mechanics-readonly" role="status"><strong>Read-only access</strong><span>You can inspect and preview mechanics, but this account cannot change the global policy.</span></div> : null}
    <div className="mechanics-savebar">
      <div><span>POLICY REVISION {loaded.revision} · MECHANICS V2</span><strong>{dirty ? "Unsaved mechanics draft" : "Saved mechanics active"}</strong></div>
      <button type="button" className="secondary-button" disabled={!dirty || saving} onClick={discard}>Discard</button>
      <button type="button" className="secondary-button" disabled={saving || !canManage} onClick={reset}>Reset to Natural Hybrid</button>
      <button type="submit" className="primary-button" disabled={!canManage || !dirty || saving}>{saving ? "Saving…" : "Save Mechanics"}</button>
    </div>

    <fieldset className="mechanics-editor-fieldset" disabled={!canManage}>
      <section className="mechanics-panel">
        <SectionTitle eyebrow="1 · DECAY MODEL" title="Choose the velocity signature" copy="Every thumbnail is sampled from the same compiled curve consumed by live spins." />
        <div className="curve-preset-grid">{PROFILE_IDS.map((profile) => <CurveCard key={profile} profile={profile} selected={mechanics.curveProfile === profile} mechanics={mechanics} onSelect={() => updateMechanics({ curveProfile: profile })} />)}</div>
      </section>

      <PhysicsControls mechanics={mechanics} onChange={(physics) => updateMechanics({ curveProfile: "custom-physics", physics })} />

      <section className="mechanics-panel">
        <SectionTitle eyebrow="3 · ADVANCED CURVE" title="Shape-preserving custom velocity" copy="Seven bounded points use monotone PCHIP interpolation. Endpoints stay locked; reverse motion and overshoot are impossible." />
        <CustomShapeEditor points={mechanics.customShape.points} onChange={(points) => updateMechanics({ curveProfile: "custom-shape", customShape: { interpolation: "monotone-pchip", points } })} />
      </section>

      <section className="mechanics-control-grid">
        <div className="mechanics-panel">
          <SectionTitle eyebrow="4 · LAUNCH / REVOLUTIONS" title="Bounded travel envelope" copy="Launch speed is converted through the compiled curve area, then reconciled to the exact target delta." />
          <div className="mechanics-fields">
            <NumberField label="Minimum launch speed" value={mechanics.launchRpsMin} min={MECHANICS_BOUNDS.launchRps[0]} max={mechanics.launchRpsMax} step={.1} suffix="RPS" onChange={(value) => updateMechanics({ launchRpsMin: value })} />
            <NumberField label="Maximum launch speed" value={mechanics.launchRpsMax} min={mechanics.launchRpsMin} max={MECHANICS_BOUNDS.launchRps[1]} step={.1} suffix="RPS" onChange={(value) => updateMechanics({ launchRpsMax: value })} />
            <NumberField label="Minimum full turns" value={mechanics.minimumFullTurns} min={MECHANICS_BOUNDS.minimumFullTurns[0]} max={Math.min(MECHANICS_BOUNDS.minimumFullTurns[1], mechanics.maximumFullTurns)} step={1} onChange={(value) => updateMechanics({ minimumFullTurns: value })} />
            <NumberField label="Maximum full turns" value={mechanics.maximumFullTurns} min={mechanics.minimumFullTurns} max={MECHANICS_BOUNDS.maximumFullTurns[1]} step={1} onChange={(value) => updateMechanics({ maximumFullTurns: value })} />
          </div>
          <div className="turn-examples"><span>10-second Wheel <b>≈ {ranges[0].minimum}–{ranges[0].maximum} full turns</b></span><span>60-second Wheel <b>≈ {ranges[1].minimum}–{ranges[1].maximum} full turns</b></span><small>Compiled curve area: {compiled.area.toFixed(6)}</small></div>
        </div>
        <div className="mechanics-panel">
          <SectionTitle eyebrow="5 · DURATION DEFAULTS" title="New-Wheel duration policy" copy="Existing Wheels keep stored durations. These bounds govern new or subsequently edited configurations." />
          <div className="mechanics-fields mechanics-fields--single">
            <NumberField label="New-Wheel default" value={mechanics.defaultSpinDurationMs / 1000} min={mechanics.minimumSpinDurationMs / 1000} max={mechanics.maximumSpinDurationMs / 1000} step={.5} suffix="seconds" onChange={(value) => updateMechanics({ defaultSpinDurationMs: Math.round(value * 1000) })} />
            <NumberField label="Minimum allowed" value={mechanics.minimumSpinDurationMs / 1000} min={2} max={mechanics.defaultSpinDurationMs / 1000} step={.5} suffix="seconds" onChange={(value) => updateMechanics({ minimumSpinDurationMs: Math.round(value * 1000) })} />
            <NumberField label="Maximum allowed" value={mechanics.maximumSpinDurationMs / 1000} min={mechanics.defaultSpinDurationMs / 1000} max={60} step={.5} suffix="seconds" onChange={(value) => updateMechanics({ maximumSpinDurationMs: Math.round(value * 1000) })} />
          </div>
        </div>
      </section>

      <section className="mechanics-panel">
        <SectionTitle eyebrow="6 · EXISTING GLOBAL WHEEL POLICY" title="Authority retained in the current revisioned row" copy="These controls save atomically with Mechanics V2 through the existing wheel_settings global policy. No schema migration." />
        <div className="mechanics-fields policy-fields">
          <label><span>Default theme</span><select value={String(draft.defaultTheme || "third-rail-gold")} onChange={(event) => updatePolicy("defaultTheme", event.target.value)}><option value="third-rail-gold">Third Rail Gold</option><option value="live-wire-red">Live Wire Red</option><option value="gina-violet">Gina Violet</option><option value="high-voltage-mono">High Voltage Mono</option></select></label>
          <NumberField label="Maximum participants" value={Number(draft.maximumParticipants || 1000)} min={2} max={1000} step={1} onChange={(value) => updatePolicy("maximumParticipants", value)} />
          <NumberField label="Creator Wheel limit" value={Number(draft.maximumWheelsPerCreator || 20)} min={1} max={100} step={1} onChange={(value) => updatePolicy("maximumWheelsPerCreator", value)} />
          <NumberField label="Official cooldown" value={Number(draft.officialSpinCooldownSeconds || 2)} min={1} max={60} step={1} suffix="seconds" onChange={(value) => updatePolicy("officialSpinCooldownSeconds", value)} />
        </div>
      </section>
    </fieldset>

    <section className="mechanics-panel mechanics-graph-studio">
      <SectionTitle eyebrow="COMPILED CURVE STUDIO" title="Current saved versus unsaved draft" copy="Violet is the draft. The restrained gold dashed trace is the current saved policy." />
      <div className="mechanics-graphs mechanics-graphs--v2">
        <GraphPanel title="Angular velocity" copy="Normalized speed; clicker and capture thresholds are derived from the compiled curve."><CurveGraph compiled={compiled} current={currentCompiled} profile={mechanics.curveProfile} mode="velocity" /></GraphPanel>
        <GraphPanel title="Angular deceleration" copy="Deceleration magnitude exposes late spikes and terminal braking risk."><CurveGraph compiled={compiled} current={currentCompiled} profile={mechanics.curveProfile} mode="deceleration" /></GraphPanel>
        <GraphPanel title="Cumulative rotation" copy="Integrated A(u) / A(1), ending at exactly 100% angular displacement."><CurveGraph compiled={compiled} current={currentCompiled} profile={mechanics.curveProfile} mode="progress" /></GraphPanel>
        <GraphPanel title="Segment crossing cadence" copy="Derived clicks per second for 24 segments and a representative 10-second travel."><CurveGraph compiled={compiled} current={currentCompiled} profile={mechanics.curveProfile} mode="cadence" /></GraphPanel>
      </div>
    </section>

    <MechanicsPreview mechanics={mechanics} />

    <section className="mechanics-panel">
      <SectionTitle eyebrow="8 · NATURALNESS DIAGNOSTICS" title="Measured from the real compiled curve" copy="Warnings flag perceptually forced endings without blocking mathematically safe experimentation." />
      <DiagnosticsPanel diagnostics={diagnostics} compiled={compiled} />
    </section>

    <section className="mechanics-panel mechanics-invariants">
      <SectionTitle eyebrow="9 · READ-ONLY SECURITY INVARIANTS" title="Fairness and result authority stay fixed" copy="Configuration cannot weaken these server and animation guarantees." />
      <ul><li>Official winner selected before animation</li><li>Random landing covers the full winning slice</li><li>Weighted fairness unchanged</li><li>Configured duration is exact</li><li>Terminal speed and acceleration are zero</li><li>No final correction or snap</li><li>Stage Official All remains atomic</li><li>V1.9 renderer remains rigid</li><li>One immutable snapshot per spin</li><li>No Public D1 or R2 authority</li></ul>
    </section>
  </form>;
}

function PhysicsControls({ mechanics, onChange }: { mechanics: WheelMechanics; onChange: (physics: WheelMechanics["physics"]) => void }) {
  const fields = [
    ["quadraticDrag", "High-speed drag", "Resistance strongest while the Wheel is moving quickly.", .01],
    ["viscousDrag", "Bearing drag", "Continuous exponential-style resistance throughout the spin.", .01],
    ["clickerFriction", "Clicker resistance", "Low-speed resistance as the selector passes Wheel divisions.", .002],
    ["clickerOnsetSpeed", "Clicker onset", "The speed at which the mechanical clicker begins contributing fully.", .01],
    ["clickerBlendWidth", "Clicker blend", "How gradually clicker resistance engages.", .01],
    ["captureStartSpeed", "Soft-stop speed", "The very low speed at which imperceptible terminal capture begins.", .001],
    ["captureDurationFraction", "Soft-stop window", "The bounded final interval used to reach an exact zero-speed stop.", .005],
  ] as const;
  return <section className="mechanics-panel">
    <SectionTitle eyebrow="2 · PHYSICS CONTROLS" title="Custom friction model" copy="Sliders and precise numeric values edit bounded coefficients; no raw equation or frame-dependent damping is accepted." />
    <div className="physics-control-grid">{fields.map(([key, label, description, step]) => <RangeField key={key} label={label} description={description} value={mechanics.physics[key]} min={MECHANICS_BOUNDS[key][0]} max={MECHANICS_BOUNDS[key][1]} step={step} suffix={key === "captureDurationFraction" || key === "captureStartSpeed" || key === "clickerOnsetSpeed" || key === "clickerBlendWidth" ? "%" : ""} scale={key === "captureDurationFraction" || key === "captureStartSpeed" || key === "clickerOnsetSpeed" || key === "clickerBlendWidth" ? 100 : 1} onChange={(value) => onChange({ ...mechanics.physics, [key]: value })} />)}</div>
  </section>;
}

function CurveCard({ profile, selected, mechanics, onSelect }: { profile: WheelCurveProfile; selected: boolean; mechanics: WheelMechanics; onSelect: () => void }) {
  const sample = { ...mechanics, curveProfile: profile } as WheelMechanics;
  const compiled = compileVelocityProfile(sample);
  const meta = profileMeta(profile);
  return <button type="button" className={"curve-preset-card" + (selected ? " is-selected" : "")} aria-pressed={selected} onClick={onSelect}>
    <span className="curve-card-check">{selected ? "SELECTED" : "SELECT"}</span>
    <strong>{meta.name}{profile === "natural-hybrid" ? " · DEFAULT" : ""}</strong>
    <small>{meta.description}</small>
    <CurveGraph compiled={compiled} profile={profile} mode="velocity" thumbnail />
    <span>{profile === "classic-linear" ? "Compatibility reference" : profile === "legacy-broadcast-smooth" ? "Exact V1.12 comparison" : "Compiled · " + compiled.sampleCount + " samples"}</span>
  </button>;
}

function GraphPanel({ title, copy, children }: { title: string; copy: string; children: React.ReactNode }) {
  return <div className="mechanics-panel mechanics-panel--graph"><h3>{title}</h3><p>{copy}</p>{children}</div>;
}

type GraphMode = "velocity" | "deceleration" | "progress" | "cadence";
function CurveGraph({ compiled, current, profile, mode, thumbnail = false }: { compiled: CompiledWheelMechanics; current?: CompiledWheelMechanics; profile: WheelCurveProfile; mode: GraphMode; thumbnail?: boolean }) {
  const width = thumbnail ? 240 : 720;
  const height = thumbnail ? 92 : 270;
  const padding = thumbnail ? 8 : 38;
  const uniqueId = useId().replace(/:/g, "");
  const fillId = "curve-area-" + uniqueId;
  const lineId = "curve-line-" + uniqueId;
  const maximum = mode === "deceleration" ? Math.max(...compiled.deceleration) : mode === "cadence" ? velocityAt(compiled, 0) * 24 * 10 / compiled.area : 1;
  const valueAt = (curve: CompiledWheelMechanics, u: number) => {
    if (mode === "velocity") return velocityAt(curve, u);
    if (mode === "progress") return progressAt(curve, u);
    if (mode === "deceleration") return decelerationAt(curve, u) / Math.max(maximum, Number.EPSILON);
    return velocityAt(curve, u) * 24 * 10 / curve.area / Math.max(maximum, Number.EPSILON);
  };
  const makePoints = (curve: CompiledWheelMechanics) => Array.from({ length: 161 }, (_, index) => {
    const u = index / 160;
    return [padding + u * (width - padding * 2), height - padding - Math.min(1, Math.max(0, valueAt(curve, u))) * (height - padding * 2)];
  });
  const points = makePoints(compiled);
  const path = graphPath(points);
  const area = path + " L" + (width - padding) + "," + (height - padding) + " L" + padding + "," + (height - padding) + " Z";
  const currentPath = current ? graphPath(makePoints(current)) : "";
  const captureX = padding + compiled.captureStartU * (width - padding * 2);
  const clickerSpeed = compiled.mechanics.physics.clickerOnsetSpeed + compiled.mechanics.physics.clickerBlendWidth;
  const clickerU = firstTimeForSpeed(compiled, clickerSpeed);
  const clickerX = padding + clickerU * (width - padding * 2);
  const terminal = points.at(-1)!;
  const label = mode === "velocity" ? "angular velocity" : mode === "deceleration" ? "angular deceleration" : mode === "progress" ? "cumulative rotation" : "segment crossing cadence";
  return <svg className={"mechanics-curve-graph" + (thumbnail ? " is-thumbnail" : "")} viewBox={"0 0 " + width + " " + height} role="img" aria-label={profileName(profile) + " " + label + " graph"}>
    <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#a75bd5" stopOpacity=".34" /><stop offset=".58" stopColor="#713a9b" stopOpacity=".15" /><stop offset="1" stopColor="#3d204f" stopOpacity=".015" /></linearGradient><linearGradient id={lineId} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#7440a2" /><stop offset=".55" stopColor="#b967df" /><stop offset="1" stopColor="#f3c928" /></linearGradient></defs>
    {!thumbnail ? <><rect className="graph-plot" x={padding} y={padding} width={width - padding * 2} height={height - padding * 2} rx="8" /><path className="graph-grid" d={"M" + padding + "," + padding + "H" + (width-padding) + " M" + padding + "," + (height/2) + "H" + (width-padding) + " M" + padding + "," + (height-padding) + "H" + (width-padding) + " M" + padding + "," + padding + "V" + (height-padding) + " M" + (width/2) + "," + padding + "V" + (height-padding) + " M" + (width-padding) + "," + padding + "V" + (height-padding)} /><text x={padding} y={height - 9}>0%</text><text x={width - padding - 28} y={height - 9}>100%</text><text x={8} y={padding + 4}>MAX</text><text x={12} y={height - padding}>0</text>{mode === "velocity" || mode === "deceleration" ? <><line className="graph-marker" x1={clickerX} y1={padding} x2={clickerX} y2={height-padding} /><line className="graph-marker graph-marker--capture" x1={captureX} y1={padding} x2={captureX} y2={height-padding} /><text className="graph-marker-label" x={clickerX + 6} y={padding + 15}>CLICKER</text><text className="graph-marker-label" x={Math.max(padding, captureX - 58)} y={padding + 29}>CAPTURE</text></> : null}</> : null}
    <path className="graph-area" d={area} fill={"url(#" + fillId + ")"} />
    {current && !thumbnail ? <path className="graph-current" d={currentPath} /> : null}
    <path className="graph-line graph-line--glow" d={path} style={{ stroke: "url(#" + lineId + ")" }} /><path className="graph-line" d={path} style={{ stroke: "url(#" + lineId + ")" }} />
    {!thumbnail ? <circle className="graph-terminal" cx={terminal[0]} cy={terminal[1]} r="4" /> : null}
  </svg>;
}

function CustomShapeEditor({ points, onChange }: { points: CustomShapePoint[]; onChange: (points: CustomShapePoint[]) => void }) {
  const width = 720; const height = 300; const padding = 34;
  const update = (index: number, time: number, speed: number) => {
    if (index === 0 || index === points.length - 1) return;
    const previous = points[index - 1]; const next = points[index + 1];
    const nextPoints = points.map((point, pointIndex) => pointIndex === index ? { time: clamp(time, previous.time + .01, next.time - .01), speed: clamp(speed, next.speed, previous.speed) } : { ...point });
    onChange(nextPoints);
  };
  const drag = (index: number, event: PointerEvent<SVGCircleElement>) => {
    if (index === 0 || index === points.length - 1 || event.buttons !== 1) return;
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect(); if (!rect) return;
    const time = (event.clientX - rect.left) / rect.width;
    const speed = 1 - (event.clientY - rect.top) / rect.height;
    update(index, time, speed);
  };
  const keyEdit = (index: number, event: KeyboardEvent<SVGCircleElement>) => {
    if (index === 0 || index === points.length - 1) return;
    const point = points[index]; const multiplier = event.shiftKey ? .05 : .01;
    if (event.key === "ArrowLeft") update(index, point.time - multiplier, point.speed);
    else if (event.key === "ArrowRight") update(index, point.time + multiplier, point.speed);
    else if (event.key === "ArrowUp") update(index, point.time, point.speed + multiplier);
    else if (event.key === "ArrowDown") update(index, point.time, point.speed - multiplier);
    else return;
    event.preventDefault();
  };
  return <div className="custom-shape-editor">
    <svg className="custom-shape-canvas" viewBox={"0 0 " + width + " " + height} role="img" aria-label="Custom monotone velocity control points">
      <rect x={padding} y={padding} width={width-padding*2} height={height-padding*2} rx="10" />
      <polyline points={points.map((point) => (padding + point.time * (width-padding*2)) + "," + (height-padding-point.speed*(height-padding*2))).join(" ")} />
      {points.map((point, index) => <circle key={index} cx={padding + point.time * (width-padding*2)} cy={height-padding-point.speed*(height-padding*2)} r={index === 0 || index === points.length - 1 ? 7 : 9} className={index === 0 || index === points.length - 1 ? "is-locked" : ""} tabIndex={index === 0 || index === points.length - 1 ? -1 : 0} role="slider" aria-label={"Curve point " + (index + 1)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(point.speed * 100)} onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={(event) => drag(index, event)} onKeyDown={(event) => keyEdit(index, event)} />)}
    </svg>
    <div className="shape-point-grid">{points.map((point, index) => <div key={index} className="shape-point-row"><strong>{index === 0 ? "START · LOCKED" : index === points.length - 1 ? "STOP · LOCKED" : "POINT " + (index + 1)}</strong><NumberField label="Time" value={Number((point.time*100).toFixed(2))} min={index === 0 ? 0 : points[index-1].time*100+1} max={index === points.length-1 ? 100 : points[index+1].time*100-1} step={.1} suffix="%" disabled={index === 0 || index === points.length - 1} onChange={(value) => update(index, value/100, point.speed)} /><NumberField label="Speed" value={Number((point.speed*100).toFixed(2))} min={index === points.length-1 ? 0 : points[index+1].speed*100} max={index === 0 ? 100 : points[index-1].speed*100} step={.1} suffix="%" disabled={index === 0 || index === points.length - 1} onChange={(value) => update(index, point.time, value/100)} /></div>)}</div>
  </div>;
}

function MechanicsPreview({ mechanics }: { mechanics: WheelMechanics }) {
  const frame = useRef<number | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const run = useRef<{ compiled: CompiledWheelMechanics; start: number; durationMs: number; revolutions: number; lastBoundary: number } | null>(null);
  const [duration, setDuration] = useState(10);
  const [sound, setSound] = useState(false);
  const [state, setState] = useState({ running: false, elapsed: 0, velocity: 0, revolutions: 0, rotation: 0, cadence: 0, phase: "READY", settled: false, noSnap: false });
  const stop = useCallback((settled = false) => { if (frame.current != null) cancelAnimationFrame(frame.current); frame.current = null; run.current = null; setState((current) => ({ ...current, running: false, velocity: 0, cadence: 0, settled, phase: settled ? "SETTLED" : "READY" })); }, []);
  useEffect(() => () => { if (frame.current != null) cancelAnimationFrame(frame.current); void audio.current?.close(); }, []);
  const click = () => {
    if (!sound) return;
    audio.current ||= new AudioContext();
    const oscillator = audio.current.createOscillator(); const gain = audio.current.createGain();
    oscillator.frequency.value = 760; gain.gain.setValueAtTime(.025, audio.current.currentTime); gain.gain.exponentialRampToValueAtTime(.0001, audio.current.currentTime + .025);
    oscillator.connect(gain).connect(audio.current.destination); oscillator.start(); oscillator.stop(audio.current.currentTime + .03);
  };
  const start = () => {
    stop(false);
    const snapshot = normalizeWheelMechanics(mechanics); const compiled = compileVelocityProfile(snapshot); const durationMs = duration * 1000;
    const range = estimatedFullTurnRange(durationMs, snapshot); const revolutions = (range.minimum + range.maximum) / 2; const started = performance.now();
    run.current = { compiled, start: started, durationMs, revolutions, lastBoundary: 0 };
    setState({ running: true, elapsed: 0, velocity: revolutions / duration / compiled.area, revolutions: 0, rotation: 0, cadence: revolutions / duration / compiled.area * 12, phase: "LAUNCH", settled: false, noSnap: false });
    const tick = (now: number) => {
      const active = run.current; if (!active) return;
      const elapsed = Math.min(active.durationMs, now - active.start); const u = elapsed / active.durationMs; const completion = progressAt(active.compiled, u); const completed = active.revolutions * completion;
      const velocity = active.revolutions / (active.durationMs / 1000) / active.compiled.area * velocityAt(active.compiled, u); const boundary = Math.floor(completed * 12);
      if (boundary > active.lastBoundary) { active.lastBoundary = boundary; click(); }
      const phase = u >= active.compiled.captureStartU ? "SOFT CAPTURE" : velocityAt(active.compiled, u) <= .1 ? "SUSPENSE TAIL" : u < .2 ? "LAUNCH" : "FRICTION DECAY";
      const settled = elapsed >= active.durationMs;
      setState({ running: !settled, elapsed, velocity: settled ? 0 : velocity, revolutions: completed, rotation: completed * 360, cadence: settled ? 0 : velocity * 12, phase: settled ? "SETTLED" : phase, settled, noSnap: settled });
      if (settled) { frame.current = null; run.current = null; return; }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };
  return <section className="mechanics-panel mechanics-preview">
    <SectionTitle eyebrow="7 · LIVE MECHANICS PREVIEW" title="Local unsaved-draft sandbox" copy="Synthetic participants, actual compiled mechanics, true boundary-crossing clicks, zero API mutation and no Official result." />
    <div className="preview-layout"><div className="preview-wheel-shell"><div className="preview-pointer"/><div className="preview-wheel" style={{ transform: "rotate(" + state.rotation + "deg)" }}><span>ALPHA</span><span>BRAVO</span><span>CHARLIE</span><span>DELTA</span></div></div><div className="preview-console"><div className="preview-selectors"><label><span>Preview duration</span><select value={duration} disabled={state.running} onChange={(event) => setDuration(Number(event.target.value))}><option value={3}>3 seconds</option><option value={10}>10 seconds</option><option value={20}>20 seconds</option><option value={60}>60 seconds</option></select></label><label className="sound-toggle"><span>Boundary sound</span><button type="button" className="secondary-button" aria-pressed={sound} onClick={() => setSound((value) => !value)}>{sound ? "Sound on" : "Sound off"}</button></label></div><div className="preview-readouts"><Readout label="Elapsed" value={(state.elapsed / 1000).toFixed(2) + " s"} /><Readout label="Angular speed" value={state.velocity.toFixed(3) + " RPS"} /><Readout label="Completed" value={state.revolutions.toFixed(2) + " rev"} /><Readout label="Click cadence" value={state.cadence.toFixed(2) + " / sec"} /><Readout label="Curve phase" value={state.phase} /><Readout label="Settlement" value={state.noSnap ? "0 speed · no snap" : state.running ? "in motion" : "ready"} /></div><div className="preview-actions"><button type="button" className="primary-button" disabled={state.running} onClick={start}>Preview spin</button><button type="button" className="secondary-button" disabled={!state.running && !state.settled} onClick={() => stop(false)}>Stop / reset</button></div><small>Each run freezes one compiled snapshot. Editing the draft cannot alter an in-flight preview.</small></div></div>
  </section>;
}

function DiagnosticsPanel({ diagnostics, compiled }: { diagnostics: ReturnType<typeof calculateNaturalnessDiagnostics>; compiled: CompiledWheelMechanics }) {
  const metrics = [["Speed at 25%", diagnostics.speedAt25.toFixed(4)], ["Speed at 50%", diagnostics.speedAt50.toFixed(4)], ["Speed at 75%", diagnostics.speedAt75.toFixed(4)], ["Speed at 90%", diagnostics.speedAt90.toFixed(4)], ["Tail duration", (diagnostics.tailDurationFraction*100).toFixed(1) + "%"], ["Terminal speed", diagnostics.terminalSpeed.toExponential(1)], ["Terminal acceleration", diagnostics.terminalAcceleration.toExponential(1)], ["Peak deceleration", diagnostics.peakDeceleration.toFixed(4)], ["Maximum jerk", diagnostics.maximumJerk.toFixed(3)], ["Final click interval", diagnostics.estimatedFinalClickIntervalMs.toFixed(0) + " ms"], ["Travel in final 10%", diagnostics.finalTravelPercent.toFixed(3) + "%"], ["Capture derivative match", (compiled.captureDerivativeScale*100).toFixed(1) + "%"]];
  const checks = [["Monotone speed", diagnostics.checks.monotoneSpeed], ["Soft terminal stop", diagnostics.checks.softTerminalStop], ["No reverse motion", diagnostics.checks.noReverseMotion], ["No final snap", diagnostics.checks.noFinalSnap], ["Suspense tail present", diagnostics.checks.suspenseTailPresent], ["Frame-rate independent", diagnostics.checks.frameRateIndependent]];
  return <><div className="diagnostic-metrics">{metrics.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div><div className="diagnostic-checks">{checks.map(([label, passed]) => <span key={String(label)} className={passed ? "is-pass" : "is-warn"}><b>{passed ? "PASS" : "CHECK"}</b>{label}</span>)}</div><div className={"handbrake-risk " + (diagnostics.handbrakeRisk ? "is-warning" : "is-clear")}><strong>{diagnostics.handbrakeRisk ? "HANDBRAKE RISK DETECTED" : "NO HANDBRAKE RISK"}</strong><span>{diagnostics.handbrakeRisk ? "Late deceleration, terminal acceleration or capture energy exceeds the perceptual warning threshold." : "The final deceleration remains bounded and terminal capture begins only at visually tiny speed."}</span></div></>;
}

function profileMeta(profile: WheelCurveProfile) {
  if (profile === "custom-physics") return { name: "Custom Physics", description: "Edit bounded drag, bearing, clicker and soft-stop coefficients." };
  if (profile === "custom-shape") return { name: "Custom Shape", description: "Edit seven monotone velocity points with shape-preserving interpolation." };
  return CURVE_PRESETS[profile];
}
function graphPath(points: number[][]) { return points.map(([x, y], index) => (index ? "L" : "M") + x.toFixed(2) + "," + y.toFixed(2)).join(" "); }
function firstTimeForSpeed(compiled: CompiledWheelMechanics, speed: number) { for (let index = 0; index < compiled.velocity.length; index += 1) if (compiled.velocity[index] <= speed) return index / (compiled.velocity.length - 1); return 1; }
function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)); }

function RangeField({ label, description, value, min, max, step, suffix, scale, onChange }: { label: string; description?: string; value: number; min: number; max: number; step: number; suffix?: string; scale: number; onChange: (value: number) => void }) { const shown = value * scale; return <label className="range-field"><span>{label}</span>{description ? <small>{description}</small> : null}<div><input type="range" min={min * scale} max={max * scale} step={step * scale} value={shown} onChange={(event) => onChange(Number(event.target.value) / scale)} /><input type="number" min={min * scale} max={max * scale} step={step * scale} value={shown} onChange={(event) => onChange(Number(event.target.value) / scale)} /><em>{suffix}</em></div></label>; }
function NumberField({ label, value, min, max, step, suffix, disabled = false, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; disabled?: boolean; onChange: (value: number) => void }) { return <label><span>{label}</span><div className="number-with-suffix"><input type="number" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />{suffix ? <em>{suffix}</em> : null}</div></label>; }
function Readout({ label, value }: { label: string; value: string }) { return <span><small>{label}</small><strong>{value}</strong></span>; }
function SectionTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { return <header className="mechanics-section-title"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{copy}</p></div></header>; }
function Heading({ title, summary }: { title: string; summary: string }) { return <section className="wheels-admin-heading"><div><p className="eyebrow">THIRD RAILIFY DRAW AUTHORITY</p><h1>{title}</h1><p>{summary}</p></div><span className="wheels-status">Admin D1 authority</span></section>; }
function Tabs() { return <nav className="wheels-admin-tabs" aria-label="Wheels workspace">{TABS.map((tab) => <Link key={tab.to} to={tab.to}>{tab.label}</Link>)}</nav>; }
function Metric({ label, value }: { label: string; value: number }) { return <article><span>{label}</span><strong>{value}</strong></article>; }
function Jump({ to, eyebrow, title, copy }: { to: string; eyebrow: string; title: string; copy: string }) { return <Link className="wheels-overview-jump" to={to}><span>{eyebrow}</span><strong>{title}</strong><p>{copy}</p></Link>; }
function WheelAutomationScaffold() { const concepts = ["Exact chat text adds actor", "Follower adds actor", "Subscriber adds actor", "Gift purchaser adds actor", "Source-scoped username identity", "Event fingerprint dedupe"]; return <section className="wheels-admin-panel wheel-automation-deferred"><header><div><p className="eyebrow">RUMBLE AUTOMATION Â· DEFERRED</p><h2>Future entry sources</h2><p>Configuration preview only. No entry write, bot lease, provider request, or Save path exists in this milestone.</p></div><Link className="secondary-button" to="/automations">Open Automations</Link></header><div>{concepts.map((concept) => <label key={concept}><input type="checkbox" disabled /><span>{concept}</span></label>)}</div><footer><span>Duplicate policy: not configured</span><span>Live source: no selector active</span><button type="button" disabled>Save unavailable</button></footer></section>; }
function Alert({ children }: { children: React.ReactNode }) { return <div className="admin-alert admin-alert--error" role="alert">{children}</div>; }
function Loading({ children }: { children: React.ReactNode }) { return <div className="wheels-admin-empty">{children}</div>; }
function profileName(profile: WheelCurveProfile) { return profileMeta(profile).name; }
function message(reason: unknown) { return reason instanceof Error ? reason.message : "The Wheels Admin service is unavailable."; }
