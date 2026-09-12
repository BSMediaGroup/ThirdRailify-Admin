# Production D1 write budget

Current/pending version: 0.1.0-alpha.0. Audit started 2026-09-12 UTC.
Protected evidence: `X:/GIT/_EVIDENCE/ThirdRailify/d1-write-audit-20260912-222440/`.

## Database authority

- Commerce (`3dd23a7e-7c64-49cb-a52c-c1540b41db1c`): Admin Functions own Commerce, Polls, Wheels, analytics, Bot control and subscriber observations. The Commerce Operations Worker invokes authenticated Admin maintenance every five minutes and binds this same database.
- Accounts (`b8be3879-7aa1-4d70-af3f-617abce7a929`): Admin owns authentication and account mutations; Public reads shared sessions. Live Lab Pages and its recovery Worker also bind Accounts; their independent Lab database contributes to the same account-wide quota. Lab is outside this repair's writable scope.
- Community and broadcast snapshots use the existing Public State SQLite Durable Object, not either D1 database. Community semantic changes debounce for five seconds, with a 600-second freshness checkpoint; broadcast checkpoints are 75/150/600 seconds for live/upcoming/offline state.

## Proven dominant writers

Wrangler's pinned `d1 insights` supports JSON, 1h/1d/7d and all six requested rankings. Retained evidence ranks total/average writes, execution count, total/average reads and duration independently. Rounded `avgRowsWritten` is not reliable for sub-one averages; divide total by execution count.

| Database / SQL shape | Owner / caller | 24h writes / executions at baseline | Purpose |
| --- | --- | ---: | --- |
| Commerce: `INSERT INTO bot_service_nonces` | `functions/_shared/polls-core.js`, `verifyBotServiceRequest` and `retainServiceNonce`; internal Bot and signed Public relays | 59,565 / 19,855 | Authoritative replay prevention; index amplification makes each insert three written rows |
| Commerce: `DELETE FROM bot_service_nonces WHERE expires_at < ?` | Same authentication functions on each signed request | 19,335 / 19,394 | Expired nonce retention cleanup |
| Accounts: master `INSERT INTO accounts ... ON CONFLICT DO UPDATE` | `functions/_shared/auth-core.js`, `ensureEnvironmentMasters`; authenticated session/status/account requests | 6,819 / 2,273 | Enforce configured master identity and privileges; unconditional unchanged updates were redundant |
| Commerce: heartbeat singleton upsert | `recordBotHeartbeat`, POST `/api/internal/bot/heartbeat` | 4,906 / 4,906 | Required current liveness and runtime freshness |
| Commerce: variant reconciliation update | `current-catalogue-reconciliation.js`, explicit reconciliation | 1,221 / 111 | Legitimate provider/catalogue reconciliation; left unchanged |
| Commerce: subscriber observation insert | `rumble-intelligence.js`, subscriber observation ingress | 1,216 / 304 | Existing bounded observations/checkpoints; no subscriber-to-Wheel work in this repair |
| Commerce: analytics insert | `analytics-core.js`, analytics ingress | 396 / 66 | Genuine audience events; retained |

Live retained nonces independently showed 18 requests each for rules-v2, config, poll and heartbeat in roughly five minutes. `THIRD-RAIL-BOT/thirdrailify_bot/stream_manager.py` selects a 15-second interval while automation rules are active, even when the generic heartbeat polling field says 60 seconds. This proves the persistent baseline's request source without inferring cadence from the chart.

## Repair and bounded contract

`functions/api/internal/bot/[[path]].js` adds GET `/control`. It authenticates once, then concurrently returns the existing config, active-Poll and rules-v2 projections in independent status/body envelopes. A failed section does not discard successful sections. Existing endpoints remain available for authority rollback. HMAC, signature age, nonce uniqueness, expiry, rate limits and all business mutation paths are unchanged.

The paired Bot consumes one fresh envelope per existing control refresh, retaining the same cadence and last-known-good validation. Real local configuration writes/conflicts re-read the authority immediately. No cache interval, provider call, rule counter rewrite or heartbeat delay is introduced.

