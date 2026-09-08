# Aboot Nothing Matchup Studio

Current/pending version: 0.1.0-alpha.0. Admin owns planning, publication, result decisions and media. Public only relays the intentionally published projection. The existing Poll ledger remains the only source of ordinary and committed bonus vote totals.

## Routes and workflow

- Admin `/polls/abootnothing/brackets` and `/:id`: library, private Ideas bench, explicit slot placement/swapping, 4/8/16/32/64 single-elimination canvas, inspector, reviewed reference template, new-ID draft import/duplicate/export, archive/restore and print.
- Existing `/polls/abootnothing` remains the Poll editor/library. `?edit=:slug&bracket=:id` opens a selected Poll and retains its return link. Title/trigger fields are shared with Studio creation.
- Public `/polls/abootnothing/brackets` and `/:slug`: Season Roadmaps, responsive rounds, match lightboxes, source-aware scores, confirmed winner treatment, final champion, gallery links and a feature shelf in the Aboot gallery. `/abootnothing` remains unchanged.
- Admin HTTP mutations use `/api/admin/brackets`, `polls.manage`, authenticated same-origin requests and CSRF. Read access requires `polls.view`. Public/approved Poll creators receive no bracket authority. Public `/api/brackets` accepts GET only and owns no database/storage binding.

## Reference fidelity

Rendered and visually reviewed `migrations/TRO_sample_bracket.pdf`, including seed placement and punctuation. Seed sequence is 1/16, 9/8, 5/12, 13/4, 3/14, 11/6, 7/10, 15/2. Seven first-round decisions are explicitly historical/manual. Batman 32–20, Spider-Man 102–99, Rugrats 20–11, Rocko’s Modern Life 13–4, Animaniacs 40–20, The Powerpuff Girls 14–11, Courage 15–8. The last match and all later scores remain unknown. The template does not infer an official season title, dates or later winners, and creates no Poll votes. Schema migration has no season seed SQL.

## Storage and authority

Migration `0043_aboot_matchup_studio.sql` adds seven tables: `aboot_brackets`, `aboot_publications`, `aboot_poll_links`, `aboot_decisions`, `aboot_audit`, `aboot_guards`, `aboot_media`. Validated JSON contains the bounded contender/match/slot graph; downstream slots reference stable upstream match IDs. Unique indexes enforce one active match per Poll and one active Poll per match. Immutable publications, decisions and audit preserve evidence; supersession changes only decision status.

All writes require schema readiness. D1 batches check optimistic revisions with a failing guard, write the decision/link/publication, increment the working revision and append audit atomically. Poll creation uses a server-only transaction extension of the existing `createPoll`; it does not spoof owners or create a second vote engine. Concurrent retries cannot leave several Polls for one match. Independently owned contender artwork is copied into the real Poll media contract within that transaction, with staged R2 objects cleaned only when no committed media row owns them.

Closed Poll results include ordinary votes plus committed bonus allocations; waiting/review credits prevent advancement. Poll/option mapping, current Poll and results revisions, unique nonempty winner, bracket revision and upstream review state are rechecked. Accepted fingerprints detect reconciliation, reopening, visibility/metadata revision changes and missing sources. A deliberate override is allowed only for a closed, credit-settled source with an explicit reason; it never changes Poll totals. A bye requires a resolved contender opposite an explicitly marked bye, not an unresolved upstream placeholder.

Linked and decided matches protect their own inputs and all upstream matches. Unrelated unfinished branches remain editable; protected identities and tree topology are checked on the server. Use audited detach/correction, or duplicate as a fresh private draft, before replacing them. Downstream links are protected even while draft: deliberately detach descendants from the final round backward, retaining their Polls/ledgers, before rolling back the source decision. Unlinked historical results remain separate evidence when later Poll authority is selected. Finalization requires every required match resolved and no unresolved source review; reopen requires an audited reason. A conflicted finalized source loses unquestioned public finality.

## Publication and media privacy

