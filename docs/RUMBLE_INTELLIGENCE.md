# Rumble Intelligence V1

## Pre-edit audit, 9 September 2026

Admin main HEAD and origin/main: `4efc3cced73f6665f43ca26adac52d301a51bfde`; production Pages deployment `24ec2b67-440d-41f3-af4b-32f740211743` identifies that revision. Current/pending version is `0.1.0-alpha.0`. Existing untracked `migrations/RUMBLE_SUBSCRIBER_AUDIT.{md,json}` are preserved analytical references.

Bot main HEAD and origin/main: `ff59bf29882dd07d68b8056eedda17f57344f69b`; current/pending `1.1.0`. Existing modified `logs/bot.log` is preserved. Initial process inventory did not identify a THIRD-RAIL-BOT Python process; other applications' Python processes are outside scope. Runtime release verification remains required.

Local Accounts migrations: 0001,0002. Commerce inventory: 0001 through 0042, both distinct 0043 files (`aboot_matchup_studio`, `poll_manual_votes`), and 0044. Complete remote Commerce ledger read succeeded: all 45 files applied, last 0044 at 2026-09-08 13:24:40 UTC. Next additive migration is 0045. No historical migration is changed. D1 allowance is exhausted/intermittent per operator: successful metadata reads do not establish runtime availability.

## Implementation contract

This private report describes currently API-listed subscriptions, not verified billing entitlements. Operator rule `amount-v1`: integer 500 cents = Self-paid; integer 0 = Gifted; all other values = Needs review. A person's current records can establish Self-paid + gifted. Unexpected evidence takes the primary Needs review label while retaining both positive evidence flags. Historical paid records never confer current paid status. Gift purchases and badges are not personal-payment evidence.

Names use source-scoped NFKC, outer trim, lowercase. No fuzzy or cross-source matching. Record fingerprints include version, source, normalized name, raw reported date and amount evidence; they exclude avatar, array position and observation time. Without provider subscription IDs, identical grants cannot be distinguished; raw duplicate counts remain visible.

Reported subscription date is retained verbatim with validated UTC and a separate initial 30-day review date. Neither is a renewal, cancellation or paid-through date. Repeated observations never create payments or extend the review date.

Immutable membership sets retain record versions and observation references. New observations reuse identical sets. Atomic D1 batches insert sets, observations and conditionally promote the current pointer; older deliveries cannot move it backwards. Provider time must advance to confirm freshness or disappearance. Repeated provider time retains latest transport attempt separately. Qualified observations require unfiltered user/channel context, valid time, complete array, consistent raw count and no truncation signal. Count equality is not a provider completeness guarantee. Partial/failure observations never promote an empty roster. Distinct newer qualified absences confirm missing on the second observation; this is an observation interval, never an exact cancellation date.

History views show at most 180 qualified checkpoints, with explicit bounded coverage and gaps. Immutable stored observations are retained in V1; no destructive retention job runs. Initial bootstrap has unknown arrivals/removals, not synthetic churn. Historical imports retain provider time, unknown actual Bot fetch time, import receipt time and historical provenance. The separate danielclancy fixture is rejected by the ThirdRailify import workflow. Imports cannot dispatch automation events.

Admin Refresh reads existing storage only. Bot consumes the existing successful snapshot, before the no-Poll guard, using the existing HMAC client and a separate durable bounded retry outbox. Unchanged membership checkpoints are rate-bounded; membership changes are retained. No public roster, new provider polling loop, Wheel, Poll-credit or Discord side effects are added.

## Subscriber chart and pagination

The registry defaults to 20 rows with 10/20/50/100 options; changing page size or filters returns to page one. CSV continues to export every filtered account across all pages. Rumble Intelligence sits immediately below Watch / Broadcast, using an inline AdminIcon path drawn from the Rumble reference shape.

The green subscriber chart highlights total current distinct API-listed accounts independently of table filters. A second headline shows total paid subscribers (self-paid-only plus mixed accounts, each counted once). Explicit checkbox-style series toggles can hide every reporting type without changing either headline. Its 24hr/7d/30d/90d controls query the private, capability-protected `/api/admin/rumble-intelligence/trend` endpoint. Self-paid-only, gifted-only, mixed and unknown categories are exclusive and sum to total. Legend toggles and keyboard-focusable observations reveal exact values. Point markers appear only on hover/focus, with a detailed tooltip showing the exact UTC timestamp, source, provenance, total and category counts/percentages. The graph uses a slightly deeper green. Layout adapts its SVG coordinates to the container so mobile axes remain readable.

