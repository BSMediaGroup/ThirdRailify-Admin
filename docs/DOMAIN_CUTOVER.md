# Third Railify production domain cutover

## Authority and completed registrar work

The GoDaddy nameserver change was completed by the operator before this cutover task. Registration remains at GoDaddy. Authoritative DNS is Cloudflare Full DNS in the `Brainstream Media Group` account (`b98c3fe4118854c1a58982da6dae38a4`). Cloudflare assigned exactly:

- `jim.ns.cloudflare.com`
- `sloan.ns.cloudflare.com`

Cloudflare zone `thirdrailify.com` is `a57cb25776578896c003098775e28aee`. On 30 August 2026, Cloudflare's API reported `active`, Full DNS, and not paused. Cloudflare and Google public resolvers both returned only the assigned pair and a Cloudflare SOA. No parent DS answer existed. The former authoritative pair recorded by Cloudflare was `ns73.domaincontrol.com` and `ns74.domaincontrol.com`.

## Pages projects and final origins

| Surface | Pages project ID | Project | Production branch | Build | Output | Canonical origin |
| --- | --- | --- | --- | --- | --- | --- |
| Public | `97c50daa-87df-4bfa-a0a0-18c5fb85983e` | `thirdrailify` | `main` | `npm run build` | `dist` | `https://thirdrailify.com` |
| Admin | `2349097d-583c-4d7a-8323-6070a967fdcb` | `thirdrailify-admin` | `main` | `npm run build` | `dist` | `https://admin.thirdrailify.com` |

Both projects use Node `22.16.0` and compatibility date `2026-08-11`. Registration did not move from GoDaddy.

## DNS inventory

The three web records were changed in the authenticated Cloudflare dashboard and read back through the Cloudflare DNS API. No bulk deletion or mutation of mail, verification, CAA, SRV, or unrelated names occurred. Cloudflare and Google DNS-over-HTTPS returned the same Cloudflare proxy addresses for all three web names; the machine's configured Windows resolver retained stale Wix data during the propagation window, so direct edge verification used `curl --resolve`.

| Name | Type | Sanitized before state | Preservation/action |
| --- | --- | --- | --- |
| `thirdrailify.com` | NS | `jim.ns.cloudflare.com`; `sloan.ns.cloudflare.com` | Preserved |
| `thirdrailify.com` | SOA | Cloudflare (`jim.ns.cloudflare.com`) | Preserved |
| `thirdrailify.com` | CNAME | `thirdrailify.pages.dev`, proxied | Active Public Pages apex |
| `www.thirdrailify.com` | CNAME | `thirdrailify.pages.dev`, proxied | Active Public Pages alias; Pages middleware returns `301` to apex |
| `admin.thirdrailify.com` | CNAME | `thirdrailify-admin.pages.dev`, proxied | Active Admin Pages hostname |
| `thirdrailify.com` | MX | Google Workspace priorities 1, 5, 5, 10, 10 | Preserved unchanged |
| `thirdrailify.com` | TXT | Google verification; SPF includes Google and Wix | Preserved unchanged |
| `_dmarc.thirdrailify.com` | TXT | DMARC quarantine policy | Preserved unchanged |
| `thirdrailify.com` | CAA | No public answer | No change; audit only if issuance fails |
| `thirdrailify.com` | DS | No public parent answer | Cloudflare DNSSEC enabled and pending GoDaddy DS publication |
| `thirdrailify.com` | SRV | No apex public answer | No change; unknown/unrelated records were not deleted |

The five Google Workspace MX records, SPF TXT, Google verification TXT, Google DKIM TXT, and DMARC quarantine policy were read back unchanged. Cloudflare-managed proxying remains required for the web names; mail and verification records remain DNS-only according to their existing record types.

## Environment and binding matrix

Secrets are listed by name only. Values were neither printed nor rotated. Preview retains Pages origins; production uses the custom origins. `THIRDRAILIFY_AUTH_COOKIE_DOMAIN` remains empty, preserving host-only Secure, HttpOnly, SameSite=Lax sessions and the existing one-time handoff architecture.

