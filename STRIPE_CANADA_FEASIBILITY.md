# Stripe Canada feasibility

Reviewed against current official Stripe documentation on 2026-08-27. This is a source-based feasibility result, not a review of the existing Brainstream Media Group Stripe Dashboard and not provider acceptance.

## Result

The requested Canadian merchant model is generally supported by Stripe:

- Stripe lists Canada as a supported business country and CAD as a supported presentment currency.
- Connect lists Canada among connected-account countries, but the actual countries available depend on the platform's country, profile, enabled features, and Stripe configuration.
- A connected account with full Stripe Dashboard access can complete Stripe-hosted onboarding and manage requirements, finances, disputes, refunds, reporting, and payouts.
- Direct charges place the payment and resulting balance on the connected account. With the fee payer configured as the connected account, the connected account pays Stripe processing fees. The platform can omit application fees.
- Direct card charges require the connected account's `card_payments` capability to be active.
- Stripe Checkout supports cards and eligible Apple Pay/Google Pay presentation. Wallet display is conditional on payment-method enablement, HTTPS/domain registration where applicable, supported browser/device, customer wallet/card, currency, and other Checkout restrictions; it must never be promised for every session.
- Canadian connected accounts can receive CAD payouts. Instant Payouts exist for eligible Canadian accounts using eligible external accounts; Stripe currently documents Canadian Connect Instant Payout eligibility through supported debit cards/institutions. Eligibility must be checked in the account, not assumed.
- Canadian verification requirements vary by account country, capabilities, business type/structure, service agreement, and risk. Stripe localizes a business tax ID as a Business Number and may require business, representative, owner/controller, address, tax, bank, and document information.

## Intended configuration

| Concern | Intended selection |
| --- | --- |
| Platform operator | Brainstream Media Group / Daniel's existing Connect platform |
| Merchant | Third Railify Official / Shawn |
| Connected country/currency | Canada / CAD |
| Dashboard | Full Stripe Dashboard |
| Onboarding | Stripe-hosted, one-time Account Link from authenticated Admin |
| Charge model | Direct charges |
| Fee payer | Connected account (`controller.fees.payer=account` or the platform's supported equivalent) |
| Application fee | None by default |
| Loss liability | Stripe-managed, only if available/approved for the exact platform configuration |
| Payment UI | Stripe Checkout Sessions |
| Methods | Cards; Apple Pay and Google Pay only when eligible |
| Payout owner | Connected merchant account |

Shawn's identity documents, representative/ownership information, bank details, and Stripe agreements stay in Stripe-hosted onboarding and the full Stripe Dashboard. Third Railify Admin stores only the connected account ID and safe status/requirements metadata. Account Links are single-use and must be created server-side for an authenticated authorized administrator; they must not be emailed or persisted as reusable credentials.

## Mandatory Dashboard check

Repository code cannot prove the existing Connect platform's country or platform profile. Before any account creation, Daniel must inspect the real Connect Dashboard and confirm all of the following for this specific platform:

1. The platform is approved for Connect and its country/configuration permits a Canadian connected account.
2. Full Stripe Dashboard access and Stripe-hosted onboarding are available for that account configuration.
3. Direct charges with `card_payments` are available.
4. The connected account can be the merchant of record and payout owner.
5. Stripe fees are paid by the connected account (`controller.fees.payer=account` or the exact current Dashboard/API equivalent).
6. Stripe-managed payment-loss liability is available for the selected controller configuration.
7. CAD settlement and the intended Canadian external account are supported.
8. Apple Pay/Google Pay payment-method and domain requirements can be satisfied for the final checkout surface.
9. Test-mode Connect webhook and event-destination requirements for the chosen Accounts API version are understood.

If any item differs, the design must be revised before a connected account is created. This milestone deliberately does not call Stripe, create an account or Account Link, configure a webhook/domain, or create a payment.

## Official sources

- [Stripe global availability](https://stripe.com/en-ca/global)
- [How Connect works and country availability](https://docs.stripe.com/connect/how-connect-works)
- [Stripe-hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding)
- [Full Dashboard access for SaaS merchants](https://docs.stripe.com/connect/saas/tasks/dashboard)
- [Connect charge types and direct-charge behavior](https://docs.stripe.com/connect/charges)
- [Direct-charge fee payer behavior](https://docs.stripe.com/connect/direct-charges-fee-payer-behavior)
- [Supported currencies](https://docs.stripe.com/currencies)
- [Identity verification for Canadian connected accounts](https://docs.stripe.com/connect/identity-verification?country=CA)
- [Apple Pay](https://docs.stripe.com/apple-pay?platform=web) and [Google Pay](https://docs.stripe.com/google-pay?platform=web)
- [Payment-method domain registration](https://docs.stripe.com/payments/payment-methods/pmd-registration)
- [Instant Payout institution support](https://docs.stripe.com/payouts/instant-payouts-banks) and [Connect Instant Payouts](https://docs.stripe.com/connect/instant-payouts)

