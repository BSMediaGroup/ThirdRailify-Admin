# Workshop account authority

`/workshop/access` manages existing-account approvals for https://lab.thirdrailify.com. Search and pagination show account avatars, site roles, effective access/source, expiry, actor/time and audit history. Row-local grant, revoke and edit requests require current authorization, exact Admin origin, canonical CSRF and a matching grant revision. No operation promotes a site role.

Capabilities: `workshop.use`, `workshop.access.manage`, `workshop.providers.manage`. Active Masters retain protected recovery access. Full Admin defaults follow the canonical capability-denial policy; explicit suspension can disable Workshop use. Active regular accounts need an explicit unexpired grant. Disabled accounts are denied. Full Admins cannot grant to themselves or other administrators. Master accounts cannot be suspended by these controls. Managing access never confers ownership of private Lab data.

Admin remains the only account authority. Exact `THIRDRAILIFY_LAB_ORIGIN=https://lab.thirdrailify.com` extends the existing configured origins and single-use, short-lived, target-bound handoff. OAuth callbacks/state/PKCE remain canonical; host-only cookies are retained. Lab-origin Turnstile requests must report the Lab hostname and expected action. No auth secrets or provider keys are copied into Public/Bot or added to Admin for Lab.

Account migrations: existing `0002_full_admin_capability_denials.sql` prerequisite plus new `0003_workshop_access.sql`. Both were checked against fresh/upgrade schemas and applied through the supported Wrangler ledger with a scoped migration config. Commerce was untouched. Pre-mutation account backup: `X:\GIT\_BACKUPS\ThirdRailify\workshop-20260912\thirdrailify-accounts-before-workshop.sql`, 298,032 bytes, SHA-256 `bcffb3516e409c2cadfb137f361ec0e1f102cee8ebf36be0414ae2e2273b0476`. Sidecars retain original ledger, schema and aggregate row baselines.

Created files:

```text
functions/_shared/workshop-policy.js
functions/api/workshop/[[path]].js
migrations/0003_workshop_access.sql
src/pages/WorkshopAccessPage.tsx
src/pages/workshop-access.css
docs/WORKSHOP_ACCESS.md
```

Integrated files: canonical capabilities/auth core and handoff route; App routing, navigation and client capability IDs; Pages invocation routing and production origin configuration. No files removed. The shared policy is packaged in Lab with a matching source hash. Lab stores its projects/conversations/jobs/media in dedicated D1/R2, not Commerce.

Validation: 16 existing Admin authorization/auth tests passed. Lab's real local D1/R2 checks cover grants/audit/CAS, protected delegation, session revocation and handoff replay. Local browser fixture tests are not production identity proof. Deployment and authenticated live acceptance evidence is recorded in the Lab release document and updated here when completed.

Deploy compatible Admin before enabling the Lab Pages release. For rollback, select the previous compatible Admin deployment and leave additive schema intact. Do not restore the entire accounts backup over newer account/session changes. Unrelated concurrent Commerce work is excluded using an isolated release worktree.
