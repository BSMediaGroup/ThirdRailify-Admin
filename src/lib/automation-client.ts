import type { ActionConfig } from './automation-model.mjs';

export const families = [
  ['rumble.raid.received', 'Raid Received', 'Detected from the complete chat announcement “has raided this stream!”. This API response does not identify whether the message is system-generated.'],
  ['rumble.chat.exact', 'Exact Chat Message', 'Match the complete message; case and outer spaces are ignored.'],
  ['rumble.rant', 'Rant Received', 'Award entries to the ranter, using a fixed award or reported integer cents.'],
  ['rumble.follow', 'New Follower', 'Award entries to the follower. Only events after activation qualify.'],
  ['subscriber_self_paid', 'New Self-Paid Subscriber', 'Triggered by a newly observed subscriber record reporting 500 cents. Gift recipients and review amounts never qualify.'],
  ['rumble.gift_purchase', 'Gifted Sub Purchase', 'Award entries to the purchaser using purchased_by and total_gifts. Gift recipients are separate and are never added by this event.'],
  ['rumble.livestream.started', 'Livestream Started', 'State transition only. This event has no entrant actor.'],
  ['rumble.livestream.stopped', 'Livestream Ended', 'State transition only. This event has no entrant actor.'],
] as const;
export type Conditions = { exactText?: string; minAmountCents?: number; minGifts?: number; giftType?: string; badge?: string; livestreamId?: string };
export type Readiness = { entryIdentity?: boolean; appearance?: boolean; awards: boolean; raidSchema: boolean; raidRuntime: boolean; raidStatus: string };
export type Rule = { targetType?: string; targetAvailable?: boolean; targetLifecycle?: string; targetLocked?: boolean; runtimeStatus?: string; legacySubscriberRule?: boolean; id?: string; revision?: number; name: string; description: string; enabled: boolean; sourceScope: string; sourceLabel?: string | null; eventType: string; conditions: Conditions; actionType: string; targetWheelId: string; duplicatePolicy: string; actionConfig?: ActionConfig; targetWheelTitle?: string; activatedAt?: string; lastMatchAt?: string; lastOutcome?: string; lastFault?: string; counters?: Record<string, number> };
export type WheelChoice = { id: string; title: string; lifecycle: string; editing_locked: number };
export type Discovery = { botState: string; discoveryState?: string; source: { scope: string; displayName: string } | null; livestreams: { id: string; title: string; isLive: boolean }[]; freshness?: { ageSeconds: number; observedAt?: string | null } | null };
export type TestResult = { classification?: string; sourceScope?: string; livestreamId?: string; matched: boolean; actorLabel: string; calculation: string; action: string; repeatActorPolicy: string };
export type RosterAuthority = { source: string; label: string; health: string; current: null | { id: string; providerAt: string; provenance: string }; counts: { eligible: number; giftedExcluded: number; mixedCurrent: number; reviewExcluded: number }; fingerprint: string | null; addAllowed: boolean; removalAllowed: boolean; removalBlockReason: string | null };
export type RosterRule = { id?: string; name: string; sourceScope: string; sourceLabel?: string | null; targetWheelId: string; targetWheelTitle?: string; targetAvailable?: boolean; targetLifecycle?: string; targetLocked?: boolean; enabled: boolean; syncMode: 'add_missing' | 'exact_managed'; entriesPerMember: number; minimumQuality: 'qualified_live_current'; appearance?: ActionConfig['appearance']; lastEvaluatedSnapshotId?: string | null; lastRosterFingerprint?: string | null; lastSuccessfulSyncAt?: string | null; lastResult?: string | null; revision?: number; members?: Array<{ entryId: string; actorLabel: string; weight: number; snapshotId: string }>; counts?: { eligible: number; added: number; unchanged: number; removed: number; giftedExcluded: number; mixedCurrent: number; reviewExcluded: number; failures: number; managed: number; managedWeight: number } };
export type RosterPayload = { ok: true; rules: RosterRule[]; wheels: WheelChoice[]; discovery?: Discovery; authorities: Record<string, RosterAuthority> };
export type RosterPreview = { ok: true; rule: RosterRule; authority: RosterAuthority; delta: { added: Array<{ displayName: string }>; updated: Array<{ displayName: string }>; removed: Array<{ actor_label: string }>; unchanged: number; retainedIneligible: number; failures: number }; removalBlocked: boolean; status: string; synced?: boolean; noOp?: boolean; result?: string };
export class AutomationRequestError extends Error {
  constructor(message: string, public issues: { field: string; message: string }[] = [], public status = 0) { super(message); }
}
export async function automationRequest<T>(path: string, csrf?: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/admin/automations/${path}`, { credentials: 'include', cache: 'no-store', method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new AutomationRequestError(value.message || 'Automation request failed.', value.issues || [], response.status);
  return value;
}

