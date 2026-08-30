# Third Railify production domain cutover

## Authority and completed registrar work

The GoDaddy nameserver change was completed by the operator before this cutover task. Registration remains at GoDaddy. Authoritative DNS is Cloudflare Full DNS in the `Brainstream Media Group` account (`b98c3fe4118854c1a58982da6dae38a4`). Cloudflare assigned exactly:

- `jim.ns.cloudflare.com`
- `sloan.ns.cloudflare.com`

Cloudflare zone `thirdrailify.com` is `a57cb25776578896c003098775e28aee`. On 30 August 2026, Cloudflare's API reported `active`, Full DNS, and not paused. Cloudflare and Google public resolvers both returned only the assigned pair and a Cloudflare SOA. The operator then published the exact Cloudflare DS at GoDaddy; both resolvers returned the same parent DS and Cloudflare DNS-over-HTTPS validated the chain with `AD=true`. The former authoritative pair recorded by Cloudflare was `ns73.domaincontrol.com` and `ns74.domaincontrol.com`.

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
| `thirdrailify.com` | DS | Key tag `2371`, algorithm `13`, digest type `2`, expected SHA-256 digest | Published at GoDaddy and validated by Cloudflare and Google |
| `thirdrailify.com` | SRV | No apex public answer | No change; unknown/unrelated records were not deleted |

The five Google Workspace MX records, SPF TXT, Google verification TXT, Google DKIM TXT, and DMARC quarantine policy were read back unchanged. Cloudflare-managed proxying remains required for the web names; mail and verification records remain DNS-only according to their existing record types.

## Environment and binding matrix

Secrets are listed by name only. Values were not printed. Existing provider, auth, commerce, and mail secrets were preserved; only the dedicated bot-to-Admin `THIRDRAILIFY_COMMUNITY_INGEST_SECRET` was rotated while repairing machine ingress. Preview retains Pages origins; production uses the custom origins. `THIRDRAILIFY_AUTH_COOKIE_DOMAIN` remains empty, preserving host-only Secure, HttpOnly, SameSite=Lax sessions and the existing one-time handoff architecture.

| Project | Environment | Names | Class | Action |
| --- | --- | --- | --- | --- |
| Public | production | `THIRDRAILIFY_PUBLIC_ORIGIN`; `THIRDRAILIFY_ADMIN_ORIGIN`; `THIRDRAILIFY_PROFILE_MEDIA_ORIGIN`; `THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN`; `VITE_THIRDRAILIFY_ADMIN_ORIGIN` | canonical origins | Public/Admin custom domains plus `https://cdn.thirdrailify.com` |
| Public | production | `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE` | cutover switch | `true`; enabled after domain/TLS/asset verification |
| Public | production | `AUTH_ENVIRONMENT`; `CURRENCY_RATES_API_URL`; `THIRDRAILIFY_AUTH_COOKIE_DOMAIN`; `THIRDRAILIFY_TURNSTILE_SITE_KEY`; `VITE_GOATS_MAP_STYLE_URL` | neutral/safety | Preserved |
| Public | production | `THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET`; `THIRDRAILIFY_COMMUNITY_API_SECRET`; `THIRDRAILIFY_COMMUNITY_INGEST_SECRET` | encrypted secret | Preserved, not read |
| Public | production | `THIRDRAILIFY_AUTH_DB`; `THIRDRAILIFY_PUBLIC_STATE` | D1; Durable Object service | Preserved exactly |
| Public | preview | Existing variables and bindings | Pages preview authority | Retained Pages origins and existing bindings |
| Admin | production | `THIRDRAILIFY_PUBLIC_ORIGIN`; `THIRDRAILIFY_ADMIN_ORIGIN`; `THIRDRAILIFY_PROFILE_MEDIA_ORIGIN`; `THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN` | canonical origins | Public/Admin custom domains plus `https://cdn.thirdrailify.com` |
| Admin | production | `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE` | cutover switch | `true`; enabled after domain/TLS/asset verification |
| Admin | production | `ADMIN_EMAIL_1`; `ADMIN_EMAIL_2`; `AUTH_ENVIRONMENT`; `CONTACT_CC_EMAIL`; `CONTACT_TO_EMAIL`; provider client IDs/store IDs; `GOOGLE_OAUTH_ENABLED=true`; mail sender/reply-to; `THIRDRAILIFY_AUTH_COOKIE_DOMAIN`; `THIRDRAILIFY_TURNSTILE_SITE_KEY` | non-secret neutral/safety | Google enabled only after operator callback/Google authority confirmation; other values preserved |
| Admin | production | Admin passwords; OAuth client secrets; auth/community/commerce secrets; provider credentials/webhook secrets; Resend key; Turnstile secret | encrypted secret | Preserved, not read |
| Admin | production | `THIRDRAILIFY_AUTH_DB`; `THIRDRAILIFY_COMMERCE_DB`; `THIRDRAILIFY_PROFILE_MEDIA`; `THIRDRAILIFY_PUBLIC_STATE` | two D1 bindings; Admin-only R2; external Public Durable Object | Existing storage preserved; direct signed bot ingress added |
| Admin | preview | Existing variables and bindings; `GOOGLE_OAUTH_ENABLED=false` | Pages preview authority | Retained Pages origins and existing bindings; Google remains intentionally disabled pending a separate preview client decision |

