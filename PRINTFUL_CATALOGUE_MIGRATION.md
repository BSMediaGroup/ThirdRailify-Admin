# Printful catalogue migration manifest

This manifest records the finalized read-only selection milestone captured on 2026-08-28. It authorizes no provider or D1 writes. The four downloaded Printful/Public/reconciliation files in `commerce-import/live/` are immutable evidence and must not be regenerated or rewritten.

## Authoritative evidence

| Evidence | Result |
| --- | ---: |
| Total legacy Printful source products | 119 |
| Total legacy variants | 2,456 |
| Synced variants | 2,293 |
| Active variants | 2,287 |
| Temporarily out-of-stock variants | 6 |
| Discontinued variants | 163 |
| Ignored variants / products | 157 / 1 |
| Valid CAD prices | 2,456 |
| Missing or malformed prices | 0 |
| Fileless active / temporary / discontinued variants | 0 / 0 / 163 |
| Current live Wix product pages | 49 |
| Strong Printful-backed live matches | 49 |
| Non-Printful product pages | 0 |
| Final target creates | 49 |
| Target-native keeps | 1 |
| Not-currently-published legacy products | 69 |
| Ignored source manual review | 1 |
| Active variants in target-create payloads | 1,317 |
| Discontinued variants excluded globally / from live payloads | 163 / 90 |
| Temporarily out-of-stock variants globally / in live selection | 6 / 5 |

The current publication authority is `commerce-import/live/live-wix-published.snapshot.json`. It was built from the live `robots.txt`, sitemap index, discovered `store-products-sitemap.xml`, and one public Wix Stores GraphQL GET per sitemap product slug. The census made GET requests only and persisted no anonymous token, session, or customer data.

## Corrected identity hierarchy

Matching is tiered, not additive:

1. exact stable Printful source product ID;
2. exact known Wix external product ID;
3. exact normalized product name where unambiguous;
4. exact stable provider variant ID or SKU set;
5. catalogue variant structure;
6. artwork identity;
7. price;
8. fuzzy name similarity only as a weak aid.

Weaker evidence can never add up to outrank a stronger tier. This fixes the prior invalid price-plus-variant-shape mapping of **Just Gina™ Icon | Short Sleeve T-shirt** to source `399113926` (**Third Railify™ | Leggings**). The product now maps to source `393315779` by exact Wix external ID and exact normalized name.

## Availability and artwork semantics

Only active, non-ignored variants enter the current target-create payloads. Temporarily out-of-stock variants are recorded separately and deferred until target catalogue support is explicitly verified. Discontinued variants never enter a target payload.

The former `fileConflicts = 24` result was over-broad because it treated every fileless discontinued legacy variant as a migration blocker. All 163 fileless variants are discontinued. Active fileless variants are zero and temporarily out-of-stock fileless variants are zero, so the finalized write set has no real artwork blockers.

Ignored is independent of availability. The ignored source product `454885552` (**Raider's Goblet | Black Glossy Mug**) has two active variants and remains `MANUAL_REVIEW`; it is not migrated merely because it exists in Printful.

## Duplicate SKU evidence

The source contains two duplicate SKU groups, each with two active variants:

- `68F047EC4A5F5_20487` on source product `396323008` variants `5014326919` and `5014327851`;
- `68F04A457A1A9_20487` on source product `396324489` variants `5014334286` and `5014337752`.

SKU is therefore nullable, searchable, and non-unique in migration `0005`. Stable local/provider identities carry uniqueness instead.

## Permanent target-native product

Target product `459991347`, **My Balloon | classic tee**, and variant `5463409939` remain user-owned target-native data under `KEEP_EXISTING_TARGET_RELATED_LEGACY`. They are not deleted, overwritten, remapped, or recreated.

Legacy source product `439028668` shares the artwork filename `baLLOON2.pdf`, but it is not the same product identity: the target uses catalogue product `438` / variant `11576` (Gildan 5000, one variant, CAD 12.50), while the legacy product uses catalogue product `960` (Cotton Heritage, six variants). Both may coexist. Shared artwork is relationship metadata only.

## Final write plan

The exact bounded artifacts are:

- `commerce-import/live/catalogue-reconciliation.corrected.json`;
- `commerce-import/live/catalogue-write-selection.json`;
- `commerce-import/live/printful-target-create-payloads.json`;
- `commerce-import/live/migration-evidence-report.json`.

The payload plan contains 49 unsent `POST /store/products` plans and 1,317 active variants. Every payload has `send: false`; no discontinued or temporarily out-of-stock variant is included.

## Migration 0005 and checkout contract

`commerce-migrations/0005_commerce_product_variants.sql` is the finalized real migration and remains unapplied. It adds explicit product provenance, creates authoritative variants with exact CAD cents and stable target/legacy mappings, keeps SKU non-unique, and extends order-line snapshots with variant identity/options/fulfillment mapping.

Checkout remains disabled. The future variant-product request contract is:

```json
{
  "productId": "opaque-product-id",
  "variantId": "opaque-variant-id",
  "quantity": 1
}
```

For products with variants, the server requires `variantId` and reads price, currency, sellability, availability, and Printful mapping from D1. Browser-supplied prices and fulfillment identities are rejected.

## Next write milestone gates

The next task may write only after separately authorizing application of migration `0005`, target product creation, and local import. Checkout and fulfillment must remain disabled until target IDs are returned and verified, D1 import is complete, Stripe TEST checkout/webhook behavior passes, and the operator accepts the final catalogue.
