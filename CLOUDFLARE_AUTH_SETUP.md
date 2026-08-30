# Third Railify shared account authority setup

`ThirdRailify-Admin` owns the account schema, credentials, OAuth callbacks, email flows, rate limits, audit records, and Admin authorization. `ThirdRailify` is a client with only same-origin session, handoff, and logout Functions. Both Pages projects must bind the same D1 database as `THIRDRAILIFY_AUTH_DB`.

No D1 database ID, Turnstile widget, provider application, secret, Pages binding, deployment, Access rule, or custom domain was created by this milestone. The checked-in Wrangler files intentionally omit `d1_databases` until a real database ID exists.

## Staging order

1. Create a dedicated staging D1 database, for example `thirdrailify-auth-staging`, in the intended Cloudflare account.
2. Record its real database ID. Add this binding to both repository Wrangler files; replace the documentation marker with the real value:

```jsonc
"d1_databases": [
  {
    "binding": "THIRDRAILIFY_AUTH_DB",
    "database_name": "thirdrailify-auth-staging",
    "database_id": "<REAL_STAGING_DATABASE_ID>",
    "migrations_dir": "migrations"
  }
]
```

The Public repository does not own migrations, so omit `migrations_dir` there. Do not create separate Admin and Public account databases.

3. From `ThirdRailify-Admin`, review and apply `migrations/0001_auth_foundation.sql` with Wrangler D1 migrations. Apply locally first, then use the explicit remote flag only after the target database identity is confirmed.
4. Create one staging Turnstile widget restricted to `thirdrailify.pages.dev` and `thirdrailify-admin.pages.dev`. Add the site key as the non-secret `THIRDRAILIFY_TURNSTILE_SITE_KEY` variable on Admin. Store the secret only as `THIRDRAILIFY_TURNSTILE_SECRET_KEY` on Admin.
5. Configure these non-secret staging values on both Pages projects:

```text
AUTH_ENVIRONMENT=staging
THIRDRAILIFY_PUBLIC_ORIGIN=https://thirdrailify.pages.dev
THIRDRAILIFY_ADMIN_ORIGIN=https://thirdrailify-admin.pages.dev
THIRDRAILIFY_PROFILE_MEDIA_ORIGIN=https://thirdrailify-admin.pages.dev
THIRDRAILIFY_AUTH_COOKIE_DOMAIN=
```

The empty cookie domain is deliberate: staging uses host-only cookies plus one-time D1 handoffs.

6. Add Admin-only encrypted values with the Pages dashboard or `wrangler pages secret put`:

```text
THIRDRAILIFY_TURNSTILE_SECRET_KEY
THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET
ADMIN_SECRET_1
ADMIN_SECRET_2
RESEND_API_KEY
DISCORD_CLIENT_SECRET
GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_SECRET
X_OAUTH_CLIENT_SECRET
```

Set `ADMIN_EMAIL_1` and `ADMIN_EMAIL_2` as ordinary variables and the corresponding secrets as strong independent values. The two environment accounts are synthesized into D1 as locked Master Admin rows; their passwords are never written to D1.

7. Configure Resend with an authenticated sender domain, then set `MAIL_FROM` and optional `MAIL_REPLY_TO`. Verification links expire after 24 hours and reset links after 30 minutes.
8. Create provider applications and add client IDs as ordinary Admin variables. Add client secrets only as encrypted values. Use no wildcard callback URLs.
9. Deploy Admin first, verify config/session/error behavior, then deploy Public. Apply no custom-domain or DNS change during staging.

## Profile-media storage

Avatar changes use the verified existing `thirdrailify-profile-media` bucket through one Admin-only R2 binding named `THIRDRAILIFY_PROFILE_MEDIA`. The checked-in Admin Wrangler configuration declares that binding; Public has no R2 binding. Public `r2.dev` access remains disabled, and a custom `cdn.thirdrailify.com` media domain remains deferred.

`THIRDRAILIFY_PROFILE_MEDIA_ORIGIN` is safe configuration. Staging uses `https://thirdrailify-admin.pages.dev`, where the Admin `/u/*` Function serves immutable objects. A future R2 custom domain such as `https://cdn.thirdrailify.com` can become the value only after its bucket, DNS, TLS, and exact `/u/*` delivery are verified. The stored key remains `u/<opaque-account-key>/avatar/<sha256>.<jpg|png|webp>`, so moving to a custom media origin does not require base64/data URLs or browser-owned identity state.

The avatar endpoint accepts a multipart `avatar` file or JSON `imageUrl`, requires a live session plus CSRF proof, applies the existing D1-backed abuse controls, validates a 5 MB maximum and JPG/PNG/WebP bytes, and stores URL imports in R2 rather than persisting the third-party source URL. Old immutable revisions are retained so cached account payloads never point at overwritten bytes; lifecycle cleanup is an explicit later operational policy.

## Exact OAuth callbacks

Staging:

```text
https://thirdrailify-admin.pages.dev/api/auth/oauth/discord/callback
https://thirdrailify-admin.pages.dev/api/auth/oauth/google/callback
https://thirdrailify-admin.pages.dev/api/auth/oauth/github/callback
https://thirdrailify-admin.pages.dev/api/auth/oauth/twitter/callback
```

Production:

```text
https://admin.thirdrailify.com/api/auth/oauth/discord/callback
https://admin.thirdrailify.com/api/auth/oauth/google/callback
https://admin.thirdrailify.com/api/auth/oauth/github/callback
https://admin.thirdrailify.com/api/auth/oauth/twitter/callback
```

Discord requests `identify email`. Google requests `openid email profile`. GitHub requests `read:user user:email`. X requests `users.read tweet.read`. Google, GitHub, and X use PKCE S256; every provider uses a short-lived one-time D1 state transaction. Provider tokens are discarded after identity retrieval.

## Cloudflare Access caveat

If Cloudflare Access currently protects `thirdrailify-admin.pages.dev`, the public config/login/OAuth-start routes and every OAuth callback must remain reachable from the Public origin and providers. Either remove the outer gate once application auth is accepted or create a narrowly reviewed bypass for only the required auth routes. Do not broadly bypass `/api/admin/*`. This milestone does not alter Access.

## Production authority

Production uses `https://thirdrailify.com` and `https://admin.thirdrailify.com` as exact origins. Keep `THIRDRAILIFY_AUTH_COOKIE_DOMAIN` empty: the established host-only sessions and one-time handoff do not require a parent-domain cookie. Register every exact production OAuth callback and keep the old Admin Pages callback only for the bounded transition described in `docs/DOMAIN_CUTOVER.md`. Commerce environment and provider states remain independently fail-closed.

Never copy `.env`, `.dev.vars`, database IDs, bootstrap passwords, provider secrets, the Turnstile secret, the Resend key, session tokens, one-time tokens, or OAuth codes into source control or browser-prefixed variables.

Official references: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/), [Pages Function routing](https://developers.cloudflare.com/pages/functions/routing/), [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [Turnstile CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/), and [Resend send email](https://resend.com/docs/api-reference/emails/send-email).