The Public project has no Commerce D1 or R2 binding. Admin remains the only write authority for Commerce D1 and the existing profile-media R2 bucket. The read-only `thirdrailify-media` Worker binds that bucket and Commerce D1 solely to serve allowlisted public assets and enforce GOATS/Wheels publication state. No KV, queue, Hyperdrive, AI, or Analytics Engine binding was added. The Public Durable Object remains the `THIRDRAILIFY_PUBLIC_STATE` authority; Admin has an external binding only for authenticated bot snapshot writes.

## Redirect and legacy-route map

| Source | Destination/behavior | Status |
| --- | --- | --- |
| `www.thirdrailify.com/<path>?<query>` | `https://thirdrailify.com/<path>?<query>` | Permanent `301`, path/query preserved |
| `thirdrailify.pages.dev/<path>?<query>` | `https://thirdrailify.com/<path>?<query>` | Permanent `301` after cutover switch |
| Admin Pages browser GET/HEAD outside `/api/*` | Same path/query on `admin.thirdrailify.com` | Permanent `301` after cutover switch |
| Admin Pages `/api/*`, including `/api/webhooks/*` | Continue on old host during provider migration | No host redirect; methods and bodies preserved |
| Old Admin product/avatar GET or HEAD | Exact `https://cdn.thirdrailify.com/commerce-media/*` or `/u/*` path | Permanent `301` for recognized immutable shapes; all 153 current catalogue-image paths now redirect and no purge remains |
| `/store` | `/shop` | Existing `301` |
| `/merch` | `/shop` | Existing `301` |
| `/product-page/:slug` | Canonical product detail route | Existing application compatibility |

Unknown former Wix paths are not guessed. The SPA fallback does not intercept Functions routes because Pages routing explicitly includes them.

## Auth provider cutover

| Provider | Live configuration evidence | Canonical endpoint | Remaining action |
| --- | --- | --- | --- |
| Discord OAuth | Operator confirmed custom and legacy callbacks saved; Client ID and encrypted secret configured | `https://admin.thirdrailify.com/api/auth/oauth/discord/callback` | Custom and legacy routes both reached the state validator; retain the Pages URI until one legitimate sign-in passes |
| Google OAuth | Operator confirmed Branding, Audience, Search Console, and both callbacks; Client ID/secret configured; production gate enabled | `https://admin.thirdrailify.com/api/auth/oauth/google/callback` | Public and Admin render Google enabled; custom and legacy callbacks reach the state validator. One legitimate interactive sign-in remains acceptance evidence |
| GitHub OAuth | Operator confirmed both callbacks saved; Client ID and encrypted secret configured; wildcard matching remains disabled | `https://admin.thirdrailify.com/api/auth/oauth/github/callback` | Custom and legacy routes both reached the state validator; retain the Pages URI until one legitimate sign-in passes |
| X OAuth | Operator confirmed both exact callbacks saved; Client ID and encrypted secret configured | `https://admin.thirdrailify.com/api/auth/oauth/twitter/callback` | Custom and legacy routes both reached the state validator; retain the Pages URI until one legitimate sign-in passes |
| Twitch | No repository route or production variable discovered | Not applicable | None |
| Stripe | Secrets exist but `stripe_enabled=false`; no provider endpoint was created | `https://admin.thirdrailify.com/api/webhooks/stripe` | Defer endpoint migration until Stripe is re-enabled; old-host webhook compatibility remains |
| Printful | Store `18668025` read successfully. One authorized POST returned HTTP success but no usable signing keys and persisted no URL/events; repeated GET readback remains empty | `https://admin.thirdrailify.com/api/webhooks/printful` | No second POST was issued under the one-POST safety budget. Existing encrypted secret names remain present but do not prove a live configuration; signed delivery is unverified |
| PayPal | No production PayPal credential variables; unconfigured | `https://admin.thirdrailify.com/api/webhooks/paypal` | No migration now. Future `commerce:paypal` setup derives this canonical URL from Admin configuration |
| Resend | Outbound encrypted API key only; no inbound callback | Not applicable | None; transactional sending remains disabled |
| Cloudflare Access | Account API returned no Third Railify Access applications | Not applicable | None |

