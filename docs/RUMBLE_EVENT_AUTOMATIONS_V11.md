# Rumble automations V1.1 — local implementation

Package version remains `0.1.0-alpha.0`; the typed action payload is version 2. No release, remote migration or Bot restart is part of this milestone.

## Initial audit and root causes

- Admin started clean on `main`, HEAD and origin/main `bdb07fef9d638a9c74fd8d20803cb17974c797e6`.
- Bot started on `main`, HEAD and origin/main `72ee98efc035bc52ae3ef48adedd1d3adc8b1e3e`, with modified `logs/bot.log` and untracked `data/runtime/event-automation.json`. Both are operator/runtime work, preserved.
- No applicable AGENTS.md was found in the writable repositories or their inspected parent paths.
- TriggerStudio's required raw `sourceScope` input had no detected-label selector. The per-Wheel caller did not supply discovery. Both surfaces now obtain the same sanitized discovery with their rule list.
- The duplicate select was literally disabled and fixed to `skip`; server validation also required `skip`.
- `validateRule` called generic `invalid()` for missing name, missing source, missing target, invalid booleans/action and other fields. Invalid source syntax also inherited the same generic message. This reproduces the reported failure, but the attachment supplied no failing request payload or screenshot bytes, so the exact historical rejected fields cannot be established.
- `executeAutomationWheelEntry` inserted weight `1` and treated every normalized existing label as a no-op.
- Inspected the existing rule/receipt migration, CRUD/conditions persistence, dry run, capabilities/origin/CSRF, HMAC routes, heartbeat discovery sanitizer, Poll selector reference, Wheel validation/mutations/revision/audit and browser/D1 tests. In Bot, inspected normalization of all five event families, fingerprints, source scope, signed serialization, pending outbox, retry acknowledgements and active-rule parser.

## Discovery and shared editor

The protected rule-list endpoint requires existing Automations and Wheels view capabilities. It returns only `getSafeRumbleDiscovery`: source identity/display name, bounded stream metadata and freshness. It does not return raw heartbeat/provider payloads, chat or credentials. The existing Poll creator wrapper still enforces creator access before calling the same sanitizer.

The actual contract contains **one source**, not a list of independent sources. The editor automatically selects that source for a new rule and shows a clickable friendly choice. Bot resolves `channel_id=null`, `user_id=1sl8zm`, `username=ThirdRailify` to `user:1sl8zm` and label `ThirdRailify`. `now=1788174504` is provider response time, not identity. There is no fabricated multiple-source list.

Advanced / Custom source accepts `user:<id>` or `channel:<id>`. Saved labels are cached by the server only from sanitized discovery; client-supplied labels are ignored. A saved source survives unavailable discovery, while a new rule without a source says `Select a Rumble source.` Discovery updates every 30 seconds without resetting the form. Provider observation age is classified separately using the established heartbeat freshness policy; the heartbeat thresholds themselves are unchanged.

Only Chat and Rant expose stream selection: any eligible containing stream, one current detected live stream, detected choices, or an advanced ID. Current selection pins the exact detected ID; it does not follow future streams. Stream titles, LIVE status and secondary ID are shown. Followers/subscribers have no stream filter. Gift `video_id` is not mapped to `livestream.id`.

`AutomationRuleEditor` is shared by Trigger Studio and per-Wheel creation/editing. Per-Wheel creation preselects its target. Actorless livestream transitions expose no Wheel award controls or Save action.

## Action contract and calculations

`automation_rules.action_config_json` contains:

```json
{"version":2,"repeatActorPolicy":"accumulate","award":{"mode":"per_gift","entriesPerUnit":5,"unitCents":100}}
```

- `fixed`: positive bounded integer entries for each distinct qualifying actor-bearing event.
- `per_gift`: Gift Purchases only; `totalGifts * entriesPerUnit`. Bot's `totalGifts` is the sanitized authoritative `total_gifts` value. All entries go to `purchased_by`; recipient identities are unavailable.
- `per_amount`: Rants only; `floor(amountCents / unitCents) * entriesPerUnit`. Only integer cents are used, never `amount_dollars`. Default unit is 100 cents. No USD/CAD/AUD assumption.
- Subscriber amount zero remains valid unless an explicit minimum condition excludes it.
- Conditions are checked independently before award calculation. No formulas or executable expressions are accepted.

Shared `automation-model.mjs` drives browser validation/previews and server validation/calculation. Admin computes awards from the saved config and verified matched-event evidence. A submitted `calculatedEntries` value has no authority. Missing, negative, fractional or oversized event evidence is rejected. Multiplication is checked against safe integer and canonical weight bounds. A below-unit Rant awards zero with `no_complete_units`; no weight-0 row is created.

Examples: gifts 2 then 3, at 5 entries/gift, contribute 10 then 15, total 25. Rants 650 then 250 cents, at 1 entry/100 cents, contribute 6 then 2. Replaying either fingerprint adds zero. A purchase of 20 gifts with fixed 5 still awards only 5.