| Project | Environment | Names | Class | Action |
| --- | --- | --- | --- | --- |
| Public | production | `THIRDRAILIFY_PUBLIC_ORIGIN`; `THIRDRAILIFY_ADMIN_ORIGIN`; `THIRDRAILIFY_PROFILE_MEDIA_ORIGIN`; `VITE_THIRDRAILIFY_ADMIN_ORIGIN` | old hostname to custom hostname | Changed by this cutover |
| Public | production | `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE` | cutover switch | `true`; enabled after domain/TLS/asset verification |
| Public | production | `AUTH_ENVIRONMENT`; `CURRENCY_RATES_API_URL`; `THIRDRAILIFY_AUTH_COOKIE_DOMAIN`; `THIRDRAILIFY_TURNSTILE_SITE_KEY`; `VITE_GOATS_MAP_STYLE_URL` | neutral/safety | Preserved |
| Public | production | `THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET`; `THIRDRAILIFY_COMMUNITY_API_SECRET`; `THIRDRAILIFY_COMMUNITY_INGEST_SECRET` | encrypted secret | Preserved, not read |
| Public | production | `THIRDRAILIFY_AUTH_DB`; `THIRDRAILIFY_PUBLIC_STATE` | D1; Durable Object service | Preserved exactly |
| Public | preview | Existing variables and bindings | Pages preview authority | Retained Pages origins and existing bindings |
| Admin | production | `THIRDRAILIFY_PUBLIC_ORIGIN`; `THIRDRAILIFY_ADMIN_ORIGIN`; `THIRDRAILIFY_PROFILE_MEDIA_ORIGIN` | old hostname to custom hostname | Changed by this cutover |
| Admin | production | `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE` | cutover switch | `true`; enabled after domain/TLS/asset verification |
| Admin | production | `ADMIN_EMAIL_1`; `ADMIN_EMAIL_2`; `AUTH_ENVIRONMENT`; `CONTACT_CC_EMAIL`; `CONTACT_TO_EMAIL`; provider client IDs/store IDs; `GOOGLE_OAUTH_ENABLED`; mail sender/reply-to; `THIRDRAILIFY_AUTH_COOKIE_DOMAIN`; `THIRDRAILIFY_TURNSTILE_SITE_KEY` | non-secret neutral/safety | Preserved |
| Admin | production | Admin passwords; OAuth client secrets; auth/community/commerce secrets; provider credentials/webhook secrets; Resend key; Turnstile secret | encrypted secret | Preserved, not read |
| Admin | production | `THIRDRAILIFY_AUTH_DB`; `THIRDRAILIFY_COMMERCE_DB`; `THIRDRAILIFY_PROFILE_MEDIA` | two D1 bindings; Admin-only R2 | Preserved exactly |
| Admin | preview | Existing variables and bindings | Pages preview authority | Retained Pages origins and existing bindings |

The Public project has no Commerce D1 or R2 binding. Admin remains the only Commerce D1 and profile-media R2 authority. No KV, queue, Hyperdrive, AI, Analytics Engine, or Pages service binding was discovered on either Pages project. The Public Durable Object binding remains the service-backed `THIRDRAILIFY_PUBLIC_STATE` authority.

## Redirect and legacy-route map

| Source | Destination/behavior | Status |
| --- | --- | --- |
| `www.thirdrailify.com/<path>?<query>` | `https://thirdrailify.com/<path>?<query>` | Permanent `301`, path/query preserved |
| `thirdrailify.pages.dev/<path>?<query>` | `https://thirdrailify.com/<path>?<query>` | Permanent `301` after cutover switch |
| Admin Pages browser GET/HEAD outside `/api/*` | Same path/query on `admin.thirdrailify.com` | Permanent `301` after cutover switch |
| Admin Pages `/api/*`, including `/api/webhooks/*` | Continue on old host during provider migration | No host redirect; methods and bodies preserved |
| `/store` | `/shop` | Existing `301` |
| `/merch` | `/shop` | Existing `301` |
| `/product-page/:slug` | Canonical product detail route | Existing application compatibility |

Unknown former Wix paths are not guessed. The SPA fallback does not intercept Functions routes because Pages routing explicitly includes them.

## Callback and webhook migration