Master provisioning uses a conditional conflict update: unchanged configured values produce zero written rows; changed email, missing display name, role/level/status/source drift or missing verification repairs immediately. Personal display names and existing verification timestamps remain intact. No schema migration or index is needed.

Local real-D1 test, 100 control refreshes: 900 -> 300 rows written; 1,201 -> 800 queries; 1,146 -> 500 rows read; 9.66s -> 5.72s elapsed. These include cold readiness reads in the old-path baseline, so they are not a production latency claim. Nonce cleanup was not yet due in that short local interval. One hundred unchanged master reconciliations write zero rows; heartbeat deliberately retains its one-row-per-pulse contract.

Steady-state baseline: four signed requests per cycle, one heartbeat row. Repaired: two signed requests per cycle, one heartbeat row. At the observed accounting cost of three inserted rows and approximately one cleanup row per request, the fixed control/liveness portion falls from approximately 17 to 9 rows per cycle (47%). At an ideal 15-second cadence that is 97,920 -> 51,840 writes/day, before business traffic; actual observed cadence is slower because work takes time. Master duplicate savings are additional. Post-deploy measured results and final recommendation will be appended after acceptance.

## Other paths and why they are unchanged

The external evidence directory contains exhaustive source write-statement inventories for Public, Admin and Bot, including dynamic/batched SQL references. Auth session touches already coalesce at 15 minutes and do not extend expiry. Accounts rate-limit writes were 320 rows across both observed query shapes, not the dominant writer. Ordinary authenticated reads incur master reconciliation and occasional session touch; rate limit mutations are attached to login/signup/reset/profile, sensitive operations and submission paths. Signed public relays do incur nonce writes on reads. Removing those protections is outside this repair.

Overview/Automations reads obtain control, heartbeat, rules, receipts and summaries; they do not rewrite entire configurations. Poll and Wheel mutations, event receipts/counters, inbox, account commerce, GOATS submissions/views, media metadata, order/payment/provider paths and analytics retain their established event-driven writes. Runtime schema readiness uses schema reads; migrations and triggers are inventoried separately. Five-minute Commerce readiness writes (~169 observed) are small and unchanged; they were not used to justify a broader provider/transaction repair. Nonce expiry deletion remains necessary; fewer redundant signed requests reduce both inserts and eventual deletes without adding cleanup scans.

## Subscriber Intelligence next-milestone guardrails

No subscriber-to-Wheel logic is added. Reuse the existing Bot `SubscriberIntelligence` semantic key and five-minute checkpoint discipline, and Admin `rumble-intelligence.js` hashing/set identity primitives. Separate observation freshness from configuration/member/history mutations.

- Unchanged membership and classification: zero member writes. Never write one row per member per minute or observation.
- Fingerprint canonical source-scoped semantic data, excluding observation timestamps; replays are idempotent.
- Persist only changed members/classifications and real additions/removals; retain atomicity, incomplete-coverage handling and concurrency guards.
- An unchanged checkpoint may persist only bounded source/observation metadata, no copied member set. Target at most ten D1 written rows per checkpoint including indexes and service-auth overhead, at most 288 five-minute checkpoints/day/source.
- Measure real D1 metadata for 100 identical inputs and one-member deltas before enabling the next milestone. Budget below 5,000 routine writes/day/source including checkpoints, with explicit event/peak allowances; never infer the budget solely from SQL statement count.

## Release and rollback

Build and test Admin before deploying its authority, then restart the paired Bot once with its existing single-instance lock, config and durable outboxes. Public and Commerce Worker source are unchanged. No D1 migration, export, bulk rewrite or index build is required. Remote ledgers are captured; unrelated pending migrations must not be applied. For rollback deploy the previous Admin version; Bot falls back to existing routes only on 404. Reverting Bot restores the previous higher write rate, so monitor account headroom.

Cloudflare economics verified 2026-09-12: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) lists Free 5M reads/day and 100k writes/day, Paid 25B reads/month and 50M writes/month included; overages $0.001/million reads and $1/million writes. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) lists $5 USD/month minimum. Free's daily limits reset at midnight UTC. Account UTC-day and database rolling-24h charts cover different windows.
