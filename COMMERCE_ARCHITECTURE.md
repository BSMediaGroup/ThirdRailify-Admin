# Commerce architecture

## Customer identity and order history

An Account is authentication authority; a Customer is commerce relationship authority. Accounts own login providers, credentials, roles, state, sessions, display name, avatar, and verified email. `commerce_customers` owns only the protected guest/account customer relationship and current encrypted checkout contact identity. Accounts without purchases have no Customer. Guest purchasers remain Customers with no Account linkage. Authenticated checkout resolves the real session server-side and creates or reuses the one Customer linked to that Account; browser-supplied account or Customer IDs are rejected.

Exact guest email reuse uses a keyed fingerprint plus the existing AES-GCM contact encryption. It never links or merges a Guest Customer into an Account merely because email text matches. Admin list/detail reads require `commerce.view`, aggregate orders in SQL, correlate Accounts in bounded batches across the existing D1 authorities, and never return encryption envelopes, fingerprints, credential material, or session tokens.

`commerce_orders.customer_id` is nullable for legacy evidence and restrictive for linked history. Every new normal checkout persists Customer linkage in the same D1 batch as the order, but the encrypted order delivery snapshot also retains the checkout-time contact. Current Customer or Account changes therefore do not rewrite historical order truth. TEST and LIVE counts and integer CAD aggregates remain separate. This migration is local-only until a separately authorized remote apply.

## Replacement catalogue read path

```text
Admin Commerce D1 -> /api/public/commerce/catalogue
                  -> /api/public/commerce/products/:slug
                  -> Public same-origin Pages Function proxy
                  -> replacement shop UI and local variant-aware cart
```

Commerce D1 owns replacement product and variant identities, integer CAD prices, public presentation, and readiness state. Public owns no Commerce D1 binding and receives only local IDs plus sanitized merchandising fields. Browser totals are display values; the checkout server revalidates product/variant association, state, quantity, currency, and exact D1 price.

Displayability is deliberately separate from checkout and fulfillment readiness. The 49 accepted current-Wix products may be public while their Printful migration is paused or incomplete. The preserved target-native My Balloon product remains private. Normal checkout, live payment capture, and fulfillment submission stay disabled; the completed Master-only Stripe TEST acceptance gate is closed and does not imply customer cutover. Wix remains production until explicit cutover.

## Milestone posture

This repository contains the Admin-only control-plane foundation for a future Stripe-first Canadian commerce stack. It is a staging scaffold, not an activated payment or fulfillment system.

| Area | Current state |
| --- | --- |
| Commerce environment | `staging` |
| Dedicated Stripe account | created; operator-confirmed |
| Stripe integration mode | `direct_merchant` |
| Stripe API connection | connected after successful Canadian CAD account verification |
| Stripe webhook endpoint | operational at `POST /api/webhooks/stripe`; one signed sandbox event accepted |
| Stripe webhook signing | configured and verified by a valid signed sandbox Event |
| Stripe environment | `test`; production readiness not established |
| Normal checkout | `disabled` |
| Controlled acceptance checkout | passed once, then closed; no candidate selectors remain |
| Live payment capture | `disabled` |
| Live payout readiness | not verified |
| Fulfillment submission | `disabled` |
| Printful API connection | verified native `Third Railify API` store `18668025`; provider writes disabled |
| PayPal | `deferred` |
| Printify | `unavailable`; credential custody undecided |
| Wix | `legacy production`; remains authoritative and untouched |

The separate Admin-only commerce D1 is bound, and its encryption key plus Stripe TEST API/webhook credentials remain encrypted Cloudflare Secrets. The 50-product/1,323-variant replacement catalogue is authoritative. `checkout_enabled=false` keeps normal checkout closed; `stripe_test_checkout_enabled=false` now permanently closes the completed temporary acceptance path. Live payments, tax, shipping calculation, fulfillment, refunds, payouts, and production merchant readiness remain outside this milestone.

## Checkout and shipping foundation

