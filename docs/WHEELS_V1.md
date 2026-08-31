# Wheels V1.12 Admin Authority

## V1.12 global mechanics authority

The existing `wheel_settings` row with `setting_key = 'global'` now owns the normalized mechanics object alongside prior global defaults. It stores the selected profile/custom parameters, launch RPS bounds, full-turn bounds, and default/minimum/maximum duration policy under the row's existing optimistic revision. Read normalizes legacy rows without mutating them. Save strictly validates the complete policy, conditionally advances the revision, and appends an existing `wheel_audit_events` record; no migration or second settings model is required.

`/wheels/mechanics` is the visual Master-authorized editor. Named profiles and the bounded Custom profile are sampled from the same pure module used by Public. Its test-spin preview is local and synthetic: it creates no Official result and sends no Wheel write. The editor uses the established Admin graphite surfaces, warm neutral borders, and restrained gold emphasis. `/api/wheels/mechanics` exposes only the sanitized normalized projection and settings revision; all policy writes remain on the protected Admin settings endpoint with existing origin, CSRF, capability, rate-limit, and revision checks.

`/wheels` is now a metrics-and-jump-point Overview. `/wheels/library` owns the Wheel table, while `/wheels/stages`, `/wheels/access`, `/wheels/results`, and `/wheels/:id` retain their previous responsibilities.

# Wheels V1.10 Admin Authority

## V1.10 Official animation plans

Official winner selection remains the existing server-side Web Crypto rejection sample over authoritative active integer weights. Admin persists the immutable result before Public animates it; browser physics is presentation and cannot choose or replace the winner. The safe response adds a deterministic `spin-plan-v1` derived with SHA-256 over the secure random result UUID, Wheel ID, and participant snapshot hash. Its first two 32-bit words map to strictly interior `(word + 0.5) / 2^32` landing and turn-variance fractions. Retrying one idempotency key therefore returns the same winner, result ID, landing point, and turn variance with no new column or migration.

## V1.8 style and segment-media authority

Migration `0022_wheels_segment_styles.sql` adds nullable bounded `wheel_entries.segment_style_json` and rebuilds `wheel_media_assets` to add `segment_fill`, `image/gif`, and safe original filenames. It preserves every legacy row and does not touch `wheel_official_spins`, result selection, entry identity, or access. Background/centre retain one-active-per-purpose semantics; segment fills instead have a wheel/purpose/SHA active uniqueness constraint for byte reuse.

Admin strictly allowlists `solid|pattern|image`, nine built-in pattern IDs, strict `#RRGGBB` base/alternate colours, six spin sound IDs, and seven winner sound IDs. Image references must be active `segment_fill` assets belonging to the same wheel. Segment bounds are SVG 512 KiB, static raster 1.5 MiB, GIF 2 MiB, 2048×2048 / 4,194,304 pixels, 20 active unique assets, and 12 MiB combined. Uploads reuse an existing wheel/SHA asset, preserve GIF bytes, validate magic/MIME/dimensions, screen SVG executable/external constructs, revalidate owner/editor authority, rate limit, audit, and expose no R2 key. Removed references retire only assets that were part of the prior persisted wheel state, preserving concurrent uploads and shared references.

## V1.8 staging acceptance — 30 August 2026

A 3,076,029-byte export was captured before applying only `0022_wheels_segment_styles.sql`. Before/after counts remained 3 wheels, 24 entries, 0 official spins, 4 wheel media assets, 50 commerce products, 1,323 variants, 1 customer, and 2 orders. The new style/filename columns and segment hash index exist, `PRAGMA foreign_key_check` is empty, migration 22 is recorded, and no migrations remain pending. Admin deployment `0bcab315` serves the shell, `/wheels`, and public Wheels JSON from immutable and stable origins; the protected Admin API remains 401 without a session.

## V1.7 portable appearance config

No migration is required. The existing `config_json` authority now accepts `themePreset: "custom"` with 1–5 strict six-digit hex values in the existing `palette` array and one normalized `pointerAccent`. Named/legacy palette validation retains its previous bound for backward-compatible imports. The new `fireworksEnabled` boolean is projected through the same sanitized config; missing/legacy values normalize to `true` under the existing boolean-default convention. Entry colour persistence, signed save authorization, revision checks, wheel media, and official-spin/result semantics are unchanged.

## Authority and storage

Wheels is an additive subsystem in the existing Admin-owned `thirdrailify-commerce` D1. Migration `0014_wheels_v1.sql` adds `wheels`, `wheel_entries`, `wheel_creator_grants`, `wheel_access`, `wheel_official_spins`, `wheel_audit_events`, `wheel_rate_limits`, and `wheel_settings`. Migration `0016_wheels_media.sql` adds only `wheel_media_assets` and its active-purpose index; it creates no wheel and no asset. Existing commerce, GOATS, banner, inbox, catalogue, order, and payment tables are not changed.

The accounts D1 remains identity/session authority. Wheel tables store opaque account IDs; Admin reloads the account from `THIRDRAILIFY_AUTH_DB` before creator or wheel authorization. Master Admin has implicit full authority. Ordinary accounts are denied creation by default.

