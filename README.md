# Third Railify Admin

## Gaming request Inbox intake (local implementation)

Signed Public `POST /api/gaming/suggestions` requests now enter the existing durable Admin Inbox as category `gaming` and source type `gaming_suggestion`. The receiver verifies the exact Public origin, timestamp, request ID, body digest, and existing `THIRDRAILIFY_COMMUNITY_API_SECRET`; applies the existing Turnstile and rate-limit authorities; normalizes only exact HTTPS Steam app URLs; and preserves server-signed account attribution without trusting browser identity. Idempotency uses the existing Inbox source identity constraint. No new Admin page, schema migration, provider API, Steam credential, email delivery, or remote mutation is required; operators use the existing `/inbox` destination.

Focused coverage is `npm run test:gaming`. No deployment, remote database write, migration, secret, DNS, or provider action was performed.

Gaming tree additions are `functions/api/gaming/suggestions.js` and `tests/gaming-suggestions.test.mjs`. The existing limiter registry, Pages route manifest, package scripts, README, and bump notes are extended in place; no file or migration was added elsewhere.

## Polls V1.1 discovery and media authority (local implementation)

The existing bot heartbeat now carries a bounded, secret-safe Rumble discovery projection. Creator-authorized signed requests can read only the resolved `channel_id`-first/`user_id`-fallback source, display name, safe livestream metadata, and freshness. Raw chat, stream keys, server URLs, credentials, and arbitrary runtime fields are excluded; bot health is reported as healthy, stale, or offline and does not widen creator grants.

Additive migration `commerce-migrations/0027_polls_v11_media.sql` adds lifecycle-tracked Poll banner and option-image metadata while retaining the existing `theme_json` authority. Uploads reuse Admin-owned `THIRDRAILIFY_PROFILE_MEDIA`, accept bounded validated JPG/PNG/WebP files, use opaque object keys, and are owner/Admin scoped. Only active assets belonging to public open/closed Polls are readable from `cdn.thirdrailify.com`; draft/private reads stay on the signed same-origin path. There is no Public R2 binding or upload authority.

No remote migration, D1/R2 write, deployment, provider request, secret, DNS, or bot process action was performed. Apply `0027` deliberately before deploying the Admin/API/media code, then roll out the bot heartbeat adapter and Public UI.

## Current Printful catalogue reconciliation (local implementation)

Shop / Products now has an auditable Preview / Apply workflow that reads the explicitly configured `Third Railify API` native store in full, matches only deterministic provider identities, preserves deliberate local curation and historical references, imports current missing rows privately, and archives stale/wrong-store/legacy rows without hard deletion. Migration `commerce-migrations/0026_printful_catalogue_reconciliation.sql` adds current-provider state plus sanitized run/item audit records. Apply is Master-only, CSRF/rate-limited, requires exact typed confirmation, and re-reads both provider and local authority before one D1 batch. Image completeness is compared per product even when the provider fingerprint is unchanged: explicit valid Admin editorial overrides win, otherwise reconciliation selects only current customer-safe Printful thumbnails/previews, canonicalizes first-party commerce-media URLs, and records the selected provenance in existing safe metadata.

The default Admin product view, Featured/publish controls, Public projection, checkout, and sellability now honor current provider presence after the first reconciliation. Featured is an independent local curation preference for every provider-current product, including Hidden products and products with zero public variants; Public still requires current provider state, active/public visibility, valid CAD pricing, and a purchasable public variant before exposing that preference. See [the operator, rollback, and evidence guide](docs/PRINTFUL_CATALOGUE_RECONCILIATION.md). This work is local only: no remote migration, deployment, provider write, payment, order, or production D1 mutation was performed.

Tree additions: `commerce-migrations/0026_printful_catalogue_reconciliation.sql`, `functions/_shared/current-catalogue-reconciliation.js`, `scripts/verify-current-printful-catalogue.mjs`, `docs/PRINTFUL_CATALOGUE_RECONCILIATION.md`, and `tests/current-catalogue-reconciliation.test.mjs`. Updated authority surfaces include Admin Commerce routes/core/media/launch, Products UI/client/styles, migration tests, and responsive commerce browser fixtures. `npm run verify:printful:current` performs the bounded store read; `npm run preview:printful:reconciliation` compares that read with the checked-in legacy manifest in an ephemeral local D1 database.

## Automations and Poll authority V1 (local implementation)

