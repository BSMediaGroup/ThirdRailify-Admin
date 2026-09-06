# Commerce checkout repair - 2026-09-07

## Proven root cause

Live Admin /api/public/commerce/catalogue returned checkoutEnabled=true, while Public /api/commerce/catalogue returned false. Both responses were no-store. Public functions/_shared/commerce-catalogue-proxy.js hard-coded false in both catalogue and product normalization; CartPage.tsx enabled its link only when checkoutEnabled && !unavailable.length. This was a Public projection defect, not partial activation or stale cache.

The original activation timestamp is 2026-09-06T16:51:00.943Z. All 13 STORE_ACTIVATION_SETTINGS matched; pause was clear, PayPal preferred, Stripe disabled, fulfillment enabled, worldwide Printful rates configured, tax not_collecting, and Resend sending enabled. No live settings require repair.

## Repair authority

The existing Admin-owned catalogue includes checkoutReadiness: lifecycle, pause, enabled state, payment and fulfillment readiness, destination codes, safe blocker codes/messages, and a configuration fingerprint. No credentials, internal provider identifiers, private business data or audit payloads are projected. Public remains a validating proxy without Commerce D1 bindings. Dynamic catalogue/product responses are no-store; other caching is unchanged. Cart rechecks when focused and on route mount.

POST /api/admin/commerce/launch/reconcile requires Master capability, CSRF and exact production origin, current digest/revision, retained current owner attestation, an active unpaused store and ready dependencies. Only drifted STORE_ACTIVATION_SETTINGS are restored. A transactional guard refuses concurrent edits and inconsistent payment-provider state; original activation and provider records remain untouched. Repeated coherent calls return no-op.

Email delivery remains post-order communication, with its existing dispatcher/idempotency history. A configured active store does not lose payment authority due to a recoverable email availability failure. Optional Printful inbound webhook absence remains fail-closed and distinct from authenticated scheduled reconciliation.

## Live pre-release evidence

- Cart HTTP 200; legitimate verified session had an empty device cart and no saved address. The existing device cart was preserved.
- An isolated browser context used the two named products, one medium variant each: product-393307261 / variant-4974991984 and printful-18668025-466945458 / printful-variant-18668025-5484152196. Sizes are controlled acceptance selections, not a claim about the original screenshot sizes.
- Australian unsaved address (AU / NSW / Sydney) produced HTTP 201 from shipping quote authority: CAD 71.50 subtotal, 11.78 flat-rate shipping (alternative 12.03), 83.28 total. This proves serviceability for these two variants and destination at quote time, not every size/destination combination.
- Agreement offer returned HTTP 201 and identical totals; tax not_collecting, amount zero. The offer was not accepted on live production. PayPal configured/live/store enabled, webhook configured, public client identifier present; Stripe configured but disabled.
- No provider create-order/capture, fake order, fulfillment or email send was made. The live probe creates an expiring local quote and unaccepted agreement offer through normal application authority.

## Backup and preservation

Backup: C:/Users/TempAdmin/.codex/tmp/commerce-checkout-repair-20260907/commerce-before.sql; 4,550,082 bytes; 2026-09-06 17:41:44 UTC. Backup import foreign_key_check: zero violations.

Before counts: products 54; variants 1372; collections 6; customers 4; saved addresses 1; orders 3; provider connections 5; settings 46; payment attempts 2; shipping quotes 3; agreement offers 0; Commerce audit 198.

## Validation and release

Production restored and verified up to the enabled PayPal button, without creating a provider transaction.