Migration `0015_checkout_shipping_foundation.sql` adds two narrow authorities without changing an activation gate. `commerce_shipping_quotes` stores an opaque quote ID, TEST/LIVE environment, SHA-256 cart and canonical-recipient fingerprints, CAD currency, strategy/provider, safe normalized rate options, and Third Railify's bounded local expiry; it stores no recipient plaintext. `commerce_order_delivery_snapshots` stores one restrictive historical snapshot per order: the existing purpose-bound AES-256-GCM recipient envelope, safe destination country/region, selected method/provider, integer CAD shipping amount, and source quote.

Public intentionally requests rates after completing delivery details. It sends only local product/variant IDs, quantity, and the bounded recipient form. Admin re-resolves sellability, exact integer CAD prices, physical-product semantics, Printful mapping, and the distinct Printful Catalog variant ID used by the stable V1 shipping-rate endpoint. The Sync Variant ID remains the future order-item identifier. Provider tokens, provider IDs, raw responses, and authoritative amounts never enter the browser projection.

A selected quote can be used only while its opaque ID is locally fresh and its stored environment, CAD currency, recomputed cart fingerprint, recomputed recipient fingerprint, and opaque option ID all match. The stored rate amount—not a browser field—is added to the authoritative line subtotal. The local order, immutable items, and encrypted delivery snapshot are written before the Stripe boundary. Stripe receives a server-built fixed-amount shipping option, and its returned total must equal the local order total. Recipient PII is absent from Stripe metadata. Signed Stripe webhooks remain the only payment-confirmation authority.

The Printful shipping adapter is implemented but `shipping_strategy` remains `unconfigured`; it fails before fetch in the current canonical state. Normal checkout, the completed controlled TEST gate, live payment capture, fulfillment submission, confirmation, and customer email sending remain disabled. The normalized provider-order, shipment, item-coverage, return/reshipment, encrypted-tracking, and signed-webhook receiver capabilities exist without current production evidence. `prepareStoredPrintfulDraftOrder` can decrypt a protected order snapshot and construct an internal non-network draft representation; the fulfillment gate still makes submission impossible.

## Pre-cutover Stripe TEST acceptance

`POST /api/admin/commerce/test-checkout` requires the existing Admin exact-origin session, Master role, CSRF proof, D1-backed route rate limit, checkout-core rate limit, and the dedicated test gate. It calls the same `createStripeCheckoutSession` core as normal checkout. The only special authority is passage through the pre-cutover gate; D1 product/variant association, active/public state, integer CAD amount, quantity, target-verified mapped state, immutable order-item snapshot, Stripe response validation, deterministic idempotency, and webhook linkage are unchanged.

The accepted candidate was `product-397267935` / `variant-5019554081`: **Third Rail Farm | Black Glossy Mug**, slug `third-rail-farm-black-glossy-mug`, variant **11 oz / Black**, CAD 15.00. Order `ord_e47b94a4-4252-438b-8ca7-c47470029940` and Session `cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC` remain immutable acceptance evidence. After the signed payment transition, the gate was set false, its selectors were removed, the variant returned to `is_sellable=0`, and only its acceptance-only metadata markers were removed. The historical status lookup is deliberately independent of the gate.

Stripe receives `mode=payment`, quantity one, inline server-generated `price_data[currency]=cad`, and the D1 unit amount. No `Stripe-Account` header or Stripe Product/Price duplication is used. Metadata contains only local order/request correlation and a cart digest. Success returns to `/checkout/success?session_id={CHECKOUT_SESSION_ID}`; Public polls its same-origin proxy to an exact opaque-Session local status lookup. The redirect is never payment authority: only the signed `checkout.session.completed` handler can move `pending` to `paid`, and fulfillment remains disabled afterward.

## Authoritative payment flow

```text
Customer
  ↓
Third Railify Public shop
  ↓
Admin-authoritative server endpoint
  ↓
Stripe Checkout Session created with Third Railify Official's own secret key
  ↓
Stripe-hosted Checkout
  ↓
Payment owned by the Third Railify Official Stripe account
  ↓
Stripe webhook
  ↓
Authoritative commerce order/payment state
  ↓
Later Printful draft order
  ↓
Later explicit Printful confirmation safety gate
```