Admin Commerce D1 is the sole authority for Poll definitions/options, creator grants, lifecycle, current votes, Rumble event fingerprints, one active Rumble lease per source, bot desired-state revisions, heartbeat/runtime state, and bounded activity. Additive `commerce-migrations/0025_automations_polls_v1.sql` follows `0024`; it must be applied deliberately after backup/ledger inspection and before any V1 code rollout. No remote migration was run.

`/polls` provides the all/open/draft/closed/archived catalogue with owner, audience policy, Rumble state, totals, inspection, lifecycle controls, and `/polls/access` creator moderation. `polls.view/manage` and `automations.view/manage` use the existing capability registry: Master and Full Admin retain current parity, approved regular accounts create/manage only owned Polls through Public, and regular accounts cannot self-grant or mutate bot-global state.

`/automations` is the versioned bot command centre. It shows online/stale/offline heartbeat state, desired/applied revision, safe Discord settings, Rumble configuration-versus-health, scheduler/lease/backoff/backlog state, the active Poll and triggers, and bounded activity. Supported Rumble enablement/cadence and notification channel/role values converge with the existing slash commands through signed optimistic revision sync; an Admin outage leaves local slash changes explicitly pending, and a revision conflict refreshes Admin authority instead of silently overwriting it. Process control is explicitly deferred. The General Trigger Studio is presentation-only; follower/subscriber/gift/livestream rule execution, ordinary Rant parsing, and Wheel-entry execution remain disabled pending verified contracts.

Public relays use `THIRDRAILIFY_COMMUNITY_API_SECRET`; the bot uses the separate `THIRDRAILIFY_BOT_ADMIN_SECRET`. Bot service requests sign method, exact path, timestamp, request ID, and SHA-256 body digest with replay retention. Poll voter hashes use `THIRDRAILIFY_POLL_VOTER_SECRET`; browser abuse bounds use the existing `THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET`. None is browser-editable or projected. API groups live under `/api/polls`, `/api/admin/polls`, `/api/admin/automations`, and `/api/internal/bot`.

Tree additions: `commerce-migrations/0025_automations_polls_v1.sql`, `functions/_shared/poll-normalization.js`, `functions/_shared/polls-core.js`, the Poll/Admin/Automations/bot Functions, `src/polls/`, `src/pages/PollsAdminPages.tsx`, `src/styles/polls-admin.css`, and `tests/polls-core.test.mjs`. Rollout order is migration and secret custody, Admin, bot, then Public; verify staging HMAC, revision convergence, heartbeat, lease release, account/anonymous votes, and responsive routes before production promotion.

Wheels V1.12 adds `/wheels/mechanics` as the visual editor for the existing revisioned global Wheels settings authority, `/wheels` as an operational Overview, and `/wheels/library` as the focused library. The editor follows the same graphite, warm-neutral, and gold Admin visual system. Public receives only the sanitized read projection; saving remains protected and audited. See `docs/WHEELS_V1.md` and `docs/WHEELS_STAGE_V1.md`.

## Admin authorization and Full Admin parity

Admin authorization is server-owned and capability-based. `functions/_shared/admin-capabilities.js` is the canonical registry and resolver; `src/auth/capabilities.ts` mirrors its identifiers only for route, navigation, and read-only presentation. Master Admin receives every registered capability and cannot be restricted. Full Admin receives every registered normal Admin capability by default, including ordinary operational mutations, then loses only capabilities explicitly denied by Master Admin. Regular users receive no Admin capabilities. Unknown identifiers fail closed.

The only nondelegable control-plane capability is `role_permissions.manage`. Full Admin always retains `role_permissions.view`, so `/settings` always exposes the Role Permissions & Scopes matrix even if general settings visibility or management is restricted. Master Admin can explicitly save Full Admin denials or reset to defaults; reset deletes denial rows. Full Admin sees the same selectable Master/Full/Regular inspection views, grouped matrix, descriptions, default/restricted/required/Master-only states, and current effective policy; inspection radios and search remain usable while policy switches and all mutation actions remain unavailable. View denials hide navigation and render a branded restricted route state; manage denials retain the page in an intentional read-only mode, while the corresponding API independently rejects direct mutation calls.

Migration `migrations/0002_full_admin_capability_denials.sql` adds `admin_role_capability_denials` to the existing Account/Auth D1. Absence means allowed, so existing and future Full Admins need no grant seeding and newly registered normal capabilities inherit default access. Policy reads and normal capability resolution are request-time authoritative; a role-policy change therefore applies on the next request, while the Settings editor refreshes the current session projection after save/reset. Each changed capability writes existing `auth_audit` evidence with the Master actor, previous/new effective state, operation, and timestamp.

