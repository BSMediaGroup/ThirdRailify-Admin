# Cloudflare Pages staging setup

This document describes dashboard values for the current static Vite scaffold. It does not claim a Pages project exists and does not authorize deployment, Cloudflare Access, DNS, nameserver, Wix, or custom-domain changes.

## Project values

| Setting | Value |
| --- | --- |
| Repository | `ThirdRailify-Admin` |
| Production branch | `main` |
| Root directory | `/` (repository root; leave the dashboard field blank) |
| Framework preset | React (Vite), if offered |
| Dependency install | Cloudflare's lockfile install (`npm ci`) |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `22.16.0`, pinned by `.node-version` |

Cloudflare's current Pages documentation lists `npm run build` and `dist` for React/Vite, treats an unspecified root as the repository root, and supports `.node-version` for Node selection. Vite copies `public/_headers` and `public/_redirects` into `dist/`.

## Environment names

No application runtime environment variables are currently required or optional. There are no Pages Functions, auth providers, databases, or server APIs. Do not copy the repository's local `.env` into Cloudflare and never expose later provider credentials as `VITE_*` values.

`NODE_VERSION` does not need to be added in the dashboard because `.node-version` already pins it. If dashboard policy requires an explicit build variable, use the same name/value and keep both settings synchronized.

## Staging verification

1. Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm run build` locally.
2. Connect the repository with the values above and use only a separate `pages.dev` URL.
3. Confirm direct loads for `/`, every navigation route, and an unknown route.
4. Confirm the document meta and static response both specify `noindex, nofollow, noarchive`.
5. Confirm the response security headers and SPA fallback are present.
6. Check phone, tablet, and desktop layouts, mobile menu/Escape, keyboard focus, reduced motion, overflow, local assets, and browser console/network errors.
7. Keep the surface free of privileged data and controls. `noindex` is not authentication.

## Security and domain hold

This scaffold is safe only because it contains no privileged state. Before any sensitive functionality, implement authenticated server enforcement, deny-by-default authorization, session controls, secure credential storage, audit logs, and an explicit staging access decision.

**DO NOT ATTACH `thirdrailify.com` OR `admin.thirdrailify.com` YET.**

Do not change GoDaddy, DNS, nameservers, Wix bindings, redirects, or either custom domain during staging.

Official references: [Cloudflare Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/), [build image and Node version selection](https://developers.cloudflare.com/pages/configuration/build-image/), [serving SPAs](https://developers.cloudflare.com/pages/configuration/serving-pages/), and [custom headers](https://developers.cloudflare.com/pages/configuration/headers/).
