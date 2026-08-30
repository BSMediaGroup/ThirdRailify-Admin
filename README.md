# Third Railify Admin

Commerce payments use PayPal Orders API v2 as the preferred direct-merchant rail for store purchases and one-time donations. Stripe is retained as a configured but disabled future option. PayPal documentation: [commerce operations](docs/PAYPAL_COMMERCE.md), [owner setup for Shawn](docs/PAYPAL_SETUP_FOR_SHAWN.md), and [operator setup for Daniel](docs/PAYPAL_OPERATOR_SETUP_FOR_DANIEL.md).

## Replacement commerce catalogue authority

Commerce D1 (`thirdrailify-commerce`) is the merchandising and CAD price authority for the replacement shop. `/products` manages product presentation, public visibility, deterministic ordering, bounded quantities, variant labels/options, integer-minor-unit CAD prices, and display-versus-checkout readiness. Provider identities and migration provenance are read-only integration metadata.

Accounts and Customers are deliberately different authorities. An Account is an authentication identity with providers, roles, state, and sessions; it does not become a Customer merely by existing. A Customer is created when a guest enters the order lifecycle or when a signed-in user deliberately opens an Account commerce surface. Guest Customers remain unlinked, while account-backed Customers use the server-resolved Account ID and one Account maps to at most one Customer. Exact matching guest and Account emails never trigger an automatic merge. Orders reference Customers from additive migration `0017_commerce_customers.sql`, while each order keeps its encrypted checkout contact/delivery snapshot as immutable historical truth.

Migration `0019_account_address_book.sql` adds encrypted current Customer phone custody and `commerce_saved_addresses`. The signed internal `/api/account-commerce/internal/*` boundary accepts only exact-Public-origin HMAC-authenticated requests after Public has resolved an active session. It provides bounded current contact, address CRUD/default selection, and account-owned order list/detail projections. Saved addresses use optimistic revisions, one default, a ten-active-address cap, hard deletion for reusable PII, and no coupling to historical order snapshots. Public still has no Commerce D1 binding, and projections exclude encryption envelopes, fingerprints, Stripe identifiers, webhook evidence, secrets, and raw provider objects.

The Admin exposes only sanitized, unauthenticated read projections under `/api/public/commerce/*`; the Public Pages project proxies them without owning a Commerce D1 binding. Normal checkout, live payment capture, and fulfillment remain globally disabled. The one-time `stripe_test_checkout_enabled` pre-cutover gate is now closed after the successful first genuine Stripe TEST acceptance; its product/variant selectors were removed, so no further controlled Session can be generated. The permanent Printful migration is independently checkpointed and remains manually paused.

Acceptance passed for preserved TEST order `ord_e47b94a4-4252-438b-8ca7-c47470029940` and Session `cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC`: one signed `checkout.session.completed` receipt confirmed CAD 15.00 for local product `product-397267935` / variant `variant-5019554081` (**11 oz / Black**). The variant is restored to `is_sellable=0` with acceptance-only markers removed. The historical status page remains readable from local state; fulfillment stays `disabled / not_started` with no Printful order.

Independent authenticated control room for Third Railify operations. The shared D1 account authority, real session/role enforcement, bounded account administration, and an Admin-only Canadian commerce control plane are implemented. The real Printful API can be verified read-only against its dedicated store, while checkout, live payment capture, provider writes, and fulfillment remain disabled.

The canonical Admin origin is `https://admin.thirdrailify.com`; Public links use `https://thirdrailify.com`. The old Admin Pages hostname retains `/api/*` and webhook compatibility while browser navigation becomes non-canonical. Sessions remain host-only; no cookie is broadened to all subdomains.

Production Google OAuth is enabled through the existing centralized Admin callback after operator confirmation of Google Branding/Audience, Search Console ownership, and exact custom plus transitional redirect URIs. Discord, GitHub, Google, and X all use the custom Admin callbacks for normal production starts; the old Pages callbacks remain only for bounded rollback compatibility until legitimate custom-domain sign-ins pass. Preview Google OAuth remains intentionally disabled. Provider secrets remain encrypted Admin-only bindings and normal OAuth accounts never inherit an Admin role.

## Current state