New Admin work must first register a real capability, map its route, enforce that capability in every privileged Function, and use the effective session payload only for presentation. Normal new capabilities must remain Full-Admin-enabled by default. Direct Master checks are reserved for the immutable role-policy authority and protected environment-Master identity lifecycle. The legacy per-account Commerce grant endpoints are retired in favor of this role policy.

Local rollout artifacts added by this milestone are `functions/_shared/admin-capabilities.js`, `functions/api/admin/role-permissions/[[path]].js`, `migrations/0002_full_admin_capability_denials.sql`, `src/auth/capabilities.ts`, `src/auth/AdminCapabilityBoundary.tsx`, `src/auth/role-policy-client.ts`, `tests/admin-capabilities.test.mjs`, and `tests/role-policy-browser.test.mjs`. Apply the Auth D1 migration before deploying the Admin code; do not seed allow rows. Verify the policy endpoint and default Full Admin route/operation parity after deployment.

## Public account eligibility hotfix

Public account eligibility is independent of Admin privilege. Regular, Full Admin, and environment Master Admin sessions all use the same canonical internal Account ID for profile, Customer linkage, addresses, orders, donations, and recipient-scoped Public Messages. The signed `/api/account-commerce/internal/*` relay continues to derive that ID from the authenticated Public session; browser-supplied account or recipient IDs are not trusted, and the separate Admin Inbox remains unchanged.

Normal authenticated account reads now use a dedicated high-volume `account_commerce_read` limiter, while account mutations use `account_commerce_mutation` and Admin commerce mutations retain their existing `commerce` limiter. This prevents ordinary overview/header/inbox reads from inheriting a Master Admin's Admin-commerce mutation bucket without disabling abuse controls. Public clients issue bounded requests and do not automatically retry permanent 4xx or 429 responses.

Server-owned account order and donation creation now writes an idempotent transactional Public Message in the same local Commerce D1 batch when the Customer is linked to an Account. Message recipient identity comes only from `commerce_customers.linked_account_id`; role never broadens or suppresses delivery. Authenticated donations lazily create the existing canonical account Customer when needed. Migration `0024_analytics_and_message_controls.sql` already represents these relationships, so this hotfix adds no migration. Repository tree addition: `functions/_shared/account-messages.js`.

## Operations directories and account access presentation (local implementation)

The former `/media`, `/membership`, `/integrations`, and `/settings` scaffolds are now bounded operational directories built from existing authenticated clients and current repository authority. `/media` provides a read-only view of Commerce catalogue images plus approved GOATS previews and links to the authoritative Wheels and Access owners. `/membership` distinguishes Accounts from currently unavailable recurring membership/subscription authority. `/integrations` summarizes sanitized Auth, PayPal/Stripe, Printful, email, D1, R2, Turnstile, and OAuth configuration without calling providers or exposing secrets. `/settings` is an authority directory for the existing banner, GOATS, Wheels, Payments, Fulfillment, Emails, and Access owners; its three future global-control fields remain visibly disabled and non-persistent.

`/access` now uses exact presentation chips: Master is gold, Full is magenta/purple, and Regular is grayscale. The Admin account trigger and dropdown share the presentation-only shield badges used by Public: gold lightning for Master Admin, gold check for Full Admin, and muted gray check for Regular User. The dropdown identity is two rows, the compact badge remains visible on small screens, and no authorization decision is derived from these visuals.

Commerce Intelligence reporting headings and table reset controls now retain consistent card gutters at desktop, tablet, and mobile widths. Repository tree additions are `src/components/AccountAccessBadge.tsx` and `src/pages/OperationsPages.tsx`. Existing routes and deep links remain intact; no migration, backend authority, deployment, provider call, or Cloudflare resource mutation was introduced.

## Analytics incident repair and Commerce Intelligence V1 (local implementation)

The live `/analytics` failure is explained by production being one Commerce D1 migration behind: `commerce-migrations/0024_analytics_and_message_controls.sql` creates `analytics_events` and all 21 columns required by the ingestion and reporting contract. The reporting code has no correctness dependency on the four reporting indexes, although `0024` creates them for bounded query performance. The Admin endpoint now performs an explicit `PRAGMA table_info('analytics_events')` capability check before any report query and returns safe `503 analytics_migration_required` state instead of relying on the shared generic missing-table translator. Missing schema is never represented as zero traffic. Authentication failures, malformed ranges, independent Revenue Pulse failure, empty compatible storage, partial history, stale collection, and map-only failure remain distinct. Audience Analytics now uses a dedicated chart icon rather than the Overview grid icon.

