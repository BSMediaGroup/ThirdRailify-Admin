# Bump notes

CURRENT VER=0.0.0-seed

PENDING VER=0.1.0-alpha.0

No prior version metadata or release scheme existed in this repository. `0.0.0-seed` names the seeded pre-scaffold state; `0.1.0-alpha.0` establishes the first pending, non-production Admin milestone.

## Pending 0.1.0-alpha.0

### Technical

- Corrected the unprovisioned commerce scaffold from an obsolete Stripe Connect platform/connected-account model to the dedicated Third Railify Official Canadian merchant account. Stripe is now a single `stripe` provider with canonical `direct_merchant` mode, `environment_secret` custody, operator-confirmed account creation, Canada/CAD, and truthful setup-required API/webhook/checkout/live-readiness flags.
- Replaced the two Connect-specific migration seeds and onboarding setting in place because no commerce D1 has been provisioned. Added a constrained generic integration-mode field, rejected legacy Stripe provider identifiers, preserved all commerce permissions/entities, and added the missing separate Printful refund/credit accounting field.
- Updated Admin commerce overview, Payments & Payouts, Fulfillment, navigation, architecture, feasibility, Cloudflare runbook, README, and focused tests. The dedicated account does not imply API connectivity, live readiness, payout readiness, wallet availability, or enabled checkout; no Stripe/Printful/PayPal request or remote mutation was made.
- Established the Admin-only Stripe-first Canadian commerce control-plane scaffold without activating commerce: added truthful `/commerce` overview, Payments & Payouts, Business Information, Tax & Documents, Customer Emails, Fulfillment Integrations, and upgraded Products/Orders surfaces. Checkout, live capture, onboarding, provider connection, and fulfillment submission remain disabled.
- Added the idempotent local `commerce-migrations/0001_commerce_control_plane.sql` authority for a future separate `thirdrailify-commerce` D1. It models business/tax profiles, constrained provider custody/status, structured templates, settings, capability grants, provider-neutral products, separately accounted Stripe/Printful order economics, and redacted audit history; no D1 was created, bound, or migrated remotely.
- Added a server-only AES-256-GCM envelope for encrypted private business/legal/tax and future `admin_encrypted` credentials, with a 32-byte base64url key, random nonce, authenticated purpose, bounded plaintext, versioning, tamper/wrong-key rejection, and no plaintext fallback. Stripe and Printful tokens remain Cloudflare Secrets.
- Reused existing auth/session/role/origin/CSRF/rate-limit/audit authority for five commerce capabilities. Master Admins have all capability authority and alone can grant/revoke it; Full Admins can view and receive bounded grants; ordinary users are rejected.
- Recorded a fresh non-mutating Wix public audit, the existing bounded Public snapshot, owner-confirmed private Wix provider facts, and unresolved dashboard-only facts. Wix remains production authority and no Public/Wix/provider state was changed.
- Historical and superseded before provisioning: documented a Canadian Connect account design with hosted onboarding and platform-specific eligibility checks. The dedicated direct merchant account correction above is now authoritative.
- Documented the separate customer-payment and Printful billing transactions, parallel manual/API Printful store, environment-managed store token, safe Store ID, draft-only orders, and explicit no-confirm posture. PayPal remains a later direct-merchant donations/VIP integration; Printify remains unavailable pending evidence.
- Added focused commerce migration, constraints, crypto, fail-closed storage, projection/masking, permission, CSRF, audit-redaction, template-safety, provider-truth, and two-transaction tests. No provider APIs or live resources are used.
- Corrected email sign-in so the browser no longer applies the 12-character new-password policy to existing credentials; signup and password reset retain the 12-character minimum. Added CSRF-protected, rate-limited, audited self-service display-name updates through the Admin D1 authority, including durable custom names for environment Master accounts.
- Moved the oversized sidebar collapse control into the desktop top bar as a discreet icon-only action pinned 12px from the sidebar/workspace boundary before the breadcrumb; mobile continues using only its established drawer button.
- Restored the Admin account trigger from an unrequested pill treatment to the shell's existing 9px squared control radius without changing its identity content or dropdown.
- Upgraded the Admin shell with a persistent desktop icon-only sidebar state, full-width mobile drawer behavior, and a StreamSuites-reference account menu adapted to Third Railify with an identity header, details matrix, icon-prefixed actions, keyboard navigation, and separated sign-out treatment.
- Added Admin-authoritative avatar changes to `/access`: JPG/PNG/WebP uploads and public HTTPS URL imports are session/CSRF/rate-limit protected, capped at 5 MB, byte-validated, stored as immutable `u/<opaque-account-key>/avatar/<sha256>.<ext>` objects through the Admin-only `THIRDRAILIFY_PROFILE_MEDIA` R2 binding, and persisted to D1 only as a clean HTTPS URL. The binding/custom domain remain manual deployment prerequisites.
- Added a shell-level horizontal loading indicator adapted from the StreamSuites Dashboard/Public pattern with Third Railify gold gradients, real Overview/Accounts async tracking, concurrent-load-safe tokens, main-content `aria-busy` state, and a static reduced-motion treatment.
- Switched the Admin dashboard favicon to the supplied `assets/icons/thirdadminfavx.png` artwork with an explicit PNG MIME declaration; all previous icon assets remain preserved but inactive.
- Wired the confirmed production Google OAuth client ID while keeping staging explicitly gated with `GOOGLE_OAUTH_ENABLED=false`. Admin now exposes truthful provider states and blocks both Google OAuth start and callback/token exchange until the gate is enabled with both credentials present; the production callback remains deferred to the domain migration and derived from `THIRDRAILIFY_ADMIN_ORIGIN`.
- Established `ThirdRailify-Admin` as the shared D1 account authority with an idempotent schema for accounts, identities, PBKDF2 credentials, hashed sessions, OAuth transactions, public handoffs, verification/reset tokens, rate limits, and bounded audit events.
- Added explicit Turnstile validation, Resend verification/reset flows, two locked environment Master Admins, Discord/Google/GitHub/X OAuth with one-time state and PKCE where supported, provider-subject uniqueness, verified-email linking, and immediate token discard.
- Added fail-closed Admin session/role gates, the real account widget, protected status hydration, and a functional `/access` registry. Full Admins may read; only Master Admins may promote, demote, enable/disable, or revoke sessions.
- Added exact auth/Admin Function routing, minimal Turnstile/avatar CSP allowances, safe staging origins, sanitized environment examples, and a complete manual Cloudflare/provider setup runbook. The missing real D1 ID remains an explicit activation blocker.
- Added focused D1 migration and auth integration tests. No live OAuth, Turnstile, Resend, Cloudflare resource, binding, secret, deployment, DNS, Access, or custom-domain change was performed.
- Added a Vite/React/TypeScript/React Router application with deterministic npm metadata.
- Added a responsive Third Railify operational shell, centralized route configuration, Overview, eight future-area shells, mobile navigation with Escape handling, visible focus, reduced motion, state examples, and a branded 404.
- Established the seeded American Captain face as the main display/header font, supported by Blinker and Geist Mono.
- Relaxed American Captain heading and brand-lockup tracking/line-height and removed faux-heavy rendering so titles remain condensed without crowding.
- Made system boundaries explicit: no auth, APIs, users, orders, memberships, analytics, provider state, privileged data, or writes are implemented or simulated.
- Added document/response noindex, restrictive static headers, SPA fallback, `.node-version`, and Cloudflare Pages staging documentation.
- Added lint, TypeScript, and production-build scripts. Validation evidence belongs in the completion report for this milestone.
- No Pages project, deployment, DNS, domain, provider, or Wix change was performed.
- Polished the document and scrollable sidebar with a narrow graphite/gold scrollbar treatment adapted from the approved POC.
- Rebuilt the sidebar lockup around the exact `assets/logos/boltv2.svg` silhouette, a POC-derived dark square, gradient-gold mask paint, and a larger `THIRD RAILIFY` title with a subordinate `CONTROL ROOM` label.
- Replaced the temporary inline favicon with the exact `assets/icons/boltv2.ico` asset.
- Checked the visual-polish milestone responsively at 390px, 768px, and 1440px, including the mobile sidebar, overflow, built assets, and browser-console behavior.
- Switched the Admin sidebar lockup to its exact local `assets/logos/boltv2straight.svg` copy while preserving the established gold-gradient mask, rounded dark square, inset highlight, and responsive lockup treatment.
- Replaced the active Admin favicon with the byte-identical local `assets/icons/thirdfavstraight.ico` copy sourced from the authoritative Public asset; previous ICO assets remain preserved but inactive.
- Validated the milestone with Admin lint, TypeScript, production build, diff checks, exact built-favicon bytes/content type, and rendered 390px/768px/1440px checks including the mobile sidebar with no overflow, broken assets, or console errors.
- Configured the confirmed safe Resend sender identity and reply-to address in Admin Wrangler without adding or changing the encrypted `RESEND_API_KEY`; no deployment or email acceptance test was performed.
- Wired the existing Third Railify Official Discord application ID (`1283057181578625034`) into Admin Wrangler as safe staging OAuth configuration.
- Wired the GitHub OAuth App client ID into safe Admin configuration. Its staging and production callbacks remain registered externally on the same GitHub App; GitHub stays credential-driven and becomes available only after the encrypted client secret is provisioned.
- Wired the confirmed X OAuth 2.0 Client ID into safe Admin configuration. The X application is configured externally as a confidential Web App with both staging and production callbacks; its separate numeric X App ID is not used by website authentication, and X becomes operational once `X_OAUTH_CLIENT_SECRET` is provisioned as an encrypted Admin secret.

