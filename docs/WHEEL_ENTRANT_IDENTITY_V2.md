# Wheel entrant identity V2

## Authority

`wheel_entries.id` remains the stable row identity. `entrant_code` is a globally unique, seven-character human reference using `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`; it is never derived from a display label. Labels and the optional `display_suffix` are mutable presentation fields and are never matching keys.

Automatic accumulation resolves an exact current `wheel_entry_source_bindings` row over Wheel, provider, source scope, actor key, and accumulation group. A stale binding fails closed. The existing typed identity key is the compatibility fallback for pre-V2 entrants; only the previously proven single-type legacy reconciliation may adopt an untyped row. Renames, reordering, hidden state, and cosmetic edits retain entry IDs, codes, bindings, provenance, weight, style, media, and appearance.

## Receipts and privacy

`automation_receipt_details` stores an immutable safe snapshot beside the existing idempotent receipt: entrant code/label/suffix, entry type, provenance, rule name/revision, received unit and quantity, calculation, before/after weight, delta, outcome reason, and an allowlisted evidence object. It never stores the raw chat body in this table. The public activity route emits only timestamp, public event label, entrant display snapshot, code, delta, and outcome. Admin detail explicitly separates historical snapshot fields from current Wheel/rule/entrant references and renders absent legacy fields as `Not recorded`.

Raid receipts remain labelled chat-derived and do not claim native or independently verified Rumble provenance.

## Migration and backfill

Migration `0050_wheel_entrant_codes_activity_and_successions.sql` is additive and preserves all prior rows, weights, identities, results, receipts, media, and lifecycle values. It intentionally leaves legacy entrant codes null so schema application is short and recoverable.

Release sequence:

1. Export and hash a protected remote Commerce D1 backup outside both source trees.
2. Run `scripts/release-wheel-identity-schema.ps1` in preview mode with the backup path/hash, then with `-Apply`. Its isolated migrations directory can apply only 0050 and rejects the unrelated pending 0046 migration.
3. Run `scripts/backfill-wheel-entrant-codes.ps1` in preview mode, then with `-Apply`. It processes no more than 100 null-code rows per D1 transaction and is safe to resume.
4. Verify zero null, duplicate, or invalid codes; verify the three new tables, indexes, ledger row, and `PRAGMA foreign_key_check`.
5. Deploy Admin before Public. Complete authenticated stable-domain acceptance before using the workflow on a real competition Wheel.

Restore is intentionally operator-driven: stop deployment, retain the failed database for evidence, and restore the verified export to a replacement D1 database before rebinding. Do not attempt a destructive in-place down migration after new codes, bindings, receipts, or successions have been written.

## Close and create next

Only an unvoided official result belonging to the editable open Wheel may decide it. The idempotent server transaction creates one hidden draft successor, copies active access, visual settings, independently copied R2 media, and disabled event/roster definitions, then closes the original and disables its practice/official controls. Participants are excluded by default. When explicitly selected they receive fresh row IDs and entrant codes while their display, weight, state, media/style, identity classification, and appearance are copied. Results, activity, counters, source bindings, and roster contributions never carry forward.

The original stays public and stable in Past Wheels. Practice results can never invoke this workflow.
