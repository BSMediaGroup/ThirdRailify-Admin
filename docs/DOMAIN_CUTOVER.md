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

No GoDaddy BIND export or `_domain-cutover` directory was present. The operator OAuth token had zone-read but not DNS-record-read permission, so the full Cloudflare record API could not be exported. The cutover therefore used a preserve-only rule: no bulk deletion and no mutation of mail, verification, CAA, SRV, or unrelated names. Public resolver evidence before web attachment was:

| Name | Type | Sanitized before state | Preservation/action |
| --- | --- | --- | --- |
| `thirdrailify.com` | NS | `jim.ns.cloudflare.com`; `sloan.ns.cloudflare.com` | Preserved |
| `thirdrailify.com` | SOA | Cloudflare (`jim.ns.cloudflare.com`) | Preserved |
| `thirdrailify.com` | A/AAAA | Proxied Cloudflare answers; HTTP reached Wix | Reconciled only by Pages custom-domain attachment |
| `www.thirdrailify.com` | A/AAAA | Proxied Cloudflare answers; HTTP reached Wix | Reconciled only by Pages custom-domain attachment; host redirect at Pages edge |
| `admin.thirdrailify.com` | A/AAAA | Proxied Cloudflare answers; no usable TLS endpoint | Reconciled only by Admin Pages custom-domain attachment |
| `thirdrailify.com` | MX | Google Workspace priorities 1, 5, 5, 10, 10 | Preserved unchanged |
| `thirdrailify.com` | TXT | Google verification; SPF includes Google and Wix | Preserved unchanged |
| `_dmarc.thirdrailify.com` | TXT | DMARC quarantine policy | Preserved unchanged |
| `thirdrailify.com` | CAA | No public answer | No change; audit only if issuance fails |
| `thirdrailify.com` | DS | No public answer | No stale DNSSEC blocker |
| `thirdrailify.com` | SRV | No apex public answer | No change; unknown/unrelated records were not deleted |

After attachment, verify the same MX/TXT/DMARC answers and confirm the web names terminate at Pages. Cloudflare-managed proxying is required for the web names; mail and verification records remain DNS-only according to their existing record types.

## Environment and binding matrix

Secrets are listed by name only. Values were neither printed nor rotated. Preview retains Pages origins; production uses the custom origins. `THIRDRAILIFY_AUTH_COOKIE_DOMAIN` remains empty, preserving host-only Secure, HttpOnly, SameSite=Lax sessions and the existing one-time handoff architecture.

| Project | Environment | Names | Class | Action |
| --- | --- | --- | --- | --- |
| Public | production | `THIRDRAILIFY_PUBLIC_ORIGIN`; `THIRDRAILIFY_ADMIN_ORIGIN`; `THIRDRAILIFY_PROFILE_MEDIA_ORIGIN`; `VITE_THIRDRAILIFY_ADMIN_ORIGIN` | old hostname to custom hostname | Changed by this cutover |
| Public | production | `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE` | cutover switch | `false` for preparation deploy; `true` only after domain verification |
| Public | production | `AUTH_ENVIRONMENT`; `CURRENCY_RATES_API_URL`; `THIRDRAILIFY_AUTH_COOKIE_DOMAIN`; `THIRDRAILIFY_TURNSTILE_SITE_KEY`; `VITE_GOATS_MAP_STYLE_URL` | neutral/safety | Preserved |
| Public | production | `THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET`; `THIRDRAILIFY_COMMUNITY_API_SECRET`; `THIRDRAILIFY_COMMUNITY_INGEST_SECRET` | encrypted secret | Preserved, not read |
| Public | production | `THIRDRAILIFY_AUTH_DB`; `THIRDRAILIFY_PUBLIC_STATE` | D1; Durable Object service | Preserved exactly |
| Public | preview | Existing variables and bindings | Pages preview authority | Retained Pages origins and existing bindings |
| Admin | production | `THIRDRAILIFY_PUBLIC_ORIGIN`; `THIRDRAILIFY_ADMIN_ORIGIN`; `THIRDRAILIFY_PROFILE_MEDIA_ORIGIN` | old hostname to custom hostname | Changed by this cutover |
| Admin | production | `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE` | cutover switch | `false` for preparation deploy; `true` only after domain verification |
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