The query pins the displayed current snapshot and source, selecting the latest qualified actual observation per UTC hour (24hr/7d) or day (30d/90d), before loading membership sets. It covers the full window independently of the recent 180-checkpoint drawer; at most 340 observation rows are loaded, with reused sets classified once per request. Missing periods are not zero-filled, and lines break across gaps longer than 2.5 buckets. Refresh report also reloads chart history when the current snapshot has not changed, so imported older evidence appears. No additional migration or background polling is introduced.

Validation: production build/typecheck, scoped ESLint, eight focused contract/connected tests, and Chrome at 1920/1440/768/390. Browser checks exercise every page size, last-page boundaries, all timescales, legend toggles, keyboard evidence, source totals and sidebar order. Backend tests cover 90-day history beyond 180 checkpoints, exclusive categories, degraded observations, source isolation and pinned snapshots. The chart screenshots in `.artifacts/rumble-intelligence/ui-*/trend-{width}.png` use explicitly synthetic local historical observations and the real sample's latest 116-account roster; they are not production history. No production login or remote D1 calls were attempted for this enhancement.

## Release evidence

Protected full Commerce D1 backup: `X:\GIT\_BACKUPS\ThirdRailify\rumble-intelligence-20260909-before.sql`, 5,179,162 bytes, SHA-256 `506d906d14bc3e1b11fd07fa3dc5a17e3123ebf6039c1f2d0a4dfe43c141ae84`. NTFS access restricted to the operator, SYSTEM and Administrators. Successfully restored into an in-memory SQLite database for inspection; baseline includes 12 Wheels, 262 entries, 13 automation receipts and 37 Poll votes. The additive migration has no business-table writes or triggers.

Reviewed 0045 SHA-256: `4ecc443cc730ff58a8dd1aaf3f0c1e1774e16980498ab9c5d0b1cc4a8f046eef`. `.gitattributes` preserves LF. `scripts/release-rumble-intelligence-schema.ps1` verifies the full backup and migration hashes, checks every predecessor against the remote ledger and exposes only 0045 to Wrangler's supported migration procedure. It stops on native-command failure. Windows execution policy was not changed; the reviewed command block was invoked in the existing PowerShell session.

**Production migration completed:** 0045 applied to `thirdrailify-commerce` on 2026-09-09 at 04:03:16 UTC using the isolated reviewed release script. The protected backup and migration hashes passed, all prerequisites were present, all four tables/two indexes were verified, and the foreign-key check returned no violations. The earlier quota error 7500 blocked the first attempt; it no longer blocked this application. The already-running Bot then delivered a real observation without restart or manual outbox modification.

Production verification at 04:05:55 UTC ran the actual report and trend functions through a read-only production D1 adapter. Snapshot `92a4799118c1eb80dcf504e02a9e931c24bbb7c3837d00334258fb2db000f93a`, source `user:1sl8zm`, provider time `2026-09-09T04:00:52.000Z`: 108 raw records, 103 accounts, 9 self-paid-only, 92 gifted-only, 2 mixed, 0 needs review; paid total 11. The report and 24-hour trend reconciled on that exact snapshot. Bot outbox had zero pending and zero coverage gaps. Evidence: `.artifacts/rumble-intelligence/production-verification.json`. The user subsequently supplied a production screenshot confirming the populated report. The agent browser had no authenticated session; no credentials/cookies were copied and no login was requested.

Local tests reproduce all four original sources/timestamps/counts, including 122 raw / 116 names / 9 self-paid-only / 105 gifted-only / 2 mixed for the latest historical ThirdRailify sample. These are **fixture counts, not live production counts**. The connected test runs the actual Python extractor and HMAC HTTP client into the real Admin ingestion handler, local D1, real authenticated reporting and an actual Chrome browser. It validates source isolation, import preview fingerprint/CSRF/idempotency, continued observations without duplicate membership or arrivals, keyboard details, filters, reload persistence, unauthorized denial and zero automation/Poll receipts. Screenshots are local, not stable production proof.

History overview is bounded to 180 qualified provider checkpoints. The detail drawer separately reads up to 500 distinct retained record identities across all stored history with first/last provider, Bot observation and Admin receipt times. Historical imports have no invented Bot observation time. Outbox corruption is preserved and isolated from other Bot services; explicit terminal validation rejection increments durable lost-coverage diagnostics instead of blocking all later observations. The Bot publishes unchanged membership at most once per five minutes; membership changes are retained up to the documented hard bounds. Latest attempt in this report is the latest **published** attempt, not every high-frequency provider transport attempt.

