import assert from 'node:assert/strict';
import test from 'node:test';
import { heartbeatFreshness, heartbeatState } from '../functions/_shared/heartbeat-freshness.js';

test('normal signed cadence stays current across a 60-second loop, then detects missed reports', () => {
  const policy = heartbeatFreshness({ pollingIntervalSeconds: 60 });
  assert.deepEqual(policy, { expectedIntervalSeconds: 60, currentSeconds: 93, offlineSeconds: 210 });
  for (const age of [0, 45, 50, 60, 75, 93]) assert.equal(heartbeatState(age, policy), 'online');
  assert.equal(heartbeatState(94, policy), 'stale');
  assert.equal(heartbeatState(211, policy), 'offline');
  assert.equal(heartbeatState(null, policy), 'offline');
  assert.equal(heartbeatState(NaN, policy), 'offline');
});

test('active Poll and event cadences are independent of normal cadence and retries cannot hide missed reports', () => {
  assert.equal(heartbeatFreshness({ pollingIntervalSeconds: 15, pollLeaseActive: true }).currentSeconds, 46);
  assert.equal(heartbeatFreshness({ pollingIntervalSeconds: 120, eventAutomation: { activeRules: 1 } }).expectedIntervalSeconds, 15);
  assert.equal(heartbeatFreshness({ pollingIntervalSeconds: 120 }).currentSeconds, 156);
  assert.deepEqual(heartbeatFreshness({ pollingIntervalSeconds: 60, backoffSeconds: 3600 }), heartbeatFreshness({ pollingIntervalSeconds: 60 }));
  for (const value of [null, '', '60', -1, NaN, Infinity, 90000]) assert.equal(heartbeatFreshness({ pollingIntervalSeconds: value }).currentSeconds, 45);
});
