The five-zone shipping manager and checkout integration are deployed. Country headings include the existing AU, GB, US and CA SVG flags; Worldwide uses the existing neutral globe SVG.

Customer pricing cutover is intentionally pending real shipping weights. All supplied tariffs are retained in draft `wix-five-zone-20260906`, revision 1. The active customer-pricing setting remains `printful_dynamic`; the merchant policy pointer is null, revision 1. No store activation or pause action was performed.

1. Installed CAD tariffs (lower weight exclusive, upper inclusive):

   | Destination | >0–1100 g | >1100–2200 g | >2200–4400 g | Final bracket |
   |---|---:|---:|---:|---|
   | Australia (AU) | 28.00 | 33.00 | 39.00 | >4400 g: 44.01, unlimited |
   | United Kingdom (GB; UK label) | 17.00 | 20.00 | 24.00 | >4400 g: 26.54, unlimited |
   | United States (US) | 15.00 | 18.00 | 21.00 | >4400 g: 24.19, unlimited |
   | Canada (CA) | 23.00 | 30.00 | 35.00 | >4400–6600 g: 40.40 |
   | Worldwide | 40.00 | 50.00 | 60.00 | >4400 g: 67.03, unlimited |

   All values are integer CAD cents. Bands and shipping weights use integer milligrams, preserving exact sub-gram boundaries. Delivery estimates are null; free-shipping thresholds are off. No handling, per-item, per-kilogram or package-count surcharge was added.

2. Canada is exactly CAD 23.00 / 30.00 / 35.00 / 40.40. Its final upper bound is exactly 6600 g. Under this ratebook, 6601 g produces `shipping_weight_out_of_range`, before a provider rate request or payment. There is no Worldwide fallback, provider-price fallback, artificial package split or free-shipping interpretation. A finite final bracket publishes successfully and does not itself block global readiness.

3. Membership is AU, GB, US and CA respectively; Worldwide covers remaining active supported countries. Existing canonical country/subdivision selectors and explicit provider exclusions are preserved. Live Public shipping-markets currently returns 242 destinations; this is a readback count, not a new hardcoded contract. The legacy overview counts of 8/4/54 subdivisions could not establish exact historical membership, so no extra territories were guessed.

4. Final D1 coverage: 113 current checkout-eligible, fulfillment-mapped physical variants; 0 known weights and 113 missing. All are currently configured for TEST checkout. Matching Sync and Catalog IDs are present for these 113 records. No shipping weights occur in the retained local Wix/import snapshots or the inspected D1 product/variant metadata, and no physical weight columns previously existed. The official Printful documentation distinguishes fabric density, carrying capacity and warehouse-item weight; these are not evidence for these print-on-demand variants. No weights were invented or imported from unrelated records.

   Exact product/variant IDs, SKU, size, colour and configured environment are in [missing-variant-weights.csv](missing-variant-weights.csv). The earlier broader catalogue scan counted 238 sellable variants; the final coverage report uses the current physical-checkout filters rather than that broad count.

5. Admin management URL: https://admin.thirdrailify.com/commerce/fulfillment#shipping-rates . The workspace supports destination editing, enabled/disabled/archived methods, adding methods/ranges, bounded or unlimited final ranges, optional delivery text, fully implemented free-shipping thresholds based on authoritative merchandise subtotal before shipping/tax, draft save/cancel, conflict messages, atomic publication and a provider-free calculator. Product Editor at `/products` supports product defaults, explicit units, variant overrides, bulk assignment, provenance and inheritance. Provider refresh cannot overwrite the separate weight authority.

6. Quotes keep customer charge, provider service identifier and provider cost distinct. The provider service is resolved against the actual `STANDARD` response; checkout labels are never sent as provider service codes. Legacy shipping-strategy columns retain the compatible provider-adapter value, while merchant pricing policy and weight revisions live on quote options and immutable order policy snapshots. Admin order detail identifies merchant pricing and the separate provider quoted cost. No fulfillment Worker change was required: the existing Worker only schedules the Admin operations endpoint.

7. Quotes bind the existing cart/recipient/environment/expiry authority plus published ratebook, zone, method, bracket, effective cart weight and weight-source revisions. New order creation checks publication and weight revisions transactionally. Draft identity and revision both participate in optimistic concurrency, including across publication. Established orders use their accepted snapshots and never reprice on retries.

