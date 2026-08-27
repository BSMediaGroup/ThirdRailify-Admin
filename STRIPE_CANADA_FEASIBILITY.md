# Stripe Canada feasibility

Reviewed against current official Stripe documentation on 2026-08-27. This records the confirmed dedicated-account position and remaining activation checks; it is not provider acceptance or proof of live readiness.

## Confirmed direct-account position

The authoritative integration is the dedicated Third Railify Official Canadian Stripe merchant account. It is separate from Brainstream Media Group, StreamSuites, DanielClancy, and every other project.

User-confirmed operational facts:

- The dedicated account exists.
- Its account name is Third Railify Official.
- Its country is Canada.
- Its currency and balance context is CAD.
- Stripe team access has been corrected by the account administrators.
- Stripe Sandbox/test mode is accessible.

Current official Stripe documentation lists Canada as a supported business country. Stripe Checkout supports a Stripe-hosted payment page, and Checkout Sessions are created server-side. Secret API keys and webhook signing secrets are server-side credentials and must not be exposed to browser code.

## Intended integration

| Concern | Authoritative selection |
| --- | --- |
| Merchant of record | Third Railify Official through its dedicated account |
| Account model | Direct dedicated merchant account |
| Country / currency | Canada / CAD |
| Charge ownership | Third Railify Official account |
| Payment UI | Stripe-hosted Checkout |
| Checkout Session mode | `payment` for shop purchases |
| Methods | Cards; Apple Pay and Google Pay only when eligible and enabled |
| Link | Optional only after later approval and enablement |
| Credential custody | Admin-only Cloudflare encrypted secrets |
| Business, KYC, banking, payouts, team | Stripe Dashboard |
| Checkout state | Disabled |
| Live activation | Not verified |
| Live payout readiness | Not verified |

The server will eventually authenticate with the dedicated account's own `STRIPE_SECRET_KEY`, retrieve and verify the account identity without hardcoding an `acct_...` value, create Checkout Sessions, and process signed webhooks into authoritative order/payment transitions. The Stripe-hosted redirect flow does not require Public to initialize Stripe.js.

## Remaining pre-live checks

1. Complete the Stripe account's business verification.
2. Configure the Canadian payout bank.
3. Confirm charges are enabled.
4. Confirm payouts are enabled.
5. Confirm the statement descriptor.
6. Confirm public business and support information.
7. Review payment-method settings.
8. Enable and test Apple Pay where eligible.
9. Enable and test Google Pay where eligible.
10. Configure a test webhook.
11. Conduct test-mode Checkout acceptance while the public checkout gate remains disabled.
12. Repeat approved acceptance with live keys only in a later production milestone.

Do not infer from account creation or Sandbox access that live business verification, payout banking, charges, payouts, Stripe Tax, Apple Pay, Google Pay, a live webhook, or live Cloudflare keys are complete.

## Superseded question

The previous feasibility question asked whether an existing platform could create and onboard a Canadian connected account. That question and its fee-payer, loss-liability, platform-country, Account Link, Dashboard-access, and direct-charge capability blockers are obsolete because Third Railify now has its own dedicated merchant account. This note does not preserve that model as an implementation option.

## Official sources

- [Stripe global availability](https://stripe.com/en-ca/global)
- [Checkout Sessions](https://docs.stripe.com/payments/checkout-sessions)
- [Stripe Checkout](https://docs.stripe.com/payments/checkout)
- [Checkout quickstart](https://docs.stripe.com/payments/checkout/quickstarts)
- [Save a payment method during payment](https://docs.stripe.com/payments/checkout/save-during-payment)
- [Express Checkout Element payment methods](https://docs.stripe.com/elements/express-checkout-element/accept-a-payment)
- [API keys](https://docs.stripe.com/keys)
- [Webhooks](https://docs.stripe.com/webhooks)
