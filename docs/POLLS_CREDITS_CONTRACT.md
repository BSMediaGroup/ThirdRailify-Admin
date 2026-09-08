# Poll matchups and additional votes (local milestone)

## Starting audit — 2026-09-08

Public main / HEAD / origin/main: a443c11fee89b8eed6166a8d63dca4344e27acea; clean.
Admin main / HEAD / origin/main: ca099ff8078200f8113921d04214d7d9dc1ed864; clean.
Bot main / HEAD / origin/main: 07859bb585c9b11403c133558775163e1b37305d; pre-existing logs/bot.log modification preserved.
Public/Admin package version 0.1.0-alpha.0, supported Node 22.16.0. Bot 1.1.0, own .venv Python 3.11.9.
Admin auth migrations 0001–0002; Commerce inventory 0001–0040 before this work. New migration: 0041_poll_matchups_and_credits.sql. No historical migration edited.
All four supplied RUMBLE JSON files were read locally; no raw response or credentials copied. Events sample has 50 recent messages, one Rant, and same-actor equal timestamps. Raid sample has 48 messages and five Rants. Gift video IDs are integers; stream IDs are strings. No verified conversion was found.

## Authority and checkpoints

Admin polls-core.js owns D1 Polls/options, ordinary current votes, lifecycle, creator grants and exclusive source leases. Public functions/api/polls is the relay. Admin poll-media.js owns private/public R2 delivery. Bot poll_automation.py uses the existing locked shared snapshot and signed control client; event_automation.py supplies canonical paid-event adapters. No new provider loop, secret, or infrastructure.

Checkpoints: additive schema/accounting and atomicity; Bot evidence/outbox; Public and Admin presentation; connected local acceptance.
Ordinary current votes retain actor/source identity and replacement semantics. Additional credits never change their weight. Option totals sum ordinary rows and committed allocations; pending balances are excluded. Vote units do not imply identified people across sources.
Product defaults: floor(integer amount_cents / 100), five votes per total_gifts, three following messages, 300-second timeout. No currency code is inferred; amounts use reported currency units. expires_on is not earned-credit expiry.
Rants use literal NFKC/lowercase whole-word/phrase containment. Chat/gift follow-ups use entire-message equality. Repeated same-option phrases award once; different-option matches go to review. No trigger means non-voting Rant.
Each gift lot retains its policy/window, independent attempts and balance. Every distinct subsequent purchaser message consumes an attempt. Exhaustion/timeout/window close move credits to review. Late history never reopens a resolved lot. Equal-time ordering, unknown identity, and finite-window gaps must not be guessed.
Invariant: earned = committed + waiting + unreconciled + discarded. D1 batches use a failing revision guard to roll back all associated writes. Reconciliation requires Admin automation management and Poll management, independently from creator ownership. Closed pre-close credits may be reconciled without reopening voting.

## Controlled future rollout (not authorized here)

Backup -> review exact predecessor and 0041 migration set -> compatible Admin/media code -> compatible Bot update and authorized restart -> Public release -> controlled acceptance -> explicit paid-policy enablement. Never apply all pending migrations blindly. Release scripts must fail on each native error and build successfully before using dist. This task performs no remote migration, deployment, push, provider event, Bot restart, payment, announcement, or real vote.


## Routes, storage and permissions

Public routes: `/polls` feature shelf (server-filtered, maximum four); `/polls/abootnothing` current/past/search/pagination; `/abootnothing` permanent redirect plus client fallback. Existing `/polls/new`, `/:slug`, `/:slug/edit`, `/:slug/popout` and quick view retain canonical identity. Aboot Nothing requires exactly two stable options. Subtype/option structural changes are locked when votes or credits exist; open editors save presentation without rewriting option identities.

