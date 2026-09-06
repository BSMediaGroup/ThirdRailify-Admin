# Printful production fulfillment

The production canonical mode is `draft_then_confirm`. This is the repository's existing name for draft creation followed by server validation and a separate controlled confirmation. `draft_only` remains the isolated TEST acceptance mode; changing the active store to that value would close the LIVE worker gate. Active-store reconciliation repairs both the canonical setting and derived provider mode metadata, with Master access, Origin/CSRF checks, rate limits, authority-fingerprint guards and an audit. The original activation evidence is retained.

Printful Dynamic uses recipient, mapped catalog variant, quantity and currency. Local weights belong to the separate merchant weight-band ratebook and are required only for publishing that pricing strategy. The production dashboard uses current checkout eligibility; excluded catalogue items do not block eligible items. The structural preview uses a synthetic recipient and explicitly defers shipping method to the paid order's accepted quote. It cannot submit an order.

## Signed webhook operations

The stable HTTPS receiver is `https://admin.thirdrailify.com/api/webhooks/printful`. It accepts bounded JSON POSTs without a browser session, verifies the expected `x-pf-webhook-public-key`, decodes `PRINTFUL_WEBHOOK_V2_SECRET_HEX` from hexadecimal, and verifies HMAC-SHA256 against the exact raw body using Web Crypto before parsing JSON. Missing signatures, incorrect keys, modified bodies, unsupported events and wrong stores fail closed. Public-key identity is held in `PRINTFUL_WEBHOOK_V2_PUBLIC_KEY`; no secret value is stored in D1 or projected to the browser.

Supported subscriptions: `order_created`, `order_updated`, `order_failed`, `order_canceled`, `order_put_hold`, `order_put_hold_approval`, `order_remove_hold`, `order_refunded`, `shipment_sent`, `shipment_delivered`, `shipment_returned`, `shipment_canceled`.

The Master-only **Reconcile webhook config** action performs provider GET/readback, compares the stable URL, complete event set and public key, and stores only safe evidence in the existing provider metadata. The page itself never calls Printful. Subscription, secret custody and signed-event observation remain distinct states. An unknown external reference is retained as unresolved verified evidence without creating a customer order or sending email.

Intentional rotation uses `scripts/rotate-printful-v2-webhook.mjs --execute-rotation`. Printful issues new keys: the script first configures an empty event set, transfers the pair directly to encrypted Cloudflare Pages secret bindings, deploys the tested Admin build, and verifies the live receiver using a signed malformed JSON body that cannot create an event. Only then does it enable the supported events individually and verify the final provider GET. Failures before verification leave delivery disabled, with polling still active. Never run rotation from a page load or a generic configuration-read button.

The optional `scripts/verify-printful-draft-webhook.mjs --execute-one-draft` smoke creates one empty V2 draft with an explicit synthetic external reference and recipient, then deletes it using V2 DELETE and verifies GET 404. It contains no confirmation call. Do not rerun it merely because provider delivery is delayed. The retained TEST draft `174104132` is unrelated and must be preserved.

## Lifecycle and payment safety

The worker requires a paid LIVE merchandise order, matching completed capture evidence, encrypted recipient snapshot, selected provider shipping method, valid line mappings, enabled fulfillment and a clear emergency pause. It reconciles before creating, validates the draft's items and recipient, and rechecks current local payment/pause authority immediately before confirmation. Existing submitted orders are reconciled without another confirmation. Customer sale amounts remain separate from provider fulfillment costs.

Webhook normalization and authenticated scheduled reconciliation converge on the same provider-order, shipment and encrypted tracking tables. Five-minute reconciliation buckets match the existing cron schedule. Failed webhook processing can retry; terminal duplicate events do not repeat lifecycle transitions or customer notifications. Tracking is ready while awaiting the first actual shipment, which is not a prerequisite for accepting the first order.

Official contracts refreshed for this task: [Printful V2](https://developers.printful.com/docs/v2-beta/) and [Cloudflare Pages secrets](https://developers.cloudflare.com/pages/functions/bindings/#secrets). Production order submission retains the established V1 Sync Variant adapter; V2 is used for signed webhooks and disposable draft verification. No migration or new resource is required.

Live deployment and acceptance evidence is recorded in `PRODUCTION_FULFILLMENT_20260907.md` after verification.
