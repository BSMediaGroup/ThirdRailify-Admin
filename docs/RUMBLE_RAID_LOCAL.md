# Raid local implementation audit

Current/pending version: 0.1.0-alpha.0

git status --short
```
(clean)
```
git branch --show-current
```
main
```
git rev-parse HEAD origin/main
```
aaaaafef569f05e3ef8d461ab80f3a0689268e26
aaaaafef569f05e3ef8d461ab80f3a0689268e26
```
Migration inventory:
migrations\0001_auth_foundation.sql
migrations\0002_full_admin_capability_denials.sql
commerce-migrations\0001_commerce_control_plane.sql
commerce-migrations\0002_stripe_webhook_events.sql
commerce-migrations\0003_product_merchandising.sql
commerce-migrations\0004_goats_community.sql
commerce-migrations\0005_commerce_product_variants.sql
commerce-migrations\0006_site_banner.sql
commerce-migrations\0007_goats_engagement_and_wix_import.sql
commerce-migrations\0008_goats_profile_gif.sql
commerce-migrations\0009_commerce_collections.sql
commerce-migrations\0010_commerce_production_control_plane.sql
commerce-migrations\0011_goats_geocoder.sql
commerce-migrations\0012_admin_inbox_and_reaction_reset.sql
commerce-migrations\0013_homepage_content_rail.sql
commerce-migrations\0014_wheels_v1.sql
commerce-migrations\0015_checkout_shipping_foundation.sql
commerce-migrations\0016_wheels_media.sql
commerce-migrations\0017_commerce_customers.sql
commerce-migrations\0018_printful_fulfillment_lifecycle.sql
commerce-migrations\0019_account_address_book.sql
commerce-migrations\0020_commerce_launch_operations.sql
commerce-migrations\0021_paypal_direct_merchant.sql
commerce-migrations\0022_wheels_segment_styles.sql
commerce-migrations\0023_wheels_stages_v1.sql
commerce-migrations\0024_analytics_and_message_controls.sql
commerce-migrations\0025_automations_polls_v1.sql
commerce-migrations\0026_printful_catalogue_reconciliation.sql
commerce-migrations\0027_polls_v11_media.sql
commerce-migrations\0028_gaming_catalogue.sql
commerce-migrations\0029_paypal_donation_capture_authority.sql
commerce-migrations\0030_business_profile_compliance_separation.sql
commerce-migrations\0031_store_activation_and_agreements.sql
commerce-migrations\0032_gaming_igdb_mapping.sql
commerce-migrations\0033_merchant_shipping_ratebook.sql
commerce-migrations\0034_rumble_event_automations.sql
commerce-migrations\0035_rumble_automation_awards.sql

No reference repository inspected or modified. Bot runtime JSON and log are concurrent live-owned changes; do not edit.
Attachment lookup: named markdown absent from Downloads/Documents/workspace and Codex attachment index; no raid phrase in saved RUMBLE JSON samples. The operator subsequently pasted the current response directly; see source evidence below.

## Implemented contract and source evidence

The operator's original evidence identifies the complete normal-chat text `has raided this stream!`, attributed to `wesrev`, at `2026-09-07T02:14:01+00:00`, under receiving source `user:1sl8zm` and containing livestream `7d01f6`. These sample identities are never hardcoded in production. The later JSON pasted directly during acceptance was read in the conversation: it confirms the same ordinary chat/source/stream shape but its recent chat window is approximately 02:46-02:51 and no longer contains the 02:14 notice. The operator subsequently saved `ThirdRailify-Admin/migrations/RUMBLE_OUTPUT_WITH_RAID.json`. It was inspected in place: 48 recent messages, no raid-related message and no raid-specific metadata keys. That user-owned file is unchanged. The implementation did not copy the full response into fixtures, artifacts or logs. The earlier announcement is evidence stated in the original request; it is absent from both later snapshots.

Event family `rumble.raid.received`, label Raid Received, classification Chat-derived, detection method `chat-announcement-v1`. NFKC, outer whitespace trimming and the existing case-insensitive normalization must yield exactly `has raided this stream!`, retaining punctuation. Commentary, mentions, doubled punctuation, missing punctuation and emotes do not qualify. A user-authored identical message is indistinguishable; badges, profile images, familiar names and viewer counts establish no authenticity. No native ID, system discriminator, authenticated origin, originating channel, participant list or raid size is provided.

