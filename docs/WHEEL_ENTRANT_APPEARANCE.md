# Automation cards and entrant appearance — local milestone

Current/pending repository version: `0.1.0-alpha.0`. No deployment or remote migration has been performed.

## Authority and shared source

Admin selects and applies appearance. Bot matching projections contain no appearance configuration, new renderer, provider client, payment badge or decorative RNG. Public keeps its existing same-origin session/CSRF and signed Admin gateway; Wheel edit permissions, limits and revision checks remain authoritative.

The following source files are mirrored verbatim between Admin and Public and checked for parity by the Admin feature tests:

- `src/lib/entrant-appearance.mjs` and `.d.mts`: versioned values, validation, precedence, projection, deterministic automatic resolution.
- `src/lib/entrant-feature-drawing.ts`: curated 24-unit vector primitives, slice fills, marks and bounded effects.
- `src/components/EntrantAppearanceControls.tsx`, `src/styles/entrant-appearance.css`: independent controls and shared normalized Canvas slice preview.
- `src/components/AutomationRuleList.tsx`, `src/styles/automation-rule-cards.css`, `src/lib/automation-rule-store.ts`: grouped cards and row-local state.
- The existing `AutomationRuleEditor`, automation client and award model remain mirrored.

Admin `TriggerStudio` supplies `/automations`, `/wheels` Overview and `/wheels/:id` detail. Public `WheelAutomations` supplies the `/wheels/:slug/edit` modal tab. Global groups use target type and target ID, never title; scoped surfaces receive only their Wheel's rules. Groups and cards sort by stable IDs. Collapsed groups, search and family filters survive changes. The server list is bounded at 200, reports truncation, and includes unavailable targets. Metrics refer to loaded rules; successful event counts remain distinct from awarded weight.

Switches use labelled `role=switch`, `aria-checked`, visible focus, a green checked enabled state, neutral paused state and explicit pending state. A per-rule lock suppresses duplicate writes without blocking unrelated cards. A successful save publishes the small authoritative response to mounted consumers. Errors roll back that row; 409 fetches the affected rule and requires a deliberate retry. There is no toggle-triggered auth/bootstrap/catalogue reload. Runtime readiness is secondary to configuration, and historical faults are described as historical. Raid notices remain chat-derived and not independently verified.

## Contract and storage

Migration `0040_wheel_entrant_appearance.sql` adds nullable `wheel_entries.entrant_appearance_json`, checked as valid JSON and at most 8192 characters. Existing `segment_colour`, `segment_style_json` and image ownership remain unchanged. The old style column's 512-character constraint cannot hold bounded component provenance, which is why the new column is necessary. No historical migration is edited.

Rules keep optional `actionConfig.appearance` in the existing award JSON. Missing or null appearance is opt-out. Enabling the section alone does not select a preset. Selecting components does not enable the rule. Cosmetic name/description/appearance edits preserve activation time and receipts; changed eligibility/awards or enabling still establish a fresh boundary. A revision still changes, so older in-flight Bot rule revisions remain rejected under the existing contract.

```json
{
  "version": 1,
  "manual": { "icons": [], "effects": null },
  "automatic": {
    "fill": { "value": { "colors": ["#492079", "#DB41D3"] }, "source": "automation" }
  }
}
```

Components are `preset`, `fill` (exactly two hex colours), `icons` (at most two curated IDs), `edge` (hex colour plus inner/outer/both), and `effects` (sparkles/shine/dazzle/pulse, intensity 0.1–0.6, speed 0.5–1.5, density 1–4). The server rejects unknown keys, unsafe colours/enums and out-of-range numbers. No user CSS, SVG, URL, script or shader is accepted in this contract. Presets expand into independently editable values; they do not create a second fill or image authority.

Stored automatic components also carry normalized provider time and a stable SHA-256 tie-break from event fingerprint and rule ID. Those fields are removed from Public projections. No raw event/payment/chat fields or privileged rule metadata are attached to an entrant.

## Precedence and awards