## Wheel authority and transactions

The real Wheel model has ordered rows, integer `weight` 1–100,000, `active`/`hidden` state, duplicate labels permitted by schema, a canonical 1,000-row ceiling and a configured global `maximumParticipants`. Active weights are chance units. No parallel entrant storage is introduced.

`skip` retains existing normalized-label behavior. `accumulate` updates the first matching row in display-order/id order (NFKC, trim, lowercase), or creates one weighted row. It preserves existing labels, hidden state, colors and styling. Existing manually duplicated rows are not merged or deleted. Hidden rows remain excluded from active chances until an operator unhides them.

An existing entrant can accumulate when row capacity is full. Creating a row respects both canonical and configured capacity. An award that would exceed entrant weight or active spin integer range is rejected in full, without clamping. Receipt action results distinguish `created`, `accumulated`, `skipped_existing`, `wheel_locked`, `capacity_exceeded`, `weight_limit_exceeded`, `award_limit_exceeded` and `no_complete_units`.

The receipt uniqueness key remains `(rule_id,event_fingerprint)`, independent of rule revision and repeat-actor choice. The D1 batch gates receipt insertion on current rule, Wheel and settings revisions, then conditionally writes the entry/weight, Wheel revision/count/timestamp, rule counters and audit. A revision race returns `retry` without a successful receipt; a downstream SQL error rolls back the batch. This follows [D1 batch transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), with actual local D1 rollback/concurrency tests.

## Bot compatibility and database decision

**Bot unchanged.** Its existing envelope already carries `totalGifts`, `amountCents`, fingerprint, actor key/label, type and source scope. Its V1 parser requires legacy `duplicatePolicy: "skip"`, but never uses it to execute an action. The signed matching projection keeps that compatibility token. Admin's versioned action config is the sole repeat/award authority; it is deliberately not sent to Bot.

The existing acknowledgement vocabulary is also retained: `added` means weight successfully added (created or accumulated); `wheel_unavailable` is a terminal action rejection. Admin receipts/activity expose the exact `action_result` and `awarded_entries`, so the UI does not conceal the reason behind the broad wire acknowledgement. HMAC, request nonce protection, fingerprint, outbox, backoff and shared scheduler are unchanged.

**Migration required: YES.** `0034` has only `conditions_json`, no action-config storage, and a CHECK restricting its legacy `duplicate_policy` to `skip`. Mixing action keys into conditions would violate the existing typed matcher. New additive `0035_rumble_automation_awards.sql` adds versioned action JSON, authoritative cached source label, receipt quantity and detailed result. Legacy rules default to fixed 1/skip and historical successful receipts backfill quantity 1. It does not rebuild tables or alter `0034`.

Only disposable local test databases apply the migration chain. No migration has been applied to remote storage. A future separately authorized rollout must apply **0035 only** to the already upgraded production database before releasing this Admin code; do not rerun 0034. No Bot release/restart is required.

## Validation and files

Safe server errors use the established `{ok:false,error:"automation_input_invalid",message,issues:[{field,message}]}` convention. Inline errors use the same shared validator. Missing fields and invalid award quantities explain why Save/Test is disabled. Stale revisions and transport failures retain explicit global messages. Gift and Rant save/readback is exercised in the real-local-D1 browser harness. Dry run has no database mutation and explains calculation, actor/purchaser, repeat policy and execution-time Wheel checks.

Created: `commerce-migrations/0035_rumble_automation_awards.sql`, `src/components/AutomationRuleEditor.tsx`, `src/lib/automation-client.ts`, `src/lib/automation-model.mjs`, `src/lib/automation-model.d.mts`, `tests/automation-awards.test.mjs`, this document.

Materially changed: `functions/_shared/automation-contract.js`, `automation-core.js`, `wheels-core.js`, `polls-core.js`; `src/components/TriggerStudio.tsx`; `src/pages/PollsAdminPages.tsx`; `src/styles/trigger-studio.css`; `tests/commerce-test-helpers.mjs`, `event-automations.test.mjs`, `event-automations-browser.test.mjs`; README and additive BUMP_NOTES. No files removed.

Unrelated customer-email/commerce edits appeared during execution and were preserved. No Public/reference source edits, commits, resets, stashes, pushes, deployment, remote migrations, secret/config/DNS/provider/payment changes or Bot restart were performed.

## Verification record

