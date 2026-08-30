# PayPal commerce operations

PayPal Orders API v2 with `intent=CAPTURE` is the preferred direct-merchant payment rail for physical store purchases and one-time donations. Both use one server adapter, one verified webhook receiver, and provider-neutral payment attempts. Store orders retain Customer, immutable item, encrypted delivery, shipping, and Printful authorities; donations use `commerce_donations` and can never enqueue Printful. Stripe remains implemented and historically readable, but is configured, disabled, non-preferred, and excluded from PayPal launch readiness.

## Runtime custody

Configure these as encrypted Admin Pages secrets, never Public or Worker values:

- `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET`, `PAYPAL_SANDBOX_WEBHOOK_ID`, and optional `PAYPAL_SANDBOX_MERCHANT_ID`
- `PAYPAL_LIVE_CLIENT_ID`, `PAYPAL_LIVE_CLIENT_SECRET`, `PAYPAL_LIVE_WEBHOOK_ID`, and optional `PAYPAL_LIVE_MERCHANT_ID`

Sandbox and Live use separate apps, credentials, Webhook IDs, and API origins. The browser receives only the selected environment's Client ID after D1 configuration and webhook gates are ready. OAuth tokens and Client Secrets remain server-only.

Use the repository-local operator CLI; it rejects credentials on command-line arguments and writes secrets directly to Admin Pages encrypted custody:

```text
npm run commerce:paypal -- status
npm run commerce:paypal -- configure sandbox
npm run commerce:paypal -- verify sandbox
npm run commerce:paypal -- configure live
npm run commerce:paypal -- verify live
```

`configure` reads `PAYPAL_<ENV>_CLIENT_ID` and `PAYPAL_<ENV>_CLIENT_SECRET` from the named process environment or uses masked interactive prompts. It validates OAuth, reconciles exactly one canonical webhook, stores all three bindings through `wrangler pages secret put` stdin, deploys Admin, and then records only sanitized OAuth/webhook readback evidence in Commerce D1. Never put credentials in CLI arguments, source, committed JSON, or browser storage.

Future onboarding must register the canonical production Admin URL `https://admin.thirdrailify.com/api/webhooks/paypal` for exactly:

- `CHECKOUT.ORDER.APPROVED`
- `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
- `PAYMENT.CAPTURE.PENDING`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DECLINED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`

The receiver verifies the exact event through PayPal's verification endpoint using the environment-specific Webhook ID. It stores normalized evidence and a digest, never the raw body. Simulator events are non-authoritative.

## Launch and rollback

Migration `0021_paypal_direct_merchant.sql` installs PayPal as preferred while closing store, donation, LIVE capture, fulfillment, email, and Stripe gates. Configure and read back provider identity/webhooks before enabling anything. Donations may be enabled independently of shipping and Printful; store activation still requires catalogue, Customer/Order, shipping, tax-policy, and fulfillment readiness. Emergency pause immediately blocks new creates/captures while allowing completed evidence reconciliation.

Use the existing commerce launch API/CLI for authorized store activation or pause. A rollback closes PayPal store, donation, and LIVE capture settings and leaves Stripe disabled. Restoring Stripe requires a separately authorized milestone that changes the canonical preferred provider and gates; no Stripe history or implementation needs to be rebuilt.

No LIVE acceptance order is required or permitted. Sandbox completions never enqueue Printful or production email; LIVE completed store captures enter the existing fulfillment job once, while donations never do.