Per component: explicit manual choice, then automatic snapshot, then existing defaults/Wheel palette. Existing explicit segment colours/patterns/images count as manual fill. A newly selected feature fill takes over that component; choosing Solid/Pattern/Image through the existing editor replaces the manual feature fill. Changing the global palette preserves feature overrides.

- Omitted manual key: inherit, including the existing explicit fill where present.
- Null or empty icons: explicit off/default, retained across subsequent awards.
- **Use automatic appearance:** clear manual component choices and existing explicit fill.
- **Use Wheel defaults:** explicitly suppress feature components, with palette fill.
- **Clear manual component:** remove just that component's manual choice.

Latest qualifying appearance-bearing event wins independently per component by provider event time, then stable hash on ties. Delivery order does not decide the outcome. The latest automatic value can advance beneath a manual override, but the effective manual choice remains unchanged; restoring automatic reveals the stored value.

Appearance is written only inside the existing guarded successful entry-create/weight-accumulation D1 batch. Receipt, weight, Wheel revision and audit share rollback. Replayed events, rejected/stale events, skipped existing entrants and zero awards cannot change appearance. Hidden entrants stay hidden. Editing/disabling/deleting a rule never strips past appearance. Subscriber award eligibility, including zero amounts, is unchanged; automatic subscriber decoration requires positive reported cents. Manually selecting crimson remains unrestricted decoration, without a payment-verification claim.

## Public editing and persistence

The normal participant manager exposes **Features** for existing and newly added rows. The standalone new-Wheel editor and Appearance dialog's entrant rows use the same controls. Participant details show the full component information even where a wedge is too narrow for a glyph. Participant list dots reflect the effective fill.

Admin merges omitted appearance fields from older clients instead of deleting them, and retains server-owned automatic provenance during manual edits. Explicit manual clears use validated values. Text, weight and order edits retain appearance. New/imported entries cannot assert automation provenance: portable exports/imports preserve the decorative result as manual values with fresh IDs. TWL v2 gains the optional versioned appearance field; older files work unchanged. Older strict importers may reject files containing the new optional field rather than silently losing it.

`useWheelRefresh.ts` provides visible-page content refresh at a bounded 15-second cadence, on focus, and after same-origin save notifications. Detail/Presentation and Stage refresh safe projections only. Refresh is held while spinning, preflighting, displaying results, transitioning, or editing; an in-flight response is discarded if the view becomes held. A Stage refreshes its whole bounded projection rather than starting a poller per tile. Appearance never enters spin plans or mechanics randomness.

## Renderer

Every existing `WheelCanvas` consumer receives the same treatment: detail, Presentation, Stage overview/focus/fullscreen, editor and Appearance previews. Gradients and vector marks build with the static artwork cache. Dynamic effects use one extra decorative Canvas and a cached foreground Canvas under the same DOM rotor. Labels and marks sit above the highlights; pointer, hub and stationary mechanics remain separate.

Effects use cached annular wedge paths, entrant-ID cosmetic seeds and aggregate angular particle allocation. There is no bitmap per slice, timer per entrant, frame-driven React state, image decode/text measurement/static reconstruction per frame, or decorative network activity. Idle decoration has one visible-Wheel scheduler; spinning uses the existing renderer angle write. Hidden/offscreen/unmounted Wheels stop decorative work. Reduced motion receives static equivalents without changing the spin preference policy. Selected glyphs and the name share one radial line. Glyph space is reserved first and longer names are measured and ellipsized into the remaining width during static cache creation. Glyphs are hidden only when the actual slice cannot fit a legible mark; names never force a configured glyph onto another line or remove it. Clicking a slice shows the full name and appearance details, including effect settings. Small wedges retain their data and colour/edge cues.

The accepted spin RAF effect, pointer sampler, engine, mechanics, canonical geometry/render plan and protected Admin result functions are verified unchanged. See `.artifacts/entrant-features/protected-final.json` and the appended results in `WHEEL_RENDER_PERFORMANCE.md`.

## Rollout prerequisites