Permanent operator defaults in `commerce-launch.mjs`, Commerce media backfill/verification, and the retained Stripe acceptance verifier use the custom origins. The PayPal setup command derives the canonical Admin origin. OAuth dashboard changes were operator-confirmed, the Google production gate was deployed, and exactly one bounded Printful configuration POST was attempted with the outcome recorded above. Old Admin machine endpoints remain compatible until legitimate provider sign-ins pass and the transitional callbacks can be retired.

## Printful signed webhook

The canonical V2 receiver is `https://admin.thirdrailify.com/api/webhooks/printful`. Final provider readback for store `18668025` is `configured=no`, `readback_verified=no`, and `signed_delivery_evidence=no`: the single authorized POST returned no usable public/secret keys and no configuration persisted. The receiver's established encrypted secret names remain in Admin Pages, but their presence is not evidence that the provider configuration or current signing identity matches. No secret was printed or copied to source/D1, no second POST was issued, and preserved draft order `174104132` remains draft/unconfirmed.

## Post-cutover media and machine integration

`cdn.thirdrailify.com` is a Cloudflare Worker custom domain for `thirdrailify-media`, backed by the existing `thirdrailify-profile-media` R2 bucket. The canonical public namespaces are `/commerce-media/<sha256>.<ext>`, `/u/<account-hash>/avatar/<sha256>.<ext>`, `/goats-media/<opaque-id>`, and `/wheel-media/<opaque-id>`. Product/avatar paths are immutable content-addressed reads. GOATS and Wheels are additionally checked against current Commerce D1 publication/lifecycle state before R2 is read. Bucket listing, raw object keys, drafts, deleted assets, mutations, arbitrary query strings, and noncanonical paths are unavailable.

Responses use `Cache-Control: public, max-age=31536000, immutable`, stable ETags, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`, and origin-reflecting CORS only for Third Railify production/Pages origins. Only GET, HEAD, and allowlisted preflight are accepted. Product, avatar, approved GOATS, and active public Wheel assets returned real image bytes; private GOATS and deleted Wheel assets returned 404. A fresh audit checked all 153 current catalogue-image paths: every canonical CDN URL returned `200` and every corresponding old Admin URL redirected. The former stale edge hit no longer reproduces, so no cache purge was performed and none remains required.

The D1 backfill changed only recognized first-party URL prefixes after CDN byte delivery was proven: 49 product metadata rows, one stored community-comment avatar, and two account avatars. Post-readback found zero recognized old-host product/avatar URLs. External provider avatar URLs were not rewritten. Upload/save paths now persist CDN URLs, while Admin/private projections continue to use authenticated routes where required.

The bot now posts only to `https://admin.thirdrailify.com/api/community/discord/ingest` and `/api/watch/ingest`. Admin verifies the timestamped raw-body HMAC within 300 seconds, validates size/content, and writes directly to the existing Public Durable Object. The restarted singleton published real broadcast and Discord snapshots with HTTP 204; Public readback returned their fresh generated timestamps. Legacy Wix status publishing remains disabled. YouTube publication remains deliberately feature-disabled in `config.json` even though the channel/API-key names and diagnostic path exist; this is not an obsolete domain-cutover guard. Rumble remains the enabled primary broadcast source, so this auth task did not restart the bot or change quota/publication behavior.

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

## DNSSEC completion

Cloudflare DNSSEC was enabled after both custom domains were stable. The operator published this exact parent DS at GoDaddy:

- Key Tag: `2371`
- Algorithm: `13`
- Digest Type: `2`
- Digest: `5E9DC02990DD823D0C0514BAB127C00266A875D4EB4566B593B69D4667EDC042`

