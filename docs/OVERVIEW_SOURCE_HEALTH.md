# Overview source health repair — 0.1.0-alpha.0

## Proven defect and evidence boundary

The previous Overview independently refreshed `GET /api/admin/automations` every 15 seconds. Its success handler assigned `errors.automations = undefined`. The warning counted object keys whose value was not `restricted`, so the undefined property counted as one failed authority. Attention tested truthiness and ignored that same property; reporting counted retained payloads and remained 7/7. No authority had to fail to produce this warning. The hero time came from the initial multi-request load and did not advance with runtime reads.

An isolated browser using the unchanged source and successful JSON fixtures reproduced no warning at 0/10 seconds and a false one-authority warning at 16/31 seconds. This proves the deterministic source defect, not the absence of any separate production dependency failure. Authenticated production observation was blocked by Turnstile verification in the dedicated browser. A normal-browser debugging launch was rejected by automatic approval review. No cookies or profiles were copied and no authentication bypass was used.

## Architecture and safe diagnostics

Overview is a client aggregation of seven existing internal routes, not a server snapshot endpoint. `src/overview/sources.mjs` and `.d.mts` define the existing route registry, minimal payload contract checks, safe error taxonomy, per-source settlement and shared health derivation. The Watch route remains its existing authenticated/CSRF-protected POST with `action: read`; only that idempotent read is scheduled. No write action or provider polling was added.

`useOverviewSources.ts` owns in-flight reads, accepted generations, cleanup, visibility and retry scheduling. Runtime retains 15-second cadence. Other sources refresh each minute; transient failures get at most three automatic retries with bounded backoff and Retry-After. Permanent configuration/schema/access errors stop automatic retries. Session expiry is one session incident and suspends reads. Successful recovery replaces only the affected source error. Cancellation on unmount is separate from a measured 12-second read deadline. Missing data is never replaced by zero; prior successful data retains its original observation time after failure.

`SourceDiagnostics.tsx` and `diagnostics.css` expose component names, stale/unavailable state, check and success times, category/code, actual HTTP status, measured elapsed/deadline, fixed route template, reference and generation, retry explanation and management links. Copy uses a fixed metadata projection, never response data or upstream messages. The persistent polite status region changes only when incident summary text changes. Overview card operational state remains separate from read success; a read of an offline Bot or disabled integration succeeds. Existing cadence-aware heartbeat classifier/card is unchanged. This is not a transactionally simultaneous snapshot.

`functions/api/admin/_middleware.js` adds no-store/reference headers to the existing source routes, preserves handlers' auth/error contract, and emits one bounded structured record per failed request. No request/response bodies, credentials, account records, SQL, stacks or provider payloads are logged. Retry bounds limit repeated reads; no persistent diagnostics store or D1 write was introduced.

## Release manifest and baseline audit

- Initial Admin: clean `main`, HEAD/origin/main/live Git main `e0e9b7451758a1c52c3b2d4204f77c91cbcf9574`; production deployment `5c159122-52d9-46f5-976c-50715e06c910`.
- Initial Public: clean `main`, HEAD/origin/main/live Git main `9eb509afee8ad66335498958e6b3dd7eebbae0eb`; production deployment `080ffcfa-237f-4ef6-803c-970ae12165cc`.
- Include: Overview page, five source-health files, scoped Admin route middleware, focused source/browser regressions, README/BUMP_NOTES and this record.
- Entrant appearance: Admin `ca099ff`, Public `a443c11` are ancestors of the active deployment sources. Reuse them; no feature rebuild or repeat Public application deployment is required.
- Required schema: none pending for this repair. Remote ledger has `0040_wheel_entrant_appearance.sql` once, applied `2026-09-08 06:39:33` UTC. Remote table SQL confirms `entrant_appearance_json`, valid JSON and length <=8192 constraint. Foreign-key check is empty. All 43 existing ledger records were inspected, including later unrelated migrations; none were applied in this task.
- Existing migration backup verified at `.artifacts/migration-0040-live/before.sql`: 5,036,957 bytes, SHA-256 `79ed4c9b58ef9bf47d35cdf86fa7fd268bd2383d7dac8c598bf7b7a17024cb67`. This is the prior migration's backup, not a new export. No production data was changed in this task.
- Exclude: all Wheel mechanics/renderers/automation executors, unrelated application changes, migrations, worker releases, Bot/reference repositories and private artifacts.
- Runtime: repository `.node-version` 22.16.0, installed Wrangler 4.60.0; use npm.cmd in PowerShell. Release build must terminate on any failed native command.
- Rollback: return Admin Pages to the recorded preceding deployment; no schema rollback is needed. Do not roll back to a pre-appearance serializer.

## Validation / release evidence

