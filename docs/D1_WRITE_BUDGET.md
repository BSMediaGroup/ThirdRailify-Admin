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
| Commerce: analytics insert | `functions/_shared/analytics.js`, analytics ingress | 396 / 66 | Genuine audience events; retained |

Live retained nonces independently showed 18 requests each for rules-v2, config, poll and heartbeat in roughly five minutes. `THIRD-RAIL-BOT/thirdrailify_bot/stream_manager.py` selects a 15-second interval while automation rules are active, even when the generic heartbeat polling field says 60 seconds. This proves the persistent baseline's request source without inferring cadence from the chart.

## Repair and bounded contract

`functions/api/internal/bot/[[path]].js` adds GET `/control`. It authenticates once, then concurrently returns the existing config, active-Poll and rules-v2 projections in independent status/body envelopes. A failed section does not discard successful sections. Existing endpoints remain available for authority rollback. HMAC, signature age, nonce uniqueness, expiry, rate limits and all business mutation paths are unchanged.

The paired Bot consumes one fresh envelope per existing control refresh, retaining the same cadence and last-known-good validation. Real local configuration writes/conflicts re-read the authority immediately. No cache interval, provider call, rule counter rewrite or heartbeat delay is introduced.

Master provisioning uses a conditional conflict update: unchanged configured values produce zero written rows; changed email, missing display name, role/level/status/source drift or missing verification repairs immediately. Personal display names and existing verification timestamps remain intact. No schema migration or index is needed.

Local real-D1 test, 100 control refreshes: 900 -> 300 rows written; 1,201 -> 800 queries; 1,146 -> 500 rows read; 9.66s -> 5.72s elapsed. These include cold readiness reads in the old-path baseline, so they are not a production latency claim. Nonce cleanup was not yet due in that short local interval. One hundred unchanged master reconciliations write zero rows; heartbeat deliberately retains its one-row-per-pulse contract.

Steady-state baseline: four signed requests per cycle, one heartbeat row. Repaired: two signed requests per cycle, one heartbeat row. At the observed accounting cost of three inserted rows and approximately one cleanup row per request, the fixed control/liveness portion falls from approximately 17 to 9 rows per cycle (47%). At an ideal 15-second cadence that is 97,920 -> 51,840 writes/day, before business traffic; actual observed cadence is slower because work takes time. Master duplicate savings are additional. Post-deploy measured results and final recommendation will be appended after acceptance.

## Other paths and why they are unchanged

The external evidence directory contains source write-statement inventories for Public, Admin and Bot, including dynamic/batched SQL references. Auth session touches already coalesce at 15 minutes and do not extend expiry. Accounts rate-limit writes were 320 rows across both observed query shapes, not the dominant writer. Ordinary authenticated reads incur master reconciliation and occasional session touch; rate limit mutations are attached to login/signup/reset/profile, sensitive operations and submission paths. Public's limiter in `functions/_shared/public-auth.js` counts authentication handoffs, not ordinary page/session reads. Signed public relays do incur nonce writes on reads. Removing those protections is outside this repair.

Overview/Automations reads obtain control, heartbeat, rules, receipts and summaries; they do not rewrite entire configurations. Poll and Wheel mutations, event receipts/counters, inbox, account commerce, GOATS submissions/views, media metadata, order/payment/provider paths and analytics retain their established event-driven writes. Runtime schema readiness uses schema reads; migrations and triggers are inventoried separately. Five-minute Commerce readiness writes (~169 observed) are small and unchanged; they were not used to justify a broader provider/transaction repair. Nonce expiry deletion remains necessary; fewer redundant signed requests reduce both inserts and eventual deletes without adding cleanup scans.

