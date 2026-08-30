# Wheels Stage V1.1 authority

## Official All

The signed `POST /api/wheels/stages/:slug/spin-all` operation accepts the expected Stage revision, Stage-ordered Wheel slugs/revisions, and one secure batch idempotency key—never winners. Admin re-resolves the active account, Stage, current ordered membership, and every Wheel's independent Official permission, lifecycle, lock, revision, cooldown, active entries, and existing rate limits. Stage ownership does not grant Wheel permission.

After complete preflight, the existing weighted Web Crypto selector chooses every result. A SHA-256 derivation over Stage, batch key, position, and Wheel identity supplies stable per-Wheel idempotency keys. One D1 transactional batch conditionally inserts all normal `wheel_official_spins`, advances each Wheel sequence/cooldown timestamp, and appends normal audit events. A concurrent authority change forces the whole batch to fail; no partial successful Official All is accepted. Retry returns the same ordered results and deterministic animation plans. There are zero Stage result rows, no Stage winner authority, and no migration.

Practice/Demo All is Public-only and non-persistent. `.tws` remains Stage composition only and never includes mode, winners, result IDs, landing plans, or active coordinator state.

Migration `0023_wheels_stages_v1.sql` adds normalized `wheel_stages` and `wheel_stage_items` tables. A Stage references one to six existing Wheels by position; Wheel entries, configuration, media, official spins, and lifecycle remain owned by existing Wheel tables.

Public reads expose only active public Stages whose members are active public Wheels. Signed internal reads reauthorize the Stage owner or Master Admin and independently resolve each Wheel. Mutations require the canonical Public session, CSRF validation at Public, a time-bounded service signature at Admin, creator grant, owner or Master Admin access, revision matching, rate limits, and audit events.

Admin `/wheels/stages` is a distinct management surface with hide, archive, restore, and delete actions. Stage deletion cascades only Stage membership; Wheels and official results are preserved.
