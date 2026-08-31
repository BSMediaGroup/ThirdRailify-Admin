# Current Printful catalogue reconciliation

This milestone replaces the historical 50-product / 1,323-variant import view with the explicitly configured current Printful store as the provider authority. Commerce D1 remains the local merchandising, historical-order, and customer-safe projection authority. The reconciliation never title-matches products, never hard-deletes catalogue or order history, and never writes to Printful.

## Authority contract

- Configured Store ID: server-only `PRINTFUL_STORE_ID` (expected `18668025`).
- Verified identity: `Third Railify API`, type `native`.
- Provider read: `GET /stores`, every paginated `GET /store/products`, then every `GET /store/products/{id}` detail.
- Store context: `X-PF-Store-Id` is sent on store-product reads, supporting an account-scoped token without silently choosing the first visible store.
- Matching: exact Sync Product ID first; unique external ID is permitted only when no Sync Product ID exists. Equal titles are review evidence, never identity.
- Apply: Master Admin, exact origin, valid session, CSRF, bounded rate limit, unchanged provider fingerprint/counts, unchanged local plan, and exact typed confirmation.

Any zero/partial page, changed total, duplicate identity, missing detail, wrong store identity, invalid price/currency, rate limit, timeout, or snapshot drift fails closed before catalogue mutation. Preview persists only sanitized classification/audit data.

## Classification and apply behavior

Current exact matches preserve stable local IDs, slugs, titles, descriptions, collections, tags, Featured state, and other deliberate curation. Provider mappings, current prices, variants, and customer-safe Printful mockup URLs are refreshed. Incomplete or ambiguous rows become private and require review.

Provider products not yet represented receive deterministic local identities and start private, unfeatured, and unsellable. Rows absent from the current store are retained but archived: product/variants become disabled, private, unfeatured, and unsellable; storefront collection memberships are removed. Historical order and community references remain intact. Re-running an unchanged reconciliation performs zero catalogue mutations.

After a successful apply, Admin Products defaults to current rows and exposes explicit archived/provider-missing/wrong-store/review filters. Public catalogue, product detail, collection counts, Featured, cart re-resolution, checkout, and sellability gates accept only current rows. Browser carts retain stale local IDs long enough to show an unavailable state and a removal action; stale lines cannot reach shipping or payment.

## Operator sequence

No step below was run by this local implementation.

1. Confirm the production migration ledger and take a recoverable Commerce D1 backup.
2. Apply only additive `commerce-migrations/0026_printful_catalogue_reconciliation.sql` and verify the new columns/tables.
3. Deploy Admin code. Sign in as Master Admin and open Shop / Products.
4. Run **Preview reconciliation**. Verify Store ID/name/type, provider product and variant counts, every classification group, historical-reference counts, incomplete products/images/prices, blockers, and the unusual-reduction warning.
5. If the preview is expected, type its generated confirmation phrase and Apply. An unusual reduction strengthens the phrase to `RECONCILE <current-count> ARCHIVE <archive-count>`. Apply performs a fresh full read and refuses any snapshot or local-plan drift.
6. Verify the second Preview reports zero inserts, updates, or archives. Verify current/archived totals, Featured eligibility, direct current product routes, and a stale cart fixture.
7. Deploy Public only after Admin projection acceptance. Confirm the Public product count does not exceed the reconciled current count and archived slugs return 404.

## Rollback

Do not delete reconciliation rows or historical products. The preferred rollback is restoring the pre-apply Commerce D1 backup, then redeploying the prior Admin/Public artifacts together. If a database restore is not appropriate, leave newly imported rows private and unsellable and use a reviewed, auditable compensating D1 change derived from the saved preview/backup to restore previous status, visibility, Featured order, variant sellability, and collection memberships. Do not infer old collection or Featured state from provider titles.

If only the code rollout is reverted while migration `0026` remains, the additive columns/tables are compatible with prior reads, but the archived states applied to existing rows remain authoritative until explicitly restored. A code-only rollback therefore does not undo catalogue reconciliation.

## Local verification

Run `npm run verify:printful:current` for the bounded GET-only store census. Run `npm run preview:printful:reconciliation` to compare that live read with the checked-in permanent catalogue manifest using an ephemeral local D1 database; this second command does not mutate remote D1.

Use repository-pinned Node 22.16.0. The focused engine tests cover 10+7 pagination for 17 products, full details, explicit store headers, zero/partial/wrong-store failure, no title-only match, archive/history behavior, sanitized audit, Master-only access, CSRF, checkout exclusion, Public count bounds, and second-run idempotency. The Admin browser suite covers 1920, 1440, tablet, and 390 widths; Public checkout coverage includes stale-cart removal.