| Provider | Current/transition endpoint | Canonical endpoint | Required action |
| --- | --- | --- | --- |
| Discord OAuth | Admin Pages callback | `https://admin.thirdrailify.com/api/auth/oauth/discord/callback` | Add exact callback in provider dashboard; keep old callback until verified |
| Google OAuth | Admin Pages callback | `https://admin.thirdrailify.com/api/auth/oauth/google/callback` | Add exact callback/redirect URI; keep old until verified |
| GitHub OAuth | Admin Pages callback | `https://admin.thirdrailify.com/api/auth/oauth/github/callback` | Add exact authorization callback; keep old until verified |
| X OAuth | Admin Pages callback | `https://admin.thirdrailify.com/api/auth/oauth/twitter/callback` | Add exact callback; keep old until verified |
| Stripe | `/api/webhooks/stripe` on Admin Pages | `https://admin.thirdrailify.com/api/webhooks/stripe` | Add/update endpoint for existing required signed events; do not send a test payment |
| Printful | `/api/webhooks/printful` on Admin Pages | `https://admin.thirdrailify.com/api/webhooks/printful` | Update subscription only when provider readback can verify it; no order action |
| PayPal | `/api/webhooks/paypal` on Admin Pages or unconfigured | `https://admin.thirdrailify.com/api/webhooks/paypal` | Update Sandbox/LIVE registrations separately only if configured; do not create/capture an order or donation |
| Resend | No inbound application callback | Not applicable | Update verified sender links/templates through repository-owned origins only; transactional sending stays disabled |
| Cloudflare Access | Potential outer Admin gate | Custom Admin hostname | Ensure public auth start/config and OAuth callbacks are reachable; never bypass `/api/admin/*` broadly |

Repository URL builders now use the custom origins. Old Admin machine endpoints remain compatible until every external registration is read back and verified.

## Commerce safety baseline

Immediately before cutover, remote `thirdrailify-commerce` settings were: `checkout_enabled=false`, `stripe_test_checkout_enabled=false`, `live_payment_capture_enabled=false`, `fulfillment_submission_enabled=false`, `transactional_email_enabled=false`, `stripe_tax_enabled=false`, `customer_document_access_enabled=false`, `paypal_store_checkout_enabled=false`, `paypal_live_capture_enabled=false`, `paypal_donations_enabled=false`, `commerce_emergency_paused=false`, `printful_order_mode="draft_only"`, and `commerce_environment="staging"`.

The same settings were queried again after both preparation deployments and were unchanged. Row-count fingerprints were also unchanged: `orders=2`, `payment_attempts=0`, `donations=0`, `shipping_quotes=1`, `fulfillment_orders=1`, `shipments=0`, `email_deliveries=0`, and `documents=0`. Domain work does not authorize a payment, donation, order, quote, shipment, document, email, fulfillment action, provider order, or commerce gate mutation.

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

There was no stale parent DS record. After both Pages domains and redirects are stable, enable DNSSEC in Cloudflare and record the generated key tag, algorithm, digest type, and digest. In GoDaddy, open the domain's DNSSEC/DS management and add those exact values. Do not claim completion until `Resolve-DnsName thirdrailify.com -Type DS -Server 1.1.1.1` and `8.8.8.8` both return the Cloudflare DS. DNSSEC is a follow-up and does not delay an otherwise healthy HTTPS cutover.

## Rollback

If only Pages must roll back, disable `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE`, redeploy the last known Pages artifacts, detach only the three new Pages custom-domain associations if required, and restore the previous apex/`www`/`admin` web records from the Cloudflare audit log. Do not touch MX, SPF, DKIM, DMARC, verification TXT, CAA, SRV, or unrelated subdomains.

If authoritative DNS itself must be rolled back and the exact former names are unavailable, use GoDaddy's **Default Nameservers** restoration option. The last Cloudflare-recorded former pair was `ns73.domaincontrol.com` and `ns74.domaincontrol.com`, but GoDaddy must supply the current defaults. Registration remains at GoDaddy throughout.

## Final state record

- Public preparation deployment: `136bad6d-96c3-4f3c-8494-91890eeb3223`.
- Admin preparation deployment: `c81fa80a-5df3-42e0-8448-83b620d43fd6`.
- Pages accepted custom-domain associations `thirdrailify.com`, `www.thirdrailify.com`, and `admin.thirdrailify.com`, but all remain `pending` with `CNAME record not set` because the available OAuth grant has no DNS-record read/write scope and the imported web records still route to Wix.
- `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE=false` is deliberate until all three domains are active and TLS-valid. This prevents the Pages aliases from redirecting users to Wix during the blocked interval.
- Required DNS action: in Cloudflare **DNS > Records**, edit only the existing web records so apex (`@`) and `www` are proxied CNAMEs to `thirdrailify.pages.dev`, and `admin` is a proxied CNAME to `thirdrailify-admin.pages.dev`. Do not delete or alter any MX, TXT, DMARC, CAA, SRV, or unrelated record. Then wait for all three Pages custom domains to report `active`, verify HTTPS, set the cutover switch to `true`, rebuild/redeploy both unchanged artifacts, and rerun the checks above.
- Checkout and payments remain disabled.
