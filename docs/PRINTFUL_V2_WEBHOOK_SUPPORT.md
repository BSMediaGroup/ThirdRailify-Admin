# Printful V2 webhook support escalation

## Ticket summary

Third Railify needs Printful support guidance for a V2 webhook configuration that now reads back successfully but whose signing secret was not returned through the documented response shape and is not in verified custody.

## Sanitized technical facts

- Product: Third Railify
- Target Printful store: `18668025`
- Token class: store-level private token
- Required endpoint: `POST /v2/webhooks`
- Requested callback: `https://admin.thirdrailify.com/api/webhooks/printful`
- Requested event count: `12`
- Request payload SHA-256: `b086592ccf9cc4f31ce4fcdff8154c69ee9e3cb064ae19b9c5565b735fb87006`
- Authorized provider-call totals: `GET /v2/webhooks = 3`; `POST /v2/webhooks = 1`

The single authorized POST returned HTTP `200`, content type `application/json`, and top-level JSON keys `data` and `extra`. The documented response contract and the strict client expected a top-level `result` object. No usable signing material was accepted or stored from that response.

The final authorized `GET /v2/webhooks?show_expired=true` also returned HTTP `200`, content type `application/json`, and top-level keys `data` and `extra`. Its configuration now has:

- the exact requested default URL;
- all `12` requested supported lifecycle events;
- a public key;
- `expires_at = null`.

No request/debug ID was present in the recognized response headers. The public key value, provider body, authorization header, API token, and any signing material are intentionally omitted from this document.

## Current disposition and safety boundary

- `CONFIGURED = yes`
- `READBACK_VERIFIED = yes`
- `SIGNING_SECRET_IN_VERIFIED_CUSTODY = no`
- `SIGNED_DELIVERY_EVIDENCE = no`

Cloudflare contains pre-existing bindings named for a Printful V2 public key and signing secret, but name presence is not current-key identity evidence. Cloudflare does not expose encrypted secret values for readback, and the POST response was not accepted by the strict `result` parser. The receiver therefore remains fail-closed; the project will not claim that signed webhook delivery is usable.

No further Printful GET or POST is authorized in this investigation. The configuration will not be deleted or recreated without explicit authorization and Printful guidance. Existing TEST draft order `174104132` remains untouched.

## Questions for Printful support

1. Is `data` plus `extra` now the current production response contract for `POST /v2/webhooks` and `GET /v2/webhooks`, despite the public documentation specifying `result`?
2. Should a successful POST persist configuration immediately for `GET /v2/webhooks`, or is delayed/asynchronous visibility expected?
3. Under what conditions can HTTP `200` be returned without signing material at the documented response location?
4. Is a store-level private token with `webhooks` manage scope sufficient, without an account-level token or `X-PF-Store-Id` header?
5. Is any account-level token or Store header required despite the store-scoped token?
6. What is the supported recovery path when creation returns success but the signing secret is absent from verified custody?
7. Can the secret for the current public-key identity be recovered securely, or must the configuration be recreated? If recreation is required, what exact sequence avoids a duplicate or unsafe delivery gap, and which key identities rotate?

## Ready-to-send support message

Subject: V2 webhook HTTP 200 used `data/extra`; configuration persisted but signing secret is unavailable

Hello Printful Support,

Third Railify configured `POST /v2/webhooks` for store `18668025` using a store-level private token and 12 lifecycle events, with `https://admin.thirdrailify.com/api/webhooks/printful` as the default URL. The request payload SHA-256 was `b086592ccf9cc4f31ce4fcdff8154c69ee9e3cb064ae19b9c5565b735fb87006`.

The POST returned HTTP 200 JSON with top-level keys `data` and `extra`, while the published contract and our strict parser expected `result`. No signing secret entered verified custody. A later final GET also returned `data` and `extra` and now shows the exact callback, all 12 events, a public key, and no expiry.

Please confirm whether `data/extra` is the current production contract, whether delayed persistence is expected, and the supported secure recovery path for the missing signing secret. If recreation is required, please provide the exact safe procedure and key-rotation behavior. We will not delete or recreate the current configuration without guidance.

We can provide account-authenticated details through the support channel, but will not send the API token, signing keys, raw authorization headers, customer data, or raw provider bodies.

Thank you.

## PayPal and launch distinction

This support issue does not block PayPal credential onboarding, PayPal Sandbox testing, PayPal donation testing, or PayPal Live credential verification. It can remain a blocker for automatic production Printful fulfillment because signed webhook authenticity is not currently provable. No fulfillment or commerce gate is changed by this distinction.
