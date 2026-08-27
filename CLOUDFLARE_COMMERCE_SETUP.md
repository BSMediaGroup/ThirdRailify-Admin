# Future Cloudflare commerce setup

This runbook records the completed staging control-plane prerequisites and the separately authorized steps that remain. Do not use it to activate live commerce.

## Current blockers and invariants

- The dedicated Third Railify Official Canadian Stripe account exists and Sandbox/test mode is available.
- `thirdrailify-commerce` (`3dd23a7e-7c64-49cb-a52c-c1540b41db1c`) is bound only to Admin as `THIRDRAILIFY_COMMERCE_DB`, and `0001_commerce_control_plane.sql` is applied.
- `THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY` and `STRIPE_SECRET_KEY` are stored as Admin Cloudflare encrypted Secrets. Secret values must never be retrieved, printed, logged, committed, or persisted to D1.
- The intended staging Stripe credential is the restricted TEST key (`rk_test_...`) under the unchanged `STRIPE_SECRET_KEY` name; `sk_test_...` is compatible and all live key forms fail closed.
- Read-only Stripe account verification is implemented; no webhook is configured, and Checkout/live-payment gates are disabled.
- Live business verification, payout banking, charges, payouts, wallets, Tax, and live credentials are not verified.
- The existing auth D1 remains the identity/session/role authority and must not become the main commerce database.
- Wix remains production authority and all Wix providers stay connected until an approved cutover.
- PayPal remains deferred.

## Required future sequence

Items 1–5 and the code portion of item 8 are complete. Every remaining provider or activation mutation requires separate approval at its milestone.

1. Provision a D1 database named `thirdrailify-commerce` in the intended Cloudflare account.
2. Bind it only to Admin as `THIRDRAILIFY_COMMERCE_DB`; never add the binding to Public or another client.
3. Apply `commerce-migrations/0001_commerce_control_plane.sql` and verify its identity, tables, constraints, seeds, and repeat-safe behavior.
4. Generate and store `THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY` as an Admin-only Cloudflare encrypted secret.
5. Store the dedicated restricted Stripe TEST key in the Admin encrypted secret `STRIPE_SECRET_KEY` without printing, committing, or inspecting its value in application tooling. Keep this environment variable name even though the credential begins with `rk_test_`.
6. Create a Stripe TEST webhook endpoint for the implemented event contract.
7. Store its signing secret as the Admin encrypted secret `STRIPE_WEBHOOK_SECRET`.
8. Use the implemented authenticated action once to read-only verify the Stripe account identity; retrieve the account ID from Stripe rather than hardcoding it.
9. Implement test Checkout Sessions with `mode=payment`, CAD prices, and server-returned Stripe-hosted Checkout URLs.
10. Implement signature-verified, idempotent webhook transitions into authoritative commerce order/payment state.
11. Keep checkout disabled throughout acceptance.
12. Configure the parallel Printful manual/API store while leaving the Wix-connected store active.
13. Implement Printful draft orders with no automatic confirmation.
14. Do not disconnect Wix.
15. Complete and verify the live Stripe business and payout setup directly in Stripe Dashboard.
16. Swap to live credentials only during a later explicitly approved production milestone.

## D1 and encryption details

After Cloudflare returns a real database ID, the Admin-only configuration shape is:

```jsonc
{
  "binding": "THIRDRAILIFY_COMMERCE_DB",
  "database_name": "thirdrailify-commerce",
  "database_id": "<real-cloudflare-d1-id>",
  "migrations_dir": "commerce-migrations"
}
```

Do not merge an unresolved placeholder into active Wrangler configuration. Generate the commerce encryption key as a cryptographically random 32-byte value encoded as unpadded base64url. Never print it, put it in D1, share it with Public, or reuse an auth/provider secret. Establish an approved backup and rotation procedure before entering private business data.

## Stripe test integration details

`STRIPE_SECRET_KEY` and the future `STRIPE_WEBHOOK_SECRET` belong only in Admin Cloudflare encrypted secrets. The current staging verifier accepts `rk_test_...` and `sk_test_...` only, performs `GET https://api.stripe.com/v1/account`, and requires `CA` plus `cad`. Preserve the blank `STRIPE_PUBLISHABLE_KEY` scaffold as safe future configuration, but do not expose it to Public or require it for verification or the initial Stripe-hosted Checkout URL redirect. A publishable key becomes relevant only if a separately approved embedded or client-side Stripe component needs Stripe.js.

The first implementation must use the dedicated account's ordinary merchant API context. It must not send a `Stripe-Account` header or implement connected-account creation, Account Links, onboarding, OAuth, capability polling, application fees, transfer destinations, or inter-account balances.

Persist only safe verified account metadata and bounded status summaries. Never persist secret keys, webhook signing secrets, bank data, card data, identity documents, full private Stripe payloads, or team-member email addresses. Verify webhook signatures and idempotency before any state transition. Do not create a Checkout Session, PaymentIntent, charge, refund, payout, or webhook in this scaffold-correction task.

## Printful and PayPal boundaries

Create the later Printful manual/API store in parallel with the existing Wix-connected store. Store its scoped private token as the Admin-only Cloudflare encrypted secret `PRINTFUL_API_TOKEN` and its non-secret Store ID as safe `PRINTFUL_STORE_ID` configuration. Keep `printful_order_mode=draft_only`, fulfillment submission disabled, and explicit confirmation required after authoritative payment reconciliation. Stripe never pays Printful directly.

Do not configure PayPal credentials yet. Its future direct-merchant REST credentials are `admin_encrypted`, and it remains limited to later `/donate` and possible VIP work rather than preferred shop checkout. Do not design partner onboarding.

## Acceptance before any production plan

Require evidence for exact D1 identity and migration, secret presence without values, role/capability enforcement, CSRF/rate limits/audit redaction, read-only Stripe account identity, webhook signature/idempotency, test Checkout redirect and completion, wallet eligibility, refund/dispute handling, order reconciliation, Printful draft creation, explicit no-confirm behavior, and Public's no-secret boundary.

Keep Wix connected throughout testing. A later production cutover requires its own inventory/order/customer/policy reconciliation, URL plan, rollback plan, and explicit approval. No deployment or live provider activation is part of this runbook's current execution.