| Caller / route family | D1 mutation owner and tables | Cadence / repeat contract |
| --- | --- | --- |
| Public auth/session/handoff/logout | Public `public-auth.js`: sessions, accounts, auth_handoffs, auth_rate_limits, auth_audit | Session read touches only after 15 minutes; handoff consumption/rotation and logout are intentional state changes |
| Admin auth/status/account reads | `auth-core.js`: accounts, sessions; `oauth-providers.js`: auth identities/transactions | Conditional master reconciliation; 15-minute session touch; OAuth/login/rotation only on auth flows |
| Admin account/security edits | account routes, `admin-capabilities.js`, `profile-media.js`: accounts, credentials, capability denials, audit, media records | Explicit account changes; security rate limits retained |
| Public Poll/Wheel reads and controls | Signed relays call Admin `polls-core.js`, `wheels-core.js`, `wheel-stages-core.js` | Reads preserve projections; signed requests retain nonce protection; voting/staging/spinning use existing revision/receipt guards |
| Bot desired/applied/runtime | internal Bot route, `polls-core.js`: config, heartbeat, nonce/activity tables | Fresh control reads; one current heartbeat row; configuration/history change only on real mutations |
| Bot rules/events/credits | `automation-core.js`, `poll-credits.js`, entrant storage: rules, receipts, credit lots/allocations, entries, audit | Actual matched events, transitions or credits; no all-rule counter rewrite on refresh |
| Subscriber observations | `rumble-intelligence.js`: immutable semantic sets, bounded observations and source pointers | Existing five-minute checkpoint/change uploads, immutable set reuse; no per-member minute writes |
| Audience analytics | internal analytics ingress, `analytics.js`: analytics_events | Genuine deduplicated events; reporting reads do not rewrite summaries |
| Account commerce/inbox | `account-commerce.js`, `commerce-customers.js`, `account-messages.js`, `admin-inbox.js` | Profile/address/cart/order projections and user inbox actions; unchanged request reads do not rebuild record sets |
| Commerce operations/provider readiness | internal commerce/jobs, `commerce-operations.js`, `catalogue-sync.js`, `resend-domain.js` | Five-minute scheduler plus configured catalogue maintenance; readiness marker is one small write, real jobs/provider changes retain their transaction paths |
| Checkout/payment/fulfillment | checkout, PayPal, shipping, Printful and Commerce modules inventoried in evidence | Business-event writes, webhooks, dedupe receipts, reconciliation; no transaction/provider changes in this repair |
| GOATS/community/media | `goats-core.js`, media helpers | Explicit submission/view/reaction/media workflows; draft cleanup is bounded and operator-invoked |
| Gaming/content/brackets | gaming, IGDB, banner/Commerce, bracket helpers | Explicit editorial/operational changes; not a material periodic writer in Insights |
| Auth expiry cleanup | `cleanupExpiredAuthState`, Admin accounts cleanup action | Explicit operator action over five expiry tables; not ordinary request middleware |

The read-only Wheels release checkout still contains an Accounts binding but is not a distinct live Pages project. Lab Pages and Lab recovery both have verified live Accounts bindings. Raw schema inventory contains 116 Commerce tables/336 indexes/36 triggers and 16 Accounts tables/40 indexes, including SQLite/D1 internal objects. Commerce has 47 ledger entries, Accounts three; only Commerce `0046_poll_permanent_delete.sql` is pending. No pending migration was applied.

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

## Measured rollout results

Admin source commit `d7c49bcdfff777b6eeb6f54b3b1d0470f12f697b` deployed as `fa5ea95a-e29f-4c59-9d2b-39696a035bcf`, completed at 12:39:19 UTC. Bot source commit `c5cd22755da6801c33b43b913ee82989afb6e852` was committed/pushed and started at 12:40:48 UTC after the previous runtime logged every graceful shutdown stage through completion. Node 22.16.0, Admin build, Functions compile, focused ESLint, 22 Admin auth/Poll/cost tests and 106 Bot control/Poll/event/stream/publisher tests passed. Extended cost tests also verified 100 one-row heartbeats, immediate liveness transitions, independent control-section failures and concurrent nonce replay rejection.

At baseline capture, rolling metrics reported Commerce 88,778 writes / 1,295,576 reads, Accounts 7,694 / 21,677 and Lab 120 / 444: 96,592 account writes / 1,317,697 reads. The separate current UTC-day account figure was 56,148 writes. The historical seven-day account dataset recorded 97,337 writes on September 10, 4,826,475 reads on September 11 and 6,896,045 reads on September 8. Those are analytics measurements, not claims that every historical request succeeded beyond a cap.

Matched five-minute GraphQL Query Insights windows: before **12:30–12:35 UTC**, after **12:41–12:46 UTC**, September 12. The Bot had a working Rumble browser throughout the after window. Query Insights is an adaptive dataset: execution counts are estimates and need not equal the independently aggregated database metrics or exact nonce inventory. Rounded sub-one averages should be recomputed from sum/count.

| Query shape | Executions before -> after | Written rows before -> after | Read rows before -> after | Average SQL latency ms before -> after |
| --- | ---: | ---: | ---: | ---: |
| Nonce insert | 66 -> 33 | 198 -> 99 | 0 -> 0 | 0.198 -> 0.204 |
| Nonce expiry delete | 59 -> 24 | 76 -> 50 | 135 -> 74 | 0.190 -> 0.193 |
| Master reconciliation, old -> conditional shape | 271 -> 100 | 813 -> 0 | 1,355 -> 300 | 0.296 -> 0.328 |
| Required heartbeat | 51 -> 22 | 51 -> 22 | 51 -> 22 | 0.224 -> 0.296 |