- Vite 5, React 18, TypeScript, and React Router.
- Wheels V1.8 authority uses additive migration `0022_wheels_segment_styles.sql`, bounded participant style JSON, strict pattern/sound allowlists, and Admin-owned R2 segment-fill validation/delivery with GIF preservation, SHA reuse, ownership checks, and 20-asset/12 MiB wheel budgets.
- Wheels Stage V1 authority uses additive migration `0023_wheels_stages_v1.sql`, normalized Stage membership, six-Wheel bounds, independent Wheel reauthorization, revision conflicts, audit/rate limiting, and a dedicated Admin management route. See `docs/WHEELS_STAGE_V1.md`.
- Branded responsive sidebar with a discreet topbar-triggered desktop icon-only collapse, a full mobile drawer, a header-aligned authenticated account menu, a fail-soft cross-authority operational overview, future-area route shells, and a branded 404.
- American Captain display typography rendered at its real weight with lightly relaxed heading tracking and line-height.
- Routes for Overview, Watch / Broadcast, Site Content, expandable Shop (Products, Collections, Orders), Commerce Overview, Payments & Payouts, Business Information, Tax & Documents, Customer Emails, Fulfillment Integrations, Media, VIP / Membership, Users / Access, Integrations, and Settings.
- D1-backed email/password accounts, verification/reset email, Discord/Google/GitHub/X OAuth, explicit Turnstile, hashed sessions, one-time public handoff, rate limiting, and bounded audit records.
- Fail-closed loading, signed-out, regular-user, Full Admin, and Master Admin gates with no protected dashboard flash.
- Functional `/access` account registry with self-service display-name editing, avatar upload/URL import, search/filters, and Master-only promotion, demotion, status, and session-revocation controls.
- Admin-authoritative avatar ingestion validates JPG/PNG/WebP bytes, stores immutable content-addressed objects under `/u/<opaque-account-key>/avatar/<sha256>.<ext>`, and persists only the resulting HTTPS URL in D1.
- Admin-only authority for the bound `thirdrailify-commerce` D1, direct-merchant provider/status records, encrypted private business/tax fields, structured email/document templates, commerce capabilities, and redacted commerce audit history.
- Functional `/products` merchandising workspace backed by `commerce_products`: Master Admins can feature/unfeature displayable snapshot products, set deterministic hero order with accessible move controls, preview warnings, and persist through the established session/origin/CSRF/rate-limit/D1/audit path.
- Admin-authoritative V2 GOATS workspace for submission moderation, coarse map coordinates, private media, approved publication, editable approved stories, per-listing/global interaction policies, pending comment/reaction queues, and idempotent transactional-email outbox events. The owner-supplied Wix collection is imported through the deterministic `goats:wix:build-import` pipeline; Public receives approved fields only.
- Master-only `/watch` workspace for reading current/retained Public broadcast state and showing or hiding retained episodes through an exact-origin, CSRF/rate-limited, audited, server-signed Admin-to-Public request. The browser receives no shared secret and cannot create, scrape, edit, or delete episodes.
- Public read-only `/api/catalogue/merchandising` projection exposes only product ID, slug, featured state, and order; it contains no price, image path, safe metadata, credential, or write capability.
- Protected catalogue recovery pins the legacy Wix source to `Third Railify Official` / `16847493` / `wix` and the permanent target to `Third Railify API` / `18668025` / `native`. Its signed phased checkpoint remains a separate, manually paused migration authority. `/commerce/fulfillment` now consumes only its safe persisted counts and state; it cannot resume, retry, or mutate the migration and never calls Printful.
- Public-origin `POST /api/commerce/shipping-quotes` and `POST /api/commerce/checkout` are the Admin-authoritative guest boundaries. They accept bounded local product/variant IDs, quantities, and normalized delivery input; bind an opaque rate quote to server-resolved cart and recipient fingerprints; encrypt the durable recipient snapshot; derive integer CAD subtotal/shipping/total; snapshot the order before Stripe; and remain fail-closed while `shipping_strategy` and checkout gates are disabled.
- Master-only `POST /api/admin/commerce/test-checkout` reuses that exact checkout core behind Admin origin, session, Master role, CSRF, rate limits, the dedicated test gate, an exact configured candidate lock, and a one-order ceiling. `/orders` shows the candidate, TEST environment, immutable product/variant line, Session/payment state, disabled fulfillment, no-Printful-order state, and the safe hosted Checkout URL.
- Admin remains the sole Wheels D1 and custom-media R2 write authority. Additive migration `0016_wheels_media.sql` stores bounded lifecycle metadata only; upload/remove routes enforce owner/editor or Master access, edit locks, rate limits, raster/SVG validation, hidden-wheel protection, audit, and immediate old-object cleanup. Public receives only opaque asset IDs and D1-gated CDN media URLs, never an object key or binding.
- `GET /api/public/commerce/order-status?session_id=cs_test_…` exposes only an exact-session local payment projection for Public's `/checkout/success` page. It cannot enumerate orders, does not call Stripe from the browser, and never treats a success redirect as payment authority.
- Public machine-to-machine `POST /api/webhooks/stripe` receiver code with exact raw-body Web Crypto verification, a five-minute Stripe `v1` timestamp window, test-event enforcement, and D1-backed duplicate receipt protection. A real signed sandbox event has verified the deployed destination and matching Admin-only signing configuration.
- Public machine-to-machine `POST /api/webhooks/printful` receiver code for allowlisted Printful V2 beta lifecycle evidence, with exact raw-body HMAC verification, store isolation, bounded digest idempotency, and no raw-payload retention. It remains fail-closed and unverified until server-only keys and a provider subscription are deliberately configured.
- Stripe-first Canadian operating model using the dedicated Third Railify Official merchant account, server-created Stripe-hosted Checkout Sessions, Admin-only environment secrets, disabled Checkout/live capture, a draft-only Printful design, deferred PayPal, unavailable Printify, and untouched legacy Wix production.
- Protected `POST /api/admin/commerce/printful/verify` action for exactly two server-side reads: store-scoped discovery through `GET /stores`, then `GET /store/products?limit=1`. Live verification resolved exactly one dedicated native `Third Railify API` store, safe Store ID `18668025`, and one visible product; the Wix store was not selected. The action rejects Wix or multi-store scope, persists only safe identity/count proof, and never exposes the Private Token.
- Cloudflare Pages static output at the custom Admin origin, SPA fallback, document and response-level noindex, and restrictive baseline headers.

