# Rumble event automations V1 — local implementation

## Initial audit and scope

On 2026-09-07, Admin was clean on `main`, HEAD and local `origin/main` both `9700180b712ed8ef56bcf60e49c1838471d48d0a`. Package/current/pending version: `0.1.0-alpha.0`. The newest BUMP_NOTES entry was the September 7 Printful mockup/publication repair; that accumulated history is preserved. README already documented the existing Poll control plane, Wheels authority and pinned Node path.

Bot was on `main`, HEAD and local `origin/main` both `be81dfffcec0869ea26a362c44568a53249a785c`, version/current/pending `1.1.0`. `data/runtime/poll-automation.json` and `logs/bot.log` were already modified by the operating runtime. They were not reset, staged or used as test fixtures. Its newest bump entry documented Poll creator discovery V1.1. No live process was started or restarted. No AGENTS.md was found in either working tree or the parent roots checked.

Only Admin and Bot source/documentation/test roots are writable for this milestone. Public and all other listed reference repositories receive no changes. No migration or code was deployed; no production, provider, DNS, secret, payment or Discord action was performed.

## Authority and flow

Admin owns typed rules, revisions, activation timestamps, target validation, receipts, audit, counters and entry writes. The existing Bot is the only Rumble client. Its existing locked scheduler fetches the creator snapshot and fans it out to Poll exact-chat voting and the new event consumer. The event consumer has no provider connection or scheduler of its own. Active event rules lease 15-second cadence in that same loop, while an active Poll retains its established 10–30 second cadence. Existing provider backoff overrides the lease; Discord notification enablement stays independent.

Bot pulls the safe rule projection through the existing HMAC client, indexes by event family, matches locally and sends at most 50 matched envelopes per request. Admin independently revalidates rule revision, enablement, family, scope, activation, actor and typed condition evidence. `executeAutomationWheelEntry` lives in the existing `wheels-core.js` authority and writes existing `wheel_entries`; no alternative participant table or Public projection is introduced.

Receipt insertion, entry insertion, Wheel revision/count update, rule counters and Wheel audit execute as one D1 batch transaction. Receipt writes condition on both the current Wheel revision and current enabled rule revision. A failed downstream statement rolls back the entire batch; a concurrent edit produces a retry response. D1 batch transaction behavior is documented at https://developers.cloudflare.com/d1/worker-api/d1-database/ .

## Confirmed contracts

| Family | Provider collection / timestamp | Actor | Conditions |
| --- | --- | --- | --- |
| Exact Chat Message | `livestreams[].chat.recent_messages`, `created_on` | Source-scoped normalized username | Required exact text; optional badge and exact stream |
| Rant Received | `livestreams[].chat.recent_rants`, `created_on` | Source-scoped normalized username | Optional exact text, integer minimum cents, badge, exact stream |
| New Follower | `followers.recent_followers`, `followed_on` | Source-scoped normalized username | Source only |
| New Subscriber | `subscribers.recent_subscribers`, `subscribed_on` | Nonempty `user`, otherwise normalized username; display username | Optional integer minimum cents; zero qualifies by default |
| Gifted Sub Purchase | `gifted_subs.recent_gifted_subs`, `gifted_on` | Normalized purchaser | Optional minimum total gifts and exact gift type |
| Livestream Started / Ended | Explicit `is_live` changes for an identified stream | None | Telemetry foundation; actor entry action incompatible |

Populated recent collections are canonical; corresponding latest values are fallback only. Processing is oldest-first, deduplicated within a snapshot. Integer cents are authoritative when supplied; `amount_dollars` is not independently interpreted. The confirmed numeric gift `video_id` (including sample `444666132`) is a separate safe integer, never a string livestream ID. `remaining_gifts` is not purchased quantity. No gift recipients or account links are inferred.

`rumble-event-v1` SHA-256 fingerprints include family, source, canonical actor and raw provider timestamp. Chat adds stream and exact raw text; Rant adds stream, raw text, cents and expiry; subscription adds cents; gift adds numeric video ID, total gifts and gift type. Profile images are excluded. Existing Poll fingerprints and NFKC/outer-trim/lowercase whole-message behavior remain unchanged.

Every save of an enabled rule creates a new authoritative activation boundary; disabled rules have no active boundary. Provider events before that boundary are ignored, including the first snapshot's historical arrays. Restart/overlapping arrays use both the persisted Bot ledger and Admin's unique `(rule_id,event_fingerprint)` receipts. The local ledger is an optimization, not the exactly-once authority.

First stream observation is a baseline, not a start event. Explicit live-state changes use a durable bounded per-stream sequence for deterministic transition identity. Missing streams or malformed snapshots do not imply a stop. This milestone does not create state-triggered entry rules, clear/reset/spin actions, or fictional entrants.