Admin routes: `/polls/abootnothing` content library/create/edit/media/lifecycle; `/automations#poll-voting` policy, source discovery, matching tester; `/automations#poll-reconciliation` filtered evidence and audit queue. Policy/test/reconcile APIs are `/api/admin/automations/poll-voting/{policy,test,reconcile}`; GET `/api/admin/automations/poll-voting` returns protected state. The signed producer endpoint is POST `/api/internal/bot/poll-credits`. Existing Pages include patterns cover these routes. Public `/api/polls` remains a sanitized signed relay, with no Bot contact or direct Commerce binding.

Admin collection filtering runs before the 250-item library bound. Each reconciliation lot carries its original options even when its Poll is outside the recent library. Policy and reconciliation actions independently require both `automations.manage` and `polls.manage`. Creator grants, ownership, ordinary account status and Bot credentials do not confer either administrative action. Correction inserts compensating allocation records against original Poll options; database triggers reject updates/deletes of allocations and audit history, and corrections cannot overdraw the original option. Partial intervention moves remaining waiting units to review. Each action records administrator, reason, timestamp and before/after balances. Poll media still uses existing authorized private upload and public-visibility gates.

## Operational limits and explicit defaults

Paid collection starts disabled on every existing/new ordinary Poll until an administrator saves a policy. Desired policy is separate from fresh protocol-2 heartbeat/applied-window status. A changed policy ends the old window and preserves its lots/attempts; newly activated windows do not retrospectively earn old evidence. Reopen creates a new window. Global paid-event fingerprints prevent reminting.

Defaults are product choices, not provider guarantees: N=3 (administrator can choose 1/2/3), timeout=300 seconds (60-1800), 100 cents per Rant unit, five units per gifted subscription. The provider samples support integer amounts and gift quantity/purchaser fields; they do not establish complete history, subsecond ordering, a currency code, cross-source human identity, or numeric-video/string-stream conversion. No claim of perfect event capture is made.

Every distinct relevant purchaser chat, including emotes/nonmatches, consumes the independent lot budget. Same-snapshot chronological follow-ups work. Equal-time alternatives or later arrivals at/before processed time go to review. Nonmatching Rants earn nothing. Missing purchaser identity creates a review lot, never a shared unknown wallet. Confirmed stream end ends waiting; failed discovery alone does not. Source-scoped single-active-Poll attribution is explicitly declared when exact gift video mapping is unavailable; multiple/uncertain live contexts go to review.

Bounds: 200 evidence events per envelope; 1000 pending durable envelopes; 500 pending lots/actors per window; 100 reconciliation lots with up to 10 observations/20 audit entries each; timeout maintenance up to 200 lots per pass. Overflow is a visible failure with no acknowledgement or truncation. There is no per-lot timer or unrelated full-chat archive. D1 lookups chunk fingerprint bindings below its 100-parameter limit. Atomic batches use revision guards and database conservation/option constraints; failed guards roll back receipts, amounts and audits together. Platform basis: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [transactional batch behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/).

Closed unresolved results carry a public pending label. Only committed allocations contribute to option totals/percentages; separately labelled ordinary voter identities are source identities, not deduplicated people. Both current and past collections offer load-more pagination. Existing coordinated refresh updates open/unsettled views; loaded history pages refresh in rotation without discarding earlier pages. Fully settled closed results use the existing quiet/cache-friendly path. Reconciliation increments result revision and never reopens voting.

## Exact local schema and runtime prerequisites

Only new Poll migration: `commerce-migrations/0041_poll_matchups_and_credits.sql`, following the audited Commerce inventory through `0040_wheel_entrant_appearance.sql`. Auth schema remains unchanged. Concurrent `0042_wheel_entrant_identity.sql` belongs to separate Wheel work, and is not part of this Poll rollout set. Historical migration files were not edited.

The migration adds Poll presentation/result revision, policies/windows, earned lots, message/attempt receipts, allocations, audits, batch receipts and transaction guards. Missing readiness returns `poll_credit_schema_required` (503) before an Aboot/paid write. Predecessor ordinary reads/votes remain compatible. Existing media schema/bindings and signed secrets remain required; none were added or rotated.

