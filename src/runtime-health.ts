export type RuntimeOverallState = "healthy" | "catching_up" | "recovering" | "warning" | "degraded" | "offline" | "unknown";
export type HeartbeatState = "healthy" | "stale" | "offline" | "unknown";
export type PipelineState = "healthy" | "catching_up" | "warning" | "degraded" | "unknown";
export type ProviderState = "connected" | "recovering" | "degraded" | "disconnected" | "unknown";
export type PublicationState = "healthy" | "recovering" | "warning" | "degraded" | "unknown";
export type RevisionState = "synchronized" | "drifted" | "unknown";
export type PollProcessingState = "healthy" | "warning" | "degraded" | "unknown";

export const RUNTIME_HEALTH_THRESHOLDS = Object.freeze({
  heartbeatCurrentSeconds: 45,
  heartbeatOfflineSeconds: 180,
  pipelineWarningSamples: 3,
  pipelineDegradedSamples: 6,
  providerDegradedAfterSeconds: 180,
  providerRecoverySamples: 2,
});

export type RuntimeSnapshot = {
  config?: { desiredRevision?: number };
  runtime?: Record<string, unknown> & {
    state?: "online" | "stale" | "offline";
    heartbeatAt?: string;
    ageSeconds?: number;
    appliedRevision?: number;
    desiredRevision?: number;
    discordConnected?: boolean;
    configSyncState?: string;
    pollLeaseActive?: boolean;
    pollingIntervalSeconds?: number;
    backlogMayBeTruncated?: boolean;
    errorCode?: string | null;
    backoffSeconds?: number;
  };
};

export type RuntimeHealthObservation = {
  sampledAt: string;
  discordConnected: boolean | null;
  pollLeaseActive: boolean;
  backlogMayBeTruncated: boolean;
  processingFailure: boolean;
  pollingIntervalSeconds: number;
};

export type RuntimeHealthModel = {
  overallState: RuntimeOverallState;
  heartbeatState: HeartbeatState;
  pipelineState: PipelineState;
  providerState: ProviderState;
  publicationState: PublicationState;
  revisionState: RevisionState;
  pollProcessingState: PollProcessingState;
  headline: string;
  summary: string;
  chip: string;
  level: string;
  kicker: string;
  readout: string;
  visualTone: RuntimeOverallState;
  pipelineLabel: string;
  pipelineDetail: string;
  providerLabel: string;
  providerDetail: string;
  publicationLabel: string;
  publicationDetail: string;
};

export function runtimeHealthObservation(snapshot: RuntimeSnapshot): RuntimeHealthObservation | null {
  const runtime = snapshot.runtime;
  const sampledAt = text(runtime?.heartbeatAt);
  if (!runtime || !sampledAt || Number.isNaN(Date.parse(sampledAt))) return null;
  return {
    sampledAt,
    discordConnected: typeof runtime.discordConnected === "boolean" ? runtime.discordConnected : null,
    pollLeaseActive: runtime.pollLeaseActive === true,
    backlogMayBeTruncated: runtime.backlogMayBeTruncated === true,
    processingFailure: Boolean(text(runtime.errorCode) && number(runtime.backoffSeconds) > 0 && runtime.pollLeaseActive === true),
    pollingIntervalSeconds: boundedInterval(runtime.pollingIntervalSeconds),
  };
}

export function classifyRuntimeHealth(
  snapshot: RuntimeSnapshot | null,
  history: readonly RuntimeHealthObservation[] = [],
  now = Date.now(),
  requestState: "ready" | "loading" | "error" = "ready",
): RuntimeHealthModel {
  if (!snapshot) return unavailableModel(requestState);
  const runtime = snapshot.runtime || {};
  const observations = normalizeHistory(history, runtimeHealthObservation(snapshot));
  const heartbeatState = classifyHeartbeat(runtime, now);
  const revisionState = classifyRevision(snapshot);
  const pipelineState = classifyPipeline(runtime, observations);
  const providerState = classifyProvider(runtime, observations);
  const publicationState: PublicationState = "unknown";
  const pollProcessingState = classifyPollProcessing(runtime, observations);
  const overallState = rollUp(heartbeatState, pipelineState, providerState, revisionState, pollProcessingState);
  const presentation = presentationFor(overallState, heartbeatState);
  const pipeline = pipelineCopy(pipelineState, runtime);
  const provider = providerCopy(providerState);

  return {
    overallState,
    heartbeatState,
    pipelineState,
    providerState,
    publicationState,
    revisionState,
    pollProcessingState,
    ...presentation,
    visualTone: overallState,
    pipelineLabel: pipeline.label,
    pipelineDetail: pipeline.detail,
    providerLabel: provider.label,
    providerDetail: provider.detail,
    publicationLabel: "Not reported",
    publicationDetail: "No heartbeat delivery telemetry",
  };
}