Normalized transitions use `rumble-livestream-v1` fingerprints, explicit source/stream context, null actor fields, null provider transition timestamp and a separately named observation timestamp. The API does not supply a start/stop transition timestamp.

## Schema, APIs and access

Additive migration: `commerce-migrations/0034_rumble_event_automations.sql`, following the inspected local ledger's `0033_merchant_shipping_ratebook.sql`. It adds `automation_rules` and `automation_receipts` with typed constraints, active/target indexes and bounded-history indexes. Wheel references use `ON DELETE SET NULL`, preserving receipts when established Wheel deletion occurs. Deleted rules are tombstoned; receipts are retained for idempotency. Creator IDs follow existing cross-database account reference conventions and have no invalid cross-D1 foreign key.

| Endpoint | Method | Authority |
| --- | --- | --- |
| `/api/admin/automations/rules?wheelId=…` | GET | `automations.view` + `wheels.view` |
| `/api/admin/automations/rules` | POST | `automations.manage` + `wheels.manage`, Admin origin, CSRF |
| `/api/admin/automations/rules/delete` | POST | Same, revision and explicit DELETE confirmation |
| `/api/admin/automations/test` | POST | Same; pure dry run, no database mutation |
| `/api/internal/bot/rules` | GET | Existing Bot HMAC and replay protection |
| `/api/internal/bot/events` | POST | Existing Bot HMAC and replay protection, 128 KiB / 50-event bounds |

The established Full Admin role capability-denial policy applies. Public creator grants/ownership alone do not authorize these APIs. No arbitrary event names, regex, code, SQL, URLs or webhook actions are accepted. Projections omit account/creator data, secrets and private Wheel contents. Matched text evidence is transiently submitted only when a text condition requires it; receipts retain no message/evidence/raw payload. Unmatched chat is neither sent nor persisted.

Rules are limited to 200 live records, target choices to 500, action history to 40. Bot pending envelopes are capped at 1,000, local seen keys at 2,000 and stream state at 50; full queues preserve pending work and report dropped candidates. Receipts are indexed and deliberately retained rather than expired into replay vulnerability. Normal provider history windows can still omit events between polls; saturation is not a proof of loss or outbox depth.

## Operator surfaces

Trigger Studio replaces the deferred family cards on `/automations`. It offers typed family-specific conditions, Wheel selection, enable/disable, optimistic edits, confirmed delete, activation information, counters, latest outcome/fault and bounded action history. The dry-run form accepts synthetic input and a compact redacted sample preset; it explicitly states that no action executes. Livestream family selection shows incompatibility and no save/action button.

The same panel appears on Wheels Overview and `/wheels/:id`. A detail-page create preselects its Wheel, and the panel links back to Automations. Duplicate policy is explicitly **Skip if entrant already exists**. Existing labels, including hidden entries, are compared with NFKC/outer-trim/lowercase normalization. Every qualifying gift event attempts one weight-1 entry; gift count never multiplies entries. Locked, archived or full Wheels record a no-action fault. Successful entry mutations increment Wheel revision so a stale editor cannot overwrite them unnoticed.

## Files added

```text
commerce-migrations/0034_rumble_event_automations.sql
functions/_shared/automation-contract.js
functions/_shared/automation-core.js
src/components/TriggerStudio.tsx
src/styles/trigger-studio.css
tests/event-automations.test.mjs
tests/event-automations-browser.test.mjs
tests/fixtures/rumble-events-v1.json
tests/fixtures/rumble-event-envelopes-v1.json
docs/RUMBLE_EVENT_AUTOMATIONS_V1.md
```

Existing Poll/Bot API handlers, heartbeat sanitizer, Wheels core, Automations/Wheels pages and test migration/browser helpers are extended. No source files removed. The Bot adds `thirdrailify_bot/event_automation.py`, `tests/test_event_automation.py` and `tests/fixtures/rumble-events-v1.json`; it extends Poll service integration and the existing shared loop. Both READMEs and BUMP_NOTES are updated additively with their actual versions.

## Local validation

