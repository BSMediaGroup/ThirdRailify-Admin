# Current product mockup and publication repair — local, September 7, 2026

This repair changes Admin/provider normalization, scoped media persistence, publication diagnostics/actions, and the sanitized Public relay/rendering. It does not deploy or apply production data changes. **A downloadable image is not proof of merchant artwork.**

## Verified starting state

Both X: worktrees started clean on `main`: Admin `88cf87ed7f293e2f38d0154a9ad6eb6d373921be`, Public `27c6367b502fb295a102449e8bde0a8e91ec05b7`. The corresponding `C:\NEPTUNE LOCAL\GIT` paths do not exist. The Admin reconciliation file's starting blob is exactly the supplied `4fd7004582372571a79c6806373abaaf33be51c3`. No checkout of that blob, divergent clone, reference-repository inspection, commit, push or deployment was performed. Live bundle identity was not equated with either local HEAD.

The final complete GET-only provider read at **2026-09-06T14:14:55.252Z** verified explicit store **18668025 / Third Railify API / native**, two product pages, all 13 product details and **91 variants**. Normalized snapshot fingerprint: `a6a86b7f7714730ccac544294ad37e958f6ce06fcef320407e16c9c640315580`. Fingerprints include normalized fields; changes to the normalizer can change them without a provider edit.

Read-only production D1 diagnostics at **2026-09-06 14:10:36 UTC** found exactly the same 13 current identities/91 variants. All diagnostic queries reported zero rows written. Migration `0026_printful_catalogue_reconciliation.sql` is recorded. This repair requires **no migration** and does not rewrite 0026.

| Successful Apply | Products | Variants |
| --- | ---: | ---: |
| 2026-08-31 16:41:08 UTC | 17 | 262 |
| 2026-08-31 20:15:36 UTC | 16 | 256 |
| 2026-09-06 11:23:05 UTC | 16 | 256 |
| 2026-09-06 12:37:55 UTC | 14 | 137 |
| 2026-09-06 13:52:55 UTC | 13 | 91 |

The 16/256 Preview at 12:06 UTC was never Applied. The screenshot's 14/137 is an older successfully Applied snapshot. Current pagination and store identity agree with D1; historical decreases are not a reason to resurrect/archive rows. Product-by-product historical provider edits and their operator intent were not independently reconstructed. The status API now separates latest full-catalogue Preview from latest successful full-catalogue Apply and excludes scoped repair runs from those summaries.

## Confirmed image defects and accepted authority

All **91 current preview files have `visible=false` and `status=ok`**. The old normalizer rejected them, appended blank catalogue `sync_variants[].product.image` photographs, and used those photographs as variant fallbacks. It also accepted both resolutions of a preview. Ordinary Save copied even unchanged references into CDN storage, then compared CDN URLs to provider URLs and stamped a whole-gallery editorial override. A whole-gallery override preserved every slot, even when only the primary should be locked.

