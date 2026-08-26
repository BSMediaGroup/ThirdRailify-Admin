# Bump notes

CURRENT VER=0.0.0-seed

PENDING VER=0.1.0-alpha.0

No prior version metadata or release scheme existed in this repository. `0.0.0-seed` names the seeded pre-scaffold state; `0.1.0-alpha.0` establishes the first pending, non-production Admin milestone.

## Pending 0.1.0-alpha.0

### Technical

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

### Human-readable

The Admin surface now has a real shared account foundation and refuses to show the control room until the server confirms an Admin role. Master Admins can manage account access from the new Accounts page; every other operational module remains accurately deferred.

The separate Admin repository now has a real, polished frontend that can be reviewed on an isolated staging URL. It clearly shows where future operational areas will live while refusing to pretend that accounts, orders, products, or integrations are connected. It is a visual and routing foundation, not an administration system.

Admin now carries the confirmed public sender identity and reply-to address as safe configuration; the Resend API key remains remote and encrypted.

### Known deferrals

- Creation/binding of the real staging D1 database, remaining encrypted secrets, provider applications, Turnstile widget, deployment, and live Resend acceptance.
- CMS, catalogue/provider writes, orders, membership operations, users, media uploads, settings persistence, and integrations.
- Pages project creation, deployment, custom domain, DNS, analytics, and production acceptance.