### Merchant of record

Third Railify Official is the merchant of record through its dedicated Canadian Stripe account. That account owns its customers, Checkout Sessions, PaymentIntents, charges, refunds, disputes, balance, payouts, payment-method configuration, verification, payout-bank configuration, and Stripe team access.

### Technical custody

Daniel may manage the dedicated account's API keys and webhooks because he is its owner and technical operator. This technical custody does not redirect payments into Brainstream Media Group or any other project.

### Payment model

- Ordinary charges belong directly to the dedicated Third Railify Official merchant account.
- The Admin server creates Checkout Sessions with `mode=payment` and inline server-derived CAD `price_data`; Stripe Product/Price catalogue duplication is not required.
- The first approved customer surface is Stripe-hosted Checkout. The application redirects to the server-returned Checkout Session URL; Public does not need Stripe.js merely to perform that redirect.
- Cards are primary. Apple Pay and Google Pay may appear only when eligible and enabled for the account, Checkout, browser/device, customer, domain, and currency.
- Link is optional and must remain absent unless separately approved and enabled.
- Third Railify never collects or stores raw card details.
- There is no application fee, connected account, transfer destination, inter-account transfer, or platform-versus-merchant accounting layer.

## Stripe Dashboard boundary

Authorized Stripe account administrators manage Canadian business verification, representative and owner details, payout banking, tax details, payment-method configuration, and account team access directly in Stripe Dashboard. Third Railify Admin does not reproduce Stripe KYC, identity-document, bank, or team-management forms.

The dedicated account's creation and Sandbox/test access are operator-confirmed. Live verification, live charges, live payouts, payout-bank readiness, Stripe Tax, wallets, live webhooks, and live Cloudflare credentials remain unverified.

## Data authority

Authentication remains in the existing auth D1. Commerce state belongs in the separate `thirdrailify-commerce` D1 (`3dd23a7e-7c64-49cb-a52c-c1540b41db1c`), bound only to Admin as `THIRDRAILIFY_COMMERCE_DB`. Schema authority is the ordered additive `commerce-migrations` sequence through `0018_printful_fulfillment_lifecycle.sql`; applied migrations are never edited.

Entities:

- `commerce_business_profiles`: confirmed public defaults plus encrypted private legal/address data.
- `commerce_tax_registrations`: encrypted identifiers and safe masked/status metadata; no custom tax engine.
- `commerce_provider_connections`: provider, canonical integration mode, environment, safe status metadata, and credential-custody mode.
- `commerce_templates`: bounded structured email/document content with no scripts or executable HTML.
- `commerce_settings`: safe activation gates and environment posture.
- `commerce_permission_grants`: capability grants to existing Admin accounts.
- `commerce_products`: checkout authority for active/public/test visibility, canonical name, integer CAD unit amount, quantity cap, and physical-shipping marker. Remote product count remains zero until the separately approved authoritative import/sync milestone.
- `commerce_orders`: opaque local order, unique checkout request/digests, TEST environment, authoritative expected integer amount, bounded Checkout/payment/fulfillment states, Stripe Session/PaymentIntent references, and lifecycle timestamps. Customer-payment and later Printful cost/refund fields stay separate.
- `commerce_order_items`: immutable normalized product ID/name/CAD unit amount/quantity/line total/shipping-required snapshots; later product edits do not rewrite what was purchased.
- `commerce_shipping_quotes`: short-lived opaque, fingerprint-bound, CAD rate authority with no customer plaintext.
- `commerce_order_delivery_snapshots`: one encrypted recipient and selected shipping-method/amount history per order, never projected in catalogue or order-list APIs.
- `commerce_fulfillment_orders` and `commerce_fulfillment_order_items`: normalized Printful order state and restrictive local-to-provider item correlation, separate from payment and legacy order fields.
- `commerce_fulfillment_shipments` and `commerce_fulfillment_shipment_items`: package lifecycle, partial item coverage, reshipment relationships, returns, delivery evidence, and purpose-bound encrypted tracking references/URLs.
- `commerce_provider_webhook_events`: bounded signed Printful event evidence and digest idempotency without raw payload, signature, address, customer, or tracking plaintext.
- `commerce_audit`: redacted mutation history.
- `commerce_webhook_events`: one safe receipt per provider plus provider Event ID, with bounded event/object/status metadata and a raw-payload SHA-256 only. It has no raw payload, signature, secret, credential, customer, address, card, or full-object column.