### Human-readable

Third Railify now has its own dedicated Canadian Stripe account, and the control room says exactly that. It also stays honest about what is still missing: test API credentials, a test webhook, Checkout acceptance, live verification, and payout readiness.

The control room now has an honest, reviewable commerce foundation for a future Canadian Third Railify store. It explains who owns the merchant account and payouts, keeps Shawn's Stripe identity and bank entry inside Stripe, separates customer income from Printful costs, and provides safe business, tax, and customer-template editors without pretending that checkout or fulfillment is live.

The current Wix shop remains completely in charge. The new Admin pages show exactly what is ready, missing, deferred, or unavailable, and they refuse private persistence when the separate commerce database or encryption key is absent.

Existing Master credentials can now sign in without being blocked by a password rule intended only for new passwords. Signed-in accounts can also change their display name alongside their avatar, and Master names remain customized after refresh.

The control room sidebar can now tuck down to its icons without losing navigation, while phones continue to receive a full readable drawer. The account menu now carries the same level of identity detail and action polish as the supplied StreamSuites examples, in Third Railify’s own black-and-gold treatment.

Admins can change their own avatar from Accounts & Access using a file or image URL. Uploaded bytes live behind a clean immutable media path instead of being stuffed into account URLs as browser data.

The Admin shell now shows a slim animated gold signal beneath the top bar while real dashboard data or account actions are loading, with a non-moving alternative for reduced-motion users.