Account administration is operational in code. The separate commerce D1 is bound, its encryption secret and Stripe TEST credentials are held as Admin Cloudflare encrypted secrets, and the protected Stripe verification action performs only `GET /v1/account`, requires Canada and CAD, and stores safe proof in the provider row plus canonical setting. The Checkout/order engine is implemented server-side and signed `checkout.session.completed` events can confirm only an already-linked TEST order after exact reference, Session, amount, currency, mode, payment-status, and environment checks. Public checkout, live payments, live payout readiness, product import, and fulfillment remain disabled or incomplete. The verified existing `thirdrailify-profile-media` bucket is declared locally through the Admin-only `THIRDRAILIFY_PROFILE_MEDIA` binding. Public receives no commerce binding or secret.

## Local development

Use Node 22.16.0 (recorded in `.node-version`) and npm.

```powershell
npm ci
npm run dev
```

Quality gates:

```powershell
npm run lint
npm run typecheck
npm run test:printful
npm run test:functions
npm run test:browser:fulfillment
npm run test:browser:overview
npm run goats:import:dry-run -- C:\path\to\wix-goats-export.json
npm run goats:wix:build-import
npm run test:goats:wix-import
npm run build
npm run preview
```

The production output is `dist/`. The local development server uses port 5174 and preview uses 4174 so it can run alongside the public app.

## Routes

