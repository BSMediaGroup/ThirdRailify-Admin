# Production fulfillment completion — 7 September 2026

Production is **READY / ACTIVE**. Printful V2 signed delivery is verified, the subscription is active, and authenticated reconciliation remains the backstop. Tracking is awaiting the first real shipment. No real transaction or fulfillment confirmation was performed.

## Completion record

| # | Requirement | Result |
|---|---|---|
| 1 | Production blocked root cause | The fulfillment page hardcoded a blocked hero, recognized only the TEST `draft_only` mode, treated excluded catalogue entries as global blockers, and applied submission requirements to a synthetic structural preview. These contradicted the already active canonical store. |
| 2 | Order mode disabled source | `functions/_shared/commerce-control-plane.js` projected the valid production `draft_then_confirm` value as disabled. The established launch settings and LIVE worker already used that value. |
| 3 | Setting repaired | No live order-mode setting needed changing: `printful_order_mode=draft_then_confirm` was correct. The projection was repaired, and protected active-store reconciliation now repairs derived provider `order_mode` metadata if it drifts. Two live reconciliation requests returned idempotent success with `changedSettings=[]`. |
| 4 | Draft → Confirm authority | Preserved the production enum `draft_then_confirm`, the repository equivalent of create draft first and confirm separately. The worker requires paid LIVE merchandise, matching completed PayPal capture ID/amount/currency, an accepted shipping quote, exact recipient and items, enabled fulfillment, and a clear pause. It refreshes paid/pause authority immediately before confirm. `draft_only` remains TEST-only. |
| 5 | Weight 0/87 cause | This is incomplete local merchant weight-band ratebook coverage, not missing Printful shipping authority. No fabricated weights were inserted. |
| 6 | Dynamic weight requirement | Printful Dynamic does not consume local merchant weight values. It uses recipient, mapped provider variant, quantity and currency. |
| 7 | Final weight semantics | The UI identifies merchant weight coverage separately and explains that local weights are not required for the active dynamic strategy. Merchant ratebook publication still validates its own weight requirements. |
| 8 | Shipping method handoff | The accepted quote supplies the provider method to draft creation. A focused mocked LIVE pipeline proved draft creation, validated confirmation, no unpaid call, late-pause blocking, and no duplicate confirmation on replay. Only the explicitly synthetic structural preview may defer a method; real orders cannot. |
| 9 | Receiver | `https://admin.thirdrailify.com/api/webhooks/printful` |
| 10 | API version | Printful V2 webhooks and V2 disposable draft smoke. The existing production V1 Sync Variant order adapter remains in use. |
| 11 | Subscribed events | `order_created`, `order_updated`, `order_failed`, `order_canceled`, `order_put_hold`, `order_put_hold_approval`, `order_remove_hold`, `order_refunded`, `shipment_sent`, `shipment_delivered`, `shipment_returned`, `shipment_canceled`. |
| 12 | Signature | HMAC-SHA256 using the hexadecimal-decoded secret. |
| 13 | Secret custody | Encrypted Cloudflare Pages binding `PRINTFUL_WEBHOOK_V2_SECRET_HEX`. Signing material passed directly in process to encrypted secret storage; no secret values are in this report or application projections. |
| 14 | Public key | `x-pf-webhook-public-key` must match `PRINTFUL_WEBHOOK_V2_PUBLIC_KEY`. Provider configuration readback also verifies this identity. |
| 15 | Raw body | Verify exact bounded request bytes before JSON parsing. Whitespace/reserialization, modified bodies, wrong signatures, missing/wrong public keys and wrong store fail closed. |
| 16 | Subscription | Rotated successfully with event delivery temporarily disabled until the deployed receiver passed signature verification. Then enabled all 12 events. No expiration configured. |
| 17 | Provider GET | Verified stable receiver URL, exact event set, no expiration and matching public key. Master-only reconciliation persisted safe configuration evidence and showed subscription active, custody ready and verifier ready. |
| 18 | Signed smoke | Three real provider deliveries verified: `order_created` and `order_updated` at `2026-09-06T19:32:47.000Z`, then `order_updated` at `19:32:49.000Z`. Each retained as unresolved with `printful_local_order_not_found`, retries 0, because the disposable reference intentionally has no customer order. This is verified delivery, not a processed customer fulfillment. |
| 19 | Disposable draft | The single actually created draft was `175326850`. Reference SHA256: `9e6048ee82cef1529cc12614f3027e90f346940bb2f108581e69fb2873923436`. Two earlier create requests were rejected for external-reference length; both produced no draft. The script now validates the 32-character maximum before mutation. |
| 20 | No confirm/charge | Draft `175326850` was never confirmed or charged. The smoke helper has no confirm call. |
| 21 | Cleanup | DELETE returned 204, subsequent GET returned 404. Provider order count remained 1 before/after. Existing draft `174104132` was preserved. |
| 22 | Idempotency | Focused tests passed terminal duplicate suppression and retryable failure behavior. Concurrent in-progress delivery returns retryable 503. Mocked paid-order replay never confirmed twice. No artificial live replay was needed. |
| 23 | Reconciliation | Existing five-minute cron and authenticated heartbeat verified; heartbeat setting updated at `2026-09-06T19:30:06.928Z`. Fixed the Admin reconciliation bucket from hourly to five-minute intervals. The existing worker calls the deployed Admin handler, so no separate worker deployment was required. |
| 24 | Tracking | `awaiting_first_shipment`; encrypted tracking storage and normalization ready. Zero real shipments is not an activation blocker. |
| 25 | Catalogue | Partial catalogue: 311 mapped variants, 90 currently eligible variants. Excluded items remain excluded; they do not prevent eligible items from checking out. |
| 26 | Production result | Live production ready; provider configured; payment ready; fulfillment enabled; dynamic shipping active; structural preview eligible with no blockers. Original activation timestamp `2026-09-06T16:51:00.943Z` and revision 2 preserved. |
| 27 | Customer Sending | Live payload ready, customer sends enabled, delivery active with no blockers; order-confirmation and shipment-notification templates eligible. Focused regression tests passed. No customer email sent. |
| 28 | Checkout regression | Shipping and checkout regression suite passed; live public configuration reports active, checkout/payment/fulfillment ready and PayPal selected. |
| 29 | Files | 16 existing files changed and 6 new files, listed below. No source files removed. No Public source edits by this task. |
| 30 | Documentation | Updated Admin BUMP notes, architecture, README and V2 webhook support; added fulfillment operations runbook and this completion record. |
| 31 | Backup | `X:\GIT\ThirdRailify-Admin\.artifacts\fulfillment-20260907\commerce-before.sql`, 4,838,650 bytes. Contains private production data: keep local and out of Git. |
| 32 | Counts | Safe before/after counts below; only the three expected webhook receipt rows increased among the recorded counts. Foreign-key check empty before/after. |
| 33 | Tests | Focused outcomes and artifact filenames below. Failed fixtures were corrected and only affected tests rerun; passed suites were not repeatedly rerun. |
| 34 | Admin deployments | Receiver/intermediate: `ef7a40a2-0940-4c3d-a4d6-bfc09186ee54`. Final: `3bfff7d3-5009-43f7-aed4-f05684bc838a`, production `main`, base source `39920c3` plus scoped working-tree changes. The final deployment only corrects one misencoded apostrophe in UI copy. |
| 35 | Live Admin | Authenticated Master acceptance at `/commerce/fulfillment`: coherent ready state, active webhook configuration, verified signed delivery, active reconciliation. Missing-CSRF mutation rejected with 403 `csrf_required`. Stable origin serves the final bundle `/assets/index-D47JVKNQ.js` with HTTP 200 and corrected copy. |
| 36 | Public deployment | Not required and not performed. |
| 37 | Live Checkout | Eligible cart rendered at `https://thirdrailify.com/checkout` at 1440 and 390 pixels, no horizontal overflow. Public payment-config GET returned 200 and PayPal. Browser blocked any commerce mutation; none were attempted. Stopped before shipping-quote submission or PayPal order creation, so no live payment execution is claimed. |
| 38 | Screenshots | Inspected live Admin hero at 390 and 1440 pixels, webhook panel, and populated Public Checkout at 390 and 1440. Admin geometry also checked at 768; fixture browser coverage passed 390/768/1440. Screenshot artifacts listed below. |
| 39 | Six repos | Final preservation snapshot below. No commit, push, reset, stash or cleanup of concurrent work. |
| 40 | Mutation boundaries | No real payment, local customer order, fulfillment confirmation, customer email, migration/schema change, new D1/R2 resource, provider-account setting, DNS or custom-domain change. Authorized webhook configuration/key rotation, secret bindings, Admin deployments and one disposable draft create/delete were the provider/platform mutations. PayPal authority preserved, Stripe disabled. Polls/Wheels/GOATS/Watch source untouched. |

