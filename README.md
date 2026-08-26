# Third Railify Admin

Independent authenticated control-room foundation for Third Railify operations. This milestone establishes the shared D1 account authority, real session/role enforcement, and bounded account administration; content, commerce, media, membership, and integration operations remain deferred.

## Current state

- Vite 5, React 18, TypeScript, and React Router.
- Branded responsive sidebar, authenticated account header, server-hydrated overview, future-area route shells, and a branded 404.
- American Captain display typography rendered at its real weight with lightly relaxed heading tracking and line-height.
- Routes for Overview, Site Content, Shop / Products, Orders, Media, VIP / Membership, Users / Access, Integrations, and Settings.
- D1-backed email/password accounts, verification/reset email, Discord/Google/GitHub/X OAuth, explicit Turnstile, hashed sessions, one-time public handoff, rate limiting, and bounded audit records.
- Fail-closed loading, signed-out, regular-user, Full Admin, and Master Admin gates with no protected dashboard flash.
- Functional `/access` account registry with search/filters and Master-only promotion, demotion, status, and session-revocation controls.
- Cloudflare Pages static output, SPA fallback, document and response-level noindex, restrictive baseline headers, and no custom domain.

Only account administration is operational in code. No Cloudflare database, binding, secret, provider app, deployment, or custom domain is claimed by this repository state; those off-code prerequisites must be completed before live acceptance.

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
npm run test:functions
npm run build
npm run preview
```

The production output is `dist/`. The local development server uses port 5174 and preview uses 4174 so it can run alongside the public app.

## Routes

| Path | Current purpose |
| --- | --- |
| `/` | Authenticated account/configuration posture and deferred-module boundaries |
| `/content` | Future site-content shell |
| `/products` | Future provider-neutral catalogue shell |
| `/orders` | Future order-operations shell |
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
│   ├── _routes.json        Auth and Admin Pages Function routing
│   └── _redirects          SPA fallback
├── functions/
│   ├── _shared/            D1 auth/session/OAuth/security authority
│   └── api/                Shared auth plus signed Admin account/status APIs
├── migrations/             Idempotent D1 account foundation
├── src/
│   ├── auth/               Gate, session provider, modal, Turnstile, and account widget
│   ├── components/         Shell, icons, and state examples
│   ├── config/             Route/navigation definitions
│   ├── pages/              Live Overview/Accounts plus future-area and 404 pages
│   └── styles/             Tokens and responsive admin visual system
├── tests/                  D1 migration and auth/API integration coverage
├── CLOUDFLARE_AUTH_SETUP.md
├── CLOUDFLARE_SETUP.md
├── BUMP_NOTES.md
└── package.json
```

The display system uses the seeded American Captain asset at its real weight with lightly relaxed tracking for the primary header voice, with seeded Blinker and Geist Mono for readable body and technical roles.

## Security boundary

- D1 is the only account/session/role authority. Browser state is a hydration cache, never identity authority.
- Passwords use salted PBKDF2-SHA256; only hashed session, one-time, OAuth-state, rate-limit, and IP-derived values persist.
- All mutations require the exact Admin origin, a current server-resolved role, and CSRF proof. Environment Master accounts remain locked and their passwords stay environment-only.
- `noindex` is not access control. The application gate and signed APIs are mandatory; any outer Cloudflare Access policy must preserve narrowly required public auth/callback routes.

## Cloudflare and domain safety

See `CLOUDFLARE_AUTH_SETUP.md` for the shared D1 binding, secrets, Turnstile, Resend, exact OAuth callbacks, Access caveat, deployment order, and production transition. No Pages resource or deployment is claimed. Do not attach `admin.thirdrailify.com` during staging.