| Path | Current purpose |
| --- | --- |
| `/` | Cross-authority Watch, Commerce, GOATS, Site Content, account, runtime-posture, and operational-priority overview |
| `/watch` | Master-only current broadcast summary and retained-episode visibility controls; no manual archive creation |
| `/content` | Master-only normal promo and automatic Live Now banner presentation editor with safe previews |
| `/products` | D1-backed featured-product selection and stable hero ordering for the bounded snapshot catalogue |
| `/goats` | GOATS moderation overview with pending/approved/rejected/hidden and email state |
| `/goats/pending`, `/goats/approved`, `/goats/rejected` | Master-only bounded moderation queues |
| `/goats/comments`, `/goats/reactions` | Pending/approved/hidden interaction moderation |
| `/goats/settings` | Global inherited defaults for comments and reactions |
| `/goats/emails` | Additive GOATS template editor with safe fixture preview |
| `/goats/:id` | Private submission detail plus editable approved content/product/rating/location/interaction policy, media add/replace/remove/order, transitions, email retry, and DEMO-only cleanup |
| `/api/admin/goats/*` | Master-session, exact-origin, CSRF, and optimistic-version protected GOATS authority |
| `/api/admin/watch` | Master-session, exact-origin, CSRF, rate-limited and audited bridge to signed Public archive management |
| `/api/admin/banner` | Master-session banner read/write authority with exact-origin, CSRF, rate limit, validation, revision matching, and audit |
| `/api/banner` | Cacheable read-only projection of safe banner presentation fields for Public Pages |
| `/api/goats/*` | Approved-only public reads plus signed fixed internal ingestion actions |
| `/api/catalogue/merchandising` | Cacheable public read projection of product ID/slug/featured order only; no write path |
| `/orders` | Read-only bounded local Checkout/payment/fulfillment states plus current Customer linkage and immutable historical checkout contact; no synthetic orders or revenue |
| `/customers` | Protected `commerce.view` Customer list/detail management with guest/account distinction, server-side search/filter/sort/pagination, and isolated TEST/LIVE value |
| `/api/account-commerce/internal/*` | HMAC-authenticated exact-Public-origin current-Account contact/address/order boundary; no browser-supplied ownership authority and no provider mutation |
| `/commerce` | Truthful commerce readiness and provider status overview |
| `/commerce/payments` | Stripe direct-merchant Payments & Payouts control plane with canonical TEST evidence, isolated TEST/LIVE summaries, webhook health, fail-closed activation gates, truthful Stripe-managed payout boundaries, and a disabled future PayPal donations scaffold |
| `/api/commerce/checkout` | Exact-Public-origin customer POST/OPTIONS endpoint; server-priced Stripe-hosted TEST Checkout behind disabled product/configuration gates |
| `/api/webhooks/stripe` | External Stripe sandbox delivery route; POST/raw-body/signature/D1 required, with no browser authentication and only invariant-checked existing-order payment confirmation |
| `/api/webhooks/printful` | External Printful V2 beta lifecycle route; POST/raw-body/HMAC/store/D1 required, fail-closed while webhook keys and subscription remain unconfigured |
| `/commerce/business` | Authoritative merchant-profile editor over the singleton Commerce D1 business model: public-safe storefront/contact/address fields, masked encrypted legal replacements, read-only CA/ON/CAD defaults, server-derived tax/document/email/fulfillment dependencies shared with Payments, revisioned saves, and category-only audit |
| `/commerce/tax` | Authoritative Tax & Documents control plane: masked encrypted registrations, structured receipt/invoice editors, ephemeral SAMPLE previews, seller/email/readiness projections, and explicit no-collection/no-remittance boundaries |
| `/commerce/emails` | Safe structured customer template editor; no send path |
| `/commerce/fulfillment` | Read-only Fulfillment & Shipping control plane over canonical readiness, Printful configured state, mapping health, delivery/rate/tracking capabilities, pure draft preview, local evidence, and production locks |
| `/api/admin/commerce/printful/verify` | Admin-session, exact-origin, CSRF, rate-limit, and `commerce.integrations.manage` protected read-only Printful verification |
| `/api/admin/commerce/printful/catalogue/snapshot` | Protected phased GET-only source/target enumeration, detail/file reads, signed evidence assembly, and deterministic reconciliation |
| `/media` | Future managed-asset shell |
| `/membership` | Future VIP/membership shell |
| `/access` | D1-backed account registry and role/status/session controls |
| `/integrations` | Future server-side integration shell |
| `/settings` | Future governed settings shell |
| everything else | Branded 404 |

Business Information reads require `commerce.view`; mutations additionally require `commerce.business.manage`, exact Admin origin, CSRF, the existing commerce rate limit, server validation, optimistic profile revision matching, encryption custody, and commerce audit. Legal name, legal address, private phone, and business/corporation number are never prefilled or returned as plaintext. Tax registrations remain authoritative under `/commerce/tax`, template/sender state remains authoritative in the existing document and email models, PayPal is not a readiness requirement, and Canada / Ontario / CAD cannot be changed through this surface.

Tax & Documents reads require `commerce.view`; tax-registration mutations require `commerce.business.manage`, while receipt/invoice template mutations require `commerce.templates.manage`. Existing revision columns now reject stale registration and template writes. Registration identifiers remain encrypted at rest and masked in browser projections and audit metadata; explicit replacement inputs are always blank. Preview posts retain exact-origin/session/CSRF/rate-limit validation, use the existing allow-listed structured renderer with synthetic TEST data, and create no order, document row, customer token, email delivery, provider call, or checkout mutation. Business Information remains the seller-identity authority, Customer Emails remains the delivery authority, and the canonical server readiness consumed by Payments remains the production interpretation.

