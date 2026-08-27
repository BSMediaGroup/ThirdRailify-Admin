# Commerce architecture

## Milestone posture

This repository contains the Admin-only control-plane foundation for a future Stripe-first Canadian commerce stack. It is a staging scaffold, not an activated payment or fulfillment system.

| Area | Current state |
| --- | --- |
| Commerce environment | `staging` |
| Checkout | `disabled` |
| Live payment capture | `disabled` |
| Fulfillment submission | `disabled` |
| Stripe onboarding | `not active` |
| Stripe connected account | `not created` |
| Printful API connection | `not active`; draft-only design |
| PayPal | `deferred` |
| Printify | `unavailable`; credential custody undecided |
| Wix | `legacy production`; remains authoritative and untouched |

No Cloudflare resource, provider account, provider credential, transaction, fulfillment order, or deployment is created by this milestone.

## Ownership and money movement

- Brainstream Media Group operates Daniel's existing Stripe Connect platform and will retain the platform API keys and webhook signing secrets as Admin-only Cloudflare Secrets.
- Third Railify Official / Shawn is the Canadian merchant. The intended connected account has full Stripe Dashboard access and completes Stripe-hosted onboarding directly.
- The intended shop model uses direct charges on the connected account. Third Railify is the merchant of record, owns its payouts, and pays ordinary Stripe processing fees. The platform takes no application fee by default.
- The intended storefront creates Stripe Checkout Sessions server-side. Cards are primary; Apple Pay and Google Pay are presented only when Stripe, the browser/device, domain, and customer payment method are eligible.
- Stripe does not pay Printful. A customer payment and a Printful fulfillment charge are separate transactions. Printful charges the Third Railify Printful Wallet or configured billing method for product, shipping, and tax costs.
- PayPal is a later direct-merchant REST integration using Shawn's PayPal Business credentials. It is intended for donations and possible VIP use, not preferred `/shop` checkout. Partner referrals are out of scope.

The connected account model is not activation-approved until Daniel inspects the real Connect Dashboard and confirms Canadian connected-account availability, direct-charge/full-Dashboard support, the account-fee payer configuration, and Stripe-managed loss liability for the chosen setup.

## Stripe-hosted identity boundary

The future Admin action creates a one-time Stripe Account Link only after an authenticated, authorized request. Shawn enters identity, representative, business, ownership, bank, and agreement details directly into Stripe-hosted onboarding. Admin stores only non-secret account metadata and requirement/status summaries. It must not collect bank details, identity-document images, or full Stripe KYC payloads.

## Data authority

Authentication remains in the existing auth D1. Commerce state belongs in the separate future `thirdrailify-commerce` D1, bound only to Admin as `THIRDRAILIFY_COMMERCE_DB`. The local schema authority is `commerce-migrations/0001_commerce_control_plane.sql`; no active binding or database ID is present.

Entities:

- `commerce_business_profiles`: confirmed public defaults plus encrypted private legal/address data.
- `commerce_tax_registrations`: encrypted identifiers and safe masked/status metadata; no custom tax engine.
- `commerce_provider_connections`: provider status, environment, safe metadata, and explicit credential-custody mode.
- `commerce_templates`: bounded structured email/document content with no scripts or executable HTML.
- `commerce_settings`: safe activation gates and environment posture.
- `commerce_permission_grants`: capability grants to existing Admin accounts.
- `commerce_products`: future provider-neutral catalogue records.
- `commerce_orders`: future order records with customer-payment and Printful cost fields kept separate.
- `commerce_audit`: redacted mutation history.

The migration is idempotent, constrains statuses/custody values, indexes operational lookups, and seeds only confirmed defaults and disabled states.

## Credential custody and encryption

| Provider/data | Custody |
| --- | --- |
| Stripe platform secret/webhook keys | `environment_secret` |
| Stripe connected account | `no_secret`; metadata only |
| Printful private token | `environment_secret` |
| PayPal client credentials | `admin_encrypted` when implemented |
| Printify | `no_secret` for now; custody remains undecided |
| Wix legacy | `no_secret`; no mutation path |
| Canadian BN/tax identifiers and private legal details | Admin-encrypted D1 fields |

`functions/_shared/commerce-core.js` provides a server-only AES-256-GCM envelope. It requires a 32-byte base64url key in `THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY`, generates a random 96-bit nonce, authenticates a purpose string as additional data, caps plaintext size, versions the envelope, and rejects missing keys, malformed envelopes, tampering, or wrong keys. There is no plaintext fallback and public projections omit private values.

## Authorization

Commerce reuses the existing Admin session, role, origin, CSRF, D1 rate-limit, and audit authority. It adds these capabilities:

- `commerce.view`
- `commerce.business.manage`
- `commerce.payments.manage`
- `commerce.integrations.manage`
- `commerce.templates.manage`

Master Admins have all capabilities and are the only accounts allowed to grant or revoke them. Full Admins can view commerce by role and may receive bounded capabilities. Ordinary users cannot receive commerce authority. Provider disconnects and credential replacement are not implemented; any future implementation must require an explicit confirmation in addition to the normal mutation controls.

## Public boundary

ThirdRailify Public remains a read-only client. This milestone adds no Public binding, credential, payment button, checkout route, fulfillment route, or provider mutation. Future Public payloads must contain only safe business presentation, safe provider availability, product data, and order/customer data expressly authorized for that session. Private legal fields, tax identifiers, provider credentials, bank data, and audit internals remain Admin-only.

## Fulfillment safety

The future Printful integration uses a new parallel manual/API store and leaves the current Wix-connected store active. The token is a store-scoped Cloudflare Secret and the Store ID is safe configuration. Initial API orders are drafts. Confirmation requires authoritative Stripe payment state plus explicit safety gates; fulfillment submission is currently disabled.

