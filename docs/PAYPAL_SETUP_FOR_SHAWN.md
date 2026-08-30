# Third Railify PayPal setup for Shawn

## Purpose

Third Railify is moving store purchases and one-time donations to PayPal. Stripe stays installed but disabled so it remains available as a possible future option.

Production API use requires a PayPal Business account. The account and app must belong to the business that will receive Third Railify's payments.

## Security rules

Do not send any of the following through chat, email, screenshots, documents, or Git:

- PayPal password
- two-factor authentication (2FA) code
- recovery code
- Sandbox Client Secret
- Live Client Secret
- OAuth access token

Client Secrets must be typed or pasted directly into Third Railify's masked local CLI prompt. The setup CLI sends each secret directly to encrypted Cloudflare storage. Nothing secret is committed to Git.

Do not put a secret into this guide, a terminal command argument, a source file, a note, or a screenshot.

## Setup option A: work together

1. Shawn signs in to the PayPal Business account and PayPal Developer Dashboard himself.
2. Daniel and Shawn work through **Apps & Credentials** together.
3. When the local CLI asks for a Client Secret, Shawn types or pastes it directly into the masked prompt on Daniel's machine.
4. The setup CLI verifies the app and writes the credential directly to encrypted Cloudflare storage.
5. Nothing secret is written to the repository or committed to Git.

## Setup option B: temporary secondary user

A safer alternative to password sharing is a temporary PayPal Business secondary user:

1. In the PayPal Business account, open **Account Settings**.
2. Open **Manage users**.
3. Select **Add user**.
4. Add Daniel using Daniel's own login.
5. Grant only the permissions required to configure the payment integration.
6. If PayPal does not make Developer Dashboard access available to the secondary user, Shawn performs those specific Dashboard steps himself.
7. After setup and verification, Shawn removes Daniel or reduces the temporary permissions.

**Do not share Shawn's primary PayPal password.**

## Create or select the Sandbox app

1. Open the **PayPal Developer Dashboard**.
2. Open **Apps & Credentials**.
3. Select **Sandbox**.
4. Create a REST app, or select the existing Third Railify Sandbox REST app.
5. Use a standard direct Merchant/payment app, not a Partner, Platform, or marketplace app.
6. Suggested app name: `Third Railify Sandbox`.
7. Use the standard **Accept Payments** capability.
8. Third Railify does not require subscriptions, recurring billing, vaulting, or marketplace capabilities.
9. Obtain the **Sandbox Client ID** and **Sandbox Client Secret**.

Keep the Sandbox Client Secret on the secure local setup path described above.

## Prepare a Sandbox buyer

In the PayPal Developer Dashboard, open:

**Testing Tools -> Sandbox Accounts**

Find or create a **Personal** Sandbox account. Its email and password are fake-money test credentials. They are used only for the controlled Sandbox buyer flow; they are not a real buyer account and must never be used against Live PayPal.

## Configure Third Railify Sandbox

On Daniel's machine, open a terminal in:

`X:\GIT\ThirdRailify-Admin`

Use Node.js 22.16.0, then run:

```powershell
npm run commerce:paypal -- configure sandbox
npm run commerce:paypal -- verify sandbox
```

The Client Secret input is masked. The setup CLI verifies Sandbox OAuth, lists and reconciles the canonical webhook, securely stores the credentials and Webhook ID in Cloudflare, and saves only sanitized readiness evidence. It never prints or persists the OAuth access token.

## Create or select the Live app

1. In **Apps & Credentials**, switch to **Live**.
2. Create a Live REST app, or select the existing Third Railify Live REST app.
3. Use the direct Merchant/payment model.
4. Suggested app name: `Third Railify Live`.
5. Use the standard **Accept Payments** capability.
6. Obtain the **Live Client ID** and **Live Client Secret**.

The Live app does not need subscriptions, recurring billing, vaulting, Partner, Platform, or marketplace capabilities for Third Railify's current store and donation flows.

## Configure Third Railify Live

From `X:\GIT\ThirdRailify-Admin`, run:

```powershell
npm run commerce:paypal -- configure live
npm run commerce:paypal -- verify live
```

The CLI authenticates against PayPal's Live OAuth service, reconciles and reads back the Live webhook, and stores the Live credential bindings securely. Configuration and verification do **not** create a Live PayPal Order, Capture, donation, or any other real-money transaction.

## Webhook note

Third Railify already has a PayPal webhook receiver at `https://admin.thirdrailify.com/api/webhooks/paypal`. Do **not** manually create another PayPal webhook unless the setup CLI explicitly says manual intervention is required.

The implemented event set is:

- `CHECKOUT.ORDER.APPROVED`
- `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
- `PAYMENT.CAPTURE.PENDING`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DECLINED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`

The setup CLI lists webhooks before any create, reuses the one exact matching callback when it exists, reconciles this exact event set, prevents duplicate creation, and reads the result back.

## Requirements only Shawn can complete

Shawn must personally answer any PayPal request for:

- identity verification
- legal business information
- beneficial-owner or authorised-representative information
- account limitation resolution
- compliance information

Daniel and Codex must not guess or suggest legal answers. If a requested fact is unknown, record only the name of the field or requirement and obtain the correct answer from the owner or appropriate adviser. Do not copy sensitive verification data into chat or project notes.

## Final activation

Sandbox is configured and tested first. Live receives configuration and readback verification only; no Live payment is required merely to activate configuration.

One-time donations can activate independently after their Live PayPal gates pass. The store has additional customer/order, catalogue, shipping, tax-policy, and Printful fulfillment readiness gates. Stripe remains installed but disabled and does not block a PayPal launch.

## Security checklist

- [ ] Shawn used the intended PayPal Business account.
- [ ] Shawn's primary PayPal password was never shared.
- [ ] No 2FA code or recovery code was shared.
- [ ] No Sandbox or Live Client Secret was sent through chat, email, or screenshots.
- [ ] No OAuth token was printed, copied, or stored.
- [ ] Client Secrets were entered only into the masked Third Railify CLI prompt.
- [ ] No secret was added to Git, D1 plaintext, documentation, notes, or test snapshots.
- [ ] Sandbox and Live apps and credentials were kept separate.
- [ ] Only a Personal Sandbox buyer was used for fake-money acceptance.
- [ ] The CLI reused or reconciled the canonical webhook instead of creating a duplicate.
- [ ] No Live Order, Capture, donation, or real-money payment occurred during setup.
- [ ] Temporary secondary-user access was removed or reduced after verification.
- [ ] Stripe remains disabled and PayPal remains preferred.
