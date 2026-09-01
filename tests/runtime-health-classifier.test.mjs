import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/runtime-health.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { classifyRuntimeHealth, runtimeHealthObservation, RUNTIME_HEALTH_THRESHOLDS } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("the latched provider-window flag is healthy when no Poll lease is active", () => {
  const snapshot = fixture({ pollLeaseActive: false, backlogMayBeTruncated: true });
  const model = classifyRuntimeHealth(snapshot, [runtimeHealthObservation(snapshot)], Date.parse(snapshot.runtime.heartbeatAt));
  assert.equal(model.heartbeatState, "healthy");
  assert.equal(model.pipelineState, "healthy");
  assert.equal(model.overallState, "healthy");
  assert.equal(model.pipelineDetail, "No active Poll event work");
});

test("a live Poll burst catches up, drains, and never relabels heartbeat liveness", () => {
  const values = [false, true, true, true, false];
  const expected = ["healthy", "catching_up", "catching_up", "warning", "healthy"];
  const history = [];
  values.forEach((backlogMayBeTruncated, index) => {
    const snapshot = fixture({ heartbeatAt: iso(index * 15), pollLeaseActive: true, backlogMayBeTruncated });
    history.push(runtimeHealthObservation(snapshot));
    const model = classifyRuntimeHealth(snapshot, history, Date.parse(snapshot.runtime.heartbeatAt));
    assert.equal(model.pipelineState, expected[index]);
    assert.equal(model.heartbeatState, "healthy");
    assert.equal(model.headline, "Bot heartbeat is current");
    if (backlogMayBeTruncated && index < 3) assert.notEqual(model.overallState, "degraded");
  });
});

test("repeated provider-window saturation escalates only after cadence-based hysteresis", () => {
  const history = [];
  const states = [];
  for (let index = 0; index < 6; index += 1) {
    const snapshot = fixture({ heartbeatAt: iso(index * 15), pollLeaseActive: true, backlogMayBeTruncated: true });
    history.push(runtimeHealthObservation(snapshot));
    states.push(classifyRuntimeHealth(snapshot, history, Date.parse(snapshot.runtime.heartbeatAt)).pipelineState);
  }
  assert.deepEqual(states, ["catching_up", "catching_up", "warning", "warning", "warning", "degraded"]);
  assert.equal(RUNTIME_HEALTH_THRESHOLDS.pipelineWarningSamples, 3);
  assert.equal(RUNTIME_HEALTH_THRESHOLDS.pipelineDegradedSamples, 6);
});

test("sustained retry backoff degrades Poll processing while vote semantics remain outside the classifier", () => {
  const history = [];
  let model;
  for (let index = 0; index < 6; index += 1) {
    const snapshot = fixture({ heartbeatAt: iso(index * 15), pollLeaseActive: true, errorCode: "TimeoutError", backoffSeconds: 30 });
    history.push(runtimeHealthObservation(snapshot));
    model = classifyRuntimeHealth(snapshot, history, Date.parse(snapshot.runtime.heartbeatAt));
  }
  assert.equal(model.pipelineState, "degraded");
  assert.equal(model.pollProcessingState, "degraded");
  assert.equal(model.overallState, "degraded");
});

test("Discord one-second resume recovers for one signed sample then clears", () => {
  const samples = [
    fixture({ heartbeatAt: iso(0), discordConnected: true }),
    fixture({ heartbeatAt: iso(15), discordConnected: false }),
    fixture({ heartbeatAt: iso(16), discordConnected: true }),
    fixture({ heartbeatAt: iso(31), discordConnected: true }),
  ];
  const history = [];
  const states = samples.map((snapshot) => {
    history.push(runtimeHealthObservation(snapshot));
    return classifyRuntimeHealth(snapshot, history, Date.parse(snapshot.runtime.heartbeatAt)).providerState;
  });
  assert.deepEqual(states, ["connected", "disconnected", "recovering", "connected"]);
});

test("a sustained Discord disconnect degrades only the provider dimension and recovers with hysteresis", () => {
  const values = [[0, true], [15, false], [255, false], [256, true], [271, true]];
  const history = [];
  const models = values.map(([seconds, discordConnected]) => {
    const snapshot = fixture({ heartbeatAt: iso(seconds), discordConnected });
    history.push(runtimeHealthObservation(snapshot));
    return classifyRuntimeHealth(snapshot, history, Date.parse(snapshot.runtime.heartbeatAt));
  });
  assert.equal(models[2].heartbeatState, "healthy");
  assert.equal(models[2].providerState, "degraded");
  assert.equal(models[2].overallState, "degraded");
  assert.equal(models[3].providerState, "recovering");
  assert.equal(models[4].providerState, "connected");
});

test("publication is unknown because the heartbeat emits no transport history; a recovered timeout cannot remain latched", () => {
  const snapshot = fixture({ publicationFailureAt: iso(0), publicationSuccessAt: iso(2) });
  const model = classifyRuntimeHealth(snapshot, [runtimeHealthObservation(snapshot)], Date.parse(snapshot.runtime.heartbeatAt));
  assert.equal(model.publicationState, "unknown");
  assert.equal(model.publicationLabel, "Not reported");
  assert.equal(model.overallState, "healthy");
});

test("revision drift, delayed heartbeat, and offline heartbeat retain independent severity", () => {
  const drift = fixture({ appliedRevision: 2 });
  assert.equal(classifyRuntimeHealth(drift, [], Date.parse(drift.runtime.heartbeatAt)).revisionState, "drifted");
  assert.equal(classifyRuntimeHealth(drift, [], Date.parse(drift.runtime.heartbeatAt)).overallState, "warning");
  const stale = fixture({ state: "stale", ageSeconds: 90 });
  assert.equal(classifyRuntimeHealth(stale, [], Date.parse(stale.runtime.heartbeatAt)).headline, "Bot heartbeat is delayed");
  const offline = fixture({ state: "offline", ageSeconds: 240 });
  assert.equal(classifyRuntimeHealth(offline, [], Date.parse(offline.runtime.heartbeatAt)).overallState, "offline");
});

function fixture(overrides = {}) {
  return {
    config: { desiredRevision: 3 },
    runtime: {
      state: "online", heartbeatAt: iso(0), ageSeconds: 5, appliedRevision: 3, desiredRevision: 3,
      discordConnected: true, configSyncState: "synchronized", pollLeaseActive: false,
      pollingIntervalSeconds: 15, backlogMayBeTruncated: false, backoffSeconds: 0,
      ...overrides,
    },
  };
}
function iso(offsetSeconds) { return new Date(Date.UTC(2026, 8, 1, 6, 0, offsetSeconds)).toISOString(); }
