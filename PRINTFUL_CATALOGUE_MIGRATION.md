# Printful catalogue migration manifest

This manifest records the read-only recovery boundary. Provider counts and product identities marked **pending authenticated snapshot** must be replaced only from the four sanitized artifacts downloaded by the protected Admin action. No value is inferred from a secret and no write migration is authorized here.

The live operator-flow defect is fixed, but no authenticated snapshot has been run as part of this document update. Every pending value below remains a deliberate placeholder until the Master Admin runs **Run read-only catalogue snapshot** once and supplies the four downloaded files.

## A. Legacy source

| Field | Value |
| --- | --- |
| Store ID | `16847493` |
| Name | `Third Railify Official` |
| Type | `wix` |
| Authority | temporary read-only `PRINTFUL_WIX_SOURCE_TOKEN` |
| Product count | pending authenticated snapshot |
| Variant count | pending authenticated snapshot |
| Synced / ignored / unavailable | pending authenticated snapshot |
| Missing or malformed prices | pending authenticated snapshot |
| Missing files | pending authenticated snapshot |

The source token is limited to store products/files and must be revoked after successful migration and cutover verification. It must never perform a Printful write.

## B. Permanent target

| Field | Value |
| --- | --- |
| Store ID | `18668025` |
| Name | `Third Railify API` |
| Type | `native` |
| Last verified visible product count | `1` |
| Current complete product count | pending authenticated snapshot |
| Order mode | `draft_only` |
| Fulfillment | disabled |

The exact safe identity and disposition (`KEEP`, `MAP`, `RECREATE`, `DELETE_LATER`, or `MANUAL_REVIEW`) of every pre-existing target product is pending the authenticated target snapshot. Nothing may be updated, deleted, or recreated in this milestone.

## C. Current Public Wix projection

The read-only Public repository currently exposes eight verified CAD product records from its bounded Wix snapshot. All eight are classified `PRINTFUL_MERCH` candidates, none is classified as non-Printful in the current bounded data, and all eight remain unresolved until compared with the live source and target artifacts. The older audit reported 49 total Wix products but intentionally represented only these eight records; 49 must not be treated as a current complete Public catalogue count.

## D. Migration matrix

| Public name / slug | Visible CAD | Source Printful ID | Source Wix external ID | Variants | Files | Target match | Recommended action | Blocker |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| BLEH / `bleh-unisex-classic-tee` | 30.50 | pending | `c2cb6ed3-d090-48a9-a742-3d3ed7cfe5c4` | pending | pending | pending | reconcile | authenticated snapshot |
| Just Gina Icon Short Sleeve / `just-gina-icon-basic-short-sleeve-t-shirt` | 43.00 | pending | pending | pending | pending | pending | reconcile | authenticated snapshot |
| Just Gina Icon Unisex / `just-gina-icon-classic-unisex-tee` | 30.50 | pending | pending | pending | pending | pending | reconcile | authenticated snapshot |
| Just Gina Wordmark Dad Hat / `just-gina-wordmark-basic-dad-hat` | 45.00 | pending | pending | pending | pending | pending | reconcile | authenticated snapshot |
| Third Railify Wordmark Dad Hat / `third-rail-wordmark-basic-dad-hat` | 45.00 | pending | pending | pending | pending | pending | reconcile | authenticated snapshot |
| Third Railify Icon Dad Hat / `third-railify-icon-dad-hat` | 39.00 | pending | pending | pending | pending | pending | reconcile | authenticated snapshot |
| Third Railify Logo Short Sleeve / `third-railify-logo-short-sleeve-t-shirt` | 43.50 | pending | pending | pending | pending | pending | reconcile | authenticated snapshot |
| Third Railify Logo V2 Unisex / `third-railify-logo-v2-unisex-classic-tee` | 30.50 | pending | pending | pending | pending | pending | reconcile | authenticated snapshot |

The generated reconciliation extends this table with every unmatched source product and uses only: `MATCHED_PRINTFUL_SOURCE`, `TARGET_ALREADY_PRESENT`, `PRINTFUL_SOURCE_ONLY`, `PUBLIC_ONLY`, `NON_PRINTFUL`, `AMBIGUOUS`, `PRICE_CONFLICT`, `VARIANT_CONFLICT`, or `FILE_CONFLICT`.

## E. Variant schema requirements

The requested logical variant design follows commerce product migration 0003. Because applied `0004_goats_community.sql` already owns number 0004, its safe repository-consistent filename is [`commerce-import/0005_commerce_product_variants.proposed.sql`](commerce-import/0005_commerce_product_variants.proposed.sql). It is design-only and must not be applied in this task.

`commerce_product_variants` contains:

- opaque UUID `id`, parent `product_id`, and stable parent-scoped `local_variant_key`;
- permanent `printful_target_sync_product_id` and unique `printful_target_sync_variant_id`;
- Printful catalogue `variant_id`;
- legacy source sync product/variant IDs and Wix external product/variant IDs;
- SKU, size, color, bounded option JSON, and bounded print-file mapping JSON;
- `currency_code='CAD'` and exact positive integer `unit_amount` cents;
- bounded availability, active/sellable, fulfillment-provider, and mapping-status gates;
- explicit migration status and bounded provenance JSON.

The same design rebuilds `commerce_order_items` to reference the concrete variant and immutably snapshot its name, SKU, options, exact price, and fulfillment mapping. Only after a separately approved migration may checkout change from `{ productId, quantity }` to `{ productId, variantId, quantity }`.

## F. Write migration plan — not authorized now

1. Review the four sanitized snapshot artifacts; resolve every ambiguous stable ID, duplicate SKU/ID, price, variant, and file conflict.
2. For each approved missing source product, review the generated `send=false` conceptual target payload, Third Railify-owned external ID, catalogue variant IDs, exact CAD decimal prices, SKUs, placements, options, and files.
3. Under separate authorization, create only approved permanent-target products, record each returned target product/variant ID, and do not touch the Wix source.
4. Re-read the target with GET only and verify product identity, every variant, SKU, exact price, availability, placement, and artwork before any local import.
5. Apply the reviewed variant migration only after renumbering remains valid; import parent `commerce_products` inactive/non-public with checkout still disabled.
6. Import concrete variants inactive/non-sellable with complete target mapping and legacy provenance; independently validate artwork previews and print placements.
7. Enable no checkout until product/variant authority, Stripe TEST configuration/webhook proof, shipping/tax behavior, inventory/availability, rollback, and operator acceptance all pass.
8. Roll back by keeping checkout and fulfillment disabled, deactivating imported local products/variants, and preserving target objects for manual review; never restore by mutating the Wix source.
