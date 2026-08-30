# Third Railify PayPal operator setup for Daniel

## Scope and security boundary

This runbook completes provider onboarding for the already-implemented PayPal Orders API v2 store and one-time donation architecture. It does not redesign payment authority.

Work from `X:\GIT\ThirdRailify-Admin` with Node.js 22.16.0. Never place a Client Secret, OAuth token, PayPal password, 2FA code, recovery code, Admin session cookie, or CSRF value in ChatGPT, command arguments, documentation, Git, D1 plaintext, screenshots, or test snapshots. Client Secrets belong only in the masked setup CLI prompt and encrypted Cloudflare bindings.

The named bindings are isolated by environment:

- `PAYPAL_SANDBOX_CLIENT_ID`
- `PAYPAL_SANDBOX_CLIENT_SECRET`
- `PAYPAL_SANDBOX_WEBHOOK_ID`
- `PAYPAL_LIVE_CLIENT_ID`
- `PAYPAL_LIVE_CLIENT_SECRET`
- `PAYPAL_LIVE_WEBHOOK_ID`

## Precheck

Run:

```powershell
npm run commerce:paypal -- status
```

Before credentials, expect:

- PayPal preferred
- Stripe configured, disabled, and non-preferred
- Sandbox Client ID, Client Secret, and Webhook ID missing
- Live Client ID, Client Secret, and Webhook ID missing
- Sandbox and Live OAuth unverified
- Sandbox and Live webhooks unconfigured
- store checkout disabled
- donations disabled
- PayPal Live capture disabled
- emergency pause clear

`status` is provider-read-only: it checks named Cloudflare binding presence and sanitized Commerce D1 evidence and makes zero PayPal calls. Future Sandbox and Live onboarding must use `https://admin.thirdrailify.com/api/webhooks/paypal` as the canonical callback.

## Sandbox configuration

Obtain the Sandbox Client ID and have Shawn enter the Sandbox Client Secret directly into the masked prompt. Run:

```powershell
npm run commerce:paypal -- configure sandbox
npm run commerce:paypal -- verify sandbox
```

For both commands, supply credentials only through the secure prompts. Required proof is:

- OAuth succeeds against the Sandbox host.
- The access token is neither printed nor persisted.
- The CLI lists webhooks before considering a create.
- One exact canonical URL match is reused when present.
- The exact implemented event set is reconciled.
- A duplicate canonical webhook causes a fail-closed operator error.
- At most one webhook is created when no match exists.
- The Sandbox Webhook ID is stored in its named encrypted Cloudflare binding.
- Provider readback matches the canonical URL and exact event set.
- Sanitized D1 readiness readback succeeds.
- No credential, token, raw provider object, or Webhook ID is written to D1 evidence.

The configured events must be exactly:

- `CHECKOUT.ORDER.APPROVED`
- `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
- `PAYMENT.CAPTURE.PENDING`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DECLINED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`

Do not manually create a webhook unless the CLI explicitly reports that operator intervention is required.

## Sandbox store acceptance

Proceed only when legitimate **Personal Sandbox buyer** credentials are available and the Sandbox configuration/readback passes.

Use the existing Public checkout and one current sellable product. Use a synthetic, non-personal customer name, email, phone if required, and delivery address. The server remains authoritative for product, variant, quantity bounds, shipping quote, currency, and total.

The absolute limit for this acceptance is:

- one Sandbox store Order maximum
- one Sandbox store Capture maximum

Required evidence is one normalized completed Sandbox payment attempt associated with the local store order. Explicitly verify all of the following before declaring acceptance:

- the environment is Sandbox, never Live;
- no production Printful draft was created;
- no Printful order was confirmed;
- no production fulfillment job or submission ran;
- no production customer email was sent.

Stop after the first successful bounded acceptance. Do not repeat it for convenience.

## Sandbox donation acceptance

Proceed only after Sandbox configuration/readback passes and the fake Personal Sandbox buyer is available.

The absolute limit is:

- one Sandbox donation Order maximum
- one Sandbox donation Capture maximum

Required evidence is that the local donation record existed before the provider Order and reached normalized completed Sandbox state after Capture. Verify that the flow has:

- no merchandise commerce-order requirement;
- no shipping or delivery requirement;
- no product catalogue dependency;
- no Printful draft, confirmation, or fulfillment action;
- no production customer email;
- no tax-deductible claim.

Stop after the first successful bounded acceptance.

## Live configuration

Have Shawn enter the Live Client Secret only into the masked prompt, then run:

```powershell
npm run commerce:paypal -- configure live
npm run commerce:paypal -- verify live
```

