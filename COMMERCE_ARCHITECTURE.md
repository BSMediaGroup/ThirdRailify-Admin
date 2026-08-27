# Commerce architecture

## Milestone posture

This repository contains the Admin-only control-plane foundation for a future Stripe-first Canadian commerce stack. It is a staging scaffold, not an activated payment or fulfillment system.

| Area | Current state |
| --- | --- |
| Commerce environment | `staging` |
| Dedicated Stripe account | created; operator-confirmed |
| Stripe integration mode | `direct_merchant` |
| Stripe API connection | not configured |
| Stripe webhook | not configured |
| Stripe environment | Sandbox/test preparation |
| Checkout | `disabled` |
| Live payment capture | `disabled` |
| Live payout readiness | not verified |
| Fulfillment submission | `disabled` |
| Printful API connection | not active; draft-only design |
| PayPal | `deferred` |
| Printify | `unavailable`; credential custody undecided |
| Wix | `legacy production`; remains authoritative and untouched |

No Cloudflare commerce resource, provider credential, transaction, fulfillment order, or deployment is created by this milestone.

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
- The server will create Checkout Sessions with `mode=payment` and CAD prices for shop purchases.
- The first approved customer surface is Stripe-hosted Checkout. The application redirects to the server-returned Checkout Session URL; Public does not need Stripe.js merely to perform that redirect.
- Cards are primary. Apple Pay and Google Pay may appear only when eligible and enabled for the account, Checkout, browser/device, customer, domain, and currency.
- Link is optional and must remain absent unless separately approved and enabled.
- Third Railify never collects or stores raw card details.
- There is no application fee, connected account, transfer destination, inter-account transfer, or platform-versus-merchant accounting layer.

## Stripe Dashboard boundary

Authorized Stripe account administrators manage Canadian business verification, representative and owner details, payout banking, tax details, payment-method configuration, and account team access directly in Stripe Dashboard. Third Railify Admin does not reproduce Stripe KYC, identity-document, bank, or team-management forms.

The dedicated account's creation and Sandbox/test access are operator-confirmed. Live verification, live charges, live payouts, payout-bank readiness, Stripe Tax, wallets, live webhooks, and live Cloudflare credentials remain unverified.

## Data authority

Authentication remains in the existing auth D1. Commerce state belongs in the separate future `thirdrailify-commerce` D1, bound only to Admin as `THIRDRAILIFY_COMMERCE_DB`. The local schema authority is `commerce-migrations/0001_commerce_control_plane.sql`; no active commerce binding or database ID is present.

Entities:

- `commerce_business_profiles`: confirmed public defaults plus encrypted private legal/address data.
- `commerce_tax_registrations`: encrypted identifiers and safe masked/status metadata; no custom tax engine.
- `commerce_provider_connections`: provider, canonical integration mode, environment, safe status metadata, and credential-custody mode.
- `commerce_templates`: bounded structured email/document content with no scripts or executable HTML.
- `commerce_settings`: safe activation gates and environment posture.
- `commerce_permission_grants`: capability grants to existing Admin accounts.
- `commerce_products`: future provider-neutral catalogue records.
- `commerce_orders`: future order records with customer-payment and Printful cost/refund fields kept separate.
- `commerce_audit`: redacted mutation history.

The Stripe provider row may later store only safe, verified values: environment, `direct_merchant`, Stripe account ID retrieved through the API, country, default currency, account/business display name, charges/payouts flags, last verification time, webhook status, and a payment-method summary. It must not store API keys, webhook signing secrets, payout-bank data, card data, identity documents, full private Stripe responses, or team-member email addresses.

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

Commerce reuses the existing Admin session, role, origin, CSRF, D1 rate-limit, and audit authority. Master Admins have all five commerce capabilities and are the only accounts allowed to grant or revoke them. Full Admins can view commerce by role and may receive bounded capabilities. Ordinary users cannot receive commerce authority.

ThirdRailify Public remains a read-only client. This milestone adds no Public binding, key, Stripe script, payment button, checkout route, fulfillment route, or provider mutation. Future Public payloads must contain only explicitly authorized safe business, availability, product, and customer-order data.

## Fulfillment and deferred providers

Stripe does not pay Printful. Transaction 1 is the customer's payment to Third Railify. Transaction 2 is Printful's separate charge to the Third Railify Printful Wallet or configured billing method for product/printing, shipping, taxes, and other applicable fees. Order accounting keeps customer gross, Stripe fee, customer refund, Printful product cost, shipping, tax, refund/credit, and gross margin separate. Printful remains disconnected and draft-only until later approval.

PayPal remains a later direct-merchant REST integration for `/donate` and possible VIP use. It is not the preferred shop processor, has no partner onboarding, credential form, or API call, and stays deferred until after Stripe and Printful.

## Rejected historical architecture

The earlier local milestone modeled this shop as a Stripe Connect platform plus a Canadian connected merchant. That unprovisioned design is superseded and retained here only as a rejection record. The authoritative implementation must not create connected accounts, Account Links, Connect onboarding, Connect OAuth, platform or destination charges, application fees, transfer destinations, `Stripe-Account` headers, capability polling, Connect webhook onboarding, or platform-versus-merchant accounting.