The canonical configuration flags are evidence records, not secret-presence probes. `stripe_api_configured` becomes true only in the same successful write batch as a server-side `GET /v1/account` result that normalizes to `country=CA` and `default_currency=cad`. `stripe_webhook_configured` and provider `webhook_configured` become true only in the same duplicate-safe receipt batch as a valid `v1` signature, in-tolerance timestamp, valid Stripe Event envelope, and `livemode=false` event. `printful_api_configured` becomes true only after the store-scoped credential exposes exactly one intended native store and its read-only product probe succeeds. These flags never alter Checkout, live-payment capture, payout readiness, or fulfillment gates.

The Stripe provider row stores only safe, verified values: environment, `direct_merchant`, Stripe account ID retrieved through the API, country, default currency, account/business display name, test charges/payouts/details-submitted flags, account type, last verification time, webhook status, and the existing bounded payment-method summary. It must not store API keys, webhook signing secrets, payout-bank data, card data, identity documents, full private Stripe responses, tax IDs, individual/representative details, or team-member email addresses.

Staging verification is `POST /api/admin/commerce/stripe/verify`, protected by the existing Admin session, exact origin, `commerce.payments.manage`/Master authority, CSRF, rate limit, and audit boundaries. It reads `STRIPE_SECRET_KEY` only in the server runtime and performs exactly `GET https://api.stripe.com/v1/account` in the direct merchant context without `Stripe-Account`. Restricted `rk_test_...` is the intended credential; `sk_test_...` remains compatible. All live credential forms fail closed. A successful response must normalize to `country=CA` and `default_currency=cad`; connection status means only “Test API connected.”

## External Stripe webhook boundary

`POST /api/webhooks/stripe` is an external machine-to-machine Pages Function. It does not require or inspect an Admin session, CSRF token, Turnstile token, Origin header, CORS state, or commerce capability. Non-POST methods return `405`.

The route reads at most 1 MiB of request bytes once and verifies the exact bytes before parsing JSON. `Stripe-Signature` must contain exactly one numeric `t` value and at least one well-formed `v1` value; `v0` and unknown schemes are ignored. The signed input is the ASCII timestamp, a period, then the untouched request bytes. The complete `whsec_...` value is the UTF-8 HMAC-SHA256 key and is never Base64-decoded. Web Crypto verification safely supports multiple `v1` values during rotation. Timestamps older than 300 seconds or more than 300 seconds in the future fail closed.

Only a sane `object=event`, `livemode=false` Stripe envelope can reach D1. The explicit allowlist contains only `checkout.session.completed`. It never creates an order: metadata/client reference and persisted Session ID must resolve to the same existing TEST order, and mode, CAD currency, authoritative expected amount, Stripe paid status, and checkout state must all agree before the single `pending` to `paid` transition. Unknown, unlinked, mismatched, unpaid, or live Sessions are bounded `accepted_noop` results. Other signed test event types are ignored. `INSERT OR IGNORE` plus the ledger's composite key makes duplicate provider/Event IDs successful no-ops and the order update also requires `payment_status=pending`, so replay cannot double-transition. The accepted payment event is `evt_1U9OysB2jGrq9Tn1apdsFgi2`, stored exactly once as `processed / payment_confirmed` with a payload SHA-256; raw payload data is not retained.

## Customer Checkout boundary