## Safe counts

| Metric | Before | After |
|---|---:|---:|
| Products | 54 | 54 |
| Product variants | 1372 | 1372 |
| Collections | 6 | 6 |
| Customers | 4 | 4 |
| Saved addresses | 1 | 1 |
| Orders, all TEST | 3 | 3 |
| LIVE orders | 0 | 0 |
| Local fulfillment orders | 1 | 1 |
| Fulfillment shipments | 0 | 0 |
| Payment attempts | 2 | 2 |
| Provider connections | 5 | 5 |
| Settings | 46 | 46 |
| Printful webhook events | 0 | 3 |
| Email deliveries | 0 | 0 |
| Tracking rows | 0 | 0 |
| Fulfillment audit rows | 2 | 2 |

## Focused validation

- `regression-tests.txt`: **36/36 passed**, serial Node tests across `printful-webhook`, `printful-webhook-configuration`, `printful-webhook-rotation`, `printful-fulfillment`, `shipping-checkout`, `customer-emails-control-plane`, and `commerce-launch-operations`.
- `readiness-tests.txt`: initially **17/20 passed**. Three fixture failures were corrected: migration fixture now includes later required schema; readiness fixture inserts the required setting; paid LIVE pipeline fixture uses the correct quote environment, mock token and valid job ID.
- `repaired-tests.txt`: **2/3 passed**; `pipeline-tests.txt`: final remaining pipeline test **1/1 passed**. All three initially failing cases therefore have passing targeted outcomes; the full 20-case matrix was not repeated.
- `browser-tests.txt`: fulfillment browser test **1/1 passed**, 390/768/1440 pixels.
- TypeScript/Vite build and scoped ESLint passed. Final text-correction rebuild completed successfully (`build-final-encoding.txt`); PowerShell classified Vite's ordinary large-chunk stderr warning as a native-command warning, while Vite reported a completed build. No functional suites rerun for punctuation.
- Changed-file UTF-8 scan and known local credential-value scan passed. `git diff --check` passed.
- `public-readonly.json`: active public readiness, payment config 200, no desktop/mobile overflow, no attempted commerce writes.