The new authenticated `/commerce/analytics` route is the read-only LIVE financial command centre. Its server-owned reporting layer excludes TEST/sandbox, pending, failed, and canceled records; keeps merchandise, donations, customer-paid shipping, and tax separate; applies completed persisted refunds/reversals; groups every value by original currency; and never ships raw commerce tables or personal/provider credential data to the browser. Gross collected is captured order totals plus completed donation authority. Net collected is gross less completed persisted refund/reversal evidence and becomes incomplete when a dispute lacks an authoritative amount.

Historical fulfillment/product costs are considered known only when a provider-linked order has positive persisted transaction cost values. The schema's legacy zero defaults remain `Unknown`, never `$0.00`. Processor fees are reported only when a positive persisted transaction fee exists; no published fee schedule is estimated. Contribution margin is calculated only for fully evidenced merchandise orders as net collected less tax, known provider costs, and known processor fees. Partial-refund allocation, order-level cost allocation across multiple products, donation processor fees, and business overhead remain unavailable, so the UI does not expose a Profit metric. Coverage panels report known/unknown fulfillment costs, processor fees, order allocations, donation reversal evidence, unresolved disputes, currencies, freshness, and bounded-read truncation.

No Commerce Intelligence migration was added. Existing migrations through `0021` already contain the read authorities; current Printful normalization discards provider cost fields and no provider response fixture proves a safe final-cost contract, so this milestone does not invent provider snapshots or guessed backfills. Secure CSV export is deferred because no established financial export infrastructure exists.

Production rollout remains manual and was not performed here. From this repository, first inspect pending migrations and stop unless `0024_analytics_and_message_controls.sql` is the only pending Commerce migration. Back up the remote database, then use the pinned Wrangler 4.60.0 migration ledger command:

```powershell
$node22 = 'C:\Users\TempAdmin\.codex\tmp\node-v22.16.0-win-x64\node.exe'
& $node22 node_modules/wrangler/bin/wrangler.js d1 migrations apply thirdrailify-commerce --remote --config wrangler.jsonc
```

Deploy Admin only after schema verification; Public needs deployment only if its analytics ingestion artifact or shared encrypted ingestion-secret custody is not already current. Verify the same `THIRDRAILIFY_ANALYTICS_INGEST_SECRET` is present in both Pages projects without printing it, then confirm an authorized `/api/admin/analytics` read, live `/analytics`, signed stable-origin ingestion, and absence of the ingestion secret from browser assets. Commerce Intelligence has no additional migration dependency beyond the existing commerce chain.

Repository tree additions for this milestone are `functions/_shared/commerce-intelligence.js`, `src/commerce/intelligence-client.ts`, `src/pages/CommerceIntelligencePage.tsx`, `tests/analytics-browser.test.mjs`, `tests/commerce-intelligence.test.mjs`, and `tests/commerce-intelligence-browser.test.mjs`. No files were removed.

## Audience Analytics V1 and message controls (local implementation)

The authenticated `/analytics` workspace is the reporting authority for first-party Public traffic. `POST /api/internal/analytics/ingest` accepts only exact-Public-origin, timely HMAC-signed events using `THIRDRAILIFY_ANALYTICS_INGEST_SECRET`; `GET /api/admin/analytics` requires the established Admin session and returns private/no-store aggregates. The dashboard provides exact trailing 24-hour, 7-day, 30-day, and 90-day totals; preceding-window coverage/deltas; UTC trends; top routes, sources, and devices; a lazy MapLibre/OpenFreeMap coarse activity map with a non-map regional fallback; and truthful LIVE Commerce revenue grouped by currency.

Revenue definitions are deliberately narrow: merchandise includes LIVE orders whose payment state is `paid`, `partially_refunded`, or `refunded`; donations include LIVE `completed`, `refunded`, or `reversed` donation authority. Gross is collected merchandise plus donations, refunded/reversed is shown separately, and net collected subtracts those reversals. TEST/sandbox, pending, failed, cancelled, and disputed records are excluded. The page does not label revenue as profit because complete authoritative processor fees and fulfilment costs do not exist for every transaction.

Migration `commerce-migrations/0024_analytics_and_message_controls.sql` adds `analytics_events` and its reporting indexes, adds per-Admin `deleted_at` inbox state, and creates recipient-scoped `account_inbox_messages` / `account_inbox_states`. Admin and Public inboxes support individual/bulk read, unread, and soft-delete actions plus accessible full-detail lightboxes while preserving message CTAs.

