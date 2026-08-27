# Future Cloudflare commerce setup

This runbook records the completed staging control-plane prerequisites and the separately authorized steps that remain. Do not use it to activate live commerce.

## Current blockers and invariants

- The dedicated Third Railify Official Canadian Stripe account exists and Sandbox/test mode is available.
- `thirdrailify-commerce` (`3dd23a7e-7c64-49cb-a52c-c1540b41db1c`) is bound only to Admin as `THIRDRAILIFY_COMMERCE_DB`. The ordered `0001_commerce_control_plane.sql`, `0002_stripe_webhook_events.sql`, and revised seed-free `0003_product_merchandising.sql` migrations are applied; the remote migration list is empty.
- `THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY` and `STRIPE_SECRET_KEY` are stored as Admin Cloudflare encrypted Secrets. Secret values must never be retrieved, printed, logged, committed, or persisted to D1.
- The intended staging Stripe credential is the restricted TEST key (`rk_test_...`) under the unchanged `STRIPE_SECRET_KEY` name; `sk_test_...` is compatible and all live key forms fail closed.
- Read-only Stripe account verification, the signed sandbox receiver at `POST /api/webhooks/stripe`, and the gated server-side Checkout/order engine are deployed to Admin. The destination and Admin-only signing secret are configured, and one real signed `checkout.session.completed` sandbox Event remains preserved as `accepted_noop / checkout_disabled`. Deployment `1a9b7e5b-33fe-4bc5-b186-1f24c7e7ecca` returned `409 checkout_disabled` to the allowed-origin acceptance probe; Public checkout/live-payment/fulfillment gates remain disabled and authoritative products and orders remain zero.
- Live business verification, payout banking, charges, payouts, wallets, Tax, and live credentials are not verified.
- The existing auth D1 remains the identity/session/role authority and must not become the main commerce database.
- Wix remains production authority and all Wix providers stay connected until an approved cutover.
- The permanent `Third Railify API` Printful Manual Order/API store and its store-scoped production-capable Private Token exist separately from Wix. The token belongs only in the Admin Production encrypted secret `PRINTFUL_API_TOKEN`; its numeric Store ID belongs in the ordinary Wrangler variable `PRINTFUL_STORE_ID` after read-only discovery.
- The temporary source reader is the separate encrypted secret `PRINTFUL_WIX_SOURCE_TOKEN`; only its safe verified ID is ordinary configuration as `PRINTFUL_WIX_SOURCE_STORE_ID=16847493`. It resolves to `Third Railify Official` of type `wix` and must be revoked after successful migration/cutover verification.
- PayPal remains deferred.

## Required future sequence

The D1, encryption-key, restricted TEST credential, read-only account verification, receiver code, and receipt-ledger code portions are complete. Every remaining provider or activation mutation requires separate approval at its milestone.

1. Provision a D1 database named `thirdrailify-commerce` in the intended Cloudflare account.
2. Bind it only to Admin as `THIRDRAILIFY_COMMERCE_DB`; never add the binding to Public or another client.
3. Apply `commerce-migrations/0001_commerce_control_plane.sql` and verify its identity, tables, constraints, seeds, and repeat-safe behavior.
4. Generate and store `THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY` as an Admin-only Cloudflare encrypted secret.
5. Store the dedicated restricted Stripe TEST key in the Admin encrypted secret `STRIPE_SECRET_KEY` without printing, committing, or inspecting its value in application tooling. Keep this environment variable name even though the credential begins with `rk_test_`.
6. Completed: `commerce-migrations/0002_stripe_webhook_events.sql` was the sole pending migration, was applied to the confirmed D1, and the Admin receiver was deployed.
7. Completed externally: create the Stripe Sandbox event destination exactly as documented below; do not create it through the Stripe API.
8. Completed externally: store the generated signing secret only as the Admin Production encrypted secret `STRIPE_WEBHOOK_SECRET`.
9. Completed: one signed Sandbox test delivery was verified and accepted before treating webhook signing and delivery as operational.
10. Completed in code: create test Checkout Sessions with `mode=payment`, inline server-authoritative CAD prices, local order snapshots, deterministic idempotency, and server-returned Stripe-hosted Checkout URLs.
11. Completed in code: signed completed Sessions can transition only a matching existing TEST order after exact reference/Session/amount/currency/payment invariants; unknown webhooks cannot create orders.
12. Keep checkout disabled throughout deployment acceptance and until authoritative product import/sync has populated `commerce_products`.
13. Completed externally and in code: the parallel `Third Railify API` store and store-scoped token exist, and protected read-only store/product verification is implemented while the Wix-connected store remains active.
14. Later, implement Printful draft orders with no automatic confirmation only after a separately approved catalogue-reconciliation milestone.
15. Do not disconnect Wix.
16. Complete and verify the live Stripe business and payout setup directly in Stripe Dashboard.
17. Swap to live credentials only during a later explicitly approved production milestone.

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

Persist only safe verified account metadata, bounded status summaries, opaque order/provider IDs, authoritative integer totals, and immutable product-line snapshots. Never persist secret keys, webhook signing secrets, bank data, card data, identity documents, customer email/address/billing details, full private Stripe payloads, or team-member email addresses. Verify webhook signatures and ledger/order idempotency before any state transition. With the remote gate false and catalogue empty, deployment acceptance must not create a Checkout Session, PaymentIntent, charge, refund, payout, webhook, or order.