The Public project never receives the wheel D1 or media R2 binding. Public-to-Admin creator mutations reuse the existing encrypted HMAC secret and canonical `timestamp + method + path + SHA-256 body` signature. The secret stays in Functions. Admin rejects absent, invalid, or older-than-five-minute signatures.

## Roles and controls

- Global grant: active `may_create_wheels`, with an optional owned-wheel cap.
- Owner: edit/configure/participants/official spins and permitted archive.
- Editor: edit/configure/participants and official spins.
- Spinner: official spins only.
- Master Admin: approve/revoke creators, assign/revoke roles, transfer ownership, show/hide, archive/restore, edit/spin locks, global defaults, safe hard-delete, and result voiding.

Hard deletion is refused when official history exists. Ownership transfer writes the new owner and demotes the previous owner assignment to editor. Admin controls and creator changes write wheel audit rows.

## Admin routes

- `/wheels`: Library plus compact global defaults.
- `/wheels/access`: account search, global creator grants, and per-wheel owner/editor/spinner assignments.
- `/wheels/results`: official history search and Master-only void action with a required reason.
- `/wheels/:id`: full wheel configuration, participants, assignments, results, and links to Public/presentation views.

Protected APIs are under `/api/admin/wheels/*`. Reads require Admin. Writes require exact Admin origin, active Master session, CSRF, bounded JSON, validation, and audit. Public projection/API handlers live under `/api/wheels/*`; signed internal actions are not browser-callable authority.

## Official transaction

Official draw input is wheel identity, expected revision, and a 16–120 character idempotency key. Winner fields are rejected. Admin validates account and role, active lifecycle, locks, enabled state, revision, at least two active entries, and positive bounded integer weights. Web Crypto rejection sampling selects an unbiased integer across total weight.

The immutable insert snapshots entry ID, label, weight, wheel revision, canonical participant SHA-256 hash, performer, and timestamp. A conditional insert plus `spin_sequence` compare-and-swap serializes concurrent requests. The unique wheel/idempotency key returns the existing result on a retry. Later entry edits and winner actions cannot change result snapshots. Voiding adds timestamp/reason/Admin while retaining the original row.

## Configuration, limits, and audit

The server validates titles/descriptions/labels, lifecycle/visibility, palette size, six-digit hex colours, preset/enum values, 2–60 second duration, message length, and a tested maximum of 1,000 entries. Rate-limit rows bound create, save, official-spin, winner, and media mutations. The editor never accepts raw HTML, script, arbitrary CSS, remote images, or sound uploads.

## V1.1 media authority

The existing Admin `THIRDRAILIFY_PROFILE_MEDIA` R2 binding stores owner/editor uploads below non-enumerable `wheels/<wheel-id>/<purpose>/...` keys. Admin validates magic bytes, normalized MIME, byte size, dimensions, total pixels, purpose, authorization, edit locks, and request rate before storage. Supported inputs are PNG, JPEG, BMP, WebP, and strictly screened SVG; scripts, event handlers, `foreignObject`, external resources, unsafe URL/data references, DTD/entities, oversized canvases, and excessive SVG complexity are rejected.

Only an opaque asset ID and same-origin delivery URL cross to Public. Hidden-wheel media returns 404 to anonymous callers; an assigned account or Master may fetch it through the signed boundary. Replacement and explicit removal delete the prior R2 object, mark the bounded metadata lifecycle deleted, restore the built-in treatment, and append a wheel audit event. SVG delivery is `nosniff`, same-origin, and constrained by a sandboxed deny-by-default CSP.

The optional `scripts/wheels-demo-seed.sql` creates exactly `DEMO-WHEEL-01`, eight synthetic entries, and no result. `scripts/wheels-demo-cleanup.sql` targets only that identity and cannot remove a wheel with result history. Neither script runs automatically.

Deferred integrations are documented in Public `WHEELS_V1.md`; V1 performs no chat, donation, payment, fulfilment, bot, Wix, Printful, DNS, or custom-domain write.

## Staging acceptance — 29 August 2026

Migration `0016_wheels_media.sql` was applied directly after a 3,013,256-byte D1 export because the already-present 0014 schema was missing from Wrangler's ledger and unrelated 0015 was not applied. The fully present 0014 and new 0016 rows were reconciled in `d1_migrations`; only 0015 remains pending. Before/after counts are unchanged at 1 wheel, 8 entries, 0 official spins, 50 commerce products, 1,323 variants, 1 order, 7 collections, and 13 community submissions; media assets remain zero and `PRAGMA foreign_key_check` is empty.

Admin Pages deployment `afd9db50` serves wheel detail and bounded JSON media 404s correctly; Public deployment `511d5421` passes stable browser/audio acceptance. No authenticated remote owner/editor session was available, so no remote synthetic object was uploaded and no authorization bypass was used. Local R2 lifecycle tests cover upload, replacement, hidden delivery, removal, fallback, and audit.