The working draft and immutable published graph are separate. Publishing promotes only explicitly reviewed public presentation and placed contenders. Notes, tags and unassigned alternatives never enter the projection. Confirmed operational decisions may update that graph without publishing unrelated working edits. Private/unavailable Polls redact scores, links and accepted dependent outcomes; changing Poll visibility cannot bypass protection through an old bracket snapshot. Unpublish revokes public reads and media while retaining history.

Bracket images use the existing Admin R2 bucket through protected same-origin preview endpoints. Public reads recheck active publication references and use the Public relay; there is no browser credential or new storage binding. Replacing a private image retains an image still used by the published revision. Assets remain in history; each bracket has a 256-asset limit. Only validated PNG/JPG/WebP files are accepted. Browser object URLs are used only for an immediate JSON download and are never persisted. Public uses one document-visibility-aware 15-second refresh coordinator. Responses intentionally use `no-store` to keep visibility changes authoritative.

## Validation and release evidence

Evidence is in `.artifacts/matchup-studio/` in the isolated release checkout. Run with Node 22.16.0 and `npm.cmd`/`npx.cmd`. New tests are `tests/brackets.test.mjs` and `tests/brackets-browser.test.mjs`; the browser test uses real local D1/R2, actual Admin handlers and the actual Public relay, with synthetic local accounts only. It covers reviewed sample persistence, durable images, private/public boundaries, linked Poll creation and accepted result/review, responsive geometry, publication, and anonymous unpublish denial. Existing Poll, credits, auth, media, capabilities and Public Poll browser tests are retained.

The source audit began at Admin `b4aaa9438c06bef7da0f8a7f507e8a51f3427d2a`, Public `6641c52c00972281abdc092824c47b4f8fae58f3`, Bot `6a3b3aa6e87ba8b942a718bbb2186bf4b5c3e2f7`, all main/origin-main aligned. Shared Admin edits and Bot logs were preserved by isolated worktrees. Live Pages initially matched those Admin/Public commits. Remote ledger contained migrations 0001–0042, including 0041 applied at 2026-09-08 07:57:08. Fresh Bot heartbeat reported protocol 2, backlog 0 and no credit fault; no Bot source/process action is needed.

