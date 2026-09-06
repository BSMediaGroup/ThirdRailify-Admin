# Third Railify commerce support runbook

Internal authorised-operator procedure as at 28 August 2026. The current system is pre-activation: normal checkout and fulfilment are disabled. This runbook documents investigation capability; it does not grant refund/remedy authority, activate checkout, or authorise provider mutations.

## Current launch and first-live-order procedure - 6 September 2026

Earlier TEST-only sections below are historical investigation evidence. The current launch authority is the permanent Master Admin workspace at `https://admin.thirdrailify.com/commerce`.

1. Review canonical gates and the masked existing merchant revision. Use protected reveal/edit if needed; no external verification or fabricated replacement is required.
2. Choose **SAVE, CONFIRM & ENABLE STORE**, confirm current owner facts and explicitly authorize transaction-only disclosure. Confirm once. The server saves, attests and enables atomically, reads back, then shows LIVE / ACTIVE. Deployment itself does not activate commerce.
3. Monitor the first genuine future order by local order ID: authoritative completed PayPal capture, accepted agreement/totals, one confirmation job and one eligible fulfillment job. A success-page redirect is not payment proof. Do not manufacture a monitoring purchase.
4. Inspect confirmation delivery/retries and retained receipt access in protected order evidence. Verify reconciliation before creation, draft validation/confirmation, then scheduled lifecycle reconciliation. Pending signed webhook evidence uses the polling fallback. Do not mutate preserved test draft 174104132.
5. On divergent store behavior, use **Emergency Pause store** and verify persisted checkout/capture/submission closure. Preserve donations and completed-order evidence. Resolve the pause through the existing authorized control before confirming a fresh launch.

COMMERCE_ARCHITECTURE.md lists exact settings and privacy boundaries. Stripe stays disabled/non-preferred; invoices are not applicable under not_collecting. Never redo Resend domain verification, send test mail or rotate provider secrets to clear stale readiness wording.

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

Shipping correction (6 September 2026): the owner explicitly superseded the earlier Canada-only instruction. Worldwide destination selection is enabled in the existing D1 shipping-market authority, subject to Printful published exclusions and destination/product rate availability. Canadian merchant identity and CAD charging do not restrict customer geography. No provider API call or order was made to configure markets.

## Production release evidence - 6 September 2026

- Admin production deployment: `3977003a-2083-4311-b415-0b2039b1cfb8`.
- Public production deployment: `3e3a3df7-6f27-4834-8531-93f445baa4c5`.
- Operations Worker unchanged: deployment `12800cb4-b73b-47b7-8153-9f1a24a9bec6`, version `7dccca33-fc35-42bc-82c7-80b96bdb31e7`, five-minute cron. The signed trigger's persisted heartbeat was current during readback. Heartbeat timestamp refreshes alone no longer invalidate a launch review.
- Applied only additive migration 0031; tables, indexes, immutable-agreement triggers and document ciphertext columns verified; foreign_key_check returned no violations. Initial CRLF trigger parsing failed atomically, then LF succeeded. `.gitattributes` pins that migration to LF.
- Production encrypted merchant revision remains 8; both values existed before this resumed run and canonical readiness successfully decrypts them. No failed production save was reproduced. No operator fact/attestation was fabricated and no production authenticated save was attempted through a bypass.
- Canonical production readiness: ready=true, hardBlockerCount=0. Store checkout remains false until the operator confirms. Donations true; Stripe disabled/non-preferred. Worldwide D1 shipping markets:242, subject to actual item/destination rates and [published Printful restrictions](https://help.printful.com/hc/en-us/articles/360014066779-Are-there-any-shipping-restrictions).
- 57 unique focused test cases passed across focused runs and affected reruns. Admin launch and Public agreement responsive checks cover 1440/768/390; guest/account checkout checks passed. Both production builds/typechecks, targeted lint and Functions compilation passed. Tests use synthetic records and mocked provider responses; no PayPal/Stripe/Printful/Resend/Wix API calls, payments, orders or sends were made.
- Actual custom-domain assets match isolated releases. Public configuration/catalogue/markets contain no private merchant fields. Live checkout shows worldwide destinations, remains gated, and the scoped agreement POST returns409 before activation. Authenticated production UI activation is reserved for the legitimate operator; local synthetic Master UI/auth tests cover the confirmation and authorization path.
- Next: sign in as Master at `https://admin.thirdrailify.com/commerce`, choose **SAVE, CONFIRM & ENABLE STORE**, review/attest/authorize once, and expect LIVE / ACTIVE after readback. Monitor the first genuine completed live order using the procedure above. Do not create a test transaction merely to finish deployment.