function classifyHeartbeat(runtime: NonNullable<RuntimeSnapshot["runtime"]>, now: number): HeartbeatState {
  if (runtime.state === "offline") return "offline";
  if (runtime.state === "stale") return "stale";
  const heartbeatAt = text(runtime.heartbeatAt);
  const computedAge = heartbeatAt && !Number.isNaN(Date.parse(heartbeatAt)) ? Math.max(0, (now - Date.parse(heartbeatAt)) / 1000) : null;
  const age = finite(runtime.ageSeconds) ? Number(runtime.ageSeconds) : computedAge;
  if (age === null) return runtime.state === "online" ? "healthy" : "unknown";
  if (age > RUNTIME_HEALTH_THRESHOLDS.heartbeatOfflineSeconds) return "offline";
  if (age > RUNTIME_HEALTH_THRESHOLDS.heartbeatCurrentSeconds) return "stale";
  return "healthy";
}

function classifyRevision(snapshot: RuntimeSnapshot): RevisionState {
  const runtime = snapshot.runtime;
  if (!runtime) return "unknown";
  const desired = finite(snapshot.config?.desiredRevision) ? Number(snapshot.config?.desiredRevision) : finite(runtime.desiredRevision) ? Number(runtime.desiredRevision) : null;
  const applied = finite(runtime.appliedRevision) ? Number(runtime.appliedRevision) : null;
  const configState = text(runtime.configSyncState);
  if (desired === null || applied === null) return "unknown";
  return desired === applied && (!configState || configState === "synchronized") ? "synchronized" : "drifted";
}

function classifyPipeline(runtime: NonNullable<RuntimeSnapshot["runtime"]>, history: readonly RuntimeHealthObservation[]): PipelineState {
  if (runtime.pollLeaseActive !== true) return "healthy";
  const failureRun = trailing(history, (item) => item.pollLeaseActive && item.processingFailure);
  if (failureRun.length >= RUNTIME_HEALTH_THRESHOLDS.pipelineDegradedSamples && cadenceElapsed(failureRun, 5)) return "degraded";
  if (failureRun.length) return "warning";
  if (runtime.backlogMayBeTruncated !== true) return "healthy";
  const saturatedRun = trailing(history, (item) => item.pollLeaseActive && item.backlogMayBeTruncated && !item.processingFailure);
  if (saturatedRun.length >= RUNTIME_HEALTH_THRESHOLDS.pipelineDegradedSamples && cadenceElapsed(saturatedRun, 5)) return "degraded";
  if (saturatedRun.length >= RUNTIME_HEALTH_THRESHOLDS.pipelineWarningSamples && cadenceElapsed(saturatedRun, 2)) return "warning";
  return "catching_up";
}

function classifyProvider(runtime: NonNullable<RuntimeSnapshot["runtime"]>, history: readonly RuntimeHealthObservation[]): ProviderState {
  if (typeof runtime.discordConnected !== "boolean") return "unknown";
  if (!runtime.discordConnected) {
    const disconnected = trailing(history, (item) => item.discordConnected === false);
    if (disconnected.length >= 2 && elapsedSeconds(disconnected) >= RUNTIME_HEALTH_THRESHOLDS.providerDegradedAfterSeconds) return "degraded";
    return "disconnected";
  }
  const connected = trailing(history, (item) => item.discordConnected === true);
  const previous = history[history.length - connected.length - 1];
  if (previous?.discordConnected === false && connected.length < RUNTIME_HEALTH_THRESHOLDS.providerRecoverySamples) return "recovering";
  return "connected";
}

function classifyPollProcessing(runtime: NonNullable<RuntimeSnapshot["runtime"]>, history: readonly RuntimeHealthObservation[]): PollProcessingState {
  if (runtime.pollLeaseActive !== true) return "unknown";
  const failures = trailing(history, (item) => item.pollLeaseActive && item.processingFailure);
  if (failures.length >= RUNTIME_HEALTH_THRESHOLDS.pipelineDegradedSamples && cadenceElapsed(failures, 5)) return "degraded";
  return failures.length ? "warning" : "healthy";
}

function rollUp(heartbeat: HeartbeatState, pipeline: PipelineState, provider: ProviderState, revision: RevisionState, poll: PollProcessingState): RuntimeOverallState {
  if (heartbeat === "offline") return "offline";
  if (pipeline === "degraded" || provider === "degraded" || poll === "degraded") return "degraded";
  if (heartbeat === "stale" || pipeline === "warning" || provider === "disconnected" || revision === "drifted" || poll === "warning") return "warning";
  if (provider === "recovering") return "recovering";
  if (pipeline === "catching_up") return "catching_up";
  return heartbeat === "unknown" ? "unknown" : "healthy";
}

