# Third Railify — PayPal Setup Guide for Shawn

## What this is for

Third Railify is moving store purchases and one-time donations to **PayPal** as the preferred payment provider. Stripe remains installed for possible future use, but it is currently disabled.

The setup requires a PayPal **Business** account and two PayPal REST applications:

- a **Sandbox** app for fake-money testing;
- a **Live** app for real production payments.

## Important security rules

Do **not** send any of the following through ChatGPT, email, Discord, screenshots, or source control:

- PayPal password;
- 2FA code;
- recovery code;
- Sandbox Client Secret;
- Live Client Secret;
- OAuth access tokens.

Client Secrets should only be entered directly into the masked Third Railify setup prompt on Daniel's development machine.

## Recommended setup approach

### Option A — Set it up together

This is the preferred option.

1. Shawn signs in to the PayPal Business account and PayPal Developer Dashboard himself.
2. Daniel and Shawn work through the PayPal app setup together.
3. When a Client Secret is needed, Shawn enters it directly into the masked Third Railify setup prompt, or pastes it directly into that prompt during the setup session.
4. The Third Railify CLI stores the secret directly in encrypted Cloudflare secret storage.
5. The secret is never written into Git or documentation.

### Option B — Temporary secondary-user access

If easier, Shawn can add Daniel as a temporary **secondary PayPal Business user** rather than sharing the primary PayPal password.

In the PayPal Business account:

1. Open **Account Settings**.
2. Open **Manage users**.
3. Choose **Add user**.
4. Add Daniel using his own login identity.
5. Grant only the permissions required to configure the payment/developer integration.
6. If PayPal does not permit the secondary user to manage Developer Dashboard apps, Shawn should remain logged in and perform those specific Developer Dashboard steps while Daniel handles the Third Railify CLI.
7. After setup is complete, remove the temporary user or reduce the permissions again.

**Do not share Shawn's primary PayPal password.**

---

# Part 1 — Confirm the PayPal account is ready

1. Sign in to the PayPal Business account that should receive Third Railify store and donation funds.
2. Complete any PayPal-requested account verification or business information truthfully.
3. Resolve any PayPal account limitation before Live activation.
4. Do not invent legal or business details if PayPal asks for information that is not immediately known.

PayPal's production API requires an eligible/verified Business account.

---

# Part 2 — Create or select the Sandbox REST app

1. Open the PayPal Developer Dashboard:
   - https://developer.paypal.com/
2. Open **Apps & Credentials**.
3. Switch to **Sandbox**.
4. Under REST API apps, create a new app or select the existing Third Railify Sandbox app.
5. If PayPal asks for the app type, use the standard **Merchant/direct-payment** type, not a Partner/Platform marketplace integration.
6. Suggested app name:
   - `Third Railify Sandbox`
7. Ensure normal payment acceptance is enabled for the app.
8. Third Railify does **not** need subscriptions, recurring billing, vaulting, or marketplace functionality for this milestone.
9. Record securely:
   - Sandbox Client ID
   - Sandbox Client Secret

Do not send the Sandbox Client Secret through chat.

---

# Part 3 — Prepare a Sandbox buyer account

The Sandbox payment acceptance tests require a fake buyer account.

1. In the Developer Dashboard open **Testing Tools → Sandbox Accounts**.
2. Find a **Personal** Sandbox account.
3. Open **View/Edit Account**.
4. Note the Sandbox email and generated Sandbox password.
5. If no Personal Sandbox account exists, create one.

These are fake-money test credentials only.

Do not use a real PayPal buyer account or a real bank/card for Sandbox testing.

---

# Part 4 — Configure Third Railify Sandbox

On Daniel's development machine:

1. Open a terminal in:

   `X:\GIT\ThirdRailify-Admin`

2. Use Node.js **22.16.0**.
3. Run:

   `npm run commerce:paypal -- configure sandbox`

4. Enter the Sandbox Client ID when requested.
5. Enter the Sandbox Client Secret only into the **masked secret prompt**.

The Third Railify setup CLI is designed to:

- verify Sandbox OAuth;
- find/reuse or create the canonical Sandbox webhook;
- reconcile the exact supported event set;
- store the Client Secret securely in Cloudflare;
- store the Webhook ID securely;
- persist only sanitized configuration evidence;
- redeploy the required Admin configuration where necessary.

Then run:

`npm run commerce:paypal -- verify sandbox`

Expected result: Sandbox credentials and webhook configuration show as configured/verified.

---

# Part 5 — Sandbox acceptance tests

After Sandbox configuration is successful, Daniel/Codex will run at most:

- one fake-money Sandbox store purchase;
- one fake-money Sandbox donation.

The Sandbox store transaction must **not** enter real Printful production fulfillment.

The Sandbox donation must never create a Printful order.

No real money should move during these tests.

---

# Part 6 — Create or select the Live REST app

1. Return to **PayPal Developer Dashboard → Apps & Credentials**.
2. Switch from **Sandbox** to **Live**.
3. Create a new REST app or select the existing Third Railify Live app.
4. Use the normal direct Merchant/payment app type if PayPal asks.
5. Suggested app name:
   - `Third Railify Live`
6. Ensure standard payment acceptance is available.
7. Record securely:
   - Live Client ID
   - Live Client Secret

Do **not** send the Live Client Secret through chat, email, screenshots, or Git.

No Live payment is required just to configure the integration.

---

# Part 7 — Configure Third Railify Live

On Daniel's development machine, from:

`X:\GIT\ThirdRailify-Admin`

run:

`npm run commerce:paypal -- configure live`

Enter the Live Client ID and Live Client Secret into the secure prompts.

The setup CLI should:

- validate the credentials against PayPal's Live API;
- find/reuse or create the Live webhook;
- reconcile the supported event set;
- store the Live Client Secret in encrypted Cloudflare secret storage;
- store the Live Webhook ID securely;
- read the webhook configuration back;
- redeploy the required configuration;
- keep Live checkout disabled until Third Railify's production launch gates pass.

Then run:

`npm run commerce:paypal -- verify live`

This verification should create **no Live PayPal Order and no Live Capture**.

---

# Part 8 — Webhooks

Third Railify already has its PayPal webhook receiver implemented.

The Third Railify setup CLI should configure the PayPal webhook automatically.

**Do not manually add another PayPal webhook unless the setup CLI explicitly reports that manual intervention is required.**

The implemented event set is:

- `CHECKOUT.ORDER.APPROVED`
- `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
- `PAYMENT.CAPTURE.PENDING`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DECLINED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`

The setup tool should reuse an existing matching webhook rather than create duplicates.

---

# Part 9 — Final activation

Once Sandbox and Live PayPal setup passes, Daniel/Codex will run the Third Railify production readiness check.

PayPal **donations** can be activated independently once the Live PayPal and webhook requirements pass.

The **store** also needs the existing store-specific requirements to pass, including shipping, Customer/Order authority, tax-policy handling, and Printful fulfillment readiness.

Stripe remains installed but disabled.

No real PayPal purchase should be created merely to switch the store on.

---

# Information Shawn may need to complete personally

PayPal may ask the primary Business account owner for information Daniel should not guess, including:

- identity verification;
- legal business information;
- beneficial owner or authorised representative information;
- account limitation resolution;
- compliance questions.

Shawn should answer those directly and accurately inside PayPal.

If PayPal requests an unknown legal/business fact, stop at that screen and record only the **name of the field or requirement**. Do not send sensitive documents or credentials through chat.

---

# Security checklist

- [ ] Shawn's primary PayPal password was never shared.
- [ ] No 2FA or recovery code was shared.
- [ ] No Client Secret was sent through ChatGPT or messaging.
- [ ] Client Secrets were entered only into the masked Third Railify setup prompt.
- [ ] No secret was committed to Git.
- [ ] Sandbox and Live credentials were kept separate.
- [ ] Sandbox buyer credentials were used only for Sandbox testing.
- [ ] No Live purchase was created during setup.
- [ ] If Daniel was added as a secondary PayPal user, the access was removed or reduced afterward.
- [ ] Stripe remains configured but disabled.
- [ ] PayPal is activated only after Third Railify's readiness check passes.

---

# What Daniel needs from Shawn during the setup session

1. Access to the PayPal Business account or Shawn present during setup.
2. Sandbox Client ID.
3. Sandbox Client Secret entered directly into the masked CLI prompt.
4. Sandbox Personal buyer account credentials for the fake-money acceptance test.
5. Live Client ID.
6. Live Client Secret entered directly into the masked CLI prompt.
7. Shawn's direct response to any owner-only PayPal verification requirement.

Do not put the secrets themselves into this document.

---

## Official PayPal references

- PayPal Developer Dashboard / REST API: https://developer.paypal.com/api/get-started/
- PayPal production setup: https://developer.paypal.com/api/rest/production
- PayPal Sandbox accounts: https://developer.paypal.com/api/get-started/
- PayPal Business secondary users: https://www.paypal.com/uk/cshelp/article/how-do-i-manage-users-on-my-business-account-help274