Actor label comes from the matched record username; actor key is `rumble:<receiving source scope>:<canonical username>`. Receiving source uses the existing channel ID then user ID fallback. Stream ID comes from the containing livestream. Username changes and reused names remain identity limitations. No individual raid viewer awards or inferred quantity exist.

The existing canonical recent_messages collection and validated latest_message fallback are used once. The bounded 200-record/50-stream adapter and chronological ordering remain. A later snapshot can lose an older notice entirely; the Bot cannot reconstruct missed announcements after downtime or a busy chat window. No new provider fetch or scheduler exists.

Fingerprint is SHA-256 hex over compact UTF-8 JSON `["rumble-raid-notice-v1", sourceScope, livestreamId, canonicalActor, providerEventAt, exactOriginalText]`. The timestamp is the existing parsed UTC Python ISO representation serialized in the envelope. Admin recomputes this fingerprint. Badges, images, indexes, polling time, revision and calculated award are excluded. Existing chat/Poll fingerprints are unchanged. Identical actor/text/timestamp records cannot be reliably separated.

Only a saved fixed positive integer award is valid, with skip-existing or accumulation. Admin computes it. The existing atomic Wheel executor retains receipt uniqueness `(rule_id,event_fingerprint)`, weight mutation, revision, counters and audit in the same batch. Hidden entrants remain hidden, styling is preserved and limits reject in full. First notice +10, replay +0, later notice +10 was proven with local D1 readback. Replay protection is per rule, independent of revision. Deliberately enabled Exact Chat and Raid rules may both award the underlying message; the shared editor warns about same-source/same-Wheel overlap.

Authoritative activation timestamps are still set by explicit enabled saves, including edits and re-enables. Refreshes do not change activation. Old history, disabled rules, stale revisions, source/stream mismatches and invalid evidence are rejected. Durable Bot outbox/seen state and Admin receipts retain retry/restart protection.

## Compatibility and future rollout (not performed)

Existing signed `/api/internal/bot/rules` excludes Raid so old Bot versions never receive an unsupported enum. Updated Bot requests signed `/api/internal/bot/rules-v2`, falling back only on 404 to the original route. This versioned request is the capability projection gate; a stale heartbeat cannot accidentally feed Raid to an old process. Heartbeat `eventAutomation.raidNoticeVersion=1` is an additive bounded display support signal; the existing 45-second freshness boundary is retained. Unsupported/malformed rows are isolated from valid projected rules; wholly invalid projections retain last-known-good behavior, and empty valid projections clear rules. No auth/HMAC relaxation.

Admin readiness checks the stored CHECK constraint and award column. Missing 0035 disables award editing with a specific schema error; missing 0036 disables Raid saving. A saved enabled Raid awaiting updated runtime is visibly Pending capable Bot. A current support heartbeat is a runtime support indication, not proof of a successful action. Actual execution still requires a capable Bot fetching the versioned rules projection and all existing activation, evidence, revision and Wheel gates.

Future authorized rollout order:
1. Verify actual schema state, preserve 0034, apply 0035 only if absent, then new `commerce-migrations/0036_rumble_raid_received.sql`. Never rerun completed migrations. 0035 remote status was not assumed or queried here.
2. Release updated Admin Functions and UI. The 0036 enum upgrade rebuilds the constrained rule table and preserves child receipts, awards, indexes and foreign keys. Local sequential and atomic-batch upgrades are covered.
3. Release updated Bot and perform an explicitly authorized restart; no running Bot learns Raid from the editor alone.
4. Confirm current capable-runtime report, then deliberately enable reviewed Raid rules. Only notifications at/after their activation boundaries qualify.

This entire task is LOCAL ONLY. No deployment, remote migration, live Bot restart, production rule/test event, raid initiation, production Wheel mutation, secret rotation, DNS or provider/payment operation was performed. Public and other reference repos received no writes. Concurrent runtime/log work is preserved.

## File inventory

