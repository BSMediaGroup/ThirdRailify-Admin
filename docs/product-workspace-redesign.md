# Product editor visual redesign

All five tabs share a scoped dark/gold/cream interface using the existing Blinker, American Captain and Geist Mono fonts and Admin icons. The header shows explicit readiness, publication and dirty-state chips; Save product stays in the footer with one main content scroll region.

- **Overview:** grouped product details and collection selection, a storefront preview, publication switch and merchandising settings.
- **Variants:** readiness totals, search and bulk selection, option chips, colour swatches, dollar price inputs, availability/publication/shipping status, and accessible resizable columns. Integer CAD cents remain the server storage format.
- **Media:** visible variant-selection tiles and artwork gallery first; primary/general badges, assignment counts, upload/link controls and explicit relationship reset actions.
- **Shipping:** effective policy card, separate weight/pricing/destination explanations and a styled optional weights disclosure with inheritance and source chips.
- **Sync & issues:** formatted activity timestamps, readiness summary, variant diagnostics, repair links and advanced provider references in labelled cards.

Chip colours have text labels: green ready, amber attention/staged edits, red invalid mappings/environment/unavailable dependencies, blue provider/shipping information, gold publication/selection, grey inactive or informational state. Colour is not the sole status indicator.

Validation: authenticated local browser tests use actual Admin/auth handlers with synthetic catalogue data and no provider network calls. They exercise decimal price persistence, variant selection, media assignment, one Save, all five tabs and expandable weights at 1440/768/390. Screenshots are in ignored `.wrangler/printful-workflow-20260912/browser/workspace-*.png`. Typecheck/build, scoped lint and diff checks passed. Existing build chunk-size warning remains.

This release changes editor presentation and CAD input formatting only. It does not alter checkout, shipping policy, provider synchronization, media storage or database schemas. Production authenticated editing is not claimed without a legitimate operator session.

Deployment: https://9e5261ae.thirdrailify-admin.pages.dev. The Admin custom domain returned HTTP 200 and its JavaScript/CSS matched the local build byte for byte. Evidence: .wrangler/editor-redesign-live-assets.json. No production catalogue data or provider calls were made for this visual release.
