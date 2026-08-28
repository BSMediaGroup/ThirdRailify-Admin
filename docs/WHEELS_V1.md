# Wheels V1 Admin Authority

## Authority and storage

Wheels V1 is an additive subsystem in the existing Admin-owned `thirdrailify-commerce` D1. Migration `0014_wheels_v1.sql` adds `wheels`, `wheel_entries`, `wheel_creator_grants`, `wheel_access`, `wheel_official_spins`, `wheel_audit_events`, `wheel_rate_limits`, and `wheel_settings`. It creates one bounded global-defaults row and zero wheels/results. Existing commerce, GOATS, banner, inbox, catalogue, order, and payment tables are not changed.

The accounts D1 remains identity/session authority. Wheel tables store opaque account IDs; Admin reloads the account from `THIRDRAILIFY_AUTH_DB` before creator or wheel authorization. Master Admin has implicit full authority. Ordinary accounts are denied creation by default.

The Public project never receives the wheel D1 binding. Public-to-Admin creator mutations reuse the existing encrypted HMAC secret and canonical `timestamp + method + path + SHA-256 body` signature. The secret stays in Functions. Admin rejects absent, invalid, or older-than-five-minute signatures.

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

The server validates titles/descriptions/labels, lifecycle/visibility, palette size, six-digit hex colours, preset/enum values, 2–20 second duration, message length, and a tested maximum of 1,000 entries. Rate-limit rows bound create, save, official-spin, and winner mutations. The editor never accepts raw HTML, script, arbitrary CSS, remote images, or sound uploads.

The optional `scripts/wheels-demo-seed.sql` creates exactly `DEMO-WHEEL-01`, eight synthetic entries, and no result. `scripts/wheels-demo-cleanup.sql` targets only that identity and cannot remove a wheel with result history. Neither script runs automatically.

Deferred integrations are documented in Public `WHEELS_V1.md`; V1 performs no chat, donation, payment, fulfilment, bot, Wix, Printful, DNS, or custom-domain write.