Use `C:\Users\TempAdmin\.codex\tmp\node-v22.16.0-win-x64` first on PATH and `npm.cmd` (never npm.ps1).

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
node --test --test-concurrency=1 tests/event-automations.test.mjs tests/polls-core.test.mjs tests/wheels-migration.test.mjs tests/wheels-core.test.mjs tests/wheel-stages-core.test.mjs tests/wheel-media.test.mjs tests/admin-capabilities.test.mjs tests/auth-migration.test.mjs tests/auth-functions.test.mjs
node --test --test-concurrency=1 tests/event-automations-browser.test.mjs tests/polls-browser.test.mjs tests/wheels-browser.test.mjs
node node_modules/wrangler/bin/wrangler.js pages functions build functions --outdir .artifacts/event-automations/functions
npm.cmd run commerce:worker:build
git diff --check
```

The initial focused server suite passed 41 tests. Subsequent focused additions cover the confirmed redacted Python envelopes and transaction rollback. Browser tests use Vite/Chrome, real isolated local D1 for rule CRUD/execution/dry run, and fixture session/heartbeat/Wheel-shell responses; actual route auth/HMAC/CSRF is separately covered in server tests. No claim of production acceptance is made. Required widths are 1920, 1440, 768 and 390 pixels, with 68 new screenshot files: full page plus 16 requested surface/state groups at every width. Desktop/tablet/mobile layout and control overflow are asserted. Element crops suppress the sticky shell bar and offscreen skip link during capture only; full-page evidence keeps the shell unchanged. Evidence and contact sheets: `.artifacts/event-automations/REVIEW.html`. Regression screenshots were copied into its `regression/` folder; historical tracked artifacts were restored to their initially clean contents.

Bot validation uses its `.venv`: `python.exe -m pytest`, `python.exe -m ruff check .`, `python.exe -m compileall -q thirdrailify_bot bot.py`, `python.exe bot.py --check`, and `git diff --check`. The full suite passes 326 tests; the only pytest warning is Python's existing Discord `audioop` deprecation. The check is explicitly offline and does not log in or publish. Admin lint has seven existing warnings in the pre-existing `.artifacts/public-igdb-release` checkout; production build retains the existing large-chunk warning.

Final focused verification: `node --test --test-concurrency=1 tests/event-automations.test.mjs` passed 4/4; the new browser suite passed 1/1 across all four viewports; existing Poll and Wheels browser suites each passed 1/1. After the final transition-contract refinement, `.venv\Scripts\python.exe -m pytest tests/test_event_automation.py` passed 15/15, Ruff and compileall passed again. Final Admin typecheck, lint, Functions compilation and both repository diff checks passed. The new 68 screenshots were actually inspected through all 17 four-width contact sheets, with additional native-size desktop chat editor, mobile gift editor and mobile Wheel panel inspection. Review found no page/control horizontal overflow; snapshot-only sticky-header/skip-link capture artifacts were removed and regenerated. No production visual acceptance is implied.

## Rollout — separately authorized future work

1. Review the paired changes and verify clean release checkouts. Export/verify the existing Commerce D1 backup and inspect its actual migration ledger. Apply only missing approved migrations in ledger order; do not recreate the database or replay historical migrations. Apply 0034 before the new Admin code.
2. Deploy Admin to an isolated preview and verify JSON content types for the rule/event endpoints, actual authenticated capabilities, CSRF/HMAC/replay rejection and responsive UI. Keep all new rules paused.
3. Deploy/promote Admin through the established release process. Update/restart the existing official Bot once through its normal operator procedure; do not launch another process or Rumble client. Existing configured HMAC credentials suffice; no new secret is required.
4. Confirm heartbeat event telemetry and active-rule projection with zero rules. Enable one exact-chat rule on a designated acceptance Wheel, then a Rant/follow/subscriber/gift rule as corresponding real new events become available. Record activation, event receipts, one entry/revision update and bounded counters. Never manufacture provider activity or perform purchases for testing without separate authorization.
5. Verify historical subscriber/follower/gift/Rant arrays add zero old actors; one new event adds once; duplicate snapshots and a planned Bot restart add nothing again. Verify a later distinct event produces a separate receipt, duplicate entrant skip, zero-value subscriber behavior and gift quantity 5 producing one attempt.
6. Confirm real stream transitions change telemetry once with no entrant. Recheck Poll exact voting, broadcast/community publication and Discord/slash-command behavior, one shared provider cadence/backoff and live desktop/mobile Admin/Wheel surfaces. Public Wheel projection remains the existing projection.
7. If acceptance fails, pause rules first. Preserve receipts and the additive schema; revert code only through the established release process. Do not clear receipts or restart healthy unrelated systems as a speculative fix.

## Limits

Provider arrays have no confirmed stable event IDs; byte-identical events with the same identity/timestamp/data are indistinguishable. History windows cannot guarantee complete delivery across outages. Username fallbacks are source-scoped identities, not verified Third Railify accounts. Gift recipients and numeric-video/string-stream mapping are not supplied. A missing stream is not sufficient evidence of a stop. Livestream events have no actor-compatible action in this milestone. Production rollout and live acceptance remain intentionally unperformed.