Customer Emails reads require `commerce.view`; template writes retain `commerce.templates.manage`, exact Admin origin, CSRF, rate limiting, server validation, optimistic template revisions, and bounded body-free commerce audit. `functions/_shared/commerce-control-plane.js` projects only configured-state metadata from the server-owned Resend credential, `MAIL_FROM`, and `MAIL_REPLY_TO`; it does not query Resend or claim domain/provider verification. `src/pages/CustomerEmailsPage.tsx` edits only the seven persisted email kinds, renders synthetic previews through the canonical server renderer in a sandboxed frame, and shows masked bounded `commerce_email_deliveries` evidence. Business Information owns merchant identity/contact, Tax & Documents owns receipt/invoice content, Orders owns order-specific communication history, and D1 owns the global `transactional_email_enabled` gate and deterministic delivery ledger. The page exposes no test-send, retry, resend, provider-connect, customer-document issuance, or production-enable control; no production lifecycle trigger is implemented.

## Admin control system

`src/styles/global.css` owns the application-wide button/control tokens: normal and compact heights, icon size, inline padding, icon gap, radius, transition, disabled opacity, and branded focus ring. Every native Admin `button` receives the dark graphite secondary baseline, so routed pages cannot fall back to browser `ButtonFace`; semantic classes then select `primary-button`, `secondary-button`, `ghost-button`, `danger-button`, `danger-outline-button`, `text-button`, `compact-button`, or `icon-button`. `button-link` is the anchor equivalent of the primary action. Native file selectors inherit the compact dark/gold treatment while remaining platform-accessible.

Route-specific styles may change layout or represent real segmented/tab controls, but they must retain the shared typography, focus, disabled, pressed, and alignment behavior. Browser coverage inspects computed styles rather than accepting class names alone.

## Structure

```text
ThirdRailify-Admin/
├── assets/
│   ├── backgrounds/        Seeded brand backgrounds
│   ├── fonts/              Seeded font files and licences
│   ├── icons/              Active thirdadminfavx PNG favicon and preserved earlier favicon artwork
│   ├── logos/              Seeded marks and the active straight sidebar bolt silhouette
│   └── people/             Seeded host imagery (not used in admin)
├── public/
│   ├── _headers            Noindex and static response safeguards
│   ├── _routes.json        Auth, Admin, profile-media, Stripe, and Printful webhook Pages Function routing
│   └── _redirects          SPA fallback
├── functions/
│   ├── _shared/            D1 auth/session/OAuth/security, profile-media, commerce, shared brand, GOATS, and normalized Printful fulfillment helpers
│   ├── api/                Shared auth, protected Admin/GOATS APIs, public projections, and signed Stripe/Printful webhook receivers
│   └── u/                  Immutable R2-backed profile-media delivery
├── commerce-import/        Sanitized catalogue evidence and design-only variant schema
├── commerce-migrations/    Commerce authority through additive `0018_printful_fulfillment_lifecycle.sql`
├── migrations/             Idempotent D1 account foundation
├── src/
│   ├── auth/               Gate, session provider, modal, Turnstile, and account widget
│   ├── commerce/           Typed Admin commerce API client
│   ├── components/         Shell, icons, and state examples
│   ├── config/             Route/navigation definitions
│   ├── pages/              Live Overview/Accounts, commerce control plane, future areas, and 404
│   └── styles/             Tokens and responsive admin visual system
├── tests/
│   ├── payments-control-plane.test.mjs  Direct-merchant authority, evidence, financial-isolation, permission, and no-provider-call coverage
│   ├── payments-browser.test.mjs  390/768/1440 rendering, overflow, locks, links, and payout-boundary coverage
│   ├── tax-documents-control-plane.test.mjs  Registration/template custody, revision, permissions, preview, audit, and no-side-effect coverage
│   ├── tax-documents-browser.test.mjs  390/768/1440 masked editor, preview, dependency, accessibility, and overflow coverage
│   ├── printful.test.mjs   Focused single-store, no-write, persistence, and Store-ID invariant coverage
│   ├── printful-catalogue.test.mjs  Full GET-only source/target snapshot safety coverage
│   ├── fulfillment-browser.test.mjs  390/768/1440 operator-state and explicit-download regression
│   ├── fulfillment-lifecycle-migration.test.mjs  Additive schema, constraints, history, and FK coverage
│   ├── printful-fulfillment.test.mjs  Provider normalization, split shipment, reshipment, return, and reconciliation coverage
│   ├── printful-webhook.test.mjs  Signed receiver, fail-closed security, idempotency, and no-PII persistence coverage
│   └── …                   Auth/commerce migrations, crypto, API, permissions, and safety coverage
├── docs/                   GOATS authority/import contracts and operator boundaries
├── scripts/                GOATS import validator plus opt-in demo seed/cleanup fixtures
├── CLOUDFLARE_COMMERCE_SETUP.md
├── CLOUDFLARE_AUTH_SETUP.md
├── CLOUDFLARE_SETUP.md
├── COMMERCE_SUPPORT_RUNBOOK.md
├── COMMERCE_ARCHITECTURE.md
├── STRIPE_CANADA_FEASIBILITY.md
├── WIX_COMMERCE_AUDIT.md
├── BUMP_NOTES.md
└── package.json
```

