// The current Bot emits after its shared Rumble check, not on a 45-second timer.
// Allow scheduler jitter (5%) and 30 seconds for control/provider requests.
// Do not extend this window for retries: missed reports must still become stale.
export function heartbeatFreshness(runtime = {}) {
  const reported = runtime.pollingIntervalSeconds;
  const valid = typeof reported === 'number' && Number.isFinite(reported) && reported >= 10 && reported <= 86400;
  const eventsActive = Number(runtime.eventAutomation?.activeRules) > 0;
  const interval = valid ? (runtime.pollLeaseActive === true ? Math.min(30, reported) : eventsActive ? 15 : reported) : null;
  return {
    expectedIntervalSeconds: interval,
    currentSeconds: interval === null ? 45 : Math.max(45, Math.ceil(interval * 1.05) + 30),
    offlineSeconds: interval === null ? 180 : Math.max(180, Math.ceil(interval * 3) + 30),
  };
}

export function heartbeatState(ageSeconds, freshness) {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return 'offline';
  return ageSeconds <= freshness.currentSeconds ? 'online' : ageSeconds <= freshness.offlineSeconds ? 'stale' : 'offline';
}