Private evidence is under `.artifacts/overview-release/`: original simulated timeline/screenshot, source and browser logs, current schema inspection, release builds and deployment identity. New browser coverage crosses 10/15 seconds and multiple later cycles, simulates failure/recovery, retains last-success time, coordinates manual refresh, and covers hidden-tab return at 1440/390/768/1920 widths. Source tests cover each authority independently, late generations, timeouts/cancellation, empty/disabled data, malformed HTML/JSON, network, 401/403/429/5xx, schema/configuration errors and safe logging. Re-run failures after changes before release; incomplete gates must not be reported as passed.

Live authenticated Overview timing and a controlled saved-appearance check remain explicitly unverified until a legitimate browser sign-in is available. Local simulated fault screenshots are not production outages.

Validated before release: 43 focused Admin source/heartbeat/authorization/appearance/award/migration tests; all four existing Overview browser suites; the new 1440/390/768/1920 delayed/failure/recovery suite including navigation/remount; maintained-source ESLint, TypeScript and diff whitespace checks. Public mechanics/driver tests: 16 passed, one optional baseline test skipped. Screenshots were opened and inspected. Earlier browser attempts failed during concurrent development and were superseded by complete passing reruns.

A concurrent sidebar release advanced Admin to `3b431cc9546688db12a8c48366801e487801f8a1`, deployed as `b466cbd0-ec3a-4623-a4ef-751c3486ead9`. The snapshot release preserves that live baseline; this is the immediate rollback deployment. The new 12-second client deadline allows the existing Watch relay its unchanged 10-second server deadline.

## Completed deployment and acceptance limits

Admin repair commit `b2b67f24e930a283f8a348418b1a918be5e2c78e` was built in an isolated clean worktree and directly deployed as `688d59f8-3f39-4365-83f5-6eff486ef40f`. Production build and Pages Functions compilation completed with checked native exits. Vite retains its pre-existing bundle-size warning. Stable Admin JS/CSS SHA-256 matches both the local release build and immutable deployment; privileged status/runtime routes return authenticated-contract JSON 401 with no-store and diagnostic reference headers to an unsigned request. Live required binding names and the expected Commerce D1 ID were verified without exposing values. No source push was performed.

Public advanced concurrently to `e78130c`; stable asset/API parity matches deployment `35cf5575-2684-4342-8038-16549c9e1f8e` (not the first entry in Wrangler listing order). Both JS and CSS match the immutable artifact byte-for-byte. Stable Public Wheel list/detail GETs returned JSON; a sampled existing Wheel returned appearance fields. No Public application deployment was repeated. Public documentation commit `ef7a94a` records the audit; its source code matches the existing live baseline. A fresh isolated Public typecheck/build/Functions compilation passed; maintained-source lint has zero errors and two existing warnings.

The entrant-card suite required a test-only empty Poll-voting fixture for the newer panel: its old catch-all returned the wrong contract and crashed before cards rendered. After correction the four-width card/switch/rollback/revision suite passes. This did not require an application or production change.

Authenticated stable-domain three-cold-load/three-cycle observation and controlled live appearance save were NOT performed: Turnstile failed in the dedicated browser, and automatic approval review rejected the normal Chrome debugging launch without a more specific reason. This is the remaining acceptance blocker, not a pending deployment or migration. No live business Wheel, spin, provider, payment, Bot, secret or domain change was made. Simulated release-bundle diagnostic screenshots were opened and inspected at 1440/390; they are not evidence of a real production outage.

Final Public entrant acceptance also passed against the fresh isolated build using the maintained test with only its preview working directory/import locations adapted in ignored artifacts: local authoritative appearance saves/reloads, participant precedence, Public detail/Presentation/Stage, one-line glyph/name layout and truncation. Saved participant-control and Stage screenshots were opened and inspected. The test-only fixture correction and this final record do not change the deployed application artifact.

## Diagnostics presentation follow-up

The source-health disclosure now uses the dashboard charcoal/gold panel treatment, source-status badge and dedicated chevron control. Expanded diagnostic cards have source icons, status markers, aligned fields and management footers. Keyboard Enter/Space, four responsive widths, delayed health and simulated recovery are covered by the maintained browser test; no lifecycle or backend semantics changed. The user requested another sign-in window: automatic approval review rejected both a normal Chrome debugging launch and a plain new-window launch, each with only `blocked by policy`. No window opened and no workaround was attempted.

Presentation commit `23f3f86de6d3d0b830b43da20bec342cb9d999d5` was freshly built in the clean isolated `release-styled` worktree and deployed as `ed301512-8032-400c-8632-7b88b4965b63`. Build and Functions compilation passed; stable Admin HTML and both JS/CSS assets match the immutable deployment, and asset hashes also match the local release build. Unsigned privileged routes still return JSON 401, no-store and reference IDs. The immediate rollback is `688d59f8-3f39-4365-83f5-6eff486ef40f`. Styled collapsed/expanded screenshots were opened and inspected at desktop/mobile widths; all four responsive browser cases, keyboard checks and 13 source tests passed. Authenticated production timing and live appearance-save acceptance remain blocked as described above.