function presentationFor(overall: RuntimeOverallState, heartbeat: HeartbeatState) {
  if (heartbeat === "offline") return { headline: "Bot heartbeat is offline", summary: "The signed runtime heartbeat is no longer current.", chip: "Offline", level: "Offline", kicker: "Runtime liveness", readout: "FLATLINE" };
  if (heartbeat === "stale") return { headline: "Bot heartbeat is delayed", summary: "The signed pulse is outside the current window; other service states remain independently reported.", chip: "Delayed", level: "Warning", kicker: "Delayed runtime signal", readout: "STALE SIGNAL" };
  const common = { headline: "Bot heartbeat is current", kicker: "Live signed pulse" };
  switch (overall) {
    case "catching_up": return { ...common, summary: "The runtime is healthy while the bounded event window catches up with a short-lived burst.", chip: "Catching up", level: "Catching up", readout: "CATCHING UP" };
    case "recovering": return { ...common, summary: "The runtime is current after a recent provider interruption and is stabilizing.", chip: "Recovering", level: "Recovering", readout: "RECOVERING" };
    case "warning": return { ...common, summary: "The runtime is current, but one independently reported service requires attention.", chip: "Attention", level: "Warning", readout: "SERVICE ALERT" };
    case "degraded": return { ...common, summary: "The runtime is online, but event or provider processing is not keeping up.", chip: "Degraded", level: "Degraded", readout: "DEGRADED" };
    default: return { ...common, summary: "The signed runtime pulse is current and the desired configuration revision is synchronized.", chip: "Current", level: "Healthy", readout: "LIVE SIGNAL" };
  }
}

function pipelineCopy(state: PipelineState, runtime: NonNullable<RuntimeSnapshot["runtime"]>) {
  if (runtime.pollLeaseActive !== true) return { label: "Healthy", detail: "No active Poll event work" };
  if (state === "catching_up") return { label: "Catching up", detail: "Recent event window at provider limit" };
  if (state === "warning") return { label: "Pipeline delayed", detail: number(runtime.backoffSeconds) > 0 ? `Retry backoff ${number(runtime.backoffSeconds)}s` : "Provider window repeatedly saturated" };
  if (state === "degraded") return { label: "Pipeline degraded", detail: number(runtime.backoffSeconds) > 0 ? "Processing failures persist" : "Provider window remains saturated" };
  if (state === "healthy") return { label: "Healthy", detail: "Event window within provider limit" };
  return { label: "Unknown", detail: "Pipeline telemetry unavailable" };
}

function providerCopy(state: ProviderState) {
  if (state === "connected") return { label: "Connected", detail: "Provider socket" };
  if (state === "recovering") return { label: "Recovering", detail: "Connected after interruption" };
  if (state === "degraded") return { label: "Degraded", detail: "Sustained disconnect" };
  if (state === "disconnected") return { label: "Disconnected", detail: "Awaiting reconnect evidence" };
  return { label: "Not reported", detail: "No provider signal" };
}

function unavailableModel(requestState: "ready" | "loading" | "error"): RuntimeHealthModel {
  const loading = requestState === "loading";
  return {
    overallState: "unknown", heartbeatState: "unknown", pipelineState: "unknown", providerState: "unknown", publicationState: "unknown", revisionState: "unknown", pollProcessingState: "unknown",
    headline: loading ? "Reading bot heartbeat" : "Bot heartbeat is unavailable",
    summary: requestState === "error" ? "The control-plane request failed; runtime state has not been inferred." : loading ? "Requesting the signed runtime signal and desired revision state." : "No current runtime report is available for this role or request.",
    chip: loading ? "Reading" : "Unknown", level: "Unknown", kicker: loading ? "Awaiting authority" : "Signal unavailable", readout: loading ? "ACQUIRING" : "NO DATA", visualTone: "unknown",
    pipelineLabel: "Unknown", pipelineDetail: "Pipeline telemetry unavailable", providerLabel: "Not reported", providerDetail: "No provider signal", publicationLabel: "Not reported", publicationDetail: "No heartbeat delivery telemetry",
  };
}

function normalizeHistory(history: readonly RuntimeHealthObservation[], current: RuntimeHealthObservation | null) {
  const result = history.filter((item) => !Number.isNaN(Date.parse(item.sampledAt))).slice(-24);
  if (current && result.at(-1)?.sampledAt !== current.sampledAt) result.push(current);
  return result.slice(-24);
}
function trailing(items: readonly RuntimeHealthObservation[], predicate: (item: RuntimeHealthObservation) => boolean) { let index = items.length; while (index > 0 && predicate(items[index - 1])) index -= 1; return items.slice(index); }
function cadenceElapsed(items: readonly RuntimeHealthObservation[], intervals: number) { return items.length > 1 && elapsedSeconds(items) >= Math.max(...items.map((item) => item.pollingIntervalSeconds)) * intervals; }
function elapsedSeconds(items: readonly RuntimeHealthObservation[]) { return items.length > 1 ? Math.max(0, (Date.parse(items.at(-1)!.sampledAt) - Date.parse(items[0].sampledAt)) / 1000) : 0; }
function boundedInterval(value: unknown) { const parsed = number(value); return parsed >= 10 && parsed <= 86_400 ? parsed : 15; }
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; }
function finite(value: unknown): value is number { return Number.isFinite(Number(value)); }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