Additive banner files in this structure are `commerce-migrations/0006_site_banner.sql`, `functions/_shared/banner-core.js`, the Public/protected banner Functions, `src/banner/client.ts`, `src/pages/SiteContentPage.tsx`, and focused Function/browser tests. Banner content uses the existing Admin-owned commerce D1; auth D1 is used only for the existing session, rate-limit, and audit conventions.

`commerce-migrations/0009_commerce_collections.sql` is the additive collection authority. It preserves the existing category slugs while adding stable collection metadata and normalized product membership. `/collections` and product editing reuse the existing authenticated commerce capability, exact-Origin, CSRF, rate-limit, revision, parameterized-D1, and audit boundaries; Public receives only active visible collection metadata and displayable memberships.

Catalogue imagery is copied into the existing Admin-owned R2 binding under immutable `commerce/catalogue/<sha256>.<ext>` keys and served canonically through `https://cdn.thirdrailify.com/commerce-media/<sha256>.<ext>` with year-long immutable caching, ETags, bounded CORS, content sniffing, and cross-origin image delivery. Product saves ingest external HTTPS image sources before persisting CDN URLs; the Public catalogue owns no R2 binding and receives only safe public URLs. The dedicated media Worker also serves immutable avatars and D1-gated approved GOATS/active public Wheel media while denying private lifecycle states and bucket enumeration. Products and Collections use focus-trapped, body-scroll-locked modal editors so long lists never push editing controls below the page.

`src/pages/OrdersManagementPage.tsx` is the dedicated read-only order-management surface. It uses bounded list/detail projections from order, line, encrypted delivery, normalized provider-order/shipment/tracking, Stripe webhook, document, email-delivery, and commerce-audit authority; list and Customer-history projections expose only lifecycle state, counts, and tracking availability, while protected detail can decrypt a tracking reference/URL. `src/pages/CustomerEmailsPage.tsx` remains the lifecycle-template and delivery-readiness surface; shipment-notification sends stay globally disabled. `src/pages/FulfillmentShippingPage.tsx` consumes the protected `/api/admin/commerce/fulfillment` projection and pure Printful draft preparation. The read projection performs no provider request, creates no provider object, and exposes no submission, confirmation, retry, reshipment, or activation control.

`src/pages/CustomersPage.tsx` owns the protected commerce relationship view; `src/pages/AccountsPage.tsx` remains the separate authentication/access authority. Both use bounded detail drawers and reciprocal deep links without moving password, provider, session-token, or role authority into Commerce. `src/components/ResizableTables.tsx` enhances every real named-column Admin table with pointer and keyboard resizing, route/table-scoped local preference storage, sensible width bounds, and a visible reset. The current semantic-table inventory is Accounts, Customers, Wheels Library, Wheels Access assignments, and Wheels Results; card and list layouts are not misreported as tables. Phone layouts hide desktop resize handles and retain the existing stacked-row behavior.

`docs/WATCH_V2.md` documents the Watch management route, signed server boundary, and Public archive ownership.

The display system uses the seeded American Captain asset at its real weight with lightly relaxed tracking for the primary header voice, with seeded Blinker and Geist Mono for readable body and technical roles.

## Security boundary

