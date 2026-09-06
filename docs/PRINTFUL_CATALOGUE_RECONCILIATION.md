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

Current exact matches preserve stable local IDs, slugs, titles, descriptions, collections, tags, Featured state, valid local prices and other deliberate curation. Provider mappings, metadata, variants and customer-safe Printful mockup URLs are refreshed. Provider prices initialize new rows or repair invalid local amounts. Provider-incomplete or ambiguous rows become private and require review.

Image precedence is an explicit valid `editorial_override`, then the selected current provider thumbnail/customer preview, then image review. No historical Wix image implicitly becomes an editorial override. Completeness compares images, provenance, provider metadata and variant identity/mapping fields independently from the snapshot fingerprint. Archived historical products and variants do not become fresh archival work merely because that fingerprint changes.

Both sites must permit the selector's exact Printful image hosts in `img-src`; permitting a URL in normalization alone does not make it renderable under CSP. `node scripts/verify-current-printful-catalogue.mjs --images` performs bounded GET-only census and sanitized affected-image resource checks, without printing tokens or raw provider payloads.

Provider products not yet represented receive deterministic local identities and start private, unfeatured, and unsellable. Rows absent from the current store are retained but archived: product/variants become disabled, private, unfeatured, and unsellable; storefront collection memberships are removed. Historical order and community references remain intact. Re-running an unchanged reconciliation performs zero catalogue mutations.

After a successful apply, Admin Products defaults to current rows and exposes explicit archived/provider-missing/wrong-store/review filters. Public catalogue, product detail, collection counts, Featured, cart re-resolution, checkout, and sellability gates accept only current rows. Browser carts retain stale local IDs long enough to show an unavailable state and a removal action; stale lines cannot reach shipping or payment.

## Operator sequence

No step below was run by this local implementation.

1. Confirm the production migration ledger and take a recoverable Commerce D1 backup.
2. Verify `0026_printful_catalogue_reconciliation.sql` is recorded and its columns/tables exist. This repair adds no migration; do not reapply 0026 on an already reconciled database.
3. Deploy Admin code. Sign in as Master Admin and open Shop / Products.
4. Run **Preview reconciliation**. Verify Store ID/name/type, provider product and variant counts, every classification group, historical-reference counts, incomplete products/images/prices, blockers, and the unusual-reduction warning.
5. If the preview is expected, type its generated confirmation phrase and Apply. An unusual reduction strengthens the phrase to `RECONCILE <current-count> ARCHIVE <archive-count>`. Apply performs a fresh full read and refuses any snapshot or local-plan drift.
6. Verify the second Preview reports zero inserts, updates, or archives. Verify current/archived totals, Featured eligibility, direct current product routes, and a stale cart fixture.
7. Deploy Public only after Admin projection acceptance. Confirm the Public product count does not exceed the reconciled current count and archived slugs return 404.

## September 6 local repair evidence

Starting worktrees were clean: Admin `main` at `6c7e76b9fee60d316b9b6fc7778cd2b862e6f80d`, Public `main` at `319c23da0b7175346ca2ea3612ddd9600bfbdd25`. The earlier request was already substantially implemented in Admin commit `7d59d5a`; this follow-up closes remaining delivery/completeness/integrity gaps.

The historical targeted Featured handler rejected non-active products at `POST /api/admin/commerce/products/:id/featured` with HTTP 409, `commerce_product_not_displayable`. That guard was removed in `7d59d5a`. The original screenshot's network response and live product D1 row were not captured in this local run, so its generic error cannot be attributed conclusively to that guard. Current authenticated fixtures prove Hidden/disabled/zero-public-variant ON/OFF success, Public exclusion while Hidden is actually Featured, eligible Public Featured projection, and explicit non-current/store/identity rejections.