Created `commerce-migrations/0036_rumble_raid_received.sql`, `tests/raid-automations.test.mjs`, `tests/raid-automations-browser.test.mjs`, and `docs/RUMBLE_RAID_LOCAL.md`. Extended `functions/_shared/automation-contract.js`, `automation-core.js`, `polls-core.js`, `functions/api/internal/bot/[[path]].js`, the shared `src/components/AutomationRuleEditor.tsx`/`TriggerStudio.tsx`, `src/lib/automation-model.mjs`/`.d.mts`/`automation-client.ts`, and `tests/commerce-test-helpers.mjs`. The canonical `wheels-core.js` executor and completed 0034/0035 migrations are unchanged. No files removed. Root README and BUMP_NOTES updated under the existing version.

## Local acceptance results, 2026-09-07

Commands ran from this repository using Node 22.16.0 and npm.cmd/npx.cmd.

| Command | Result |
| --- | --- |
| `npm.cmd run typecheck` | Passed |
| `npx.cmd eslint src functions tests/raid-automations.test.mjs tests/raid-automations-browser.test.mjs` | Passed; maintained source scoped to exclude generated artifacts |
| `npm.cmd run build` | Passed; existing large-chunk warning |
| `npx.cmd wrangler pages functions build --outdir .artifacts/raid-functions` | Passed, rerun after final server changes |
| `node --test --test-concurrency=1 tests/automation-awards.test.mjs tests/event-automations.test.mjs` | 8 passed |
| `node --test --test-concurrency=1 tests/raid-automations.test.mjs` | Final isolated run: 5 passed |
| `npm.cmd run test:authorization` | 16 passed |
| `npm.cmd run test:wheels` | 16 passed |
| `npm.cmd run test:polls` | 7 passed |
| `node --test --test-concurrency=1 tests/raid-automations-browser.test.mjs` | 1 passed, all four viewport widths |
| `git diff --check` | Passed |

One combined rerun of existing and Raid tests encountered three Miniflare `fetch failed` errors during database setup, before assertions. The final isolated Raid run passed all five cases. This harness intermittency is recorded rather than counted as a clean combined run.

The cross-repository test invokes the repository Bot virtual environment and actual `EventAutomationService` adapter/matcher plus `BotControlClient` envelope signing. Only transport is captured offline. Admin authenticates that serialized request and runs its real executor against local D1; readback proves +10, duplicate +0 with a fresh request nonce, and a distinct notice +10. Additional tests cover concurrency, rollback, hidden entries, per-rule overlap, reactivation and migration preservation in sequential/atomic batches.

Browser acceptance uses isolated local D1 and real save/dry-run handlers with intercepted local auth/API transport. Both shared-editor entry points, source retention, fixed accumulation, reload, matching/nonmatching evidence, incompatible runtime and overflow checks passed at 1920/1440/768/390. It is not production authentication acceptance.

All eight captured screenshots were opened and visually inspected under `.artifacts/raid-automations/`:

- `01-raid-editor-1920.png`
- `01-raid-editor-390.png`
- `02-saved-reloaded-1440.png`
- `03-dry-run-match-1440.png`
- `04-no-match-commentary-1440.png`
- `04-no-match-emotes-1440.png`
- `05-unsupported-runtime-1920.png`
- `06-wheel-editor-768.png`

Final scope audit: 12 maintained files modified and four created here; no removals. The operator-added raw sample is separate and unchanged. No staging/reset/stash, reference-repository writes, remote operation or live restart occurred. Bot validation is recorded in `../THIRD-RAIL-BOT/docs/RUMBLE_RAID_LOCAL.md`.


### 2026-09-07 production Save repair (explicitly authorized after local acceptance)

Production inspection confirmed 0035 applied and 0036 missing. Applied only pending 0036 with Wrangler D1 migrations apply. Readback: Raid enum present, both existing receipts retained, foreign_key_check empty. Current Bot heartbeat already reports raidNoticeVersion=1; no restart performed. Deployed Admin production main: https://23d215f7.thirdrailify-admin.pages.dev.

Shared editor now lets the server recheck schema on Save rather than disabling on missing/stale readiness. Server schema/auth validation remains authoritative. Server errors appear beside Save and permit retry. Browser coverage passed at four widths, including missing readiness and stale false readiness followed by successful save/reload. Typecheck, focused lint and production build passed. No production rules or Wheel entries were created or enabled by this repair.