The [Printful API documentation](https://developers.printful.com/docs/) defines file `type` as its role; visibility controls the Printfile Library, and processing status distinguishes waiting/failed files from successfully processed images. `preview_url` and `thumbnail_url` are derivatives; artwork files have them too. `url` is considered only for an attached, successfully processed preview-role file and only on the established trusted hosts. `sync_product.thumbnail_url` is a configured product thumbnail, while the nested product image is a catalogue variant reference. [Printful's mockup guide](https://help.printful.com/hc/en-us/articles/360014066179-What-are-mockup-images) distinguishes main product images from additional mockup styles and notes integration differences.

The selector now uses only product-associated `type=preview`, `status=ok` files, independent of library visibility; chooses one usable resolution per file; and deduplicates references. Attached file identity and safe alternative URLs corroborate a product thumbnail when possible. A separate thumbnail requires explicit visual review before it is retained as the primary. No artwork-role file or catalogue image is an automatic merchant image. Missing preview data is a blocker, not a stock-photo fallback. Provider response bodies and image streams are bounded, requests time out, redirects are rejected, and filenames alone do not establish MIME or design provenance.

The actual census has **23 automatically selected preview views across 13 products**, and **39 distinct per-product catalogue candidates rejected** (91 catalogue-image field occurrences). Four separate thumbnails require review. Visual inspection confirmed the jacket, silly goose and my balloon thumbnails show merchant designs; the fuc yeh thumbnail is a **blank shirt**, while its attached preview shows the design. Local acceptance explicitly retained the three merchant thumbnails, rejected the blank one, and persisted **26 product-gallery entries**. All current products have verified merchant-specific preview imagery; none is dependent on a thumbnail-only fallback. This is coverage of exposed preview files and reviewed thumbnails, **not proof of the complete dashboard-selected additional gallery or its order**. Variant-ID ordering of the remaining preview union is deterministic, not a claim about the merchant's preferred gallery order. No missing current preview required a guessed template relationship, private API, file-library enumeration or mockup-generation request.

## Existing data and editorial ownership

`products/repair/preview` and `products/repair/apply` reuse the existing authenticated commerce route, `commerce.catalogue.manage`, exact origin, CSRF and bounded rate categories. Scope is 1–20 explicit current product IDs. Preview persists the selection, prior product/variant image references, diagnostics, snapshot and local-state digest in the existing reconciliation tables. Apply checks the actor, typed confirmation, complete fresh provider read, local digest and an atomic D1 transaction guard. A scoped run cannot be submitted to the full-catalogue Apply handler.

Media Apply stages all assets in the existing Admin-owned R2 binding before activating references. Content SHA-256 determines new immutable keys; objects and historical references are never deleted or overwritten. Source URL/class and content identity remain in metadata; preview file IDs and field paths remain associated with variants. Failed staging cannot replace saved references. Unchanged provider fingerprints do not suppress desired-state correction, and a second completed repair is a no-op.

Primary locks, explicit manual additions, ordering and excluded provider slots use versioned ownership metadata. Provider-managed slots refresh independently. Unknown historical whole-gallery overrides remain blocked/preserved unless the operator explicitly chooses **Use Printful images instead of this override**. **Keep reviewed thumbnail as primary** creates a primary lock without freezing the remaining gallery. Ordinary non-media saves preserve authority and do not recache existing media; newly introduced URL references still stage through the media service.

Current stored rows had no active editorial overrides. Historical jacket audit records include real manual uploads and a product Save with disabled status; those records are retained. Their upload bytes/slot identities and whether that status was deliberately changed are not established by the old audit, so the repair does not infer permission to erase historical manual work or publish automatically.

The Worker media service retains MIME/signature validation with improved bounded streaming. The evidence downloader additionally fully decoded the actual source bytes with Sharp and the browser decoded persisted selections. No new Workers image codec or media binding was introduced.

## Exact current publication diagnostic

All 91 stored variants are structurally valid: current configured store, mapped IDs, active provider availability, not ignored, and valid CAD amounts. Only **25 variants across six products** were locally enabled/public. Global checkout, PayPal store checkout and fulfillment submission are false; emergency pause is false and Printful order mode is `draft_only`. These transaction settings do not hide published merchandise.

| Sync Product ID | Product | Stored product state | Enabled / eligible | Stored variant blocker |
| --- | --- | --- | ---: | --- |
| 460278395 | Just Gina Wordmark dad hat | active/public | 3 / 3 | None |
| 460278416 | Just Gina Icon tee | active/public | 8 / 8 | None |
| 460279742 | Third Railify Wordmark v2 dad hat | active/public | 3 / 3 | None |
| 460280318 | Third Railify Icon polo | active/public | 7 / 7 | None |
| 460280381 | Third Rail Farm mug | active/public | 2 / 2 | None |
| 460280530 | Third Railify structured cap | active/public | 2 / 2 | None |
| 460338949 | Champion jacket | disabled/public | 0 / 5 | restricted/private, `is_sellable=0` |
| 460339155 | silly goose Canada | restricted/public | 0 / 6 | restricted/private, `is_sellable=0` |
| 460339175 | my balloon | restricted/public | 0 / 6 | restricted/private, `is_sellable=0` |
| 466945458 | fuc yeh | active/private | 0 / 6 | active/public, `is_sellable=0` |
| 466984948 | Third Rail Hero | active/public | 0 / 35 | active/public, `is_sellable=0` |
| 466989584 | Third Raidify mug | active/private | 0 / 2 | active/public, `is_sellable=0` |
| 466991812 | Tully the Tiger | active/public | 0 / 6 | active/public, `is_sellable=0` |

The old Show action changed only product visibility; reconciliation retained restricted/private/unsellable variant defaults. `is_sellable` is a local variant-enablement condition consumed by projection and checkout, not a synonym for global checkout activation. The newer deterministic import rows match the import's unsellable defaults, but old records do not prove operator intent. Nothing is automatically enabled on that assumption.

**Publish product with eligible variants** previews exact exclusions and explicitly enables valid current variants plus product active/public state. It preserves Featured, prices, mapping IDs and global transaction controls. Single-product and bulk Show flows lead to the same reviewed action; the old current-product Show API refuses an unreviewed visibility-only mutation. New explicit product/variant hiding is recorded as operator intent. Reconciliation continues to preserve local flags. Historical migration/file mappings are not publication prerequisites; transaction safety checks remain in their existing domain.

`storefront-eligibility.js` supplies structured reasons to both Admin diagnostics and Public projection. The table's enabled counts, status and explanatory details now use this result. Wrong-store, archived, provider-missing, ignored and invalid variants are excluded; Featured cannot bypass publication. Public carries only the selected safe image URL, not file metadata, provider credentials or artwork. The Public relay now preserves variant images and accepts Admin's full 25-image bound. Shop/Featured use the product primary; detail retains that initial primary, supports gallery controls, and switches to the associated image on variant selection; cart drawer/page and checkout use that variant image.

## Evidence and validation

Ignored `.artifacts/printful-mockup-repair/` contains sanitized provider responses/snapshot, decoded source assets and SHA-256 manifest, read-only D1 rows/audit, the complete per-product diagnostic, local persisted after-state, Public projection, second Preview, protected API responses and responsive screenshots. No raw provider response containing production artwork URLs or credentials is saved. The artifact set is a diagnostic subset, not a production backup.

`scripts/exercise-current-product-repair.mjs` loads only those sanitized captures, seeds local D1 and existing local R2 bytes, uses a real local test session and the actual Admin handlers, then the actual Admin public endpoints and Public relay. It drives media and publication Preview/Apply through the rendered UI, reloads editors, checks immutable references, preserves transaction settings, verifies variant imagery, and captures 1440/768/390px. It loads no live credentials and makes no provider writes. It does not use a fixture that merely returns success from the mutation endpoints.

Validation results are recorded in the accompanying BUMP_NOTES and ignored logs. Stable-origin production acceptance is pending because no deployment or production Apply is authorized. Historical full-dashboard gallery completeness and historical operator intent remain unverified; neither is inferred from HTTP 200, CDN custody or Featured flags.

## Pending rollout — not executed

1. Review the coupled Admin/Public code artifacts and the scoped behavior above. Preserve concurrent changes; create reviewed release artifacts separately.
2. Confirm the production schema ledger. No additive migration is required; do not reapply 0026.
3. Take a recoverable Commerce D1 backup before any production data Apply, including media/variant/curation references.
4. Deploy reviewed Admin and Public artifacts in a coordinated release. Verify the new routes are Functions JSON responses and the Public relay preserves variant images.
5. Run scoped **Refresh Printful mockups** Preview against current IDs; inspect all previews, thumbnail choices and any legacy overrides. This is not full-catalogue reconciliation and performs no archival or identity remapping.
6. After separate authorization, Apply reviewed media and verify a second Preview is a no-op. Keep all immutable historical objects. New content uses new immutable URLs, not object overwrite or broad cache purge.
7. Separately review **Publish product with eligible variants** for the intended products. After authorization, Apply; verify persisted product/variant flags and the resulting Public subset. Do not change checkout/fulfillment configuration.
8. Expire/refresh affected cached product-detail responses after state/reference changes (existing detail cache: browser 60 seconds, shared 300 seconds, stale window 600 seconds; catalogue is no-store). Verify authenticated stable-origin editor reload, shop, Featured, gallery, variant selection and cart at desktop/tablet/390px. Do not replay the old 50-product seed or original full reconciliation to refresh media.