Cloudflare (`1.1.1.1`) and Google (`8.8.8.8`) both returned key tag `2371`, algorithm `13`, digest type `2`, and the exact digest above. A DNS-over-HTTPS A lookup through Cloudflare returned `Status=0`, `AD=true`, and `CD=false`, proving the public chain validates. No further registrar action remains.

## Post-cutover routing incident

### Symptom and redirect-chain diagnosis

Immediately after the cutover, desktop browsers reached the Wix “This domain isn't connected to a site” response at the apex and a Public Wheel deep link. The Public Pages alias also appeared to reach Wix because its intended permanent redirect was already active:

`thirdrailify.pages.dev/<path>?<query>` → `301 https://thirdrailify.com/<path>?<query>` → Wix response while the apex still had its imported Wix destination.

The immutable Public deployment `ff95c4d3.thirdrailify.pages.dev` independently rendered the Third Railify application, proving that the Pages build itself had not disappeared. After the web-record correction, the apex and Wheel route returned the same current Public asset family without a Wix fingerprint; Public Pages continued to redirect permanently to the apex with path and query intact. The immutable Admin deployment `4b976fad.thirdrailify-admin.pages.dev` likewise rendered the Admin application.

### Actual DNS fault and repair

The Cloudflare audit log proves that the zone import initially retained legacy web destinations. At `2026-08-30T07:31:57Z`, the UI deleted proxied apex A record `b59a15e3ab8cceb3480fb3bb5ce19718` (`185.230.63.107`, Wix) and created the correct Public CNAME. At `07:32:19Z`, it changed `www` from `pointing.wixdns.net` to Public Pages. At `07:32:42Z` and `07:33:32Z`, it deleted Admin A records `d52a4a350f97e42235f4466d5b60c491` (`3.33.251.168`) and `5883f6dfcac3e8ebf80f2b050e73de7f` (`15.197.225.128`), then created the Admin Pages CNAME. These were deliberate UI actions; the audit log contains no later reversal of the repaired record IDs.

The exact active web records are:

| Host | Record ID | Required destination | Proxy |
| --- | --- | --- | --- |
| `@` | `c1fa176babef063b6d746e849f39d58c` | CNAME `thirdrailify.pages.dev` | Proxied |
| `www` | `c5a2da064d1cccc205e7e3d0c6c94847` | CNAME `thirdrailify.pages.dev` | Proxied |
| `admin` | `6cf113f1cfc74dd33731c86ce22a0ae8` | CNAME `thirdrailify-admin.pages.dev` | Proxied |

`cdn` remains the existing `thirdrailify-media` Worker custom domain, represented by proxied AAAA record `545353f1e0d534d4de07e41eca9f9806` (`100::`). It was not changed. MX, SPF, DKIM, DMARC, Google verification, OAuth, CAA, DNSSEC, and unrelated records were not changed. Wix-named verification/mail records are not web destinations and must not be deleted as part of this repair.

### Why phones recovered before computers

The authoritative Cloudflare nameserver, `1.1.1.1`, and `8.8.8.8` all returned the repaired Cloudflare edge addresses. The local router resolver at `192.168.0.1` continued to return cached legacy answers after the repair: first the old Admin A addresses and, after those expired, `www → pointing.wixdns.net → 34.149.87.45` with an upstream A TTL of roughly 18 hours. This explains a cellular phone working while computers using the same router still reached Wix. Flushing Windows DNS alone cannot purge the router/upstream cache. Reboot or flush the router DNS cache, or configure the router/client to use `1.1.1.1` and `1.0.0.1` (or another validating public resolver); then flush the client/browser DNS cache. Do not change Cloudflare records again to chase this stale recursive answer.

### Emergency Public Pages alias rollback

If the apex breaks again while `thirdrailify.pages.dev` redirects to it:

1. Confirm the immutable deployment URL is healthy and capture the apex redirect/content chain.
2. Set only Public production `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE=false` and redeploy the current known-good Public artifact. Do not change preview, Admin machine routes, canonical source metadata, or custom-domain associations.
3. Use the temporary Pages alias as the emergency browser path while repairing only the proven broken apex/`www` records.
4. After apex DNS, TLS, application assets, and deep links are independently healthy, restore the switch to `true`, redeploy the same artifact, and verify the permanent path/query-preserving alias redirect.