- GOATS reuses Master Admin session/role resolution, exact-origin writes, CSRF, privacy-conscious rate limits, and the Admin-only commerce D1/R2 bindings. Public sees only approved/published projections and opaque public media routes; private email, account association, raw object keys, moderator notes, email state, and audit metadata never enter public output. See `docs/GOATS_V2.md` for APIs, binding/secrets, outbox, cleanup, and local fixture operations.
- Watch visibility reuses the Master Admin session, exact-origin, CSRF, rate-limit, and audit paths. The Admin Function signs a server-to-server request with the existing encrypted `THIRDRAILIFY_COMMUNITY_API_SECRET`; the browser never receives it. The archive remains in Public's existing SQLite Durable Object, Admin receives no Durable Object binding, and no new secret or Cloudflare resource is required. See `docs/WATCH_V2.md`.

- D1 is the only account/session/role authority. Browser state is a hydration cache, never identity authority.
- Passwords use salted PBKDF2-SHA256; only hashed session, one-time, OAuth-state, rate-limit, and IP-derived values persist.
- The 12-character minimum applies when creating or resetting passwords, not when verifying an existing credential at sign-in.
- All mutations require the exact Admin origin, a current server-resolved role, and CSRF proof. Environment Master accounts remain locked and their passwords stay environment-only.
- Display-name changes are self-service, CSRF-protected, rate-limited, audited, and persisted only through the Admin-owned D1 account authority; Master role/email locking does not overwrite a chosen display name.
- Avatar uploads and URL imports are rate-limited, capped at 5 MB, content-sniffed as JPG/PNG/WebP, and written only to the Admin-owned `THIRDRAILIFY_PROFILE_MEDIA` object binding. Public can proxy a current session proof but cannot own the object binding or update D1 itself.
- Commerce reuses the same session, role, origin, CSRF, rate-limit, and audit boundary. Master Admins own all commerce capabilities and are the only accounts that can grant/revoke them; Full Admins can view and may receive bounded commerce capabilities; ordinary users cannot.
- Featured-product changes are Master-only and validate a bounded, duplicate-free list of existing displayable product IDs server-side before one D1 batch updates the full order. The public projection is GET-only and excludes titles, prices, images, metadata, accounts, permissions, and audit records.
- Stripe staging verification accepts only recognizable TEST server credentials under `STRIPE_SECRET_KEY`: restricted `rk_test_...` is intended and `sk_test_...` remains compatible. `rk_live_...`, `sk_live_...`, missing credentials, missing D1, and non-CA/non-CAD accounts fail closed. The browser receives only `stripeSecretConfigured`, never credential material.
- The Stripe webhook is deliberately external to browser controls: it accepts POST only and does not use an Admin session, CSRF, Turnstile, Origin, CORS, or a commerce capability. It instead requires the exact raw body, a configured server-only `STRIPE_WEBHOOK_SECRET`, at least one valid `v1` HMAC-SHA256 signature, a timestamp within 300 seconds, a test-mode Stripe Event envelope, commerce D1, and a unique `stripe` plus Event ID receipt.
- Signed `checkout.session.completed` events never create orders. An event may transition one existing linked TEST order from `payment_status=pending` to `paid` exactly once only when its metadata/client reference, persisted Session ID, `mode=payment`, `currency=cad`, authoritative integer total, `payment_status=paid`, and test environment all agree. Unknown/unlinked/invalid events are bounded no-ops, duplicates keep one ledger row and cannot double-transition, and the historical accepted `checkout_disabled` receipt remains unchanged. No path submits fulfillment, inventory, email, membership, donation, or another provider action. Raw payloads, signature headers, signing/API secrets, customer/card/address data, and full Stripe objects are never persisted.
- Checkout is not an Admin mutation: it requires the exact configured Public origin, narrow POST/OPTIONS CORS, commerce D1, disabled/live/provider/API/webhook gates, a test-only server credential, bounded JSON, anonymous checkout/quote rate limits, and an unexpired server quote bound to the authoritative cart, normalized recipient, environment, currency, and selected opaque option. It requires Turnstile only if the corresponding future safe setting is explicitly enabled. It never accepts browser price, name, currency, total, provider identity, shipping amount, Stripe Price ID, tax, or discount authority.
- `stripe_api_configured=true` means a server-side test credential completed `GET /v1/account` and the returned account passed the `CA`/`cad` checks. `stripe_webhook_configured=true` means a correctly signed, timely, well-formed, `livemode=false` Stripe Event reached the duplicate-safe receipt path. Secret existence alone proves neither state, and neither flag enables Checkout, live payment capture, or fulfillment.
- Printful uses its real API, not a Stripe-style sandbox. `PRINTFUL_API_TOKEN` is a production-capable, store-scoped Admin Cloudflare encrypted secret; `PRINTFUL_STORE_ID=18668025` is ordinary safe Wrangler configuration. Verification accepts exactly one native store named `Third Railify API`, compares token/configured/persisted IDs whenever configuration exists, performs only the two approved GETs, and leaves order mode `draft_only`, webhooks false, fulfillment false, and the Wix-connected store untouched.
- `PRINTFUL_WIX_SOURCE_TOKEN` is separate temporary read-only migration authority for only the Wix-connected source. It may read store identity, sync products/details, and strictly necessary file metadata; `PRINTFUL_WIX_SOURCE_STORE_ID=16847493` is safe ordinary configuration. Revoke the token after successful migration and cutover verification. Never copy either Printful token into Wrangler vars, D1, browser requests, downloads, logs, or documentation.
- Catalogue snapshot phases are same-origin, session/CSRF/capability/rate-limit protected. Short-lived HMAC evidence lets the browser orchestrate bounded Pages invocations without trusting browser-supplied catalogue data; only the final verified assembly is audited as completed. No phase uses repository files or persists provider payloads.
- Private business/legal/tax values require the separate commerce D1 and server-only AES-256-GCM key. Missing storage/key, malformed envelopes, wrong keys, and tampering fail closed. The dedicated Stripe account's secret key/webhook secret and the Printful token remain Admin-only Cloudflare encrypted secrets; no browser or Public payload receives them.
- Structured email/document templates allow bounded fields only and reject scripts, executable HTML, header injection, malformed variables, unknown variables, and object traversal. Customer Emails exposes edit and non-mutating synthetic preview only; the pre-existing explicit TEST/PREVIEW endpoint is not exposed by this page, the production delivery gate remains separate, and no production lifecycle trigger is implemented.
- Expired sessions, handoffs, OAuth transactions, email-verification tokens, and password-reset tokens have one Master-only, exact-origin, CSRF-protected maintenance action. It deletes only rows whose existing `expires_at` is at or before execution, writes a bounded auth audit event, and does not touch accounts, identities, rate limits, or audit history.
- `COMMERCE_SUPPORT_RUNBOOK.md` documents the exact read-only order/support evidence and the absent refund, cancellation, replacement, claim, shipment, email, and fulfilment mutations. It grants no provider-write or remedy authority.
- `noindex` is not access control. The application gate and signed APIs are mandatory; any outer Cloudflare Access policy must preserve narrowly required public auth/callback routes.