| Provider | Live configuration evidence | Canonical endpoint | Remaining action |
| --- | --- | --- | --- |
| Discord OAuth | Client ID and encrypted secret configured | `https://admin.thirdrailify.com/api/auth/oauth/discord/callback` | Add the exact callback in the Discord application, retain the old Pages callback, then test custom-host sign-in |
| Google OAuth | Client ID/secret configured; `GOOGLE_OAUTH_ENABLED=false` | `https://admin.thirdrailify.com/api/auth/oauth/google/callback` | Add the redirect URI without enabling Google; retain the old URI until the separate Google activation milestone |
| GitHub OAuth | Client ID and encrypted secret configured | `https://admin.thirdrailify.com/api/auth/oauth/github/callback` | Make no blind single-callback switch; add if the application permits it, otherwise schedule an authenticated switch/test while old-host API compatibility remains |
| X OAuth | Client ID and encrypted secret configured | `https://admin.thirdrailify.com/api/auth/oauth/twitter/callback` | Add the exact callback, retain the old callback, then test custom-host sign-in |
| Twitch | No repository route or production variable discovered | Not applicable | None |
| Stripe | Secrets exist but `stripe_enabled=false`; no provider endpoint was created | `https://admin.thirdrailify.com/api/webhooks/stripe` | Defer endpoint migration until Stripe is re-enabled; old-host webhook compatibility remains |
| Printful | Store `18668025`, API token, and V2 webhook verification secrets configured; no safe idempotent webhook-registration command exists | `https://admin.thirdrailify.com/api/webhooks/printful` | In Printful, change/add the V2 webhook URL, read it back, and deliver a provider test event only if the dashboard offers a non-order test; retain the old endpoint until verified |
| PayPal | No production PayPal credential variables; unconfigured | `https://admin.thirdrailify.com/api/webhooks/paypal` | No migration now. Future `commerce:paypal` setup derives this canonical URL from Admin configuration |
| Resend | Outbound encrypted API key only; no inbound callback | Not applicable | None; transactional sending remains disabled |
| Cloudflare Access | Account API returned no Third Railify Access applications | Not applicable | None |

Permanent operator defaults in `commerce-launch.mjs`, Commerce media backfill/verification, and the retained Stripe acceptance verifier now use the custom origins. The PayPal setup command already derives the canonical Admin origin. No provider was mutated because the repository contains no safe idempotent callback updater with provider readback. Old Admin machine endpoints remain compatible until every external registration is read back and verified.

## Commerce safety baseline

Immediately before cutover, remote `thirdrailify-commerce` settings were: `checkout_enabled=false`, `stripe_test_checkout_enabled=false`, `live_payment_capture_enabled=false`, `fulfillment_submission_enabled=false`, `transactional_email_enabled=false`, `stripe_tax_enabled=false`, `customer_document_access_enabled=false`, `paypal_store_checkout_enabled=false`, `paypal_live_capture_enabled=false`, `paypal_donations_enabled=false`, `commerce_emergency_paused=false`, `printful_order_mode="draft_only"`, and `commerce_environment="staging"`.

The same settings were queried again after the final custom-domain deployments and were unchanged, including `preferred_payment_provider="paypal"` and `stripe_enabled=false`. Row-count fingerprints were also unchanged: `orders=2`, `payment_attempts=0`, `donations=0`, `shipping_quotes=1`, `fulfillment_orders=1`, `shipments=0`, `email_deliveries=0`, and `documents=0`. Both readbacks reported `rows_written=0`. Domain work does not authorize a payment, donation, order, quote, shipment, document, email, fulfillment action, provider order, or commerce gate mutation.

## Verification commands (Windows)

```powershell
Resolve-DnsName thirdrailify.com -Type NS -Server 1.1.1.1
Resolve-DnsName thirdrailify.com -Type NS -Server 8.8.8.8
Resolve-DnsName thirdrailify.com -Type DS -Server 1.1.1.1
Resolve-DnsName thirdrailify.com -Type MX -Server 8.8.8.8
Resolve-DnsName thirdrailify.com -Type TXT -Server 1.1.1.1
Resolve-DnsName _dmarc.thirdrailify.com -Type TXT -Server 8.8.8.8
curl.exe -sS -I https://thirdrailify.com/
curl.exe -sS -I "https://www.thirdrailify.com/watch?from=www"
curl.exe -sS -I https://admin.thirdrailify.com/
curl.exe -sS -I "https://thirdrailify.pages.dev/watch?from=pages"
curl.exe -sS -I https://thirdrailify-admin.pages.dev/api/auth/session
```