- Admin final release: f245bb63, https://f245bb63.thirdrailify-admin.pages.dev; stable https://admin.thirdrailify.com. Earlier repair releases d1948da7 and 651dd99a were superseded by the final Customer Sending clarification.
- Public preview: 7f1cf520, https://7f1cf520.thirdrailify.pages.dev. Four-width checkout acceptance passed.
- Public production: 6db2ac3b, https://6db2ac3b.thirdrailify.pages.dev; stable https://thirdrailify.com. Identical frozen Public release promoted without rebuilding; all three routes return HTTP 200 and index-P3OfFsRA.js / index-DFJVWGDX.css. Production upload reused all 49 assets.
- Master-authenticated application reconcile returned HTTP 200, idempotent=true, changedSettings=[], state=active, operationalState=active. Original activation timestamp retained. No manual D1 updates and no activation replay.
- Live Public catalogue returns application/json, no-store, checkoutEnabled=true, checkoutReadiness.state=active. Cart shows the primary gold Proceed to checkout and routes to Checkout.
- Final live Australian quote: shq_32caabc8-0bba-4973-a7e3-26f3c48b7e19; same CAD 71.50 + 11.78 = 83.28. Agreement HTTP 201. Checking the agreement in browser memory enabled the actual PayPal button; the button was never clicked. Both persisted agreement rows remain offered, not accepted. No saved address was created.
- Concurrent operator catalogue changes introduced two excluded sellable flags (85 eligible sellable variants remain). Initial activation still requires the strict catalogue audit. After activation, publication exclusions do not globally disable safe baskets: server-authoritative line validation rejects each excluded item. A focused regression proves valid checkout remains available, hidden items reject, and zero eligible variants disables payment readiness.
- Customer Sending now explicitly says production sending is enabled and automatic after eligible completed purchases/shipment updates. It lists the actual eligible order_confirmation and shipment_notification events and links to Store activation. The obsolete no-test-send/no-production-enable paragraph and misleading preflight readiness row were replaced with current lifecycle facts. Other template lifecycle triggers remain unimplemented; this repair does not claim delivery evidence for them.

### Focused validation

Node 22.16.0; both typecheck/builds passed. Final Admin build also passed after Customer Sending wording. Scoped ESLint and git diff --check passed.

- Admin checkout-readiness + store-activation-agreements: 20 passed before final catalogue regression; final targeted publication exclusions and reconciliation: 2 passed.
- Admin commerce-launch-operations, shipping-checkout, paypal-commerce, customer-emails-control-plane: 19 passed.
- Public storefront-commerce, checkout-foundation, account-commerce, paypal-commerce-proxy: 19 passed; final storefront projection rerun: 10 passed.
- Existing checkout browser: 1 passed across configured widths.
- New commerce-repair browser: 1 passed locally and 1 passed on immutable preview; each covers 390/768/1440/1920 widths, Australian saved-address fixture, shipping, agreement, enabled real PayPal SDK button, and blocked/guest cases. Zero transaction calls and browser errors in those runs.
- Customer emails browser: passed, including final wording build before the final lifecycle-row substitution. The final row was verified visually on live production.
- Admin commerce control browser overview: passed at 390/768/1440/1920. Initial broad control browser run hit a stale unrelated Business Information fixture; scoped affected overview passed after updating the fixture shape.
- Broad lint remains noisy from generated .artifacts: Public generated-file failures and four warnings; Admin one generated worker parse failure and seven warnings. Changed-file lint passed; no claim of clean repository-wide lint.

### Post-release preservation

After export: commerce-after.sql beside the before backup. Foreign-key violations: zero. Products 54, variants 1372, collections 6, customers 4, saved addresses 1, orders 3, provider connections 5, settings 46 and payment attempts 2 remain unchanged. Shipping quotes 3 -> 5 and agreement offers 0 -> 2 reflect the two permitted live read-through checkout probes. Commerce audit 198 -> 212 reflects concurrent catalogue operator activity: one products_bulk_updated, nine product_media_uploaded, one product_media_ingested, two product_updated, one variant_updated. This repair made none of those catalogue mutations. No setting repair was needed.

No real payment, provider create-order, capture, fake order, fulfillment submission, customer email send, migration/schema change, new resource, secret change, provider account change, DNS or custom-domain change. No commit or push. Stripe stays disabled; PayPal remains preferred. Printful fulfillment stays configured; inbound unsigned webhook handling remains fail-closed while authenticated scheduled reconciliation remains the lifecycle authority.

### Evidence inspected

Opened live before/after Cart, live shipping/agreement, final enabled PayPal screenshot, local desktop/mobile checkout views, local Admin panel/email views, and final live Customer Sending card. Screenshots live under Public output/commerce-repair/, output/commerce-repair-preview/, output/commerce-checkout-live-restored.png and output/commerce-checkout-live-payment-ready.png; Admin output/commerce-repair/customer-sending-live.png and output/commerce-repair-local-*.png. Private agreement merchant details are masked in shared evidence screenshots. Full logs, backups and final repository status are in C:/Users/TempAdmin/.codex/tmp/commerce-checkout-repair-20260907/.


