# Wix commerce audit

Audit date: 2026-08-27 (Australia/Sydney)

This is a non-mutating public-store audit of `https://www.thirdrailify.com`. No Wix dashboard was opened, no provider was changed, and no product, order, setting, or integration was written. The public DOM cannot prove private provider configuration.

## Fresh public evidence

- `/shop` rendered `Shop | Third Railify Official™`, product cards, Add to Cart links, category/filter controls, an excluding-sales-tax notice, and a visible price range of CA$6–CA$131.
- The loaded DOM exposed 38 unique product slugs. This is a rendered sample, not a complete catalogue count or a migration source of truth.
- Fresh visible filters included All, Apparel, Third Rail Lore, Accessories & Other, Just Gina™ Branded, and Third Railify™ Branded.
- `/cart-page` and `/product-page/:slug` routes remain present.
- `/gift` offered a Third Railify gift card at CA$15, CA$25, CA$50, CA$100, CA$150, CA$250, or Other, with recipient fields, scheduled delivery, message, a never-expires statement, and Buy Now.
- `/donate-1` offered one-time, monthly, or yearly CAD donations at CA$5, CA$10, CA$25, CA$50, CA$100, CA$150, CA$250, CA$500, or Other.
- `/vip` required login during the fresh audit. Current plan names, prices, and benefits were therefore not publicly verified.
- No public page text identified Printful or Printify. Their private Wix connection state cannot be established from the public storefront.

### Fresh products with visible prices

| Product | CAD price | Wix slug |
| --- | ---: | --- |
| WTF GINA? men's T-shirt | CA$47.50 | `wtf-gina-men-s-t-shirt` |
| my balloon \| Cotton Heritage MC1082 I Men's Premium Short Sleeve Tee | CA$37.00 | `my-balloon-cotton-heritage-mc1082-i-men-s-premium-short-sleeve-tee` |
| silly goose (Canada) \| Cotton Heritage MC1082 I Men's Premium Short Sleeve Tee | CA$37.50 | `silly-goose-canada-cotton-heritage-mc1082-i-men-s-premium-short-sleeve-tee` |
| fuc yeh (US) \| Cotton Heritage MC1082 I Men's Premium Short Sleeve Tee | CA$37.50 | `fuc-yeh-us-cotton-heritage-mc1082-i-men-s-premium-short-sleeve-tee` |
| King Tully black glossy mug | CA$16.50 | `king-tully-black-glossy-mug` |
| Unisex bomber jacket | CA$89.50 | `unisex-bomber-jacket` |
| Embroidered Champion packable jacket | CA$79.00 | `embroidered-champion-packable-jacket` |
| Unisex Champion tie-dye hoodie | CA$130.50 | `unisex-champion-tie-dye-hoodie` |
| Hot Dog Denial unisex classic tee | CA$30.00 | `hot-dog-denial-unisex-classic-tee` |
| Hot Dog Denial black glossy mug | CA$16.50 | `hot-dog-denial-black-glossy-mug` |
| Sandwich Activist black glossy mug | CA$16.50 | `sandwich-activist-black-glossy-mug` |
| Finger Licking Good black glossy mug | CA$16.50 | `finger-licking-good-black-glossy-mug` |
| Sandwich Activist unisex classic tee | CA$33.50 | `sandwich-activist-unisex-classic-tee` |
| Geenar Says Whaaat throw blanket | CA$44.00 | `geenar-says-whaaat-throw-blanket` |
| Geenar Says Whaaat can cooler | CA$7.50 | `geenar-says-whaaaat-can-cooler` |
| Smash Me I'm Ripe can cooler | CA$7.50 | `smash-me-i-m-ripe-can-cooler` |
| Jiggle Physics can cooler | CA$6.50 | `jiggle-physics-can-cooler` |
| Mothbaby baby short sleeve one-piece | CA$36.50 | `mothbaby-baby-short-sleeve-one-piece` |
| Mothbaby toddler short sleeve tee | CA$31.00 | `mothbaby-toddler-short-sleeve-tee` |
| Mothbaby unisex classic tee | CA$32.50 | `mothbaby-unisex-classic-tee` |
| Baby Moth women's micro-rib raglan baby tee | CA$35.50 | `baby-moth-women-s-micro-rib-raglan-baby-tee` |
| Jiggle Physics black glossy mug | CA$15.00 | `jiggle-physics-black-glossy-mug` |
| Jiggle Physics men's box hoodie | CA$70.00 | `jiggle-physics-men-s-box-hoodie` |
| Jiggle Physics unisex classic tee | CA$32.50 | `jiggle-physics-unisex-classic-tee` |

The rendered DOM also exposed these slugs without a price in the loaded product-card subset: `smash-me-i-m-ripe-unisex-classic-tee`, `third-railify-throw-blanket`, `third-railify-wordmark-structured-twill-cap`, `third-rail-farm-black-glossy-mug`, `third-railify-icon-black-glossy-mug`, `third-railify-wordmark-black-glossy-mug`, `bleh-unisex-classic-tee`, `third-railify-icon-dad-hat`, `third-railify-logo-v2-unisex-classic-tee`, `third-railify-logo-short-sleeve-t-shirt`, `just-gina-icon-basic-short-sleeve-t-shirt`, `just-gina-icon-classic-unisex-tee`, `just-gina-wordmark-basic-dad-hat`, and `third-rail-wordmark-basic-dad-hat`.

## Existing repository evidence

The read-only Public repository carries a provider-neutral catalogue adapter and a bounded Wix snapshot dated 2026-08-11. Its audit reported 49 products but intentionally captured only eight verified CAD records. It also recorded 13 historical Wix collection labels: All Products, Aboot Nothing, Accessories & Other, Apparel, Christmas Shit, For Patriots, Just Gina Lore, Just Gina™ Branded, Pop Culture Beat Down, Sportswear, Third Rail Lore, Third Railify™ Branded, and Underwear.

That source snapshot remains a historical migration input. It does not establish current inventory, availability, product-provider ownership, shipping, tax, or checkout behavior. Public currently keeps its local cart and checkout disabled.

## User-confirmed private facts

The site owner confirms the live Wix commerce stack currently includes Wix Payments, cards, Apple Pay, Google Pay, PayPal, and Printful integration, with Printify possible only where later verified. These are private-dashboard facts supplied for planning; the public audit did not independently verify them. They must remain active and untouched until an explicitly authorized cutover.

## Routes and continuity requirements

Preserve the live/public routes and aliases `/shop`, `/cart-page`, `/product-page/:slug`, `/gift`, `/donate-1`, `/vip`, `/pricing-plans/list`, and the site's policy destinations. A future migration must preserve product slugs or provide deliberate redirects, and must separately reconcile catalogue, gift-card, donation, VIP, policy, tax, shipping, and customer-history behavior.

## Unresolved facts

- Authoritative current product/variant/SKU count, collection membership, descriptions, compare-at prices, inventory, shipping profiles, and tax configuration.
- Which products are fulfilled by Printful, Printify, another provider, or manually.
- Current Printful store identifier and whether any Printify connection actually exists.
- Current Wix Payments/PayPal configuration, wallet-domain registration, payout state, and order-history export requirements.
- Current VIP plans/benefits after the login gate, gift-card liability/transfer rules, donation receipts, refund/cancellation/shipping policies, and any subscriptions.
- Exact URL redirect and SEO requirements for every product and commerce page.

Until those facts are verified through an authorized export/dashboard review, Wix remains the production commerce authority.