Verify certificates cover the requested names, redirects have no loop, canonical/OG/JSON-LD/sitemap use the apex, Admin remains noindex, anonymous protected Admin APIs return `401`, and checkout returns the intentional disabled state without provider traffic.

## DNSSEC follow-up

Cloudflare DNSSEC was enabled after both custom domains were stable. Its state is `pending` until GoDaddy publishes the parent DS:

- Key Tag: `2371`
- Algorithm: `13`
- Digest Type: `2`
- Digest: `5E9DC02990DD823D0C0514BAB127C00266A875D4EB4566B593B69D4667EDC042`

GoDaddy: Domain Portfolio -> `thirdrailify.com` -> DNS -> DNSSEC / DS Records -> Add. Enter the four fields above and save. Do not reuse any former GoDaddy DNSSEC values. Completion requires public DS answers from both 1.1.1.1 and 8.8.8.8. DNSSEC is post-cutover hardening and does not delay the healthy HTTPS site.

## Rollback

If only Pages must roll back, disable `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE`, redeploy the last known Pages artifacts, detach only the three new Pages custom-domain associations if required, and restore the previous apex/`www`/`admin` web records from the Cloudflare audit log. Do not touch MX, SPF, DKIM, DMARC, verification TXT, CAA, SRV, or unrelated subdomains.

If authoritative DNS itself must be rolled back and the exact former names are unavailable, use GoDaddy's **Default Nameservers** restoration option. The last Cloudflare-recorded former pair was `ns73.domaincontrol.com` and `ns74.domaincontrol.com`, but GoDaddy must supply the current defaults. Registration remains at GoDaddy throughout.

## Final state record

- Public preparation deployment: `136bad6d-96c3-4f3c-8494-91890eeb3223`.
- Admin preparation deployment: `c81fa80a-5df3-42e0-8448-83b620d43fd6`.
- Final Public deployment: `f51ffb90-d820-446d-aa14-405ba873d88b` from source HEAD `b8ed5f4f3961cba3f1eba92a5f23cff3a4957347`, stable at `https://thirdrailify.com`.
- Final Admin deployment: `4a72bc5d-cbe3-4ebe-81f2-2ec5ec0c6ea8` from source HEAD `c15a9f009da5d04dd068f987df45eeaa633cd038`, stable at `https://admin.thirdrailify.com`.
- `thirdrailify.com`, `www.thirdrailify.com`, and `admin.thirdrailify.com` are all Pages `active` with active HTTP validation and Google-managed certificate authority.
- Apex and Admin return `200`; `www` and Public Pages return path/query-preserving `301`; old Admin browser UI returns `301` while old-host `/api/*` remains unredirected and protected APIs return `401` anonymously.
- Stable Public output contains only the apex canonical authority in canonical/OG/JSON-LD, robots, and all 59 sitemap entries. Admin remains `noindex`.
- Responsive route acceptance covered Public home, shop, product detail, cart, disabled checkout, About, GOATS, Terms, and Privacy, plus Admin shell, Commerce Overview, Payments, Products, Orders, Customers, and Fulfillment at 1440, 768, and 390 with no horizontal overflow or mixed content. Direct custom-host TLS/assets were verified separately from the machine's stale Windows DNS cache.
- Focused Node 22.16.0 validation passed 20 Public and 41 Admin security/domain/commerce tests, both typechecks, both lints, both production builds, and both Pages Functions compiles.
- `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE=false` is deliberate until all three domains are active and TLS-valid. This prevents the Pages aliases from redirecting users to Wix during the blocked interval.
- Required DNS action: in Cloudflare **DNS > Records**, edit only the existing web records so apex (`@`) and `www` are proxied CNAMEs to `thirdrailify.pages.dev`, and `admin` is a proxied CNAME to `thirdrailify-admin.pages.dev`. Do not delete or alter any MX, TXT, DMARC, CAA, SRV, or unrelated record. Then wait for all three Pages custom domains to report `active`, verify HTTPS, set the cutover switch to `true`, rebuild/redeploy both unchanged artifacts, and rerun the checks above.
- Checkout and payments remain disabled.
