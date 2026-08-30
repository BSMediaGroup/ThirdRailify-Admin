# Third Railify — PayPal Operator Setup Guide for Daniel

## Purpose

This is the operator checklist for completing Third Railify's PayPal onboarding after the PayPal architecture has already been implemented and deployed.

PayPal is the preferred payment provider for:

- store purchases;
- one-time donations.

Stripe remains configured but disabled and must not block PayPal launch readiness.

## Security rules

Never paste these into ChatGPT, documentation, screenshots, command arguments, Git, or D1:

- PayPal Client Secret;
- OAuth access token;
- PayPal password;
- 2FA/recovery code.

Use the masked setup CLI prompts only.

---

# 1. Preflight

From:

`X:\GIT\ThirdRailify-Admin`

confirm the repository is in the expected state and use Node.js 22.16.0.

Then run:

`npm run commerce:paypal -- status`

Expected current state before credentials are added:

- preferred provider: PayPal;
- Stripe: configured / disabled / non-preferred;
- Sandbox credentials: missing;
- Live credentials: missing;
- Sandbox webhook: unconfigured;
- Live webhook: unconfigured;
- store checkout: disabled;
- donations: disabled;
- live capture: disabled.

Do not change those gates manually before provider verification.

---

# 2. Sandbox credentials

Obtain from Shawn's PayPal Developer Dashboard:

- Sandbox Client ID;
- Sandbox Client Secret.

Do not ask Shawn to send the Secret through chat.

Run:

`npm run commerce:paypal -- configure sandbox`

Enter values through the prompts.

Then run:

`npm run commerce:paypal -- verify sandbox`

Verify the CLI reports:

- OAuth success;
- canonical webhook configured/reused;
- exact event set read back;
- Webhook ID securely stored;
- no secret printed.

Canonical webhook route should be the deployed Third Railify PayPal webhook route currently implemented by the Admin application.

The code's authoritative event allowlist should remain:

- CHECKOUT.ORDER.APPROVED
- CHECKOUT.PAYMENT-APPROVAL.REVERSED
- PAYMENT.CAPTURE.PENDING
- PAYMENT.CAPTURE.COMPLETED
- PAYMENT.CAPTURE.DECLINED
- PAYMENT.CAPTURE.REFUNDED
- PAYMENT.CAPTURE.REVERSED

Do not manually create a duplicate webhook unless the CLI explicitly reports that it cannot reconcile the provider configuration.

---

# 3. Sandbox buyer

Obtain a PayPal **Personal Sandbox** account from:

PayPal Developer Dashboard → Testing Tools → Sandbox Accounts.

Use the fake Sandbox buyer email/password only for the controlled acceptance.

Do not use a real PayPal account/card.

---

# 4. Run Sandbox store acceptance

After Sandbox OAuth and webhook verification pass, run the repository's bounded Sandbox store acceptance workflow.

Requirements:

- maximum one PayPal Sandbox store Order;
- maximum one Capture;
- server-owned product/shipping/total;
- fake-money Sandbox only;
- no real Printful order mutation;
- no production fulfillment;
- no production customer email.

Verify the resulting normalized payment attempt is Sandbox, not Live.

Do not repeat after success.

---

# 5. Run Sandbox donation acceptance

Run one bounded one-time Sandbox donation through the existing Donations page/workflow.

Requirements:

- maximum one PayPal Sandbox donation Order;
- maximum one Capture;
- no merchandise Order dependency;
- no shipping;
- no Printful;
- no production customer email;
- no tax-deductibility claim.

Do not repeat after success.

---

# 6. Live credentials

Obtain from Shawn's PayPal Developer Dashboard:

- Live Client ID;
- Live Client Secret.

Run:

`npm run commerce:paypal -- configure live`

Then:

`npm run commerce:paypal -- verify live`

The Live verification must:

- authenticate against PayPal Live OAuth;
- list/reuse or create the canonical Live webhook;
- reconcile the supported event set;
- securely store the Live Webhook ID;
- read configuration back;
- create no Live PayPal Order;
- perform no Live Capture.

---

# 7. Verify Admin state

In Third Railify Admin → Payments & Payouts, PayPal should report environment-specific states for:

Sandbox:

- Client credentials configured;
- OAuth verified;
- webhook configured/read back;
- Sandbox acceptance passed/not run.

Live:

- Client credentials configured;
- OAuth verified;
- webhook configured/read back.

Stripe should remain:

- configured;
- disabled;
- non-preferred;
- future option.

No secret value should be displayed.

---

# 8. Donation activation

Donations can be activated independently if the Live PayPal donation readiness plan passes.

Do not require Printful, shipping, sellable products, fulfillment, Stripe, Resend, or invoice readiness for donations.

Activate donations only through the canonical Third Railify launch/readiness authority.

Do not create a Live donation merely to prove activation.

---

# 9. Store activation

Run the existing canonical store launch/readiness plan.

The store should only activate when the actual hard requirements pass, including:

- PayPal Live OAuth;
- PayPal Live webhook readback;
- PayPal preferred state;
- sellable catalogue;
- Customer/Order authority;
- approved production shipping strategy;
- legitimate current tax-policy state;
- Printful fulfillment automation;
- emergency pause clear.

Stripe must not block launch while intentionally disabled.

If every hard gate passes, use the canonical atomic launch mechanism to enable PayPal store checkout/live capture and future LIVE fulfillment.

Do not create a Live transaction during activation.

---

# 10. If Business/Tax still block the store

The previous PayPal onboarding run reported two separate non-PayPal blockers:

- private business address missing;
- tax policy unconfigured.

Re-query the current authority after PayPal is configured.

Do not invent either value.

If still blocked, record the exact owner-supplied field needed and complete the donations activation if its independent PayPal gates already pass.

---

# 11. Final verification

Confirm:

- PayPal is preferred;
- Stripe remains disabled;
- Sandbox and Live webhook configurations are distinct;
- no duplicate webhook registrations exist;
- Sandbox evidence remains Sandbox-only;
- no Sandbox transaction reached Printful;
- no Live PayPal Order/Capture was created during setup;
- Public exposes only browser-safe Client ID/configuration;
- Client Secret and OAuth token remain server-only;
- emergency pause remains functional.

---

# 12. If Shawn grants temporary PayPal access

Prefer a PayPal Business secondary user rather than primary credential sharing.

After setup:

1. Confirm the Live integration and webhook configuration are complete.
2. Ask Shawn to remove the temporary secondary user or reduce its permissions.
3. Do not store Shawn's PayPal login details anywhere in Third Railify configuration.

---

## Official PayPal references

- REST API getting started: https://developer.paypal.com/api/get-started/
- Production setup: https://developer.paypal.com/api/rest/production
- Sandbox accounts: https://developer.paypal.com/api/get-started/
- Business secondary users: https://www.paypal.com/uk/cshelp/article/how-do-i-manage-users-on-my-business-account-help274
