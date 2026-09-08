# D1 schema-read quota repair — 9 September 2026

## Incident evidence

The live Accounts D1 rejected a table read with Cloudflare code 7500: the account exceeded its free-tier daily row-read allowance. A constant `SELECT 1` and unsigned session requests did not exercise table reads and therefore succeeded. Sign-in configuration returned configured=true. The existing client combines configuration and session startup with Promise.all, so a session failure also produced the misleading not-configured message.

Read-only Wrangler Insights over the preceding rolling 24 hours identified Commerce metadata scans: Poll credit readiness (2,468,310 rows / 5,344 runs), Automation rule table SQL (2,143,741 / 5,333), two Poll table-existence checks (1,211,398 and 499,191), and Matchup schema readiness (340,780). This is a rolling window, not a claim that every listed read occurred in the current UTC quota day. Private raw insights remain outside tracked source under `.artifacts/auth-outage-20260909/`.

## Scoped correction

`functions/_shared/schema-capabilities.js` replaces repeated sqlite_master scans in Automation readiness, Poll credits, Poll projections/reset readiness and Matchup readiness with one fixed, whitelisted schema catalogue lookup. Completed metadata is reused for five minutes per D1 binding object in a warm isolate. No shared in-flight I/O, credentials, permissions, business rows, live counters, heartbeat state or rule results are cached. No persistent cache or D1 write is introduced.

Missing capabilities and failed reads are not cached. An older Automation table lacking Raid capability invalidates the metadata cache, allowing a subsequent additive migration to become visible immediately. Expired entries cannot mask a failed database read. Successful metadata changes may take up to five minutes to be re-observed within an existing isolate; deployments start new code instances. Destructive schema changes must not be made underneath live application writers. Existing SQL constraints, replay guards, authorizations and business operations are unchanged.

The fixed catalogue covers 16 object names and returns only metadata. Other less expensive schema probes and application polling cadence are unchanged. Cross-request reuse is an optimization, not a correctness dependency; a cold isolate safely reads the catalogue again. Therefore production savings depend on isolate lifetime and traffic distribution.

## Validation and release

Local D1 regression: 40 repeated Poll/Bracket/Automation cycles use one 464-row metadata scan. The former paid-schema checks alone would read 37,120 rows in the same exercise. All 41 live heartbeat reads still execute. This is measured local evidence, not a claimed production percentage. Deterministic tests cover expiry, missing capability, migration recovery, database isolation, immutable metadata and failure after previous success.

Baseline Admin HEAD/origin/main was `6652ac8052c467381c244d5cfefd78117a5eda85`, production deployment `737c9baf-bd0b-4bee-9bf8-f12434167daa`. No schema migration, Bot restart, Public source change, provider operation, billing change, secret or domain change is required. The already-exhausted provider allowance cannot be restored by this deployment; live database acceptance remains blocked until reset or an authorized plan change.

Released commit `c2b51a5939b3abe2e11644bd62bc63f9937ffec0` through a fresh clean isolated worktree as Admin Pages deployment `5f45372a-f807-4289-850b-b200ed282297`. All 43 focused schema/Poll/credit/Bracket/Automation/award/Raid regressions plus the local D1 quota regression passed (44 total), along with typecheck, scoped lint, production build, Functions compilation and diff check. A new heartbeat written after warming schema metadata was immediately reflected in all subsequent readiness reads. Stable Admin HTML and JS/CSS match the immutable deployment; assets also match the local release build. The preceding deployment is the rollback target.

Post-release live checks at approximately 16:17–16:20 UTC on 8 September (02:17–02:20 Sydney on 9 September) were mixed: Accounts table reads and some Polls reads succeeded, but subsequent Polls/Wheels reads failed. A bounded production Pages tail captured the Polls exception explicitly as `D1_ERROR: ... exceeded D1's free tier daily row read limit`. Therefore the outage is still intermittent and is not declared recovered. No payment or plan change was made. Live usage reduction over a complete quota window remains unmeasured; the reported reduction is the controlled local D1 test.
