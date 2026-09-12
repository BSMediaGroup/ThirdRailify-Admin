# Self-paid subscriber automation and current roster

## Authority and classification

Rumble Intelligence remains the source-scoped evidence authority. Each current person is grouped within one Rumble source. A record whose reported `amount_cents` is exactly `500` is self-paid, exactly `0` is a gifted recipient, and every other or missing value needs review. A person with both current self-paid and gifted records is eligible once; a gift-only person is excluded. Gift purchasers remain the existing `rumble.gift_purchase` actor and are never inferred from recipient records.

The canonical event family is `subscriber_self_paid` in Admin, Public, and Bot projections. Existing stored `rumble.subscribe` rows remain compatible and keep their event fingerprints and entrant identity stable. They are visibly marked as legacy, match only exact-500 self-paid evidence, and normalize to the canonical policy on a deliberate save. No historical event is replayed by this release.

## Current-roster rules

`0048_subscriber_roster_automation.sql` adds three bounded provenance tables:

- `subscriber_roster_rules` stores a disabled-by-default rule, detected source, target Wheel, sync mode, managed weight, status, counters, revision, and latest semantic fingerprint.
- `wheel_entry_contributions` records only the weight owned by a roster rule. Manual and event-derived residual weight and all appearance/media fields remain independently owned.
- `subscriber_roster_syncs` stores sparse changed, removal-blocked, and failed outcomes. Unchanged evaluations do not create audit rows.

`add_missing` adds eligible current people once and never removes them. `exact_managed` also removes only that rule's managed contribution after a complete qualified-live current snapshot. A stale, degraded, incomplete, or review-ambiguous snapshot blocks removals. Disabling a rule stops evaluation without deleting contributions. Changing its source or target is blocked once it owns contributions.

Automatic evaluation runs only after Rumble Intelligence persists a new semantic set. It does not add a Bot timer or provider fetch. The same semantic fingerprint is a zero-write no-op. Manual preview and Sync now use the same planner and optimistic rule token as automatic evaluation.

## Wheel preservation

Managed contributions may share one Wheel entrant with manual or event-derived weight. Exact removal subtracts only the roster-owned amount and deletes the entrant only when no independent weight remains. Manual participant saves cannot delete or reduce an entrant below its managed minimum, while labels, colours, images, segment styling, effects, and later manual weight increases remain editable. Existing Wheel spin, weighting, participant, result, receipt, and audit mechanics are otherwise unchanged.

## API and UI

Admin and authenticated Public Wheel surfaces share the roster editor, current membership/provenance list, preview, explicit sync, freshness/status evidence, and warning text. Source selection comes from detected safe Rumble discovery; raw source IDs are not the normal path. Rumble Intelligence shows current eligibility and links to automation management. No raw provider payload or credential is projected.

## Local evidence

The focused real-D1 suite covers self-paid/gifted/review classification, person grouping, mixed eligibility once, gift-only exclusion, add-missing and exact-managed behavior, event-plus-roster weight, manual residual/style preservation, disable behavior, stale-removal blocking, optimistic concurrency, failed audit, rollback, and foreign keys.

Measured local D1 diagnostics:

| Scenario | Queries | Rows written | Rows read | Mutations |
| --- | ---: | ---: | ---: | ---: |
| 100 identical evaluations | 400 | 0 | 1,600 | 0 |
| Gift-only semantic change | 19 | 11 | 55 | 6 |
| One eligible addition | 23 | 28 | 80 | 10 |
| One exact-managed removal | 24 | 19 | 99 | 10 |

The gift-only case updates bounded rule/snapshot status but asserts zero Wheel membership writes. All 361 Bot tests, 17 Admin Wheel tests, the focused subscriber/event suites, both frontend builds and scoped lint pass. Public cross-repository Wheel browser regressions pass; the repaired Admin Trigger Studio flow passes at 390px. Screenshots are under ignored `.artifacts/event-automations-v11/`.

## Release controls

The release script pins Node 22.16.0 and Wrangler 4.60.0, verifies the protected export and reviewed migration hashes, exposes only `0048_subscriber_roster_automation.sql` in an isolated directory, and refuses to continue if unrelated pending `0046_poll_permanent_delete.sql` appears applied. Admin must deploy before Public; the Bot must then restart once through its existing single-instance launcher. Acceptance uses a disposable production test Wheel, creates no spin, and must not enable or target any existing official Wheel or paused legacy rule.