Heartbeat's code, cadence and one-row-per-execution cost did not change; do not treat the sampled count variation as heartbeat suppression. The exact live nonce inventory after old requests expired contained 19 control requests and 19 heartbeat requests over about five minutes, compared with 18 each of config, poll, rules-v2 and heartbeat before. No legacy control calls continued after rollout.

Independent per-database metrics over those same five-minute windows were Commerce **317 -> 257 writes**, **91,455 -> 63,604 reads**, **129 -> 86 write queries**, and Accounts **481 -> 10 writes**, **1,529 -> 751 reads**, **161 -> 4 write queries**. The after window includes cleanup of pre-release nonces, six genuine acceptance page-view events in sampled Insights, and other legitimate operations. It must not be blindly extrapolated into a normal full day. No new bulk-write query or replacement read scan was introduced by this repair.

Three live stable-origin comparisons returned identical config/Poll/rule content: legacy control sequence 508–1,289ms, combined response 277–284ms; serialized payload 1,388 -> 1,516 bytes. Session response size remained 1,472 bytes, Admin status 1,663 bytes. Three-sample session/status/Automations latency ranges overlapped (session 252–332 -> 243–290ms; status 314–360 -> 284–333ms; Automations 275–319 -> 265–303ms). These short checks show no material endpoint regression, not a full production latency distribution.

Authenticated stable Admin Overview, Automations, Audience Analytics, Polls, Wheels and Commerce all loaded with no failed API responses. Automations displayed Healthy/Current. Public homepage, Watch, Polls, Wheels and account loaded; the existing Admin-to-Public handoff then verified an authenticated Public account session. No votes, spins, orders or payments were fabricated. Existing Cloudflare beacon CSP/integrity console errors remain outside this repair; first-party Audience Analytics ingestion/reporting was preserved.

## Capacity decision

**B — Free works, Workers Paid recommended for production headroom.** The optimized normal-day projection is approximately **50,000–55,000 writes and 1.3M reads**, using observed control cadence, per-cycle cost and the previous day's genuine non-control traffic. This is a projection, not a measured full repaired day. A baseline arithmetic cross-check is 96,592 - (4,906 cycles × eight avoided nonce lifecycle writes) - 6,819 duplicate master writes = 50,525 writes; allow for slightly faster completed cycles and traffic variation.

Normal write headroom is approximately 45–50k/day (1.8–2.0× safety factor). A legitimate 10-second active-Poll cadence permits 77,760 control/liveness writes/day; adding 5–10k event/other activity gives an **83–88k peak scenario**, only 12–17k headroom (1.14–1.20×). Concurrent Lab growth shares this account quota. Recent read peaks also approached or exceeded the Free allowance. These factors support Paid for reliability; efficient routine writes alone do not establish that Paid is strictly required. At projected usage the D1 portion is within Paid's included monthly allowances; other Workers/platform usage can affect the total bill. No plan change was made.

## Runtime recovery and final acceptance

The first repaired runtime initialized Discord, Rumble and both publishers normally. At 12:47:14 UTC, after the accepted measurement window, the browser closed; a separate launch at 12:47:45 was rejected by the single-instance lock. The operator confirmed attempting a restart. The remaining process ignored graceful console interrupts, so the operator explicitly authorized stopping the stuck Bot and relaunching.

At 12:55:02 UTC only the verified stuck Bot and its owned helper processes were stopped. The same tested Bot commit restarted through a protected launcher that restores console interrupt handling. One application process (PID 45636, with its Python virtual-environment launcher PID 43500) owns the runtime. Environment/config hashes remained identical, durable outboxes were preserved, and no source configuration was replaced. This recovery used an authorized forced stop; the initial deployment restart had completed gracefully.

The recovered runtime connected Discord and Rumble, published community/broadcast snapshots successfully, and remained free of new warning/error entries through 12:59:49 UTC across multiple scheduler cycles. Authenticated Admin reported online, synchronized desired/applied revision 3, three active rules, zero pending events and no rule fault. Business-record checks retained eight rules, 30 receipts, 277 Wheel entries and five orders. The five-minute D1 comparison above was measured during the first healthy repaired runtime; it is not attributed to the intervening browser outage.