The current selector accepts `sync_product.thumbnail_url`, preview-file derivatives and variant product images ([Printful V1 contract](https://developers.printful.com/docs/)). Both repository CSPs omitted all three accepted Printful image hosts. Local browser fixtures now enforce the repository `img-src` directive and load a provider-host image. The GET-only live census found 16/256 with zero missing safe images; matching selected images for Sync Products 459991347, 460338949 and 460339175 returned HTTP 200 with image content. No current product title matched `fuc yeh`. No live D1 read or write was performed.

Validation used Node 22.16.0, with `C:\Users\TempAdmin\.codex\tmp\node-v22.16.0-win-x64` prepended to PATH:

| Repository | Command | Result |
| --- | --- | --- |
| Admin | `node --test --test-concurrency=1 tests/current-catalogue-reconciliation.test.mjs tests/product-merchandising.test.mjs` | 23 passed before adding the final all-17 projection fixture. |
| Admin | `node --test --test-concurrency=1 --test-name-pattern='preview/apply archives\|unchanged snapshots' tests/current-catalogue-reconciliation.test.mjs` | 2 passed against the final completeness comparisons. |
| Admin | `node --test --test-concurrency=1 --test-name-pattern='all 17 fixture\|current Hidden' tests/current-catalogue-reconciliation.test.mjs tests/product-merchandising.test.mjs` | Hidden/Public projection passed; initial all-17 fixture exposed its missing canonical media-origin configuration. |
| Admin | `node --test --test-concurrency=1 --test-name-pattern='all 17 fixture' tests/current-catalogue-reconciliation.test.mjs` | Corrected canonical-origin fixture passed, 17 safe Admin/Public images. |
| Admin | `node --test --test-concurrency=1 tests/current-catalogue-reconciliation.test.mjs tests/product-merchandising.test.mjs tests/commerce-core.test.mjs tests/commerce-functions.test.mjs` | 42 passed; 2 unrelated Stripe assertions expect `setup_required` while current Stripe posture is `disabled`. |
| Admin | `node --test --test-concurrency=1 tests/commerce-browser.test.mjs tests/admin-routes-browser.test.mjs` | Admin routes passed; 2 Products cases initially failed on Chrome loopback/HMR blocking. |
| Admin | `node --test --test-concurrency=1 tests/commerce-browser.test.mjs` | After the local browser harness adjustment: all 3 passed, including 1920/1440/768/390px, rapid toggles and isolated rollback. |
| Public | `node --test --test-concurrency=1 tests/shop-v2-browser.test.mjs` | Passed responsive shop/Featured/collections/detail/cart flow at 1920 through 390px. |
| Public | `node --experimental-strip-types --test --test-concurrency=1 tests/storefront-commerce.test.mjs tests/featured-merchandising.test.mjs tests/checkout-foundation.test.mjs` | 17 passed. |
| Both | `npm.cmd run typecheck`; `npm.cmd run build` | Passed; existing bundle-size warnings remain. |
| Admin | `npm.cmd run lint` | Passed. Final changed-file ESLint also passed. |
| Public | `npm.cmd run lint`; `npm.cmd run lint -- --ignore-pattern .artifacts/**` | Unrestricted run fails on old release artifacts; exclusion passes with 2 existing hook warnings. |
| Both | `npx.cmd wrangler pages functions build --outdir <temporary-output-directory>` | Passed; output directories are `%TEMP%/products-admin-functions-20260906` and `%TEMP%/products-public-functions-20260906`. |
| Admin | `npm.cmd run commerce:worker:build` | Passed; `--dry-run` only. |
| Admin | `node scripts/verify-current-printful-catalogue.mjs --images` | GET-only 16-product/256-variant census and sanitized affected-image evidence. |
| Both | `git diff --check` | Passed. |

Existing semantic UI/fallback implementation remains in `CommercePages.tsx`/`global.css`: Public/Mapped mint, Hidden/Pending/review amber, blocker states red, archived gray, Featured gold. No new files, removed files, migration, schema rewrite, deployment, remote mutation or provider write is part of this repair. Public changes are limited to the image header, browser coverage and documentation. Desktop/mobile screenshots were inspected from `%TEMP%/thirdrailify-admin-commerce-browser`; Public artifacts are in `%TEMP%/thirdrailify-shop-v2-browser`.

## Rollback procedure

Do not delete reconciliation rows or historical products. The preferred rollback is restoring the pre-apply Commerce D1 backup, then redeploying the prior Admin/Public artifacts together. If a database restore is not appropriate, leave newly imported rows private and unsellable and use a reviewed, auditable compensating D1 change derived from the saved preview/backup to restore previous status, visibility, Featured order, variant sellability, and collection memberships. Do not infer old collection or Featured state from provider titles.

If only the code rollout is reverted while migration `0026` remains, the additive columns/tables are compatible with prior reads, but the archived states applied to existing rows remain authoritative until explicitly restored. A code-only rollback therefore does not undo catalogue reconciliation.

## Local verification

Run `npm run verify:printful:current` for the bounded GET-only store census. Run `npm run preview:printful:reconciliation` to compare that live read with the checked-in permanent catalogue manifest using an ephemeral local D1 database; this second command does not mutate remote D1.

Use repository-pinned Node 22.16.0. The focused engine tests cover 10+7 pagination for 17 products, full details, explicit store headers, zero/partial/wrong-store failure, no title-only match, archive/history behavior, sanitized audit, Master-only access, CSRF, checkout exclusion, Public count bounds, and second-run idempotency. The Admin browser suite covers 1920, 1440, tablet, and 390 widths; Public checkout coverage includes stale-cart removal.
