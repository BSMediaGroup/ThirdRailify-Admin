# Third Railify Admin

Independent authenticated control room for Third Railify operations. The shared D1 account authority, real session/role enforcement, bounded account administration, and an Admin-only Canadian commerce control plane are implemented. The real Printful API can be verified read-only against its dedicated store, while checkout, live payment capture, provider writes, and fulfillment remain disabled.

## Current state

- Vite 5, React 18, TypeScript, and React Router.
- Branded responsive sidebar with a discreet topbar-triggered desktop icon-only collapse, a full mobile drawer, a header-aligned authenticated account menu, server-hydrated overview, future-area route shells, and a branded 404.
- American Captain display typography rendered at its real weight with lightly relaxed heading tracking and line-height.
- Routes for Overview, Site Content, Shop / Products, Orders, Commerce Overview, Payments & Payouts, Business Information, Tax & Documents, Customer Emails, Fulfillment Integrations, Media, VIP / Membership, Users / Access, Integrations, and Settings.
- D1-backed email/password accounts, verification/reset email, Discord/Google/GitHub/X OAuth, explicit Turnstile, hashed sessions, one-time public handoff, rate limiting, and bounded audit records.
- Fail-closed loading, signed-out, regular-user, Full Admin, and Master Admin gates with no protected dashboard flash.
- Functional `/access` account registry with self-service display-name editing, avatar upload/URL import, search/filters, and Master-only promotion, demotion, status, and session-revocation controls.
- Admin-authoritative avatar ingestion validates JPG/PNG/WebP bytes, stores immutable content-addressed objects under `/u/<opaque-account-key>/avatar/<sha256>.<ext>`, and persists only the resulting HTTPS URL in D1.
- Admin-only authority for the bound `thirdrailify-commerce` D1, direct-merchant provider/status records, encrypted private business/tax fields, structured email/document templates, commerce capabilities, and redacted commerce audit history.
- Functional `/products` merchandising workspace backed by `commerce_products`: Master Admins can feature/unfeature displayable snapshot products, set deterministic hero order with accessible move controls, preview warnings, and persist through the established session/origin/CSRF/rate-limit/D1/audit path.
- Local V2 GOATS authority and Master Admin workspace for submission moderation, coarse map coordinates, private media, approved publication, reactions/comments, and idempotent transactional-email outbox events. Migration `0004` ships no production listings; two synthetic demos are explicit local/test-only fixtures.
- Public read-only `/api/catalogue/merchandising` projection exposes only product ID, slug, featured state, and order; it contains no price, image path, safe metadata, credential, or write capability.
- Public-origin `POST /api/commerce/checkout` is the Admin-hosted customer Checkout engine: it accepts only a checkout-request UUID plus bounded product IDs and quantities, derives CAD integer prices/names/totals from `commerce_products`, snapshots a local order before Stripe, and creates only Stripe-hosted TEST Checkout Sessions. The remote `checkout_enabled=false` gate and empty authoritative catalogue keep the route safely disabled.
- Public machine-to-machine `POST /api/webhooks/stripe` receiver code with exact raw-body Web Crypto verification, a five-minute Stripe `v1` timestamp window, test-event enforcement, and D1-backed duplicate receipt protection. A real signed sandbox event has verified the deployed destination and matching Admin-only signing configuration.
- Stripe-first Canadian operating model using the dedicated Third Railify Official merchant account, server-created Stripe-hosted Checkout Sessions, Admin-only environment secrets, disabled Checkout/live capture, a draft-only Printful design, deferred PayPal, unavailable Printify, and untouched legacy Wix production.
- Protected `POST /api/admin/commerce/printful/verify` action for exactly two server-side reads: store-scoped discovery through `GET /stores`, then `GET /store/products?limit=1`. Live verification resolved exactly one dedicated native `Third Railify API` store, safe Store ID `18668025`, and one visible product; the Wix store was not selected. The action rejects Wix or multi-store scope, persists only safe identity/count proof, and never exposes the Private Token.
- Cloudflare Pages static output, SPA fallback, document and response-level noindex, restrictive baseline headers, and no custom domain.

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
npm run goats:import:dry-run -- C:\path\to\wix-goats-export.json
npm run build
npm run preview
```

The production output is `dist/`. The local development server uses port 5174 and preview uses 4174 so it can run alongside the public app.

## Routes

| Path | Current purpose |
| --- | --- |
| `/` | Authenticated account/configuration posture and deferred-module boundaries |
| `/content` | Future site-content shell |
| `/products` | D1-backed featured-product selection and stable hero ordering for the bounded snapshot catalogue |
| `/goats` | GOATS moderation overview with pending/approved/rejected/hidden and email state |
| `/goats/pending`, `/goats/approved`, `/goats/rejected` | Master-only bounded moderation queues |
| `/goats/comments` | Visible/hidden comment moderation |
| `/goats/emails` | Additive GOATS template editor with safe fixture preview |
| `/goats/:id` | Private submission detail, media, correction, coordinates, transitions, email retry, and DEMO-only cleanup |
| `/api/admin/goats/*` | Master-session, exact-origin, CSRF, and optimistic-version protected GOATS authority |
| `/api/goats/*` | Approved-only public reads plus signed fixed internal ingestion actions |
| `/api/catalogue/merchandising` | Cacheable public read projection of product ID/slug/featured order only; no write path |
| `/orders` | Read-only bounded local Checkout/payment/fulfillment states; no synthetic orders or revenue |
| `/commerce` | Truthful commerce readiness and provider status overview |
| `/commerce/payments` | Dedicated Stripe/PayPal/Wix posture plus the permission-gated, read-only Stripe TEST account verification action |
| `/api/commerce/checkout` | Exact-Public-origin customer POST/OPTIONS endpoint; server-priced Stripe-hosted TEST Checkout behind disabled product/configuration gates |
| `/api/webhooks/stripe` | External Stripe sandbox delivery route; POST/raw-body/signature/D1 required, with no browser authentication and only invariant-checked existing-order payment confirmation |
| `/commerce/business` | Structured public/private business profile; persistence fails closed without commerce D1 and encryption |
| `/commerce/tax` | Encrypted tax identifiers and document presentation; no custom tax calculation/compliance claim |
| `/commerce/emails` | Safe structured customer template editor; no send path |
| `/commerce/fulfillment` | Dedicated Printful API-store identity, read-only verification control, draft-only/fulfillment-disabled gates, and untouched Wix posture |
| `/api/admin/commerce/printful/verify` | Admin-session, exact-origin, CSRF, rate-limit, and `commerce.integrations.manage` protected read-only Printful verification |
| `/media` | Future managed-asset shell |
| `/membership` | Future VIP/membership shell |
| `/access` | D1-backed account registry and role/status/session controls |
| `/integrations` | Future server-side integration shell |
| `/settings` | Future governed settings shell |
| everything else | Branded 404 |

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
│   ├── _routes.json        Auth, Admin, profile-media, and Stripe webhook Pages Function routing
│   └── _redirects          SPA fallback
├── functions/
│   ├── _shared/            D1 auth/session/OAuth/security, profile-media, commerce, and GOATS helpers
│   ├── api/                Shared auth, signed Admin/GOATS APIs, public projections, and signed Stripe webhook receiver
│   └── u/                  Immutable R2-backed profile-media delivery
├── commerce-migrations/    Commerce, Stripe/order/product authority, and additive GOATS community schema
├── migrations/             Idempotent D1 account foundation
├── src/
│   ├── auth/               Gate, session provider, modal, Turnstile, and account widget
│   ├── commerce/           Typed Admin commerce API client
│   ├── components/         Shell, icons, and state examples
│   ├── config/             Route/navigation definitions
│   ├── pages/              Live Overview/Accounts, commerce control plane, future areas, and 404
│   └── styles/             Tokens and responsive admin visual system
├── tests/
│   ├── printful.test.mjs   Focused single-store, no-write, persistence, and Store-ID invariant coverage
│   └── …                   Auth/commerce migrations, crypto, API, permissions, and safety coverage
├── docs/                   GOATS authority/import contracts and operator boundaries
├── scripts/                GOATS import validator plus opt-in demo seed/cleanup fixtures
├── CLOUDFLARE_COMMERCE_SETUP.md
├── CLOUDFLARE_AUTH_SETUP.md
├── CLOUDFLARE_SETUP.md
├── COMMERCE_ARCHITECTURE.md
├── STRIPE_CANADA_FEASIBILITY.md
├── WIX_COMMERCE_AUDIT.md
├── BUMP_NOTES.md
└── package.json
```

The display system uses the seeded American Captain asset at its real weight with lightly relaxed tracking for the primary header voice, with seeded Blinker and Geist Mono for readable body and technical roles.

## Security boundary

- GOATS reuses Master Admin session/role resolution, exact-origin writes, CSRF, privacy-conscious rate limits, and the Admin-only commerce D1/R2 bindings. Public sees only approved/published projections and opaque public media routes; private email, account association, raw object keys, moderator notes, email state, and audit metadata never enter public output. See `docs/GOATS_V2.md` for APIs, binding/secrets, outbox, cleanup, and local fixture operations.

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
- Checkout is not an Admin mutation: it requires the exact configured Public origin, narrow POST/OPTIONS CORS, commerce D1, disabled/live/provider/API/webhook gates, a test-only server credential, bounded JSON, and the anonymous checkout rate limit. It requires Turnstile only if the future `checkout_turnstile_required` safe setting is explicitly enabled. It never accepts browser price, name, currency, total, Stripe Price ID, tax, shipping, or discount authority.
- `stripe_api_configured=true` means a server-side test credential completed `GET /v1/account` and the returned account passed the `CA`/`cad` checks. `stripe_webhook_configured=true` means a correctly signed, timely, well-formed, `livemode=false` Stripe Event reached the duplicate-safe receipt path. Secret existence alone proves neither state, and neither flag enables Checkout, live payment capture, or fulfillment.
- Printful uses its real API, not a Stripe-style sandbox. `PRINTFUL_API_TOKEN` is a production-capable, store-scoped Admin Cloudflare encrypted secret; `PRINTFUL_STORE_ID=18668025` is ordinary safe Wrangler configuration. Verification accepts exactly one native store named `Third Railify API`, compares token/configured/persisted IDs whenever configuration exists, performs only the two approved GETs, and leaves order mode `draft_only`, webhooks false, fulfillment false, and the Wix-connected store untouched.
- Private business/legal/tax values require the separate commerce D1 and server-only AES-256-GCM key. Missing storage/key, malformed envelopes, wrong keys, and tampering fail closed. The dedicated Stripe account's secret key/webhook secret and the Printful token remain Admin-only Cloudflare encrypted secrets; no browser or Public payload receives them.
- Structured email/document templates allow bounded fields only and reject scripts or executable HTML. There is no send path in this milestone.
- `noindex` is not access control. The application gate and signed APIs are mandatory; any outer Cloudflare Access policy must preserve narrowly required public auth/callback routes.

## Cloudflare and domain safety

See `CLOUDFLARE_AUTH_SETUP.md` for account infrastructure and `CLOUDFLARE_COMMERCE_SETUP.md` for the staged commerce setup and remaining disabled activation gates. `COMMERCE_ARCHITECTURE.md`, `WIX_COMMERCE_AUDIT.md`, and `STRIPE_CANADA_FEASIBILITY.md` record the direct dedicated-account design, source evidence, and remaining off-code checks. Do not attach `admin.thirdrailify.com` during staging.