`POST /api/commerce/checkout` is customer-facing and therefore does not require an Admin session, Admin commerce capability, or Admin CSRF. It accepts requests only from the exact configured Public staging origin and provides narrow POST/OPTIONS CORS. Commerce D1, `checkout_enabled`, direct-merchant connected TEST Stripe, canonical API/webhook proof, signing-secret shape, test-key shape, disabled live capture, body limits, product authority, and rate limiting all fail closed before Stripe. Optional Turnstile enforcement is already structured behind the explicit `checkout_turnstile_required` safe setting.

The request is exactly a checkout-request UUID, up to 20 unique `{ productId, variantId, quantity }` lines, and—for physical goods—a normalized recipient plus opaque server-issued quote/option IDs. Browser prices, names, currencies, totals, Stripe IDs, provider IDs, shipping amounts, tax, discounts, and live-mode requests are rejected.

The server sorts identifiers, loads every product from `commerce_products`, requires active/public/test/CAD rows with positive bounded integer unit amounts and permitted quantities, calculates every line/total in minor units, and snapshots the order before contacting Stripe. A deterministic Stripe idempotency key belongs to the local order/request pair. The success redirect may carry Stripe's literal `{CHECKOUT_SESSION_ID}`, but the redirect and query parameter are never payment authority; only the signed webhook transition is authoritative.

## Credential custody and encryption

| Provider/data | Custody |
| --- | --- |
| Stripe secret key and webhook signing secret | `environment_secret` |
| Stripe publishable key | safe configuration only if a later client-side component needs it |
| Printful private token | `environment_secret` |
| PayPal client credentials | `admin_encrypted` when implemented |
| Printify | `no_secret` for now; custody remains undecided |
| Wix legacy | `no_secret`; no mutation path |
| Canadian BN/tax identifiers and private legal details | Admin-encrypted D1 fields |

`functions/_shared/commerce-core.js` provides a server-only AES-256-GCM envelope for the private D1 fields and future `admin_encrypted` credentials. Stripe and Printful credentials do not use that envelope; they remain Admin-only Cloudflare encrypted secrets. There is no plaintext fallback and public projections omit private values.

## Authorization and Public boundary

Browser-driven commerce reads and mutations reuse the existing Admin session, role, origin, CSRF, D1 rate-limit, and audit authority. Master Admins have all five commerce capabilities and are the only accounts allowed to grant or revoke them. Full Admins can view commerce by role and may receive bounded capabilities. Ordinary users cannot receive commerce authority. The external Stripe webhook is the deliberate exception to browser authentication and instead uses the signed-delivery controls above.

ThirdRailify Public remains a client with no commerce binding, provider key, Stripe script, or enabled payment button. Its same-origin quote and checkout relays forward bounded guest requests to Admin authority and return only safe customer projections. Delivery details stay in React memory and are never written to localStorage; the existing variant cart remains the only commerce browser storage.

## Printful store isolation and fulfillment boundary

Printful has no Stripe-style sandbox in this architecture. The provider API is real, and the Private Token is production-capable, but it is scoped to the separate permanent `Third Railify API` Manual Order/API store. The existing Wix-connected Printful store remains live and is only a future migration source; this Admin integration must never receive account-wide token access or target that Wix store.

`POST /api/admin/commerce/printful/verify` requires the existing Admin session, exact Admin origin, CSRF, commerce rate limiting, commerce D1, and Master or `commerce.integrations.manage`. It reads the opaque `PRINTFUL_API_TOKEN` only server-side, performs `GET https://api.printful.com/stores` without `X-PF-Store-Id`, requires exactly one returned `native` store whose whitespace/case-normalized name is `Third Railify API`, then performs only `GET https://api.printful.com/store/products?limit=1`. Wix type/name, zero/multiple stores, malformed responses, provider failure, or any configured/token/persisted Store-ID disagreement fail closed before persistence or further provider access.