Rollout is intentionally manual: back up and inspect Commerce D1, apply only migration `0024`, configure the same encrypted `THIRDRAILIFY_ANALYTICS_INGEST_SECRET` on Admin and Public, retain `VITE_ANALYTICS_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/dark` (or another approved no-key style), deploy Admin before Public, then verify authenticated reads, signed ingestion, stable custom-origin collection, map fallback, and no browser-secret exposure. No remote migration, deployment, DNS/domain, provider, payment, or commerce-gate change occurred in this local task.

Repository tree additions: `commerce-migrations/0024_analytics_and_message_controls.sql`, `functions/_shared/analytics.js`, `functions/api/internal/analytics/ingest.js`, `functions/api/admin/analytics.js`, `src/analytics/client.ts`, `src/pages/AnalyticsPage.tsx`, `tests/analytics-inbox.test.mjs`, and `tests/inbox-browser.test.mjs`. The commerce migration sequence is current through additive `0024`.

Commerce payments use PayPal Orders API v2 as the preferred direct-merchant rail for store purchases and one-time donations. Stripe is retained as a configured but disabled future option. PayPal documentation: [commerce operations](docs/PAYPAL_COMMERCE.md), [owner setup for Shawn](docs/PAYPAL_SETUP_FOR_SHAWN.md), and [operator setup for Daniel](docs/PAYPAL_OPERATOR_SETUP_FOR_DANIEL.md).

## Replacement commerce catalogue authority

Commerce D1 (`thirdrailify-commerce`) is the merchandising and CAD price authority for the replacement shop. `/products` manages product presentation, public visibility, deterministic ordering, bounded quantities, variant labels/options, integer-minor-unit CAD prices, and display-versus-checkout readiness. Provider identities and migration provenance are read-only integration metadata.

Accounts and Customers are deliberately different authorities. An Account is an authentication identity with providers, roles, state, and sessions; it does not become a Customer merely by existing. A Customer is created when a guest enters the order lifecycle or when a signed-in user deliberately opens an Account commerce surface. Guest Customers remain unlinked, while account-backed Customers use the server-resolved Account ID and one Account maps to at most one Customer. Exact matching guest and Account emails never trigger an automatic merge. Orders reference Customers from additive migration `0017_commerce_customers.sql`, while each order keeps its encrypted checkout contact/delivery snapshot as immutable historical truth.

Migration `0019_account_address_book.sql` adds encrypted current Customer phone custody and `commerce_saved_addresses`. The signed internal `/api/account-commerce/internal/*` boundary accepts only exact-Public-origin HMAC-authenticated requests after Public has resolved an active session. It provides bounded current contact, address CRUD/default selection, and account-owned order list/detail projections. Saved addresses use optimistic revisions, one default, a ten-active-address cap, hard deletion for reusable PII, and no coupling to historical order snapshots. Public still has no Commerce D1 binding, and projections exclude encryption envelopes, fingerprints, Stripe identifiers, webhook evidence, secrets, and raw provider objects.

The Admin exposes only sanitized, unauthenticated read projections under `/api/public/commerce/*`; the Public Pages project proxies them without owning a Commerce D1 binding. Normal checkout, live payment capture, and fulfillment remain globally disabled. The one-time `stripe_test_checkout_enabled` pre-cutover gate is now closed after the successful first genuine Stripe TEST acceptance; its product/variant selectors were removed, so no further controlled Session can be generated. The permanent Printful migration is independently checkpointed and remains manually paused.

Acceptance passed for preserved TEST order `ord_e47b94a4-4252-438b-8ca7-c47470029940` and Session `cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC`: one signed `checkout.session.completed` receipt confirmed CAD 15.00 for local product `product-397267935` / variant `variant-5019554081` (**11 oz / Black**). The variant is restored to `is_sellable=0` with acceptance-only markers removed. The historical status page remains readable from local state; fulfillment stays `disabled / not_started` with no Printful order.

Independent authenticated control room for Third Railify operations. The shared D1 account authority, real session/role enforcement, bounded account administration, and an Admin-only Canadian commerce control plane are implemented. The real Printful API can be verified read-only against its dedicated store, while checkout, live payment capture, provider writes, and fulfillment remain disabled.

The canonical Admin origin is `https://admin.thirdrailify.com`; Public links use `https://thirdrailify.com`. The old Admin Pages hostname retains `/api/*` and webhook compatibility while browser navigation becomes non-canonical. Sessions remain host-only; no cookie is broadened to all subdomains.