Runtime prerequisite is protocol 2 on updated Bot evidence and Admin ingestion, fresh compatible heartbeat, applied original window/policy and explicitly enabled desired policy. A frontend build or saved desired state does not prove execution. Outbox retries always retain their original window and require an explicit matching fingerprint acknowledgement. Unknown original windows retain evidence for operator investigation.

## File inventory and validation commands

All affected root READMEs contain their additions/tree. Public changes are Poll page/types/client/relay, router/redirects and new `src/styles/aboot-polls.css`; existing Poll browser fixtures isolate collection requests. Admin adds the migration, `functions/_shared/poll-credits.js`, `src/pages/AbootNothingPage.tsx`, `src/polls/{PollVotingPanel.tsx,admin-request.ts}`, two tests and this document. Existing Poll/core/automation/Bot APIs, Admin navigation/capabilities/styles and migration helper integrate them. Bot adds `thirdrailify_bot/poll_credits.py`, `tests/test_poll_credits.py`, `tests/poll_credit_bridge.py`; existing `poll_automation.py` consumes/flushes evidence. Root BUMP_NOTES record unchanged actual current/pending versions. No files were removed. Unrelated dirty Wheel work and pre-existing Bot logs were preserved.

Use Node 22.16.0 with `npm.cmd`/`npx.cmd`; Bot uses its own `.venv`.

```text
Public/Admin: npm.cmd run typecheck
Public/Admin: npx.cmd eslint src functions
Public/Admin: npm.cmd run build
Public/Admin: npx.cmd wrangler pages functions build functions --outdir .artifacts/poll-credits/functions --output-routes-path .artifacts/poll-credits/functions-routes.json
Admin: npm.cmd run test:polls
Admin: npm.cmd run test:browser:poll-matchups
Admin: node --test --test-concurrency=1 tests/admin-capabilities.test.mjs tests/event-automations.test.mjs tests/automation-awards.test.mjs
Public: node --test --test-concurrency=1 tests/polls-functions.test.mjs tests/polls-browser.test.mjs tests/poll-media-browser.test.mjs tests/polls-v12-browser.test.mjs
Bot: .venv\Scripts\python.exe -m pytest -q
Bot: .venv\Scripts\python.exe -m ruff check <changed Python files>
Bot: .venv\Scripts\python.exe -m ruff format --check <changed Python files>
Bot: .venv\Scripts\python.exe -m compileall -q thirdrailify_bot
Bot: .venv\Scripts\python.exe bot.py --check
All roots: git diff --check
```

The connected test invokes the actual Python adapter, signs its envelope, executes actual Admin HTTP handlers against isolated D1/R2, then renders actual built Public through its actual relay and actual Admin controls. Browser routing confines all traffic to local origins. Auth and unrelated inbox shell fixtures are synthetic. No provider API was called. Set POLL_BROWSER_ARTIFACTS to a fresh local directory if Windows temporarily locks an existing capture; final captures used .artifacts/poll-credits/final. It checks 1920/1440/768/390 widths, keyboard Escape, reduced motion, detail/modal/popout, collection/alias/new-route, feature shelf, artwork replacement/save/reload, closed history and closed credit allocation.

## Evidence and remaining gates

Admin `test:polls`: 15/15 passed (eight new ledger tests, six existing core tests, one media test). Concrete checks include 1000-cent Rant +10, replay +0, distinct Rant +10, gift +5 plus ordinary +1, ordinary choice replacement, N=1/2/3 saves and match positions, exhausted allowance, independent lots, partial allocation/discard, correction replay/bounds, close/match and expiry/match races, late equal timestamps, exact-stream isolation, missing-schema preflight and predecessor upgrade, source lease exclusion, creator/ordinary/Bot reconciliation denial, and conservation/rollback.

