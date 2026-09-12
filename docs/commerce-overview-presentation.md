# Commerce overview presentation

The production overview uses shared dashboard theme tokens, the existing brand fonts and Admin icons. A store-status header and metrics lead into eight service cards, an optional-services strip, grouped readiness diagnostics and the existing store controls. Status chips combine labels and icons with green ready, amber attention, red blocked, blue configured/attested and neutral optional states.

All values come from the existing Commerce launch plan. Payment readiness requires its existing preferred-provider, live-credential, account and webhook gates. Operator attestation is not provider verification. Active destination counts use the supplied active markets; no historical market count or restriction is restored. Service-card links use the existing settings routes.

The release retains the existing activation confirmation, private-record handling, permission checks, pause and reconciliation handlers. No schema, backend authority, payment, provider, email or store-setting mutation is part of this visual release.

Validation: build/typecheck, scoped ESLint and diff checks passed. Local browser fixtures at 1440/768/390 exercise activation confirmation, masked private edits, live and paused states, degraded payment readiness, expanded diagnostics and overflow. They do not prove a production authenticated activation or pause. Screenshots: `.wrangler/commerce-overview-release/output/store-launch/`. Concurrent automation and subscriber work is excluded from the isolated release; the previous editor-theme fix is retained.
