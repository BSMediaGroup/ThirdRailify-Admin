# Printful release acceptance - 12 September 2026

## Outcome and exact defect

The sticker `printful-18668025-471233950` was active/public with operator publication intent and current native-store mapping, but persisted `checkout_environment=test`. LIVE authoritative cart validation rejected that predicate before shipping calculation. Import and canonical publication now assign the production environment for eligible native catalogue records while preserving deliberate TEST fixtures. The guarded data repair corrected that product and `product-393220449`; working comparison product `product-393307261` was already live. Existing prices, operator weights and historical orders were preserved.

The sticker's four variants are `printful-variant-18668025-5496371671` through `5496371674`, mapping to Catalog 10163, 10164, 10165 and 16362, priced CAD 5.00 / 5.00 / 5.50 / 11.50. All four returned successful production shipping quotes.

## Delivered workflow

Sync Printful uses durable checkpoints, bounded retries, cancellation, completeness checks and per-product results. Review and import include desired publication; existing merchant overrides and deliberate drafts survive refreshes. Optional scheduling reuses the existing signed job runner and remains Off until an explicit policy save. Product editing uses one Save product action across variants, publication, shipping and media, with optimistic conflicts and atomic associations/publication.

The sync review presentation now has a branded hero, progress stages, readiness counts, styled filters, expandable variant cards, status badges, a structured automatic-settings panel and responsive controls. The editor retains the dark/gold/cream identity and existing brand fonts/icons.

General and variant images retain immutable canonical CDN identities and provenance. Browser delivery uses public immutable-image routes to avoid the observed CDN embedded-image rejection and cached legacy redirect. Associations use local variant IDs and survive sync; new orders snapshot selected imagery without rewriting historical snapshots.

## Production policy and acceptance

The actual policy remains Automatic Printful rates (`printful_dynamic`), CAD, with current markets including AU preserved. Missing local mass does not block that policy. Existing operator sticker weights remain unchanged and are not provider verified. Merchant weight-band behavior and explicit pricing-policy saves remain available. Category rates are deliberately unavailable pending reviewed CAD/category/independent-shipment coverage: the retrieved official 936-row report is USD only and distinguishes ordinary stickers from 15 x 3.75-inch stickers.

Nine normal shipping-only API requests returned 201, including each sticker variant, two stickers and sticker plus the existing peer. Representative totals: one ordinary sticker CAD 12.39; two CAD 17.54; sticker plus peer CAD 45.64. Large-sticker provider estimates varied between requests, as expected from live rates. No payment, order, capture, refund, donation or email operation was performed. Historical draft 174104132 was untouched.

Task-attributable Printful calls: 21 API GETs, nine shipping-rate requests (of the allowed twelve), and five asset GET attempts while staging four genuine designed images. Other image checks were against our own media delivery.

## Schema, backups and releases

Only additive migration `0047_catalogue_workflow.sql` was applied and recorded remotely; unrelated migration 0046 was not replayed. It adds sync policy/job/item storage and future order-item image snapshots. Scoped pre-repair exports and schema evidence are under ignored `.wrangler/printful-workflow-20260912/`. D1 recovery bookmark: `0000057d-0000228e-000050e4-eb6935445621e140349659e60bb5e933`.

Releases were assembled from the original HEAD plus explicit task files to exclude concurrent Workshop/auth work. Admin final deployment: `aebf199b.thirdrailify-admin.pages.dev`. Public final deployment: `cb046f54.thirdrailify.pages.dev`. Public now has the catalogue-media R2 binding; its route exposes only immutable `commerce/catalogue/` image keys. Existing operations/media Workers were not changed or deployed. No commits or pushes were made.

## Validation and limits

Failing environment regressions were written first, then passed after repair. Focused catalogue/readiness/workspace/sync/shipping/media/category suites passed, including retry/cancel/partial snapshots, conflicts, overrides and media boundaries. Both typechecks/builds and Functions compilation passed; the unchanged operations Worker dry-run passed. Admin isolated-release lint passed. Public source lint had no errors and two pre-existing warnings; blanket lint encounters unrelated generated `.artifacts` files and is not a clean result. Diff checks and scoped credential-pattern scans passed.

Local authenticated browser tests exercised the real handlers and editor/save/media/sync controls at 1440/768/390. Public variant/gallery/cart selection tests passed at those sizes. Screenshots and production checks are under `.wrangler/printful-workflow-20260912/browser/`; polished sync captures also exist under the isolated Admin release at the same relative path.

Final fresh production Chrome acceptance passed at all three widths: no horizontal overflow, no application page errors, all six displayed product/gallery image elements decoded, and selecting each of the four sizes changed the primary image to its exact assigned artwork. Public immutable-image delivery returned HTTP 200 `image/png` (45,912 bytes for the first image). This was verified after the final Public deployment.

**Unverified live action:** an authenticated production Save product and enabling scheduled sync were not exercised because no legitimate operator session was available. Local authenticated tests do not constitute that live proof. Scheduling remains Off. No fabricated session or fictional production product was used.

See [normal workflow and research sources](printful-catalogue-workflow.md).