Only the existing unique Printful provider row is updated. Live read-only verification resolved the token to exactly one `native` store named `Third Railify API`, Store ID `18668025`, with one visible product; that ID is now the safe Wrangler configuration and the Wix store was not selected. Safe store ID/name/type, single-store access, product count, real-API posture, Cloudflare-secret custody, and verification time may persist. The token, Authorization header, raw responses, account/team/billing information, and Wix credentials never persist. The provider row's schema `environment=staging` describes the application rollout, not a Printful sandbox. Permanent pre-cutover gates remain `draft_only`, `fulfillment_enabled=false`, `webhook_configured=false`, `checkout_enabled=false`, and `live_payment_capture_enabled=false`.

Stripe does not pay Printful. Transaction 1 is the customer's payment to Third Railify. Transaction 2 is Printful's separate charge to the Third Railify Printful Wallet or configured billing method for product/printing, shipping, taxes, and other applicable fees. Order accounting keeps customer gross, Stripe fee, customer refund, Printful product cost, shipping, tax, refund/credit, and gross margin separate. No Printful order, confirmation, file/product mutation, or webhook configuration call is performed by the lifecycle read surfaces.

### Normalized fulfillment lifecycle

`0018_printful_fulfillment_lifecycle.sql` adds provider order, provider item, shipment, shipment-item coverage, and signed webhook evidence authorities without rewriting historical orders. One monotonic reducer maps documented Printful V1 order states into local provider state while keeping payment, confirmation, fulfillment, and shipment state distinct. Split packages become `partial` until non-reshipment shipment-item coverage reaches the ordered quantity; reshipments never inflate coverage, returns remain distinct from cancellation, and verified delivery evidence can advance shipped packages to delivered.

`POST /api/webhooks/printful` is a public machine boundary for Printful V2 beta signed events. It is fail-closed unless the expected store ID, public key, and hex webhook secret are server-configured. It verifies exact raw bytes with HMAC-SHA256 before JSON parsing, allowlists lifecycle events, rate-limits bodies to 256 KiB, rejects wrong-store and conflicting relationships, and records only bounded digests and normalized evidence. The receiver is code-complete but its keys and provider subscription are not configured or verified; no Printful webhook-management request was made. Stable V1 remains the explicitly injected read-only reconciliation fallback, with no scheduler or automatic polling. Shipment-notification intent is projected into the existing email authority, but the global send gate remains false and no delivery is created.

### Read-only catalogue recovery

The migration source is permanently separated from the target. `PRINTFUL_WIX_SOURCE_TOKEN` must resolve to exactly `Third Railify Official` / Store `16847493` / type `wix`, its ordinary configured ID must be `PRINTFUL_WIX_SOURCE_STORE_ID=16847493`, and it must never equal `PRINTFUL_STORE_ID=18668025`. The permanent credential must independently resolve to exactly `Third Railify API` / Store `18668025` / type `native`. Any identity, type, name, configuration, or collision mismatch fails closed before catalogue enumeration.

`POST /api/admin/commerce/printful/catalogue/snapshot` is protected by the exact Admin origin, authenticated Admin session, CSRF, the existing start-action commerce rate limiter, a separate bounded continuation budget, Master or `commerce.integrations.manage`, commerce D1 availability, signed continuation evidence, and a bounded completion audit. It uses only `GET /stores`, fully paginated source `GET /sync/products`, fully paginated target `GET /store/products`, every corresponding product-detail GET, and file-detail GETs only when a detail lacks enough print-file mapping. It does not read orders, customers, addresses, billing, payments, teams, or account data.

The original implementation attempted all identity, pagination, and detail reads inside one Pages invocation. With the known 49-product source and one target product it required at least 54 external subrequests before conditional file reads, exceeding the 50-external-subrequest Free-plan limit. The resulting runtime fetch exception was caught and flattened into the misleading generic catalogue-discovery banner.

One browser action now orchestrates multiple calls to the same protected route. Cloudflare's per-invocation external-subrequest ceiling and Printful V1's published 120 calls/minute quota are independent limits: product phases remain bounded at 12 details, file phases at 20, and every source/target request start shares a conservative 675 ms scheduler (about 88.9/minute). Signed pacing evidence carries `lastProviderRequestAt`, `nextProviderRequestAt`, provider request count, safe rate-control values, and bounded throttle cycles across Pages invocations. Transient transport/5xx failures receive three paced attempts with backoff/jitter.