Production Google OAuth is enabled through the centralized Admin callback with exact `openid email profile` scopes. Legitimate custom-domain Google and X sign-ins passed through the centralized Account authority without role escalation; X required the official confidential-client token form and a matching rotated OAuth 2.0 Client Secret. Their legacy Pages callbacks can now be removed. Discord and GitHub retain their legacy callbacks only until provider-specific custom-domain acceptance passes. Preview Google OAuth remains intentionally disabled. Provider secrets remain encrypted Admin-only bindings and normal OAuth accounts never inherit an Admin role.

## Current state

- Vite 5, React 18, TypeScript, and React Router.
- Wheels V1.8 authority uses additive migration `0022_wheels_segment_styles.sql`, bounded participant style JSON, strict pattern/sound allowlists, and Admin-owned R2 segment-fill validation/delivery with GIF preservation, SHA reuse, ownership checks, and 20-asset/12 MiB wheel budgets.
- Wheels Stage V1 authority uses additive migration `0023_wheels_stages_v1.sql`, normalized Stage membership, six-Wheel bounds, independent Wheel reauthorization, revision conflicts, audit/rate limiting, and a dedicated Admin management route. See `docs/WHEELS_STAGE_V1.md`.
- Branded responsive sidebar with a discreet topbar-triggered desktop icon-only collapse, a full mobile drawer, a header-aligned authenticated account menu, a fail-soft cross-authority operational overview, future-area route shells, and a branded 404.
- American Captain display typography rendered at its real weight with lightly relaxed heading tracking and line-height.
- Routes for Overview, Watch / Broadcast, Site Content, expandable Shop (Products, Collections, Orders), Commerce Overview, Payments & Payouts, Business Information, Tax & Documents, Customer Emails, Fulfillment Integrations, Media, VIP / Membership, Users / Access, Integrations, and Settings.
- D1-backed email/password accounts, verification/reset email, Discord/Google/GitHub/X OAuth, explicit Turnstile, hashed sessions, one-time public handoff, rate limiting, and bounded audit records.
- Fail-closed loading, signed-out, regular-user, Full Admin, and Master Admin gates with no protected dashboard flash.
- Functional `/access` account registry with self-service display-name editing, avatar upload/URL import, search/filters, and `users.manage`-protected promotion, demotion, status, and session-revocation controls. Protected environment-Master identities remain immutable.
- Admin-authoritative avatar ingestion validates JPG/PNG/WebP bytes, stores immutable content-addressed objects under `/u/<opaque-account-key>/avatar/<sha256>.<ext>`, and persists only the resulting HTTPS URL in D1.
- Admin-only authority for the bound `thirdrailify-commerce` D1, direct-merchant provider/status records, encrypted private business/tax fields, structured email/document templates, commerce capabilities, and redacted commerce audit history.
- Functional `/products` merchandising workspace backed by `commerce_products`: `commerce.catalogue.manage` can feature/unfeature displayable snapshot products, set deterministic hero order with accessible move controls, preview warnings, and persist through the established session/origin/CSRF/rate-limit/D1/audit path.
- Admin-authoritative V2 GOATS workspace for submission moderation, coarse map coordinates, private media, approved publication, editable approved stories, per-listing/global interaction policies, pending comment/reaction queues, and idempotent transactional-email outbox events. The owner-supplied Wix collection is imported through the deterministic `goats:wix:build-import` pipeline; Public receives approved fields only.
- `watch.view`/`watch.manage`-protected workspace for reading current/retained Public broadcast state and showing or hiding retained episodes through an exact-origin, CSRF/rate-limited, audited, server-signed Admin-to-Public request. The browser receives no shared secret and cannot create, scrape, edit, or delete episodes.
- Public read-only `/api/catalogue/merchandising` projection exposes only product ID, slug, featured state, and order; it contains no price, image path, safe metadata, credential, or write capability.
- Protected catalogue recovery pins the legacy Wix source to `Third Railify Official` / `16847493` / `wix` and the permanent target to `Third Railify API` / `18668025` / `native`. Its signed phased checkpoint remains a separate, manually paused migration authority. `/commerce/fulfillment` now consumes only its safe persisted counts and state; it cannot resume, retry, or mutate the migration and never calls Printful.
- Public-origin `POST /api/commerce/shipping-quotes` and `POST /api/commerce/checkout` are the Admin-authoritative guest boundaries. They accept bounded local product/variant IDs, quantities, and normalized delivery input; bind an opaque rate quote to server-resolved cart and recipient fingerprints; encrypt the durable recipient snapshot; derive integer CAD subtotal/shipping/total; snapshot the order before Stripe; and remain fail-closed while `shipping_strategy` and checkout gates are disabled.
- Capability-protected `POST /api/admin/commerce/test-checkout` reuses that exact checkout core behind Admin origin, session, `commerce.operations.manage`, CSRF, rate limits, the dedicated test gate, an exact configured candidate lock, and a one-order ceiling. `/orders` shows the candidate, TEST environment, immutable product/variant line, Session/payment state, disabled fulfillment, no-Printful-order state, and the safe hosted Checkout URL.
- Admin remains the sole Wheels D1 and custom-media R2 write authority. Additive migration `0016_wheels_media.sql` stores bounded lifecycle metadata only; upload/remove routes enforce owner/editor or Master access, edit locks, rate limits, raster/SVG validation, hidden-wheel protection, audit, and immediate old-object cleanup. Public receives only opaque asset IDs and D1-gated CDN media URLs, never an object key or binding.
- `GET /api/public/commerce/order-status?session_id=cs_test_…` exposes only an exact-session local payment projection for Public's `/checkout/success` page. It cannot enumerate orders, does not call Stripe from the browser, and never treats a success redirect as payment authority.
- Public machine-to-machine `POST /api/webhooks/stripe` receiver code with exact raw-body Web Crypto verification, a five-minute Stripe `v1` timestamp window, test-event enforcement, and D1-backed duplicate receipt protection. A real signed sandbox event has verified the deployed destination and matching Admin-only signing configuration.
- Public machine-to-machine `POST /api/webhooks/printful` receiver code for allowlisted Printful V2 beta lifecycle evidence, with exact raw-body HMAC verification, store isolation, bounded digest idempotency, and no raw-payload retention. The provider configuration now reads back with the exact custom URL, 12-event set, public key, and no expiry, but the signing secret is not in verified custody. The receiver remains fail-closed and signed delivery remains unverified pending the [Printful support escalation](docs/PRINTFUL_V2_WEBHOOK_SUPPORT.md).
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
| `/watch` | Capability-protected current broadcast summary and retained-episode visibility controls; no manual archive creation |
| `/content` | Capability-protected normal promo and automatic Live Now banner presentation editor with safe previews |
| `/products` | D1-backed featured-product selection and stable hero ordering for the bounded snapshot catalogue |
| `/goats` | GOATS moderation overview with pending/approved/rejected/hidden and email state |
| `/goats/pending`, `/goats/approved`, `/goats/rejected` | Capability-protected bounded moderation queues |
| `/goats/comments`, `/goats/reactions` | Pending/approved/hidden interaction moderation |
| `/goats/settings` | Global inherited defaults for comments and reactions |
| `/goats/emails` | Additive GOATS template editor with safe fixture preview |
| `/goats/:id` | Private submission detail plus editable approved content/product/rating/location/interaction policy, media add/replace/remove/order, transitions, email retry, and DEMO-only cleanup |
| `/api/admin/goats/*` | `goats.view`/`goats.manage`, exact-origin, CSRF, and optimistic-version protected GOATS authority |
| `/api/admin/watch` | `watch.view`/`watch.manage`, exact-origin, CSRF, rate-limited and audited bridge to signed Public archive management |
| `/api/admin/banner` | `content.view`/`content.manage` banner authority with exact-origin, CSRF, rate limit, validation, revision matching, and audit |
| `/api/banner` | Cacheable read-only projection of safe banner presentation fields for Public Pages |
| `/api/gaming/suggestions` | Exact-Public-origin HMAC/Turnstile/rate-protected Gaming request intake into the existing Admin Inbox |
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
| `/media` | Read-only cross-authority asset inventory and routes to canonical editors |
| `/membership` | Account/payment readiness with explicit absent membership authorities |
| `/access` | D1-backed account registry and role/status/session controls |
| `/integrations` | Sanitized existing-provider configuration and authority directory |
| `/settings` | Authority directory plus server-backed Role Permissions & Scopes matrix |
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
├── commerce-migrations/    Commerce authority through additive `0025_automations_polls_v1.sql`
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