Pre-migration protected full Commerce backup: `X:\GIT\_BACKUPS\ThirdRailify\matchup-studio-20260908\commerce-before.sql`, 5,073,599 bytes, SHA-256 `54BEB66AD9824BD1F24E930E91F9579AD17548663D7C05E2B707F84AC8547004`. Account `b98c3fe4118854c1a58982da6dae38a4`; database `3dd23a7e-7c64-49cb-a52c-c1540b41db1c`. A 94-table baseline and full ledger were captured without exposing business rows. Use the exact reviewed migration manifest and an isolated `migrations_dir` with the same D1 ledger; see [Cloudflare migration configuration](https://developers.cloudflare.com/d1/reference/migrations/).

Rollback is to compatible prior Pages artifacts after reviewing preserved schema/data. Do not restore the old D1 export over newer customer orders, votes or credits. New bracket tables are additive and can remain when rolling application code back.

Stable authenticated acceptance must use the separate operator browser, never copied cookies or a cloned profile. `scripts/matchup-operator-session.mjs` opens that window and accepts `status`, `capture`, `accept`, `close`. The bounded UI script `scripts/matchup-stable-acceptance.mjs` creates clearly labelled temporary data, keeps paid/Rumble automation off, records one ordinary web vote, tests publication/privacy, then unpublishes and archives the acceptance records. Its durable record is `.artifacts/matchup-studio/live/acceptance-record.json`; a failed run must be reviewed and cleaned before claiming completion.

Deployment and stable acceptance results are recorded in the release manifest and the appended root bump notes. An unauthenticated Admin HTML shell is not acceptance.

## Final release integration

Preserved the Poll workspace and pending-artwork changes already serving in deployment b897ebac-5ec8-435b-a924-cd3d88f7ff4c (assets index-DCvYvstm.js and index-FaohwtHi.css), whose source matches the shared Admin checkout build. Shared checkout files remain untouched. Bracket surfaces now use existing black-and-gold tokens. Both account widgets retain failed Turnstile widgets and offer explicit retry without bypassing verification. The operator confirmed the sign-in challenge failure occurs only in the separately launched automated browser, not normal Chrome. The browser tool briefly showed a legitimate Master Admin session, then its transport closed; this is not completed Studio acceptance.

## Production release - 2026-09-08

- Admin deployed commit `9dd9c44b894d64ce0863788227e6a9c11f4d1d21`, Pages `4083ee10-78d3-4371-bfb6-43d719f1f85a`.
- Public deployed commit `738a24e26d042b46798b152551dfae905b7f1d0c`, Pages `6861272d-8ad3-49a3-a515-1931b4cc2c0c` (supersedes initial roadmap deployment c0cb1cfd after route metadata correction).
- Stable JS/CSS bytes match the built artifacts on both domains. Admin `/api/admin/brackets` denies anonymous access with JSON 401. Both public `/api/brackets` endpoints return JSON 200 with an empty library, and unpublished/unknown detail returns JSON 404.
- Exact migration `0043_aboot_matchup_studio.sql` applied at 2026-09-08 08:54:27 UTC. Protected full backup: `X:\GIT\_BACKUPS\ThirdRailify\matchup-studio-20260908\commerce-before.sql`, 5,073,599 bytes, SHA256 `54BEB66AD9824BD1F24E930E91F9579AD17548663D7C05E2B707F84AC8547004`.
- Final focused authentication/bracket tests: 13/13. Connected Studio browser test: pass. Existing Poll/Bot-evidence/artwork/reconciliation browser test: pass against isolated release builds. Turnstile recovery browser test: pass (local fixture only, no production challenge bypass). Public Functions tests: 4/4. Earlier Poll/credits/media regression results retained in artifacts. Both production builds and Functions compilation pass. Admin lint clean; Public has two existing warnings and no errors.
- Viewed corrected local Admin desktop, publication dialog and Public mobile screenshots. Stable Public library desktop/mobile screenshots viewed; mobile scroll width equals viewport width 390px. Evidence under Admin `.artifacts/matchup-studio/live/`: `stable-roadmap-library-final.png`, `stable-roadmap-library-mobile-final.png`, `stable-anonymous.json`, `stable-assets.json`.
- Production state at 09:16 UTC: zero brackets, zero publications, six pre-existing Polls. No acceptance data was created. Bot unchanged; fresh heartbeat protocol 2, backlog 0, no fault. No provider or paid-voting enablement changes.
- LIVE AUTHENTICATED ACCEPTANCE IS INCOMPLETE. Existing browser tool briefly displayed a legitimate Master Admin session, then disconnected with `Transport closed`. The separate Playwright-launched Chrome failed verification; user confirmed normal Chrome works. No credentials/cookies/profile were extracted. Remaining: authenticated create/save/reload/link/advance/publication/republish/unpublish/archive sequence and its stable screenshots. Local tests do not substitute for these gates.
- Original shared worktrees remain unchanged by source edits. Their already-deployed Poll workspace/artwork and Public hero/SEO changes were preserved in the isolated release. No Bot source or process changes, no force push or main reset.

## 2026-09-08 - Matchup canvas and winner presentation repair

CURRENT VER=0.1.0-alpha.0

PENDING VER=0.1.0-alpha.0

- Fullscreen now uses the available viewport height; Fit view accounts for both dimensions. Measured SVG connectors follow actual source cards and destination opponent rows at every zoom.
- Admin Ideas bench collapses and keeps scrolling without a visible scrollbar. Match editing uses a native modal from each pencil button or double-click, including fullscreen. Focus finds and centres the contender, switches mobile rounds, and explains empty or unmatched searches. Studio library cards have full-card links and more generous typography/spacing.
- Confirmed winners have a trophy badge, gold feature row, and hover/keyboard glow, shimmer and sparkles. Reduced-motion preference keeps a static treatment. Existing result/review authority and publication privacy remain unchanged.
- Focused browser coverage verifies connector endpoints, fullscreen bottom reachability and Fit view, mobile Focus, modal editing with save/reload, bench collapse, full-card navigation, and winner animation/reduced motion. The connected local D1/R2 publication/Poll workflow also passes. These are local fixture results; authenticated stable-domain acceptance remains incomplete because the browser transport is unavailable.
- No schema migration, Bot action, live bracket mutation or provider/paid-voting change. Source is integrated with current main before release; deployment evidence is appended separately.

### Canvas production verification - 2026-09-08 10:13 UTC

- Application commits: Admin `e12bcab12f3f8da7e613b03b476b5deec290c3a4`; Public `15b63148879825126262a98cd1e3854784da435c`. Both were fast-forwarded into the original main checkouts and pushed. Current Overview/entrant work was preserved.
- Admin direct Pages deployment `f1c91ba3-0bd8-46bb-833c-05437058e0b0`; the main-triggered deployment `524037c2-dd4a-472b-8f62-4acb609e4954` serves the stable domain from the same commit. Public Pages `93559ffb-da2a-4793-a1fe-98b2d7b3486e` serves stable Public.
- Both stable domains' JS/CSS match their respective immutable deployment bytes. Winner feature, measured connectors and fullscreen CSS are present. Admin anonymous brackets API returns JSON 401; Public library JSON 200 with zero publications, unknown roadmap JSON 404; all use no-store. Evidence: Admin `.artifacts/matchup-studio/live/canvas-release-verified.json`.
- Both production builds/typechecks and scoped maintained-source lint pass. Both Pages Functions bundles compiled successfully during deployment. Final serial browser run: 2/2 suites pass. Viewed winner hover, full-height/Fit view, fullscreen editor and improved library screenshots. Current local evidence: Admin `.artifacts/matchup-studio/browser-1788862231273/` and `browser-1788862245242/`.
- No production Studio records were created or changed for this UI release. Authenticated stable-domain end-to-end acceptance remains incomplete; asset parity and local browser tests are not represented as that acceptance.

## 2026-09-08 - Direct opponent text entry in the matchup editor

CURRENT VER=0.1.0-alpha.0

PENDING VER=0.1.0-alpha.0

- Fixed the empty-bracket editor that exposed only existing-idea dropdowns. Each opponent now has a prominent Name input; typing creates and assigns a new contender in the working draft, and renaming an existing contender retains its ID. Per-opponent Description fields are editable in the same modal. Existing idea/bye selection remains available below the Name field.
- Save validation is shown at the top of the modal. Starting slots has an explicit accessible label. Linked/decided/finalized identity protections and server-side validation remain intact; no migration or result-authority changes.
- Browser coverage includes creation with the bench hidden, both names/descriptions saving through hard reload, rename identity preservation, visible blank-name rejection, protected historical identity and responsive modal geometry. Existing connected Poll/publication browser coverage retained. No new files or Public/Bot changes; concurrent manual-vote work in the shared Admin checkout is excluded from this repair.

- Direct opponent editor deployed to Admin as `e01e1cfb9a3be88551a8a5a1d950d5c33d43e11a`, Pages `7163e87b-9d14-4314-80c2-8b30a42074d4` (main-triggered equivalent `ad07fbac-e0aa-4c0d-9e47-967cf0fd2425`). Stable Admin JS matched immutable deployment bytes and contains the Name-entry controls; opponent fieldset CSS is present. Build/typecheck/scoped lint and focused browser coverage pass; connected Poll/publication regression passes. Viewed desktop/mobile screenshots in `.artifacts/matchup-studio/browser-1788863104586/`; stable asset evidence is `.artifacts/matchup-studio/live/direct-opponent-release.json`. Local save/reload tests used disposable fixtures, with no production bracket mutations or authenticated production acceptance claim.

## 2026-09-08 - Partial-season editing, page scrolling and image sources

CURRENT VER=0.1.0-alpha.0

PENDING VER=0.1.0-alpha.0

- Removed the bracket-wide identity lock. Linked or decided matches protect their own inputs and all upstream matches; other branches can select existing ideas, type new contenders and rename unprotected contenders. Server comparisons preserve protected identities and tree topology, including attempted swaps across protected inputs. Finalization still protects the full graph.
- Outside fullscreen, the map grows vertically with the page and scrolls horizontally only, with a 3px scrollbar in Chromium and thin native fallback. Fullscreen retains bounded two-axis scrolling. Focus now scrolls the page vertically outside fullscreen. The desktop Ideas bench sticks below the Admin header and scrolls independently without a visible scrollbar.
- A discreet expand button opens the same Ideas/contender controls in a larger lightbox using the same working draft. The matchup modal supports each opponent's saved image upload, preview and removal.
- Both the bench and opponent editor accept an image URL as an alternative to file upload. Authenticated same-origin/CSRF-protected import downloads a bounded public HTTPS PNG/JPG/WebP, validates bytes and stores the existing private R2 asset. URLs cannot bypass publication/media ownership checks; redirects, credentialed/internal/IP URLs, non-images and oversized streams are rejected. No browser hotlinks or external credentials are persisted.
- Six focused tests pass: the connected canvas/editor/browser workflow, connected Poll/publication/privacy browser workflow, and four real-D1/model cases including partial-branch protections and URL import failures. Both production builds/typechecks and scoped lint pass. Desktop modal screenshots reviewed; evidence is in Admin `.artifacts/matchup-studio/browser-1788864815258/` and `browser-1788864837407/`. No production bracket mutation or authenticated production acceptance is claimed.
- No new files, schema migration, Bot action or provider/paid-voting change. Current main's manual-Poll count work is retained.

- Deployed and verified 2026-09-08 10:57 UTC: Admin `225e01230218462a6628efbaf43cbc410baf2407`, direct Pages `3f5745fc-cde9-479e-9dcc-e2db8cee7d5c`, stable main build `fdd92690-fb25-42c3-99de-ceaf02b99098`; Public `e2cd9a56f3ff63bbbc75cb420c6d5fb09d7f40b9`, Pages `fed8d8f8-e7f3-4e18-b782-5c823207e83c`. Stable JS/CSS match immutable release bytes on both domains; new image URL/expanded bench controls and unclamped map styling are present. Both Functions bundles compile. Evidence: Admin `.artifacts/matchup-studio/live/scroll-images-release.json`. Original and remote main branches include the changes; existing manual-Poll work is preserved. No production bracket records were changed during verification.

## 2026-09-08 - Matchup state and score presentation

CURRENT VER=0.1.0-alpha.0

PENDING VER=0.1.0-alpha.0

- Admin and Public use the same presentation: matchups with unresolved inputs render at 70% opacity and return to full brightness on hover or keyboard focus. Filled matchups retain normal brightness; printing restores full opacity.
- A confirmed decision without a review flag adds a discreet green check before the header status and a subtle green header gradient. Undefined, undecided and needs-review matches do not receive a completion mark.
- The winner trophy is now a smaller 20x22px badge immediately before the score, with a 15px icon. Winner row styling and hover sparkles remain intact.
- Both frontend builds/typechecks and scoped lint pass. Admin browser coverage checks completion counts, trophy placement/size, dimming and keyboard/hover restoration. Public browser assertions verify the same states on the published projection; existing responsive, editing, image and publication checks are retained. No backend, schema or result-authority changes.

- Presentation deployed and verified on both stable domains at 2026-09-08 11:37 UTC: Admin `bdd3d1a3c2ecb7e89cfe245500ca4832d3803db2`, direct Pages `129efdc5-e048-409b-a335-9a7179d3b155`, stable main build `8104b325-21aa-4ba1-bf58-218db1e04b10`; Public `d70b18c4603e560fd5950152629d8f46db04a1b2`, Pages `96e21de3-6280-4a9a-9286-1ca0a8961524`. Both stable JS/CSS match immutable release artifacts, including completion checks, opacity and score-prefix trophy styling. Both browser suites pass, including explicit Public projection assertions. Viewed Admin and Public screenshots under Admin `.artifacts/matchup-studio/browser-1788867247451/` and `browser-1788867305660/`. Stable evidence: `.artifacts/matchup-studio/live/match-state-presentation-release.json`. No live bracket changes were made; authenticated production workflow acceptance remains separate.