### Final repository changes

BUMP_NOTES.md updated in both repositories; Admin COMMERCE_ARCHITECTURE.md and this report updated. No source files removed. The following exact git status lists include repair evidence artifacts; reference repositories were not edited. StreamSuites runtime changes were already present and preserved.

ThirdRailify
```text
M BUMP_NOTES.md
 M functions/_shared/commerce-catalogue-proxy.js
 M src/lib/catalogueProvider.ts
 M src/pages/CartPage.tsx
 M src/pages/CheckoutPage.tsx
 M src/types/catalogue.ts
 M tests/checkout-browser.test.mjs
 M tests/storefront-commerce.test.mjs
?? .playwright-mcp/console-2026-09-06T17-37-17-014Z.log
?? .playwright-mcp/console-2026-09-06T17-37-57-766Z.log
?? .playwright-mcp/console-2026-09-06T17-38-46-893Z.log
?? .playwright-mcp/page-2026-09-06T17-37-19-930Z.yml
?? .playwright-mcp/page-2026-09-06T17-37-58-803Z.yml
?? docs/
?? output/commerce-checkout-before.png
?? output/commerce-checkout-delivery-before.png
?? output/commerce-checkout-live-agreement.png
?? output/commerce-checkout-live-payment-ready.png
?? output/commerce-checkout-live-restored.png
?? output/commerce-checkout-live-shipping.png
?? output/commerce-repair-preview/
?? output/commerce-repair/
?? tests/commerce-repair-browser.test.mjs
```

ThirdRailify-Admin
```text
M BUMP_NOTES.md
 M COMMERCE_ARCHITECTURE.md
 M functions/_shared/commerce-launch.js
 M functions/_shared/paypal-commerce.js
 M functions/_shared/public-catalogue.js
 M functions/api/admin/commerce/[[path]].js
 M functions/api/public/commerce/products/[slug].js
 M src/commerce/StoreLaunchWorkspace.tsx
 M src/commerce/client.ts
 M src/pages/CommercePages.tsx
 M src/pages/CustomerEmailsPage.tsx
 M tests/commerce-control-browser.test.mjs
 M tests/store-activation-agreements.test.mjs
?? docs/COMMERCE_CHECKOUT_REPAIR.md
?? functions/_shared/checkout-readiness.js
?? output/commerce-repair-local-1440.png
?? output/commerce-repair-local-1920.png
?? output/commerce-repair-local-390.png
?? output/commerce-repair-local-emails.png
?? output/commerce-repair-local-panel.png
?? output/commerce-repair/
?? tests/checkout-readiness.test.mjs
```

StreamSuites-Public
```text
M runtime/exports/audit/audit.json
 M runtime/exports/auth_events.json
 M runtime/exports/errors.json
 M runtime/exports/events.json
 M runtime/exports/live_status.json
 M runtime/exports/rates.json
 M runtime/exports/rumble_live_discovery.json
 M runtime/exports/runtime_snapshot.json
 M runtime/exports/status.json
 M runtime/exports/users/users.json
 M runtime/exports/wheels.json
 M shared/state/clips.json
 M shared/state/live_status.json
 M shared/state/quotas.json
 M shared/state/rumble_live_discovery.json
 M shared/state/runtime_snapshot.json
 M shared/state/wheels.json
```

StreamSuites-Dashboard
```text
M docs/runtime/exports/live_status.json
 M docs/runtime/exports/rumble_live_discovery.json
 M docs/runtime/exports/runtime_snapshot.json
 M docs/runtime/exports/wheels.json
 M docs/shared/state/clips.json
 M docs/shared/state/quotas.json
 M docs/shared/state/runtime_snapshot.json
?? docs/runtime/exports/audit/
?? docs/runtime/exports/auth_events.json
?? docs/runtime/exports/errors.json
?? docs/runtime/exports/events.json
?? docs/runtime/exports/rates.json
?? docs/runtime/exports/status.json
?? docs/runtime/exports/users/
```

DanielClancy
```text
clean
```

DanielClancy-Admin
```text
clean
```