- GOATS reuses canonical `goats.view`/`goats.manage` resolution, exact-origin writes, CSRF, privacy-conscious rate limits, and the Admin-only commerce D1/R2 bindings. Public sees only approved/published projections and opaque public media routes; private email, account association, raw object keys, moderator notes, email state, and audit metadata never enter public output. See `docs/GOATS_V2.md` for APIs, binding/secrets, outbox, cleanup, and local fixture operations.
- Watch visibility reuses canonical `watch.view`/`watch.manage` resolution, exact-origin, CSRF, rate-limit, and audit paths. The Admin Function signs a server-to-server request with the existing encrypted `THIRDRAILIFY_COMMUNITY_API_SECRET`; the browser never receives it. The archive remains in Public's existing SQLite Durable Object, Admin receives no Durable Object binding, and no new secret or Cloudflare resource is required. See `docs/WATCH_V2.md`.

- D1 is the only account/session/role authority. Browser state is a hydration cache, never identity authority.
- Passwords use salted PBKDF2-SHA256; only hashed session, one-time, OAuth-state, rate-limit, and IP-derived values persist.
- The 12-character minimum applies when creating or resetting passwords, not when verifying an existing credential at sign-in.
- All mutations require the exact Admin origin, a current server-resolved role, and CSRF proof. Environment Master accounts remain locked and their passwords stay environment-only.
- Display-name changes are self-service, CSRF-protected, rate-limited, audited, and persisted only through the Admin-owned D1 account authority; Master role/email locking does not overwrite a chosen display name.
- Avatar uploads and URL imports are rate-limited, capped at 5 MB, content-sniffed as JPG/PNG/WebP, and written only to the Admin-owned `THIRDRAILIFY_PROFILE_MEDIA` object binding. Public can proxy a current session proof but cannot own the object binding or update D1 itself.
- Commerce reuses the same session, capability, origin, CSRF, rate-limit, and audit boundary. Full Admin inherits every registered normal Commerce capability unless Master explicitly denies one; ordinary users receive none. The former per-account grant plane is retired.
- Featured-product changes require `commerce.catalogue.manage` and validate a bounded, duplicate-free list of provider-current product IDs server-side before one D1 batch updates the full order. The preference is independent of Hidden/Public state and public-variant count; the Public catalogue continues to apply its separate display and purchase eligibility gates. The lightweight merchandising projection is GET-only and excludes titles, prices, images, metadata, accounts, permissions, and audit records.
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
- Expired sessions, handoffs, OAuth transactions, email-verification tokens, and password-reset tokens have one `users.manage`, exact-origin, CSRF-protected maintenance action. It deletes only rows whose existing `expires_at` is at or before execution, writes a bounded auth audit event, and does not touch accounts, identities, rate limits, or audit history.
- `COMMERCE_SUPPORT_RUNBOOK.md` documents the exact read-only order/support evidence and the absent refund, cancellation, replacement, claim, shipment, email, and fulfilment mutations. It grants no provider-write or remedy authority.
- `noindex` is not access control. The application gate and signed APIs are mandatory; any outer Cloudflare Access policy must preserve narrowly required public auth/callback routes.