Printful 419 and 429 responses are not catalogue content and are not immediately terminal. The scheduler normalizes only `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, their `X-Ratelimit-*` case variants, and `X-Ratelimit-Policy`; it honors the later usable Retry-After/reset plus a one-second margin, or waits 62 seconds when timing is absent. Signed phase checkpoints contain the exact first-uncompleted cursor and every normalized success from the partial page/product/file chunk. A pre-deadline continuation performs no provider call; an eligible continuation resumes that item, so completed work is neither discarded nor fetched again. The operator sees phase, completed/total, waiting state, and an absolute-time countdown; the client resumes automatically. Twelve throttle cycles are bounded recovery, after which a terminal safe result retains progress. No provider evidence is persisted to D1.

The final response contains deterministic canonical source, target, Public projection, and reconciliation sections plus a non-canonical correlation ID. The browser exposes four explicit user-initiated downloads without credentials or headers; it never launches a multi-download burst. Reconciliation orders evidence as external IDs, Printful sync IDs, variant IDs, SKU, catalogue variant IDs, variant structure, integer-CAD price, file correlation, then normalized exact name. A weaker name cannot override conflicting stable identity. Planned `POST /store/products` objects are inert `send=false` evidence only; no transport accepts or sends them.

Concrete variants remain a design only. Applied commerce migration `0004` belongs to GOATS, so the repository-consistent next filename is `commerce-import/0005_commerce_product_variants.proposed.sql`; it is deliberately outside `commerce-migrations`. It adds opaque local variant IDs, parent products, permanent target product/variant mapping, catalogue variant IDs, legacy source/Wix provenance, SKU/size/color/bounded options, exact CAD cents, availability/sellable gates, fulfillment/file mapping, and migration provenance. Checkout continues accepting only `{ productId, quantity }` until a separately authorized schema/import milestone.

PayPal remains a later direct-merchant REST integration for `/donate` and possible VIP use. It is not the preferred shop processor, has no partner onboarding, credential form, or API call, and stays deferred until after Stripe and Printful.

## Rejected historical architecture

The earlier local milestone modeled this shop as a Stripe Connect platform plus a Canadian connected merchant. That unprovisioned design is superseded and retained here only as a rejection record. The authoritative implementation must not create connected accounts, Account Links, Connect onboarding, Connect OAuth, platform or destination charges, application fees, transfer destinations, `Stripe-Account` headers, capability polling, Connect webhook onboarding, or platform-versus-merchant accounting.

## Permanent production-control plane

Migration `0010_commerce_production_control_plane.sql` extends the existing authorities instead of creating parallel business, tax, or template stores. Private legal name, structured legal address, private phone, business registration number, and tax identifiers use the existing purpose-bound AES-256-GCM envelope. Ordinary tax projections contain only masks and safe lifecycle fields.

`commerce_templates` owns seven customer-email templates plus structured payment-receipt and invoice/sales-document templates. The renderer accepts plain structured fields only and rejects executable markup and merge variables outside the explicit allowlist. Resend delivery reuses the central server mail adapter; `commerce_email_deliveries.delivery_key` is a unique deterministic digest of template revision, order, event/state, recipient, and purpose so duplicate events cannot reserve a second delivery.

Paid-order receipt and invoice previews are built from immutable D1 order-item snapshots. Customer access uses a one-time returned 256-bit opaque token whose SHA-256 alone is stored in `commerce_order_documents`; order IDs, email addresses, and Stripe IDs are not customer authorization. Formal invoice readiness stays blocked until operator-entered legal identity, address, registration, and tax calculation strategy are complete.

The centralized readiness projection derives BUSINESS, TAX, PAYMENTS, CATALOGUE, SHIPPING, FULFILLMENT, COMMUNICATIONS, DOCUMENTS, and CHECKOUT from stored configuration and evidence. There is no manual `production_ready` override. Merchandising readiness remains independent from fulfillment readiness, so the permanent D1 catalogue stays public while the Printful migration is paused.