The Admin surface now has a real shared account foundation and refuses to show the control room until the server confirms an Admin role. Master Admins can manage account access from the new Accounts page; every other operational module remains accurately deferred.

The separate Admin repository now has a real, polished frontend that can be reviewed on an isolated staging URL. It clearly shows where future operational areas will live while refusing to pretend that accounts, orders, products, or integrations are connected. It is a visual and routing foundation, not an administration system.

Admin now carries the confirmed public sender identity and reply-to address as safe configuration; the Resend API key remains remote and encrypted.

### Known deferrals

- Historical blocker removed: the superseded Stripe Connect platform eligibility check is no longer part of the Third Railify shop architecture.
- Creation/binding/migration of `thirdrailify-commerce`, generation of its encryption secret, dedicated-account Stripe test-mode credentials/webhook, read-only account identity verification, test Checkout Sessions, wallet eligibility testing, and all live payment activity.
- Creation of a parallel Printful manual/API store and scoped token, catalogue connectivity, draft-order API work, explicit confirmation gates, and fulfillment activation. Existing Wix-connected Printful remains untouched.
- PayPal direct-merchant setup and donations/VIP work; Printify evidence and credential custody; authoritative Wix catalogue/provider/export/policy reconciliation and cutover planning.
- Creation/binding of the real staging D1 database, remaining encrypted secrets, provider applications, Turnstile widget, deployment, and live Resend acceptance.
- CMS, catalogue/provider writes, orders, membership operations, users, media uploads, settings persistence, and integrations.
- Pages project creation, deployment, custom domain, DNS, analytics, and production acceptance.
