# Product special status

In Product editor, under Special product status, turn on Not for sale and choose Competition prize or Display only, then Save product. Public visibility is a separate control. The setting can be saved while the product is private; publishing later retains it. Turning the restriction off restores the existing purchase eligibility without modifying variants, pricing, Featured placement or provider mappings.

The existing authenticated merchandising endpoint validates and persists saleRestriction: { enabled: boolean, reason: competition_prize | display_only } inside existing product safe metadata. Older editor requests that omit the optional field preserve it. Invalid field types/reasons reject. Public catalogue/detail projections explicitly allowlist it. The authoritativeCartLines gate rejects checkout_product_not_for_sale before shipping/provider requests, including stale cart submissions. Already completed order history is preserved.

Shared ProductCard banners cover shop galleries, Featured and related products. Product detail has a larger banner and disabled Not for sale button. Cart insertion, full cart, drawer and checkout all refuse restricted lines. Search structured data omits sale offers for restricted items. Visibility still follows existing publication and catalogue integrity rules.

Validation: Admin restriction round-trip/visibility/old-client preservation/invalid input/server gate/variant preservation integration passed. Existing merchandising suite: 12 passed. Public catalogue/SEO suite: 15 passed, one unrelated existing /receipt metadata-length assertion failed. Both builds/typechecks and changed-file lint passed. Admin editor browser saved public and private restriction states at 1440 and 390 pixels. Public browser checked shop cards, detail pages, related cards, old-cart blocking, restored purchasing, and absent SEO offers at 1920/1440/768/390 with isolated fixtures. No real product setting, price, variant, order, payment or provider state was changed for testing.

Admin production: https://2dd85e91.thirdrailify-admin.pages.dev
Public preview: https://7c9a6f9a.thirdrailify.pages.dev
Screenshots: output/special-products (Admin editor and Public local), output/special-products-preview (Public preview). Logs: C:/Users/TempAdmin/.codex/tmp/special-products-*.log.

Public production: https://8e6fc3cf.thirdrailify.pages.dev (same frozen build as preview). Live stable catalogue verified HTTP 200/no-store with the new safe restriction field, and stable storefront bundle includes the status banner. Initial preview screenshot waits stalled on lazy images below the mobile viewport; the harness now scrolls the card into view before waiting for image decoding.

Final immutable-preview regression passed at all four widths (28.3 seconds). Mobile detail and desktop card screenshots with decoded product artwork were opened and inspected. Admin desktop/mobile editor screenshots were also inspected. No commits or pushes were made.
