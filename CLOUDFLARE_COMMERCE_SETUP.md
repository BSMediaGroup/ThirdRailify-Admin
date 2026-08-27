# Future Cloudflare commerce setup

This is a manual activation runbook for a later, separately authorized milestone. None of these steps has been performed. Do not use it to activate live commerce.

## Current blockers and invariants

- The future `thirdrailify-commerce` D1 database does not exist.
- `THIRDRAILIFY_COMMERCE_DB` is intentionally absent from `wrangler.jsonc`; no database ID may be invented.
- Commerce encryption, Stripe, and Printful secret placeholders are blank.
- Checkout, live capture, fulfillment submission, Stripe onboarding, and provider connection actions are disabled in code.
- The existing auth D1 remains the identity/session/role authority and must not become the main commerce database.
- Wix remains production authority and all Wix providers stay connected until an approved cutover.
- PayPal remains deferred.

## 1. Verify the existing Connect platform first

Daniel must inspect the real Brainstream Media Group Stripe Connect Dashboard before any API work. Confirm the platform country/profile permits Canadian connected accounts and the exact configuration supports:

- Third Railify as a Canadian/CAD merchant;
- full Stripe Dashboard and Stripe-hosted onboarding;
- direct charges with `card_payments`;
- merchant-owned payouts;
- connected-account Stripe fee responsibility (`controller.fees.payer=account` or the current supported equivalent);
- no application fee by default;
- Stripe-managed loss liability for this configuration;
- the intended CAD bank/debit-card payout path;
- test-mode event destinations/webhooks and wallet-domain requirements.

Stop if the Dashboard differs from the documented design. Do not create a connected account during this review.

## 2. Create and bind the separate staging D1

Only after explicit Cloudflare mutation authorization:

1. Create a D1 database named `thirdrailify-commerce` in the intended account.
2. Record the real returned database ID; never use a placeholder ID in active configuration.
3. Add an Admin-only `THIRDRAILIFY_COMMERCE_DB` binding with `migrations_dir` set to `commerce-migrations`.
4. Do not add this binding to ThirdRailify Public or any other client.
5. Apply `commerce-migrations/0001_commerce_control_plane.sql` to the staging database and verify its tables, constraints, seed statuses, and repeat-safe behavior.

Example configuration shape after the resource exists (the ID must come from Cloudflare):

```jsonc
{
  "binding": "THIRDRAILIFY_COMMERCE_DB",
  "database_name": "thirdrailify-commerce",
  "database_id": "<real-cloudflare-d1-id>",
  "migrations_dir": "commerce-migrations"
}
```

Do not merge an unresolved placeholder into active Wrangler configuration.

## 3. Generate the encryption secret

Generate a cryptographically random 32-byte value, encode it as unpadded base64url, and store it as the Admin-only Cloudflare Secret `THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY`. Do not print it, commit it, put it in D1, share it with Public, or reuse an auth/provider secret. Establish an operator-approved backup/rotation procedure before private business data is entered; losing the key makes encrypted fields unrecoverable.

After configuration, validate only in staging that round-trip encryption works, wrong keys and tampering fail, logs remain redacted, and private values never appear in browser/public payloads.

## 4. Configure Stripe test mode

Only after the Dashboard eligibility check and separate authorization:

- Store `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as Admin-only Cloudflare Secrets.
- Configure the safe test publishable key under the existing `STRIPE_PUBLISHABLE_KEY` name.
- Keep `STRIPE_LIVE_ENABLED=false`.
- Implement the exact Accounts API version and event destination/webhook contract selected for the platform.
- Use authenticated, capability-checked, CSRF-protected, rate-limited endpoints to create the account and one-time Account Link.
- Send Shawn directly to Stripe-hosted onboarding. Never collect bank/KYC documents in Admin.
- Persist only connected-account metadata and safe requirement/status summaries.
- Verify webhook signatures and idempotency before changing state.
- Register required payment-method domains for the connected account when direct-charge Apple Pay/Google Pay testing reaches that milestone.

Do not create an account, Account Link, Checkout Session, PaymentIntent, charge, refund, payout, or live webhook in this scaffold milestone.

## 5. Configure the parallel Printful store

Daniel, as Printful Master Admin, should create a separate manual/API store while leaving the current Wix-connected Printful store untouched. Create a store-scoped Private Token with only the scopes required by the implemented adapter. Store the token as the Admin-only Cloudflare Secret `PRINTFUL_API_TOKEN`; store the non-secret Store ID as `PRINTFUL_STORE_ID` safe configuration. Preserve the existing `PRINTFUL_STORE_API` variable.

Validate catalogue reads in a later test milestone. Keep `printful_order_mode=draft_only` and fulfillment disabled. Any future order confirmation must require authoritative successful Stripe state, idempotency, reconciliation, and an explicit activation gate. Never model Stripe as paying Printful.

## 6. Keep PayPal deferred

Do not configure PayPal credentials yet. The future direct-merchant REST credentials belong to Shawn's PayPal Business account and are `admin_encrypted`, not tracked configuration or ordinary environment placeholders. PayPal is intended for donations and possible VIP use, not preferred shop checkout. Do not design Partner Referrals.

## 7. Staging acceptance before any production plan

Require evidence for D1 migration identity, secret presence without values, role/capability enforcement, CSRF/rate limits/audit redaction, webhook signature/idempotency, Stripe test onboarding, direct-charge fee/liability behavior, wallet eligibility, refund/dispute behavior, order reconciliation, Printful draft creation, explicit no-confirm behavior, and Public's no-secret boundary.

Keep Wix connected throughout staging. A later production cutover requires its own inventory/order/customer/policy reconciliation, URL plan, rollback plan, and explicit approval. No deployment or live provider activation is part of this runbook's current execution.