Required proof is:

- OAuth succeeds against PayPal's production host.
- The Live webhook is listed and exactly reused, created once if absent, or reconciled once if required.
- The canonical URL and exact event set read back correctly.
- The Live Webhook ID is stored in its separate encrypted Cloudflare binding.
- Sanitized Live readiness evidence reads back successfully.
- No Live PayPal Order is created.
- No Live Capture, donation, real-money payment, Stripe call, or Printful mutation occurs.

Sandbox and Live webhooks, IDs, credentials, hosts, and evidence must remain distinct.

## Admin verification

Open **Payments & Payouts** and confirm it agrees with the CLI and current authority.

Sandbox should show:

- credentials configured
- OAuth verified
- webhook configured and read back
- store acceptance passed or not run
- donation acceptance passed or not run

Live should show:

- credentials configured
- OAuth verified
- webhook configured and read back

Stripe should show:

- configured
- disabled
- non-preferred
- retained as a future option

The UI must not display a Client Secret, OAuth token, password, or sensitive provider payload.

## Donation activation

Use the canonical donation launch plan, not the store plan. Review the current plan before executing its protected, revision-guarded activation.

Donation hard gates are limited to current PayPal preference with Stripe disabled, verified Live OAuth, verified Live webhook readback, the Canadian CAD direct-merchant connection, and a clear emergency pause. Donation readiness must not require Printful, shipping, products, catalogue, fulfillment, Stripe, Resend, transactional email, or invoice readiness.

When every current donation hard gate is ready, use the canonical atomic donation activation. It enables Live PayPal capture for donations and the donation gate while keeping store checkout disabled. Do not make a Live donation to prove configuration or activation. Re-read the stable Public Donations payment configuration afterward.

## Store activation

Use the canonical store launch plan and re-query it immediately before any action. Stripe is intentionally disabled and is **not** a hard launch gate.

The current canonical hard gates cover:

- PayPal preferred and Stripe disabled
- Live PayPal credentials and OAuth verified
- Live PayPal direct-merchant connection
- Live webhook configured and read back
- emergency pause clear
- canonical customer/order and Commerce D1 authority available
- a sellable, target-verified catalogue
- an approved active shipping strategy and market
- a legitimate explicit tax-policy state
- verified Printful target, signed webhook, terminal catalogue migration, and operations worker readiness
- production fulfillment readiness

If every hard gate passes, use the canonical atomic activation to enable PayPal store checkout, PayPal Live capture, normal checkout, the already-approved production shipping strategy, and future Live Printful fulfillment submission. Keep Stripe disabled/non-preferred and emergency pause clear. Activation itself must create no Live PayPal transaction.

Do not manually toggle individual settings around the launch plan.

## Business and tax facts

A previous read reported:

- private business address missing
- tax policy unconfigured

These are historical observations, not permanent truth. Re-query the actual Business Information, Tax & Documents, and canonical launch-plan authority after PayPal setup. Do not invent an address, registration, collection rule, tax policy, or legal answer.

If the store is still blocked, record only the exact owner-supplied field or requirement name. Complete donation activation independently if its own PayPal gates pass.

## Temporary PayPal access cleanup

If Shawn created a temporary PayPal Business secondary user for Daniel:

1. Verify Sandbox and Live configuration and webhook readback.
2. Have Shawn remove the secondary user or reduce its permissions.
3. Never store Shawn's or Daniel's PayPal login credentials in Third Railify.

## Final verification checklist

- [ ] PayPal is preferred.
- [ ] Stripe is configured, disabled, and non-preferred.
- [ ] Sandbox and Live credentials use separate named bindings.
- [ ] Sandbox and Live webhooks are distinct.
- [ ] Exactly one canonical webhook exists per environment; no duplicate was created.
- [ ] The exact seven-event set reads back in both configured environments.
- [ ] Sandbox store evidence cannot reach production Printful.
- [ ] Sandbox donation evidence has no shipping, merchandise, or Printful semantics.
- [ ] No production customer email was sent during Sandbox acceptance.
- [ ] No Live PayPal Order, Capture, donation, or real-money payment occurred during setup.
- [ ] Client Secrets and OAuth tokens remain server-only and absent from Git, docs, logs, D1 plaintext, and browser payloads.
- [ ] Donations were activated only through their independent launch plan.
- [ ] Store activation occurred only if every current canonical hard gate passed.
- [ ] Emergency pause still closes checkout, donations, Live capture, and fulfillment through the canonical path.
- [ ] Temporary PayPal secondary-user access was removed or reduced.