## Wheels authority

Competition wheels are owned exclusively by the existing Admin Commerce D1 through additive migration `commerce-migrations/0014_wheels_v1.sql`. The expandable `/wheels` workspace provides Library, Access, Results, and per-wheel detail routes. Public has no wheel D1 binding: its same-origin gateway signs bounded creator actions and official draws, while Admin revalidates the current account against the accounts D1 and enforces global creator grants, owner/editor/spinner assignments, lifecycle, visibility, locks, revisions, rate limits, and audit.

Official draws reject browser-supplied winners, use Web Crypto rejection sampling over validated integer weights, persist a canonical participant hash plus immutable winner snapshots, and serialize with revision, `spin_sequence`, and idempotency. Voiding preserves the result. The migration seeds no wheels/results; the optional exact staging fixture is in `scripts/wheels-demo-seed.sql`. See `docs/WHEELS_V1.md` for the complete authority and route contract.

## Cloudflare and domain safety

See `CLOUDFLARE_AUTH_SETUP.md` for account infrastructure, `docs/DOMAIN_CUTOVER.md` for the completed canonical-domain transition, and `CLOUDFLARE_COMMERCE_SETUP.md` for the remaining disabled Commerce activation gates. `COMMERCE_ARCHITECTURE.md`, `WIX_COMMERCE_AUDIT.md`, and `STRIPE_CANADA_FEASIBILITY.md` record the direct dedicated-account design, source evidence, and remaining off-code checks. `https://admin.thirdrailify.com` is canonical; the old Pages hostname remains only for browser redirect and machine-route compatibility.
