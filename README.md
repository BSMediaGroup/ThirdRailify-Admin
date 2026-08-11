# Third Railify Admin

Independent frontend foundation for future Third Railify operations. The current milestone is intentionally a non-sensitive development scaffold: it has no authentication, private data, live APIs, analytics, memberships, orders, provider access, or write controls.

## Current state

- Vite 5, React 18, TypeScript, and React Router.
- Branded responsive sidebar, sticky operational header, overview, future-area route shells, state language, and a branded 404.
- American Captain display typography rendered at its real weight with lightly relaxed heading tracking and line-height.
- Routes for Overview, Site Content, Shop / Products, Orders, Media, VIP / Membership, Users / Access, Integrations, and Settings.
- Explicit cards for the real current posture: authentication not implemented, APIs not configured, writes disabled, and no sensitive data present.
- Cloudflare Pages static output, SPA fallback, document and response-level noindex, restrictive baseline headers, and no custom domain.

This is not a usable administration system. Do not add private records or working controls until a later milestone implements authenticated server enforcement, authorization, authoritative data sources, auditability, and feature-specific acceptance.

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
npm run build
npm run preview
```

The production output is `dist/`. The local development server uses port 5174 and preview uses 4174 so it can run alongside the public app.

## Routes

| Path | Current purpose |
| --- | --- |
| `/` | Honest scaffold posture and safe implementation sequence |
| `/content` | Future site-content shell |
| `/products` | Future provider-neutral catalogue shell |
| `/orders` | Future order-operations shell |
| `/media` | Future managed-asset shell |
| `/membership` | Future VIP/membership shell |
| `/access` | Future identity/access shell |
| `/integrations` | Future server-side integration shell |
| `/settings` | Future governed settings shell |
| everything else | Branded 404 |

## Structure

```text
ThirdRailify-Admin/
├── assets/
│   ├── backgrounds/        Seeded brand backgrounds
│   ├── fonts/              Seeded font files and licences
│   ├── icons/              Active straight-bolt favicon and preserved earlier favicon artwork
│   ├── logos/              Seeded marks and the active straight sidebar bolt silhouette
│   └── people/             Seeded host imagery (not used in admin)
├── public/
│   ├── _headers            Noindex and static response safeguards
│   └── _redirects          SPA fallback
├── src/
│   ├── components/         Shell, icons, and state examples
│   ├── config/             Route/navigation definitions
│   ├── pages/              Overview, future-area, and 404 pages
│   └── styles/             Tokens and responsive admin visual system
├── CLOUDFLARE_SETUP.md
├── BUMP_NOTES.md
└── package.json
```

The display system uses the seeded American Captain asset at its real weight with lightly relaxed tracking for the primary header voice, with seeded Blinker and Geist Mono for readable body and technical roles.

## Security boundary

- No fake signed-in user, role, permission, session, API result, health result, or business metric is displayed.
- No form can write data and the CSP blocks form submission.
- There are no client or server environment requirements and no provider names are invented.
- `noindex` protects discovery posture; it is not access control. A staging URL remains public unless Cloudflare Access or another real gate is deliberately configured later.

## Cloudflare and domain safety

See `CLOUDFLARE_SETUP.md` for the exact staging values. No Pages project or deployment is claimed. Do not attach `admin.thirdrailify.com` or place sensitive data on a public scaffold.