All commands run in Admin with `C:\Users\TempAdmin\.codex\tmp\node-v22.16.0-win-x64` first on PATH, verified Node `v22.16.0`, and `npm.cmd`.

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed; existing chunk-size advisory.
- `npm.cmd run lint`: blocked by pre-existing ignored `.artifacts/catalogue-repair/functions-worker.js` parse error; generated reference artifacts also contain warnings. They were preserved.
- `node node_modules/eslint/bin/eslint.js src functions tests --ignore-pattern '.artifacts/**'`: passed, zero warnings/errors.
- `node node_modules/wrangler/bin/wrangler.js pages functions build functions --outdir .artifacts/event-automations-v11/functions`: passed, compiled Worker. Local compilation only.
- Broader serial server suite: **57/57 passed** (automation, awards, legacy migration upgrade, heartbeat, runtime classifier, Wheels, stages/media, authorization and Polls). Log: `.artifacts/event-automations-v11/server-tests.txt`.
- Combined Automation and Wheels browser suites: **3/3 passed**. Includes all four widths, local D1 Gift/Rant saves and reload, field errors, source selection, shared Wheel editor, and automatic stale/offline discovery transitions with saved-label retention. Log: `.artifacts/event-automations-v11/browser-tests.txt`.
- Final 1440px browser verification after offline-label refinement: **1/1 passed**, including offline custom-source save. Log: `.artifacts/event-automations-v11/browser-final-copy.txt`.
- Final automation/award/HMAC-route rerun after correcting racing-replay counters: **8/8 passed**. Log: `.artifacts/event-automations-v11/award-final-tests.txt`.
- Final typecheck/build, maintained-source lint, Functions compilation and `git diff --check`: passed. Full-repository lint remains blocked only by the generated artifact noted above.
- Earlier test iterations caught fixture schema omissions, select accessible-name ambiguity and test-clock installation after timer creation; corrected and rerun successfully. A missing type-only import after splitting the client module was corrected before the final passing build.
- Wheels browser tests regenerated tracked historical screenshots/metrics; fresh outputs were retained under `.artifacts/event-automations-v11/wheels-regression/`, and only those test-generated tracked files were restored to their initial bytes.

Browser artifacts: `.artifacts/event-automations-v11/`. The test checks document/control overflow at 1920, 1440, 768 and 390 pixels with reduced motion. API transport is intercepted by the harness and calls the real local D1 control plane; session/shell are fixtures. Separate route tests exercise actual authentication, capabilities, CSRF and HMAC. Screenshots do not establish production acceptance.


Exact broad server command:

```powershell
node --test --test-concurrency=1 tests/event-automations.test.mjs tests/automation-awards.test.mjs tests/heartbeat-freshness.test.mjs tests/runtime-health-classifier.test.mjs tests/wheels-migration.test.mjs tests/wheels-core.test.mjs tests/wheel-stages-core.test.mjs tests/wheel-media.test.mjs tests/admin-capabilities.test.mjs tests/auth-migration.test.mjs tests/auth-functions.test.mjs tests/polls-core.test.mjs
node --test --test-concurrency=1 tests/event-automations-browser.test.mjs tests/wheels-browser.test.mjs
node --test --test-concurrency=1 tests/event-automations.test.mjs tests/automation-awards.test.mjs
```

The final targeted browser command used `$env:AUTOMATION_BROWSER_WIDTHS='1440'` and `node --test --test-concurrency=1 tests/event-automations-browser.test.mjs`. Default widths remain the required four-width matrix.

Screenshot review index: `.artifacts/event-automations-v11/REVIEW.html`. All generated screenshots are indexed; **only the following 25 are claimed as actually viewed**, with relative paths under `.artifacts/event-automations-v11/`:

- `19-detected-source-open-1920.png`
- `24-gift-accumulation-1440.png`
- `29-rant-dry-run-768.png`
- `20-advanced-source-1440.png`
- `02-chat-editor-1440.png`
- `22-gift-fixed-1440.png`
- `23-gift-per-unit-1440.png`
- `26-rant-fixed-1440.png`
- `27-rant-per-cents-1440.png`
- `28-rant-accumulation-1440.png`
- `06-subscriber-editor-1440.png`
- `05-follower-editor-1440.png`
- `25-gift-dry-run-1440.png`
- `18-inline-required-fields-1440.png`
- `31-valid-gift-save-1440.png`
- `32-wheel-shared-editor-1440.png`
- `24-gift-accumulation-390.png`
- `29-rant-dry-run-390.png`
- `01-overview-active-disabled-1920.png`
- `34-stale-discovery-1440.png`
- `35-offline-cached-source-1440.png`
- `36-saved-source-without-discovery-1440.png`
- `37-new-rule-offline-1440.png`
- `33-invalid-award-1440.png`
- `30-valid-rant-save-1440.png`

Visual review found the required source, award, repeat-policy, dry-run and validation controls visible; controls remained inside each tested viewport. Mobile forms stack vertically. Native select options use explicit accessible labels; error messages are associated through descriptions. Reduced-motion styles were exercised. No global UI redesign or production visual acceptance is claimed.

Final feature acceptance: detected clickable source YES; gift per-unit awards YES; integer-cent Rant awards YES; distinct-event accumulation YES; field-specific validation YES; valid Gift/Rant save YES. No feature blocker remains for the local milestone. Repository-wide lint has the preserved generated-artifact blocker. Production rollout is intentionally pending and requires the new migration.
