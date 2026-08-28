# Third Railify commerce support runbook

Internal authorised-operator procedure as at 28 August 2026. The current system is pre-activation: normal checkout and fulfilment are disabled. This runbook documents investigation capability; it does not grant refund/remedy authority, activate checkout, or authorise provider mutations.

## Safe intake

Ask for the local `ord_…` order reference or exact Stripe `cs_test_…` Checkout Session ID, the item/variant, a short description, and relevant photographs for a physical defect. Never request or store a password, full card number, CVC, session cookie, OAuth credential, Stripe/Printful token, webhook secret, or raw provider payload. Confirm the requester through the contact channel associated with the future enabled order; the current accepted test order contains no customer email, billing address or shipping address.

Create an internal case reference and record every read, decision, escalation and authorised action. Keep customer-provided evidence separate from repository documentation and redact unrelated people/provider secrets.

## Current investigation path

1. Sign in to the Admin origin with an authorised account and open `/orders`.
2. Locate the exact local order. Admin exposes up to 100 newest local orders with product/variant/quantity, authoritative CAD total, Checkout state, payment state, signed-webhook evidence count, fulfilment state and whether a Printful order ID exists. It does not call Stripe/Printful for live support status.
3. Treat `payment_status=paid` as confirmed only when local order correlation and the signed Stripe webhook path agree. A return URL alone is not payment proof.
4. Confirm the environment. Current authority is TEST only. Do not represent a sandbox record as a real customer charge.
5. Confirm fulfilment state. Current expected state is `disabled / not started` and no Printful order. An unexpected provider ID/state is an incident escalation, not permission to mutate it.
6. Check the product/variant snapshot and target mapping in `/products` or `/commerce/fulfillment` only as needed. Never rerun or resume the permanent catalogue migration for a support inquiry.
7. Record the technical finding and escalate the remedy decision to the owner-authorised commerce lead. Preserve payment/webhook/audit evidence.

## Capability matrix

| Problem / action | Current capability | Missing workflow / required escalation |
| --- | --- | --- |
| Order lookup | Read-only bounded local lookup in `/orders`; exact-session bounded Public status route | No search by customer email/address because those fields are not collected/stored |
| Refund | D1 has payment/refund status/amount fields and a draft refund email template | No Stripe refund API call, refund ledger action, approval workflow or send path. Owner authority and legal/accounting design required |
| Cancellation | Draft cancellation template; Stripe pre-payment cancel URL returns to shop | No post-order cancel action, provider cancellation or statutory workflow |
| Replacement / re-supply | None | Owner determines remedy; engineering/provider workflow not implemented |
| Fulfilment submission | Explicitly disabled | Do not submit. Activation requires approved customer/shipping schema, provider flow and release gates |
| Fulfilment retry | None | No Printful order submit/status/retry integration exists |
| Failed fulfilment | Local schema can represent `error`, but no active process sets/investigates it | Implement after activation requirements; coordinate provider without exposing credentials |
| Missing shipment | Policy support intake exists | No tracking/status integration or carrier claim workflow |
| Wrong item / damaged item | Policy requests bounded description/photos | No replacement/refund/Printful claim action; owner/counsel decides remedy and evidence proportionality |
| Printful claim/reference | Product/variant mappings and optional order ID columns exist | No claim endpoint, case record or provider mutation; do not contact/create a claim without explicit authorised process |
| Payment dispute | Schema can represent `disputed`; webhook receiver currently handles only bounded Checkout completion evidence | No dispute ingestion/evidence workflow |
| Customer notification | Draft order/shipment/cancellation/refund/payment-failure templates exist | Templates have no commerce send path and must not be represented as operational |

## Escalation rules

- Suspected duplicate/incorrect payment, leaked credential, unexpected live-mode record, unexpected Printful order, or inconsistent signed-webhook evidence: stop, preserve evidence, revoke affected access where authorised, and escalate as a security/commerce incident.
- Refund, cancellation, replacement, re-supply, claim and goodwill outcomes require owner-approved authority and qualified legal input where rights are unclear. Printful policy does not replace the seller's obligations.
- Privacy access/correction/deletion or legal hold: follow the Public repository's `PRIVACY_OPERATIONS_RUNBOOK.md`; do not delete orders, webhook receipts or audit rows ad hoc.

## Prohibited actions in the current milestone

Do not enable normal checkout, live capture or fulfilment; create a real order; send a refund; submit/cancel/retry a Printful order; mutate Wix; run the Printful migration; change secrets; or send commerce email. Provider fakes are mandatory in tests.