Readiness uses zero-row column checks cached for five minutes, not repeated sqlite_master catalogue scans. Private report refresh never fetches Rumble. No new secret/resource, Public edit/deployment, Wheel selector, credit write, billing integration or automation parser rewrite is included.

## File tree

```text
commerce-migrations/0045_rumble_intelligence.sql
functions/_shared/rumble-intelligence.js
functions/api/admin/rumble-intelligence/[[path]].js
src/pages/RumbleIntelligencePage.tsx
src/components/RumbleSubscriberTrend.tsx
src/styles/rumble-subscriber-trend.css
src/styles/rumble-intelligence.css
scripts/release-rumble-intelligence-schema.ps1
tests/rumble-intelligence.test.mjs
tests/rumble-intelligence-connected.test.mjs
docs/RUMBLE_INTELLIGENCE.md
docs/RUMBLE_INTELLIGENCE_RELEASE.json
```

Extended: shared Admin capability registry, client route policies, navigation, App, internal Bot route, scoped CSP/avatar allowlist, Pages routing and LF attributes. Root README and BUMP_NOTES document current/pending 0.1.0-alpha.0. Original provider samples and both untracked analytical audit files are unchanged. No files removed.

## Validation limits

Focused capability/Raid/schema regressions: 10/10 passed on the isolated recheck, including actual D1 quota metadata reuse and transactional award rollback. New intelligence contract/connected tests pass. Production build/typecheck, changed-file ESLint, Functions compilation and diff checks pass. Bot full pytest: 351 passed, plus a final six-test intelligence recheck after stricter corrupted-state validation; scoped Ruff and compile/offline launcher checks pass.

The broad `test:functions` run encountered Miniflare `fetch failed` errors during unrelated Commerce fixture initialization and an unrelated Commerce readiness assertion (`undefined` versus `true`). The latter was reproduced on clean pre-task commit `4efc3cc` in the isolated release worktree, so it is not attributed to this feature. The broad run was stopped after these failures; it is not reported as a full-suite pass. Full-root Admin ESLint also fails on the pre-existing generated `.artifacts/catalogue-repair/functions-worker.js` parse error (plus generated-artifact warnings). No unrelated generated artifacts or Commerce code were changed to conceal these failures. Full Bot Ruff reports its pre-existing `event_automation.py` import order issue.


## Subscriber profile presentation

The subscriber drawer uses the stored avatar beside the display name, with an initial fallback when no image is available or it fails to load. The overview, current evidence, retained history and timeline use structured label/value fields. Values use a system monospace stack, including source/name identities, amounts, timestamps and record IDs. Classification chips share the graph colours throughout the table and detail drawer: teal paid, pale green gifted, blue mixed and lavender needs review. Status badges, record counts and disclosure rows organize the evidence; the native dialog retains keyboard dismissal and focus behavior. Responsive local screenshots are saved as `ui-*/subscriber-detail-{width}.png` and `subscriber-history-{width}.png` in the existing intelligence artifact directory.


## Source and freshness card

The source card presents the source identity and qualified/stale/unavailable status above the provider observation time, collection method and quality summary. Native disclosure reveals monospace fields for collection timestamps, scope, provenance, coverage gaps and the pinned snapshot ID. Responsive browser captures cover collapsed and expanded states at 1920/1440/768/390, under `.artifacts/rumble-intelligence/ui-1788926950318/source-card[-expanded]-{width}.png`. Local fixtures are used for these design screenshots; production migration/readback evidence is recorded separately above.


Production source-card release: commit `a3f9663`, deployment `https://ebf0f9a1.thirdrailify-admin.pages.dev`. At 2026-09-09T04:11:56Z, `https://admin.thirdrailify.com/rumble-intelligence` served the exact built JavaScript/CSS assets containing the new source-card implementation; both assets returned 200. The unauthenticated report endpoint still returned 401. A subsequent normal Bot snapshot at `2026-09-09T04:11:09.000Z` reconciled to the same 103 accounts and paid total 11. Evidence: `.artifacts/rumble-intelligence/card-deployment.json` and `production-verification.json`. No Bot restart, outbox edits, Public deployment or historical-data seeding was performed.
