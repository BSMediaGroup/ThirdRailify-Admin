# Printful catalogue workflow

Use **Products → Sync Printful**. The reader authenticates native store **18668025**, reads every page and checkpoints every product. Review selection, publication, variants, prices, shipping, media and issues, then choose **Import & publish eligible products**. New products default to publication; uncheck a product to retain a draft. Existing hidden choices remain hidden. Successful products commit independently; failed siblings remain visible in the job and can be retried without repeating successes. Cancel stops further catalogue commits. Partial reads never archive absent products.

Open the edit icon for **Overview / Variants / Media / Shipping / Sync history and Issues**. Stage changes and use **Save product** once. Publication is included. Invalid dependencies preserve edits as a draft with reasons. A revision conflict requires reloading and reviewing concurrent changes. Media is validated and staged before the guarded D1 batch associates it and publishes. Existing eye/star controls, filtering, bulk tools and pagination remain available.

Sync keeps stable local IDs and URLs and preserves merchant prices, copy, collections, featured ordering, shipping weights and manual media choices. Provider variant prices/options are recorded separately; **Restore provider price** is explicit. Variant inclusion and product publication are separate intents. Provider disappearance is distinct from operator exclusion. Unusually large variant retirement requires the existing advanced reconciliation review.

**Automatic sync settings** support Off/15/30/60 minutes. A policy save explicitly enables automatic import; the default is Off. The existing signed five-minute operations runner resumes the same jobs with bounded checkpoints. Last success, next run and retry time are persisted. The local-catalogue baseline and existing publication intent prevent initial scheduling from publishing existing drafts. V1 product events are not configured; scheduled/manual sync works independently. The existing V2 fulfillment webhook is untouched.

## Shipping and weights

The verified production policy on 2026-09-12 is **Automatic Printful rates** (`printful_dynamic`), CAD, with AU currently enabled. Import does not alter markets or policy. The V1 `/shipping/rates` request uses server-resolved Catalog variants and quantities. Unknown local mass is informational in this mode.

**Merchant weight-based rates** retain the published ratebook, revisions, brackets, exclusions and thresholds. Effective mass is variant override → product default → unknown, in integer milligrams. Unknown effective mass blocks this mode. Changing customer pricing requires an explicit policy preview/save. There is no silent provider-price or zero-price fallback. Existing sticker values remain operator-entered, not provider-verified.

Customer shipping charge and provider service/cost estimate are separate. Merchant quotes retain `providerCostAmount`; new PayPal order policy snapshots retain that estimate independently of the customer charge. The current confirmation guard in `commerce-operations.js::validateDraft` checks external identity, draft status, service code, variants/quantities and recipient. **It does not compare either shipping amount or enforce a monetary cost ceiling.** Intentional subsidies/free shipping therefore must not be described as a provider-price mismatch. This task does not change fulfillment authority.

Quote identity includes authoritative product/variant revisions, amounts, quantities, destination, store, currency and merchant pricing/weight revisions. Final payment preflight re-resolves the cart and validates the persisted quote. Environment mismatches remain blocked; TEST fixtures are never globally accepted by LIVE checkout.

## Media and diagnostics

Select variants, a colour group or all matching variants and assign designed images. Explicit assignments use canonical local variant IDs, retain alt text and ordering, and survive sync. Public selection and cart imagery choose variant assignments/provider customer previews, then general product media. General images stay in the gallery. Removing an association never deletes a shared immutable R2 object. Future order items snapshot the selected image; historical snapshots are unchanged.

Admin readiness separates provider mapping, publication intent, production eligibility, shipping prerequisites and media. Destination availability remains `not_quoted` until an actual quote. Environment failures use `checkout_environment_mismatch` / `PRODUCT-ENVIRONMENT`; hidden products use `checkout_product_unavailable` / `PRODUCT-HIDDEN`. Mapping, weight, destination, ratebook and provider errors retain separate reason codes. No raw provider response is projected to shoppers.

## Research evidence

Official sources: [V1 API](https://developers.printful.com/docs/), [V2 preview](https://developers.printful.com/docs/v2-preview/), [shipping](https://www.printful.com/shipping), [rate CSV](https://www.printful.com/shipping-rates-report/shipping-rates-report/download), [mixed-order rules](https://help.printful.com/hc/en-us/articles/20583931065372-How-do-I-calculate-shipping-costs-for-different-types-of-orders), [separate shipments](https://help.printful.com/hc/en-us/articles/360014068379-Are-all-products-in-an-order-shipped-together).

The saved report was retrieved **2026-09-12T11:04:04.206Z**, contains 936 rows and is **USD only**. `scripts/refresh-shipping-research.mjs` validates before replacing the last-known report; retrieval age is recorded in the JSON sidecar. It is not an active CAD ratebook. Category pricing stays unavailable until exact variant/category/region/currency and independent shipment groups are reviewed. Catalog 10163/10164/10165 are ordinary stickers; 16362 is 15 × 3.75 inches. Mixed independently shipped groups require separate first-item charges.

Representative native-store variants and Catalog products 358/206 supplied no explicit usable mass/unit fields. Fabric density, thickness, capacity, maximum load and warehouse-only mass are not POD shipping mass. No weight was guessed or imported as zero.

## Release evidence

Scoped migration `0047_catalogue_workflow.sql` adds sync policy/jobs/items and future order-item image snapshots. Migration 0046 was not replayed. Before mutation, catalogue tables/schema were exported and a D1 recovery bookmark recorded under ignored `.wrangler/printful-workflow-20260912/`.

The live repair changed only checkout environment for intentionally published native products `printful-18668025-471233950` and `product-393220449`, guarded against current source, store, mapping, publication intent and deliberate TEST evidence. Prices, weights and historical orders were preserved. Deployment and acceptance results are recorded in the adjacent release report.
