# GOATS in the Wild V2 authority

ThirdRailify-Admin is the sole persistence and moderation authority. The additive `commerce-migrations/0004_goats_community.sql` migration extends the existing Admin-only commerce D1 because GOATS references the authoritative `commerce_products` table and shares the established Admin session, CSRF, audit, and email boundaries. The forward-only `commerce-migrations/0008_goats_profile_gif.sql` rebuilds only `community_media` so `image/gif` is valid exclusively when the row role is `profile`; existing records and indexes are copied intact. Public receives no D1 or R2 binding.

## State and APIs

The migration creates submissions, media metadata, reactions, comments, moderation events, community email templates/outbox, and privacy-hashed rate limits. Draft, pending, approved, and rejected are distinct states; approved records have an independent published/hidden flag. Public reads expose only approved and published projections. Master Admin routes under `/api/admin/goats/*` require the existing server-resolved role, exact Admin origin on writes, session CSRF, optimistic versions, and parameterised D1 operations.

The Admin UI routes are `/goats`, `/goats/pending`, `/goats/approved`, `/goats/rejected`, `/goats/comments`, `/goats/emails`, and `/goats/:id`. Approval is blocked without ready main media, valid product, consent, slug, required public fields, and confirmed coarse coordinates. Reject, approve, hide, and restore transitions write their moderation event and applicable idempotent outbox row in the same D1 batch.

Public/internal APIs are fixed under `/api/goats/*`; signed writes require the shared encrypted `THIRDRAILIFY_COMMUNITY_API_SECRET`. Media stays under opaque `goats/private/<submission-id>/...` keys in the existing Admin-only `THIRDRAILIFY_PROFILE_MEDIA` bucket. JPG, PNG, and WebP remain valid for every image role; animated GIF is accepted only for profile media. GIF ingestion verifies dimensions and the complete block stream, preserves frame controls and the standard loop extension, and removes unrelated extension metadata without flattening animation. Anonymous delivery succeeds only for approved/published media and never returns an object key. Pending/rejected delivery is Master Admin only.

## Email and provider posture

Four templates are added with `INSERT OR IGNORE`: received, Admin pending alert, approved, and rejected. They default to draft, support safe fixture previews in the Admin editor, and retain administrator edits. Ready templates are dispatched from the durable outbox as background work after submission or moderation; authorised Admins can explicitly retry pending/failed events. Provider failure remains recorded and retryable, and status transitions do not roll back or claim a send. Tests inject a fake transport and contact no recipient.

Configure, but do not commit:

- `THIRDRAILIFY_COMMUNITY_API_SECRET` — identical encrypted secret in Public and Admin.
- `THIRDRAILIFY_GOATS_ADMIN_RECIPIENTS` — optional comma-separated notification addresses; otherwise existing Master Admin addresses are used.
- Existing Admin `THIRDRAILIFY_TURNSTILE_SECRET_KEY`, `THIRDRAILIFY_TURNSTILE_SITE_KEY`, `RESEND_API_KEY`, `MAIL_FROM`, and `MAIL_REPLY_TO` contracts.
- Existing Admin-only `THIRDRAILIFY_PROFILE_MEDIA` R2 binding.

No geocoder is configured. City/region/country text may be submitted, but a moderator must confirm a deliberately coarse coordinate before approval.

## Local fixtures, import, and cleanup

Production migration `0004` inserts no listings. The owner-supplied Wix export contract and dry-run validator are in `docs/GOATS_IMPORT_CONTRACT.md` and `npm run goats:import:dry-run -- <file>`.

`scripts/goats-demo-seed.sql` adds exactly two synthetic, approved, media-free `DEMO-*` listings for local/test proof. It is never run by migrations or application startup. `scripts/goats-demo-cleanup.sql` removes only those fixed demo identities. The Admin detail action can also hard-delete only records whose reference starts `DEMO-`; ordinary records cannot use it.

Expired draft cleanup is an explicit Master Admin, origin- and CSRF-protected maintenance call: `POST /api/admin/goats/maintenance/cleanup-drafts` with `{ "limit": 50 }`. It deletes private R2 objects before the expired draft rows. Run it in bounded batches only after the R2 binding exists; it is not an automatic scheduled job.

Local validation:

```powershell
npm run goats:import:dry-run -- C:\path\to\wix-goats-export.json
npm run test:functions
npm run typecheck
npm run lint
npm run build
```

These instructions do not apply a remote migration, seed a remote database, mutate R2, send email, deploy Pages, or configure a provider/domain.