No emergency alias rollback was required in this incident because Cloudflare authority and the apex were already correct when the stale desktop resolver behavior was isolated.

### Cross-site account continuity

Public and Admin deliberately use host-only HttpOnly cookies, so browsers do not automatically send the apex cookie to `admin.thirdrailify.com` or the Admin cookie to the apex. Cross-site menu actions now use the existing short-lived, hashed, one-time, origin-bound auth handoff to establish the same account at the destination. The Public account menu includes **Admin dashboard**; the Admin account menu retains **Open public site**; and the correct non-Admin refusal screen includes **Go to Third Railify**. Session tokens remain out of JavaScript and URLs, and regular accounts remain denied Admin authorization after the identity handoff.

## Rollback

If only Pages must roll back, disable `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE`, redeploy the last known Pages artifacts, detach only the three new Pages custom-domain associations if required, and restore the previous apex/`www`/`admin` web records from the Cloudflare audit log. Do not touch MX, SPF, DKIM, DMARC, verification TXT, CAA, SRV, or unrelated subdomains.

If authoritative DNS itself must be rolled back and the exact former names are unavailable, use GoDaddy's **Default Nameservers** restoration option. The last Cloudflare-recorded former pair was `ns73.domaincontrol.com` and `ns74.domaincontrol.com`, but GoDaddy must supply the current defaults. Registration remains at GoDaddy throughout.

## Final state record

- Latest observed Public production: `3b7f46f6-9bb9-41a5-bd2f-a55bb0af6982` from isolated source `5ced9d20ca12b3d5e8c39d88e3b0f847507146d7`; canonical project variables point to Public/Admin custom domains and the media CDN, while preview configuration retains Pages origins with the cutover switch false.
- Latest observed Admin production: `21edfd5e-58f2-494e-bb6d-7e5545434f19` from isolated source `074bcff4f1f01ee85736050596890263d6f511e1`; production Google remains enabled, preview Google remains disabled, and the media Worker version remains `43b18f93-6ad0-4007-9ee8-865d43cdbe66`.
- Public preparation deployment: `136bad6d-96c3-4f3c-8494-91890eeb3223`.
- Admin preparation deployment: `c81fa80a-5df3-42e0-8448-83b620d43fd6`.
- Original cutover Public deployment: `f51ffb90-d820-446d-aa14-405ba873d88b` from source HEAD `b8ed5f4f3961cba3f1eba92a5f23cff3a4957347`.
- Original cutover Admin deployment: `4a72bc5d-cbe3-4ebe-81f2-2ec5ec0c6ea8` from source HEAD `c15a9f009da5d04dd068f987df45eeaa633cd038`.
- `thirdrailify.com`, `www.thirdrailify.com`, and `admin.thirdrailify.com` are all Pages `active` with active HTTP validation and Google-managed certificate authority.
- Apex and Admin return `200`; `www` and Public Pages return path/query-preserving `301`; old Admin browser UI returns `301` while old-host `/api/*` remains unredirected and protected APIs return `401` anonymously.
- Stable Public output contains only the apex canonical authority in canonical/OG/JSON-LD, robots, and all 59 sitemap entries. Admin remains `noindex`.
- Responsive route acceptance covered Public home, shop, product detail, cart, disabled checkout, About, GOATS, Terms, and Privacy, plus Admin shell, Commerce Overview, Payments, Products, Orders, Customers, and Fulfillment at 1440, 768, and 390 with no horizontal overflow or mixed content. Direct custom-host TLS/assets were verified separately from the machine's stale Windows DNS cache.
- Google activation validation used Node `22.16.0`: focused auth/domain tests, Admin typecheck, lint, production build, and Pages Functions compilation passed. Live custom-host config readback exposes Google as enabled to both exact origins; Public and Admin browser surfaces render all four providers active. Headless Turnstile correctly prevented an automated provider authorization, so no fabricated identity or account was created.
- `THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE=true` is active in production; preview remains false and retains Pages origins.
- The post-incident account-continuity deployments expose `/api/auth/transfer` on both hosts, require a valid session plus CSRF, and pass focused one-time bidirectional handoff tests without widening the cookie domain.
- The web-record cutover and DNSSEC chain are complete. Do not alter MX, TXT, DKIM, DMARC, CAA, SRV, Pages, or CDN records.
- Checkout and payments remain disabled.