Admin authorization/event/award regression suite: 13/13 passed. Both production builds/typechecks and both Pages Functions compilations pass. Maintained-source Admin lint is clean; Public has zero errors and two existing warnings in ProductVariantSelectors/WheelCanvas. Bot full pytest passes 345 tests; focused Ruff/format/compile and offline `bot.py --check` pass (existing discord audioop deprecation warning). The final combined Public Functions/browser run passes 8/8 (Functions=4, main=1, media=2, history=1). Connected browser acceptance passes 1/1. All three git diff --check checks pass.

Connected browser captures are under Admin `.artifacts/poll-credits/final`: gallery/detail at the four widths, Admin editor, Admin reconciled and closed settled. Selected desktop/mobile gallery/detail, Admin editor/reconciliation, closed-settled images and the recorded state-change storyboard were actually inspected. `geometry.json` records fitting detail/Admin widths. `matchup-state-change.webm` is the approximately 17-second synthetic state-change capture; accompanying storyboard supports review. These are local artifacts, not live-site evidence.

Known legacy gate failure: Admin `tests/polls-browser.test.mjs` expects "Bot heartbeat is delayed" for age 240 seconds; unchanged `src/runtime-health.ts` declares offline after 180 seconds and renders "Bot heartbeat is offline". Both values were verified in HEAD, and the stale assertion failed on repeated runs. This unrelated expectation was not changed to manufacture a pass. The new connected browser covers the changed Admin content and reconciliation controls separately.

Production remains unverified and unchanged. Full live acceptance requires separately authorized rollout and provider/runtime evidence; finite provider history and gift/stream identity constraints remain intentional review paths, not eliminated limitations. Follow the controlled rollout order above, verify JSON/content type on actual immutable and stable Function URLs, and stop if schema, compatible runtime or any acceptance gate fails. Paid enablement is the final explicit step.


## Production dashboard repair - 2026-09-08

This release supersedes the earlier unchanged-production status above for schema and dashboard deployment. Migration 0041 was the only pending Commerce migration. A protected, ignored database export was taken, then the exact migration was applied using an isolated migration directory and LF SQL. Production now reports no pending migrations, all five credit schema readiness markers, and no foreign-key violations. Existing Polls remain present. No paid policy was enabled and no production fixture votes or matchups were created.

Admin deployment: https://d3519c6a.thirdrailify-admin.pages.dev, promoted to https://admin.thirdrailify.com. Both origins serve byte-identical tested JS/CSS and return successful JSON from `/api/polls?type=abootnothing`; the Public relay returns successful JSON too. Public's deployed Polls CSS contains winner badges/glow and muted runner-up styling.

The dashboard now has padded bodies, readable section headings, responsive status cards and filter controls, and deliberate loading, error and empty states. New matchup artwork can be selected and previewed before saving. The first save establishes the Poll identity before uploading; an upload failure retains that identity and pending files for retry. Existing artwork replacements preserve unsaved editor text.

Validation: build/typecheck and focused lint passed; Poll regression suite 15/15; connected browser suite passed at 1920/1440/768/390 widths, including padding/overflow checks, pre-save selection of all three images, interrupted upload retry without duplicate creation, persisted images after reload, and unsaved text preservation. Editor and desktop/mobile panel screenshots were inspected. Evidence is ignored under `.artifacts/poll-dashboard-repair/release` and `release-verification.json`. Browser writes exercised real handlers with isolated D1/R2 and synthetic authentication; no authenticated production upload/save or live provider execution is claimed.

Poll feedback follow-up: saves, artwork updates, lifecycle/visibility/access changes and credit reconciliation use the shared AdminToasts provider. Inline saved banners were removed; matching tests do not announce a save. Connected browser acceptance verifies fixed desktop/mobile positioning and automatic dismissal; screenshots are under .artifacts/poll-dashboard-repair/toasts. Build/typecheck and focused lint pass.
