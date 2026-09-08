# Wheel entrant identity

Current/pending version: 0.1.0-alpha.0. Migration 0042 applied to live Admin Commerce D1 on 2026-09-08 at 07:47:00 UTC with explicit user authorization. Application code is still local and has not been deployed by this task.

The former executor selected the first normalized display-name match. It could
combine a subscription, a gift purchase, or a manual entrant into one slice.
Appearance presets and glyphs were decorative and did not establish entry type.

## Matching contract

Every new entry has a versioned classification: regular, chat, follow,
subscription, gift purchase, raid received, or Rant. Each also has a manual,
imported, or automatic origin. Historical unclassified rows remain legacy.

Automatic identity is a private SHA-256 digest of the versioned tuple
`[1, sourceScope, actorKey, eventType]`, scoped to its target Wheel by a unique
database index. It is independent of names, avatars, appearance, order, visibility,
rule ID and rule revision. A subscription and a gift from the same person therefore
occupy different slices. Two rules for the same actor/source/event type address the
same slice; their configured skip/accumulate policy controls the resulting award.
Different source accounts never combine. Gift purchases identify the purchaser;
raid entries retain the existing chat-derived evidence limitations.

The validated provider actor key is used exactly. Where the provider supplies only
a username, its existing normalized username key is the available identity. A
changed username or a switch between username and provider-ID keys is not guessed
to be the same account. Provider-ID subscriptions survive display-name changes.

Receipts remain idempotent per rule and event fingerprint. Entry mutation, receipt,
counters, audit and Wheel revision remain one guarded D1 batch. Racing distinct
events retry against the new revision; the unique index prevents duplicate live
automatic identities. Hidden slices still receive weight without becoming active.
Weight, capacity, lifecycle and editing-lock checks remain in force.

## Existing entries and edits

Migration 0042 adds nullable identity metadata and its unique index. It rewrites no
weights, entry IDs, results, rules or receipts. NULL projects as Legacy / unclassified.
On the next award, a legacy slice may be adopted only if its existing creation audit
and complete linked receipt history prove one actor and event type, and exactly one
live legacy row matches. The source is recovered from the validated receipt actor
key, never the mutable current rule. Adoption is atomic with a successful award or
skip receipt. Mixed, missing, or ambiguous histories are never split or reassigned;
a fresh typed automatic slice receives the new award instead.

Saving an existing entry preserves its private identity by its server-owned ID even
when the client omits metadata, renames/reorders/hides it, changes its features, or
submits a different classification. Copied IDs and new rows receive fresh IDs and
cannot claim an automatic binding. Manual presets never turn regular entries into
subscription/gift awards. Manual weight edits remain explicit edits to that slice.

The winner action **Remove matching type** removes only the selected automatic
identity. Legacy/unclassified types also remove only the selected ID because their
type is unknown. For other nonautomatic entries it matches exact label, type and origin.
It cannot remove the same person's other automatic types or source accounts.

## Portable content and UI

Wheel format v3 preserves classifications and same-name rows, with fresh IDs and
an imported origin. Versions 1 and 2, generic JSON and Wheel of Names remain readable.
Stage imports use the same Wheel parser. No import carries a private automatic key,
rule binding, or an instruction to merge by name. Importing a subscription slice
therefore does not divert subsequent live subscription awards into that copy.

Participant management, the standalone editor, appearance chooser, participant
details, and single/Stage winner details show the entry type and origin. Import
review reports type counts and calls out separate same-name rows. Wheel glyph and
label geometry, odds calculations, winner selection and spin timing are unchanged.

## Files and release prerequisite

- Shared `src/lib/entrant-identity.mjs` and `.d.mts`: strict public classification,
  portable conversion and labels; mirrored in Public and Admin.
- Admin `functions/_shared/entrant-identity-storage.js`: private matching, legacy
  receipt proof, projection and storage readiness.
- Admin `commerce-migrations/0042_wheel_entrant_identity.sql`: additive column/index.
- Admin `tests/entrant-identity.test.mjs`: actual D1, imports, replay, concurrency,
  old clients, source/type separation, legacy adoption and rollback.

Apply **0042 to the Admin-owned Commerce D1 before releasing the new Admin code**,
then release Public. It is independent of unrelated 0041 Poll work; an isolated
migration test applies it directly after 0040. Missing identity storage returns
`entrant_identity_schema_required` before any award receipt is written; there is
no fallback to name-only accumulation. Rule readiness exposes `entryIdentity`.
The user explicitly authorized the remote migration on 2026-09-08. Migration 0042 is now applied and verified on live Admin Commerce D1: identity column/index present, readiness true, 262 entries / 2639 total weight, 8 rules / 3 enabled, 13 receipts, and no foreign-key errors. A private pre-migration export and verification evidence are saved under Admin `.artifacts/migration-0042-live/`. No application deployment, Bot restart, or production toggle was performed.
