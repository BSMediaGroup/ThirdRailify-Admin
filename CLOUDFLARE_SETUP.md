# Cloudflare Pages production setup

This document records the Pages build values for the existing `thirdrailify-admin` project. Its canonical origin is `https://admin.thirdrailify.com`; follow `CLOUDFLARE_AUTH_SETUP.md` and `docs/DOMAIN_CUTOVER.md` for bindings, callbacks, old-host API compatibility, and rollback.

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

The auth Functions require the safe origins and environment mode documented in `CLOUDFLARE_AUTH_SETUP.md`, plus one shared D1 binding and Admin-only encrypted secrets. Do not copy the repository's local `.env` into Cloudflare and never expose provider credentials as `VITE_*` values.

`NODE_VERSION` does not need to be added in the dashboard because `.node-version` already pins it. If dashboard policy requires an explicit build variable, use the same name/value and keep both settings synchronized.

## Production verification

1. Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm run build` locally.
2. Verify the preparation build on `thirdrailify-admin.pages.dev`, then attach and verify `admin.thirdrailify.com` before enabling old-host browser redirects.
3. Confirm direct loads for `/`, every navigation route, and an unknown route.
4. Confirm the document meta and static response both specify `noindex, nofollow, noarchive`.
5. Confirm the response security headers and SPA fallback are present.
6. Check phone, tablet, and desktop layouts, mobile menu/Escape, keyboard focus, reduced motion, overflow, local assets, and browser console/network errors.
7. Verify signed-out and non-Admin users never receive the dashboard shell, and verify `/api/admin/*` rejects missing or insufficient sessions. `noindex` is not authentication.

## Security and domain authority

The account milestone implements application authentication, deny-by-default role checks, session controls, hashed credentials/tokens, and bounded audit records. It is not live until the real D1 binding and secrets are configured and the documented staging acceptance is completed.

Registration remains at GoDaddy and authoritative DNS remains Cloudflare. Do not broaden the host-only session cookie, delete non-web DNS records, or redirect Admin `/api/*` and webhook traffic from the old Pages hostname.

Official references: [Cloudflare Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/), [build image and Node version selection](https://developers.cloudflare.com/pages/configuration/build-image/), [serving SPAs](https://developers.cloudflare.com/pages/configuration/serving-pages/), and [custom headers](https://developers.cloudflare.com/pages/configuration/headers/).