Configuration flags are proof-driven. `stripe_api_configured=true` requires a successful server-side `GET /v1/account` with a valid staging credential and returned `CA`/`cad` identity; the existence of `STRIPE_SECRET_KEY` alone is insufficient. `stripe_webhook_configured=true` requires a valid `v1` signature, an in-tolerance timestamp, a valid Stripe Event envelope, `livemode=false`, and acceptance into the duplicate-safe receipt path; the existence of `STRIPE_WEBHOOK_SECRET` alone is insufficient. Neither flag enables Checkout, live payment capture, payout readiness, order mutation, or fulfillment.

### Completed Stripe Workbench event destination

The completed Sandbox destination used these values; retain them as the operator reference and do not recreate or mutate it during configuration reconciliation:

| Stripe Workbench field | Exact value |
| --- | --- |
| Environment | Stripe Sandbox |
| Workbench area | Webhooks / Event destinations |
| Events from | Your account |
| Payload | Snapshot event |
| Event API version | The account's normal/default supported API version; do not deliberately select preview or beta |
| Event type | `checkout.session.completed` only |
| Destination type | Webhook endpoint |
| Endpoint URL | `https://thirdrailify-admin.pages.dev/api/webhooks/stripe` |
| Suggested name/description | `Third Railify Admin - Staging` |

After creation, Stripe displays a signing secret beginning `whsec_`. Save it only as `STRIPE_WEBHOOK_SECRET` in ThirdRailify-Admin → Cloudflare Pages → Production → encrypted Secret. Do not put it in ThirdRailify Public, `wrangler.jsonc`, D1, Git, browser code, logs, responses, or an example file with a real value. Do not retrieve, reveal, rotate, or change `STRIPE_SECRET_KEY` while performing this step.

The staging receiver accepts only `v1` HMAC-SHA256 signatures over the exact raw body, uses a fixed 300-second past/future timestamp tolerance, rejects event-envelope `livemode=true`, and enforces duplicate Event IDs by provider plus Event ID. Its only recognized event is `checkout.session.completed`: the existing historical disabled event stays unchanged, while a future linked TEST Session must match local order references, Session ID, mode, CAD amount, paid status, and environment before one `pending` to `paid` transition. Other valid test events are ignored; unknown or invalid Checkout Sessions are bounded no-ops. No webhook submits fulfillment.

## Printful and PayPal boundaries

The permanent Printful store is `Third Railify API`, safe Store ID `18668025`, created as a separate Manual Order/API store while the Wix-connected store stays active. Live read-only verification resolved the token to exactly this one `native` store and one visible product; the Wix store was not selected. Printful's API itself is real and has no Stripe-style sandbox here. Pre-cutover safety comes from the dedicated store, a single-store token, `draft_only`, and disabled fulfillment—not a fake provider environment.

Store the Private Token only as the Admin Production encrypted secret `PRINTFUL_API_TOKEN`; never retrieve or expose its value. The protected read-only `/stores` action established the numeric ID, now stored only as the safe Wrangler-owned `PRINTFUL_STORE_ID=18668025` variable. Verification must see exactly one native `Third Railify API` store and require token-resolved, configured, and persisted IDs to agree after configuration. It may call only `GET /stores` and `GET /store/products?limit=1`; it must never send `X-PF-Store-Id` during initial store-scoped discovery or perform a Printful POST, PUT, PATCH, or DELETE.

Keep `printful_order_mode=draft_only`, fulfillment submission disabled, webhooks unconfigured, and explicit confirmation required after authoritative payment reconciliation. The existing Wix store is a future catalogue migration source only and must not be accessed or modified by this token. Stripe never pays Printful directly.

The catalogue action is `POST /api/admin/commerce/printful/catalogue/snapshot`, exposed as **Run read-only catalogue snapshot** on `/commerce/fulfillment`. One click uses short-lived signed phases on that same route so no Pages invocation approaches the 50 external-subrequest ceiling: manifest pagination, bounded product details, conditional bounded file metadata, then provider-free verified assembly. Every phase retains the authenticated Admin session, exact origin, CSRF, commerce rate limit, commerce D1, and Master or `commerce.integrations.manage`; only final assembly records completion. No provider credential is sent in any request body or response.

After success the operator deliberately downloads `printful-wix-source.snapshot.json`, `printful-api-target.snapshot.json`, `public-wix-catalog.snapshot.json`, and `catalogue-reconciliation.json` through four separate controls. Do not weaken authentication or create a token-bearing local substitute. Provider transport may send only source `GET /stores`, paginated `GET /sync/products`, product-detail GETs and necessary file-detail GETs, plus the equivalent target `GET /stores`, paginated `GET /store/products`, product-detail GETs and necessary file-detail GETs. Runtime never reads or writes `commerce-import`; that directory remains offline evidence/schema documentation only.

Do not configure PayPal credentials yet. Its future direct-merchant REST credentials are `admin_encrypted`, and it remains limited to later `/donate` and possible VIP work rather than preferred shop checkout. Do not design partner onboarding.

## Acceptance before any production plan

Require evidence for exact D1 identity and migration, secret presence without values, role/capability enforcement, CSRF/rate limits/audit redaction, read-only Stripe account identity, webhook signature/idempotency, test Checkout redirect and completion, wallet eligibility, refund/dispute handling, order reconciliation, Printful draft creation, explicit no-confirm behavior, and Public's no-secret boundary.

Keep Wix connected throughout testing. A later production cutover requires its own inventory/order/customer/policy reconciliation, URL plan, rollback plan, and explicit approval. No deployment or live provider activation is part of this runbook's current execution.
