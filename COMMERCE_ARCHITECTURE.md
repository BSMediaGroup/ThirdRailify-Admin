# Commerce architecture

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
| Checkout | `disabled` |
| Live payment capture | `disabled` |
| Live payout readiness | not verified |
| Fulfillment submission | `disabled` |
| Printful API connection | not active; draft-only design |
| PayPal | `deferred` |
| Printify | `unavailable`; credential custody undecided |
| Wix | `legacy production`; remains authoritative and untouched |

The separate Admin-only commerce D1 is bound, and its encryption key plus Stripe TEST API/webhook credentials remain encrypted Cloudflare Secrets. The sandbox Checkout/order engine is implemented, but `checkout_enabled=false` and zero authoritative products mean no remote Checkout Session or order is created in this milestone. Live payments, tax, shipping calculation, fulfillment, refunds, payouts, and production merchant readiness remain outside this milestone.

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

Authentication remains in the existing auth D1. Commerce state belongs in the separate `thirdrailify-commerce` D1 (`3dd23a7e-7c64-49cb-a52c-c1540b41db1c`), bound only to Admin as `THIRDRAILIFY_COMMERCE_DB`. Schema authority is the ordered `0001_commerce_control_plane.sql`, `0002_stripe_webhook_events.sql`, then `0003_product_merchandising.sql` sequence; the third migration contains no product seed.

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
- `commerce_audit`: redacted mutation history.
- `commerce_webhook_events`: one safe receipt per provider plus provider Event ID, with bounded event/object/status metadata and a raw-payload SHA-256 only. It has no raw payload, signature, secret, credential, customer, address, card, or full-object column.

The canonical configuration flags are evidence records, not secret-presence probes. `stripe_api_configured` becomes true only in the same successful write batch as a server-side `GET /v1/account` result that normalizes to `country=CA` and `default_currency=cad`. `stripe_webhook_configured` and provider `webhook_configured` become true only in the same duplicate-safe receipt batch as a valid `v1` signature, in-tolerance timestamp, valid Stripe Event envelope, and `livemode=false` event. A later valid duplicate delivery may reassert webhook proof without adding a ledger row. These flags never alter Checkout, live-payment capture, payout readiness, or fulfillment gates.

The Stripe provider row stores only safe, verified values: environment, `direct_merchant`, Stripe account ID retrieved through the API, country, default currency, account/business display name, test charges/payouts/details-submitted flags, account type, last verification time, webhook status, and the existing bounded payment-method summary. It must not store API keys, webhook signing secrets, payout-bank data, card data, identity documents, full private Stripe responses, tax IDs, individual/representative details, or team-member email addresses.

Staging verification is `POST /api/admin/commerce/stripe/verify`, protected by the existing Admin session, exact origin, `commerce.payments.manage`/Master authority, CSRF, rate limit, and audit boundaries. It reads `STRIPE_SECRET_KEY` only in the server runtime and performs exactly `GET https://api.stripe.com/v1/account` in the direct merchant context without `Stripe-Account`. Restricted `rk_test_...` is the intended credential; `sk_test_...` remains compatible. All live credential forms fail closed. A successful response must normalize to `country=CA` and `default_currency=cad`; connection status means only “Test API connected.”

## External Stripe webhook boundary

`POST /api/webhooks/stripe` is an external machine-to-machine Pages Function. It does not require or inspect an Admin session, CSRF token, Turnstile token, Origin header, CORS state, or commerce capability. Non-POST methods return `405`.

The route reads at most 1 MiB of request bytes once and verifies the exact bytes before parsing JSON. `Stripe-Signature` must contain exactly one numeric `t` value and at least one well-formed `v1` value; `v0` and unknown schemes are ignored. The signed input is the ASCII timestamp, a period, then the untouched request bytes. The complete `whsec_...` value is the UTF-8 HMAC-SHA256 key and is never Base64-decoded. Web Crypto verification safely supports multiple `v1` values during rotation. Timestamps older than 300 seconds or more than 300 seconds in the future fail closed.

Only a sane `object=event`, `livemode=false` Stripe envelope can reach D1. The explicit allowlist contains only `checkout.session.completed`. It never creates an order: metadata/client reference and persisted Session ID must resolve to the same existing TEST order, and mode, CAD currency, authoritative expected amount, Stripe paid status, and checkout state must all agree before the single `pending` to `paid` transition. Unknown, unlinked, mismatched, unpaid, or live Sessions are bounded `accepted_noop` results. Other signed test event types are ignored. `INSERT OR IGNORE` plus the ledger's composite key makes duplicate provider/Event IDs successful no-ops and the order update also requires `payment_status=pending`, so replay cannot double-transition. The accepted historical event remains `accepted_noop / checkout_disabled`.

## Customer Checkout boundary

`POST /api/commerce/checkout` is customer-facing and therefore does not require an Admin session, Admin commerce capability, or Admin CSRF. It accepts requests only from the exact configured Public staging origin and provides narrow POST/OPTIONS CORS. Commerce D1, `checkout_enabled`, direct-merchant connected TEST Stripe, canonical API/webhook proof, signing-secret shape, test-key shape, disabled live capture, body limits, product authority, and rate limiting all fail closed before Stripe. Optional Turnstile enforcement is already structured behind the explicit `checkout_turnstile_required` safe setting.

The request is exactly a checkout-request UUID plus up to 20 unique `{ productId, quantity }` lines; concrete variants are not accepted because the current authoritative schema and Public cart do not model variant IDs. Public's local Wix snapshot contains floating display prices and option-type labels only, so it is not sufficient for authoritative import without a later product/variant reconciliation. Browser prices, names, currencies, totals, Stripe IDs, tax, shipping, discounts, and live-mode requests are rejected.

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

ThirdRailify Public remains an unchanged read-only client with no commerce binding, key, Stripe script, or enabled payment button. The Admin-hosted customer Checkout endpoint is prepared for a later Public client, but its remote gate stays false until authoritative product import/sync. Public's eventual request contains identifiers and quantities only and receives only the local order ID, TEST Session ID, and Stripe-hosted Checkout URL.

## Fulfillment and deferred providers

Stripe does not pay Printful. Transaction 1 is the customer's payment to Third Railify. Transaction 2 is Printful's separate charge to the Third Railify Printful Wallet or configured billing method for product/printing, shipping, taxes, and other applicable fees. Order accounting keeps customer gross, Stripe fee, customer refund, Printful product cost, shipping, tax, refund/credit, and gross margin separate. Printful remains disconnected and draft-only until later approval.

PayPal remains a later direct-merchant REST integration for `/donate` and possible VIP use. It is not the preferred shop processor, has no partner onboarding, credential form, or API call, and stays deferred until after Stripe and Printful.

## Rejected historical architecture

The earlier local milestone modeled this shop as a Stripe Connect platform plus a Canadian connected merchant. That unprovisioned design is superseded and retained here only as a rejection record. The authoritative implementation must not create connected accounts, Account Links, Connect onboarding, Connect OAuth, platform or destination charges, application fees, transfer destinations, `Stripe-Account` headers, capability polling, Connect webhook onboarding, or platform-versus-merchant accounting.