8. A mocked integration test verifies the same CAD 23.00 shipping charge across the agreement, PayPal order breakdown, order, delivery snapshot, receipt and confirmation email, while the provider quoted cost is CAD 13.50. Changing the shipping weight after order creation preserves its CAD 83.00 total. Historical production records were not repriced or mutated by this task. The migration only creates new authorities; no historical-order or private-profile mutation was issued. Historical readback has 3 orders. This is not claimed as a before/after checksum: Wrangler's initial `--file` read returned execution summaries, so final detailed readback was obtained with `--command`.

9. Verified unchanged: store checkout disabled; donations enabled; emergency pause false; preferred provider PayPal; Stripe disabled/non-preferred; Commerce environment production; customer-pricing strategy `printful_dynamic`. Tax and private merchant disclosure policy were not changed. Existing encrypted merchant records, the Enable Store/Pause Store controls, and donation authority are preserved.

10. Migration: `0033_merchant_shipping_ratebook.sql`, applied 2026-09-06 13:00:04 UTC. It was the sole pending migration. Remote ledger, new indexes/triggers and exact seed body were read back; `PRAGMA foreign_key_check` returned no violations. Trigger-containing SQL uses LF. No applied migration was edited or replayed.

11. Final production deployments:

    - Admin: `3ee16924-2150-4926-b82d-872576b126bf` — https://3ee16924.thirdrailify-admin.pages.dev
    - Public: `94c66e65-9f5e-4945-b136-c7234e56cf52` — https://94c66e65.thirdrailify.pages.dev
    - Worker: unchanged; no deployment.

    Both canonical deployments report success. Stable-domain JavaScript matches the exact local build hashes. Admin shipping management API returns JSON 401 without authentication, as expected. Live authenticated editing was not exercised; manager interaction was validated with local mocked sessions. No live buyer rehearsal was performed.

12. Validation passed:

    - Merchant engine/D1: 4 tests, including all 20 prices, requested boundary matrix, exact conversion, Canada maximum, no fallback, exclusions, invalid ranges, inheritance, conflicts, publication, finite-ceiling readiness, immutable ratebooks, forged input, stale quotes and separate provider costs.
    - Existing shipping/PayPal/store-activation regressions: 28 tests.
    - Additional complete merchant agreement/payment/order/document/email integration: 1 test, mocked providers only.
    - Public proxy/checkout/agreement: 7 tests, including responsive worldwide checkout without a postal code and privacy checks.
    - Admin manager browser: 1 test exercising 1440/768/390, all five loaded heading SVGs, editing, calculator, weight controls and overflow checks.
    - Existing fulfillment browser: 1 test across its three viewports, preserving operations behavior. Its fixture now waits for the asynchronous payload before assertions.
    - Both typechecks, targeted lint, production builds, Functions compilation and scoped diff checks passed. Builds retain the existing bundle-size warning. Credential/PII scanning found no new real credentials or customer/private merchant data in the implementation.

    A Windows screenshot overwrite error used the one isolated retry with a fresh screenshot directory; the final flag run passed. Screenshots: [flags-1788699892969](flags-1788699892969/). Detailed readback: [release-verification.json](release-verification.json).

13. Provider/money activity: zero real PayPal orders/captures, donations, Stripe calls, Printful orders/confirmations/production rate tests, Resend deliveries or customer documents. No Wix, DNS, OAuth, CDN or credential changes. Cloudflare schema/deployment operations were within the authorized scope.

14. Preflight: both repositories were initially clean on `main`, with `origin/main` upstream and no staged/unstaged/untracked changes or diff-check errors. Initial Admin HEAD was `049aaeb8a0121c98a12a2a7291cc39bf223c8a7d`; Public was `d3273341a394aa0737b2b8797b2a5d78c270878e`. Concurrent Public gaming releases advanced its HEAD to `4571edb8d9412e9fc420fcef7e266fff39e86ddb`; this newer source was retained for the Public build. Concurrent unrelated Admin style changes and browser logs were preserved. This task issued no reset, clean, stash, commit or push. Node 22.16.0 was used explicitly.

15. Remaining input: real shipping weights for the 113 listed physical variants, entered with provenance through Product Editor, followed by ordinary ratebook publication. Canada's tariffs and 6.6 kg ceiling require no additional input. Customer pricing cutover is not claimed complete.

Documentation consulted: https://developers.printful.com/docs/v2-beta/ and https://developers.cloudflare.com/workers/wrangler/commands/ . The V1 documentation web fetch exceeded the fetch limit; the repository's existing V1 adapter and focused Catalog-ID/Sync-ID tests were also inspected.