## Wheels authority

Competition wheels are owned exclusively by the existing Admin Commerce D1 through additive migration `commerce-migrations/0014_wheels_v1.sql`. The expandable `/wheels` workspace provides Library, Access, Results, and per-wheel detail routes. Public has no wheel D1 binding: its same-origin gateway signs bounded creator actions and official draws, while Admin revalidates the current account against the accounts D1 and enforces global creator grants, owner/editor/spinner assignments, lifecycle, visibility, locks, revisions, rate limits, and audit.

Official draws reject browser-supplied winners, use Web Crypto rejection sampling over validated integer weights, persist a canonical participant hash plus immutable winner snapshots, and serialize with revision, `spin_sequence`, and idempotency. Voiding preserves the result. The migration seeds no wheels/results; the optional exact staging fixture is in `scripts/wheels-demo-seed.sql`. See `docs/WHEELS_V1.md` for the complete authority and route contract.

## Cloudflare and domain safety

See `CLOUDFLARE_AUTH_SETUP.md` for account infrastructure, `docs/DOMAIN_CUTOVER.md` for the completed canonical-domain transition, and `CLOUDFLARE_COMMERCE_SETUP.md` for the remaining disabled Commerce activation gates. `COMMERCE_ARCHITECTURE.md`, `WIX_COMMERCE_AUDIT.md`, and `STRIPE_CANADA_FEASIBILITY.md` record the direct dedicated-account design, source evidence, and remaining off-code checks. `https://admin.thirdrailify.com` is canonical; the old Pages hostname remains only for browser redirect and machine-route compatibility.