1. Apply existing migrations through `0039`, then additive `0040`, with the normal operator release procedure. **This task only applies migrations to isolated local test databases.**
2. Release Admin authority/readiness/serialization first; verify the new column and a revision-checked round trip.
3. Release Public controls/renderer/portable compatibility next.
4. Deliberately configure appearance on chosen rules or entrants. Existing rules and historical entrants are not automatically decorated.

Missing `0040` produces `entrant_appearance_schema_required` before appearance writes. Old rules without the optional field continue to execute and old Wheels continue to read. Once feature data is stored, do not roll Admin back to an old serializer that deletes/reinserts entries without preserving the new field. No new Bot release, secret, provider, payment or DNS dependency is introduced.

## Evidence

Admin tests: `tests/entrant-features.test.mjs`, `tests/entrant-feature-cards-browser.test.mjs`, and existing Automation/Wheels/auth/Stage suites. Public: `tests/entrant-features-browser.test.mjs`, existing avatar/automation and GIF renderer browser suites, deterministic driver, mechanics, engine, geometry, portable and gateway tests. Tests use isolated local D1 and synthetic events; none wait for real paid events or run a production spin.

Evidence is under each repository's `.artifacts/entrant-features/`. It includes responsive screenshots, persisted executor/Public projections, build/lint/Functions logs and protected-source hashes. Timing and recording runs are separate under Public `.artifacts/wheel-render-performance/features-*`. Exact performance measurements and environmental limitations are recorded in the [Public performance report](../../ThirdRailify/docs/WHEEL_RENDER_PERFORMANCE.md).

### Validation record (local)

- Public production build includes TypeScript project checking; maintained `src`/`functions` and changed test/profiler lint has zero errors and the three existing warnings (ProductVariantSelectors export, PollsPages dependency, and the preserved WheelCanvas rotation dependency).
- Admin production build/typecheck and maintained-source lint pass with zero errors. Both Pages Functions bundles compile locally with Wrangler 4.60.0.
- Public regression selection: 84 passed, one optional saved-baseline comparison skipped. The final inline-label browser/driver run: nine passed, one same optional comparison skipped; these overlap the regression selection and are not additive totals.
- Public avatar/automation and existing GIF/resize/hit-test browser regression run: three suites passed. New real-D1 entrant browser acceptance passed at 1920/1440/768/390, including normal-manager new entrant creation, manual settings, name/weight/reorder/save/reload, subsequent awards, Stage/focus refresh, hidden decorative stop/resume, reduced motion, same-line glyph/name geometry and full-name slice-click details.
- Admin entrant feature authority suite: four passed on final source. Auth/Stage/feature selection: 16 passed. Migration suite: six passed on isolated retry. Shared cards browser: passed at four widths across all three Admin reuse sites, keyboard/pending/focus, 401/403/429 rollback and 409 targeted reconciliation.
- An earlier combined Admin run encountered three Miniflare `fetch failed` errors in migration setup and hung during shutdown after 33 test results; it was stopped and the migration suite passed in a fresh isolated process. An intermediate Public screenshot overwrite failed locally; the fresh-filename rerun passed. These failed attempts remain in the artifact logs and are not reported as passing runs.
- Public auth/gateway final selection: eight passed, one pre-existing account-menu CSS regex assertion failed. The asserted global.css is byte-normalized identical to HEAD and the same expected regex also fails against HEAD; see `auth-baseline-proof.json`. It was left unchanged.
- Protected engine/mechanics/render-plan/Stage coordinator and accepted spin/pointer functions match HEAD. Each repository's `git diff --check` passes. Both HEADs remain unchanged; all five reference repositories' dirty-path status matches the initial audit.

Exact modified/new paths are retained in each `.artifacts/entrant-features/file-inventory.txt`: Public 25 modified plus 11 new; Admin 12 modified plus 14 new. No files removed, no dependency/version changes, and no commit/push/deployment/remote migration/live mutation. Root README and BUMP_NOTES retain history under current/pending `0.1.0-alpha.0`.