Evidence directory: `.artifacts/fulfillment-20260907/` (ignored). Key files: `counts-before.json`, `counts-after.json`, `rotation.txt`, `smoke-final.txt`, `deployments-final.json`, `live-hero-390.png`, `live-hero-768.png`, `live-hero-1440.png`, `live-webhooks.png`, `public-checkout-390.png`, `public-checkout-1440.png`.

## Files and repository preservation

Changed Admin files:

- `BUMP_NOTES.md`, `COMMERCE_ARCHITECTURE.md`, `README.md`, `docs/PRINTFUL_V2_WEBHOOK_SUPPORT.md`
- `functions/_shared/commerce-control-plane.js`, `commerce-launch.js`, `commerce-operations.js`, `printful-fulfillment.js`, `shipping-ratebook.js`
- `functions/api/admin/commerce/[[path]].js`
- `src/commerce/ShippingRatesWorkspace.tsx`, `src/commerce/client.ts`, `src/pages/FulfillmentShippingPage.tsx`
- `tests/fulfillment-control-plane.test.mjs`, `tests/printful-webhook.test.mjs`, `tests/store-activation-agreements.test.mjs`

New Admin files:

- `docs/PRINTFUL_FULFILLMENT_OPERATIONS.md`
- `docs/PRODUCTION_FULFILLMENT_20260907.md`
- `functions/_shared/printful-webhook-configuration.js`
- `scripts/rotate-printful-v2-webhook.mjs`
- `scripts/verify-printful-draft-webhook.mjs`
- `tests/printful-webhook-rotation.test.mjs`

| Repository | Final status |
|---|---|
| ThirdRailify-Admin | 16 modified + 6 untracked scoped task files above; no commits/pushes. |
| ThirdRailify | Concurrent changes preserved: BUMP_NOTES, README, ShopPage, shop-v2 browser test; untracked ShopHero component, shop-hero stylesheet/test, and browser console artifact. No task source changes or deployment. |
| StreamSuites-Public | 17 existing/concurrent modified runtime-export and shared-state files; untouched. |
| StreamSuites-Dashboard | 7 modified runtime-export/shared-state files and 7 untracked export paths; untouched. |
| DanielClancy | Clean; untouched. |
| DanielClancy-Admin | Clean; untouched. |

THIRD-RAIL-BOT was not modified. Detailed operational contracts and recovery instructions are in [PRINTFUL_FULFILLMENT_OPERATIONS.md](PRINTFUL_FULFILLMENT_OPERATIONS.md).
