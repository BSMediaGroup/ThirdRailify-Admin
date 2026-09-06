# Reviewed catalogue sellability repair (local)

## Worktree and release boundary

Verified `X:\GIT\ThirdRailify-Admin`, branch `main`, initial HEAD `b4f2f50fc2dbf86a0f84489db3ae9720d0652417`; initial `git status --short` was empty. Concurrent heartbeat/Overview edits subsequently appeared and are preserved. No replacement clone, reset, stash, cleanup, commit, staging or push. Other repositories are read-only for this task.

Implemented and exercised locally. Nothing deployed; no production catalogue flags changed; no live store activation; no remote migration, provider write, real transaction, secret, binding or DNS change. Live readiness was not read with an authenticated owner session and is **unverified**. The counts below belong to reproducible synthetic local D1 fixtures, not production or earlier provider snapshots.

## Demonstrated problem and domain rules

The original launch SQL required legacy product/variant `migration_status` values, used permissive prefix GLOBs for provider IDs, and did not check all current-store/publication evidence. Its `NOT(predicate)` aggregate omitted some NULL-valued records. Apply was two unguarded UPDATEs with a later independent audit; Commerce exposed no review/apply control.

`storefrontEligibility` now supplies the narrow stored-state classifier used by publication, readiness/repair, Admin's Public projection and current-provider checkout:

- Current provider presence and exact configured store relationship on both product and variant; no archive; current product reconciliation; actual product mapping; no provider ignored state; usable product image and CAD currency; supported physical Printful fulfillment.
- Exact decimal provider identifiers use the established shipping contract, `^[1-9]\d{0,18}$`. Sync variant and Catalog variant IDs must be present; the variant's mapped product must equal the product's mapped provider ID. CAD prices must be safe integers in the existing 1–100,000,000 range.
- Publication is separate: product/variant active and public plus no explicit `operator_hidden` intent. A deliberately disabled sellability flag recorded as `operator_hidden` stays unavailable, even if status/visibility are public. Reviewed publication still explicitly changes that intent.
- Missing/NULL evidence is classified ineligible by ordinary boolean decisions; every attached variant belongs to either eligible or excluded counts. Repair uses those same server-classified IDs for complementary enable/disable updates. Unknown or unsupported values never qualify.
- Current provider evidence supersedes obsolete migration status for this classification; migration history is never changed. The independent migration-terminal launch gate and legacy controlled-test migration checks remain. Global transaction, provider-connection, merchant, shipping and activation gates remain independent.

An invalid variant remains unavailable after safe cleanup. It does not prevent other valid products launching once the original catalogue consistency condition is satisfied. A catalogue with **zero eligible published variants stays blocked**, with publication/data-correction guidance. Optional shipment notifications and signed-webhook evidence remain advisory.

## Operator workflow and scope

1. In `/commerce`, choose **Review and fix catalogue**. The server reports current-presence product/variant counts, eligible/already-sellable/to-enable counts, unsafe flags to disable, correct exclusions, publication choices and remaining data blockers.
2. Review the scoped counts and diagnostics. Each group is paginated at 20 records with exact reason codes, authorized IDs, readable labels and product/variant editor links. Counts are catalogue-wide unless explicitly labeled as enablement scope.
3. Choose **Apply catalogue fixes**. The existing `commerce.operations.manage`, session, origin and CSRF protections apply. This changes sellability only; it does not publish, refresh mockups, import/reconcile products or activate the store.
4. The UI reloads canonical launch readiness. When all independent hard gates pass, **ENABLE STORE** becomes available. The existing Master Admin review still requires both owner merchant-facts confirmation and transaction-disclosure/activation authorization, current revisions/digest and the exact production-origin check.

Products → **Bulk edit** exposes the same repair for **selected**, **all matching**, or **all current** products. All-current uses stored current product IDs across every result page. Matching reuses the existing Products filter authority and resolves all results server-side.

Enablement stays within the chosen scope. Unsafe sellability cleanup intentionally covers the **entire catalogue**, including archives and records outside the selection. Preview names that scope and counts records outside it before Apply.

Publication is separate: select intended valid products and choose **Publish with eligible variants**, then use the existing protected publication Preview/Apply. Its existing 20-product review bound and fresh provider verification are unchanged. Sellability repair itself performs no provider calls or media work.

CLI dry-run remains available. Executed `catalogue-apply` additionally requires `--expected-digest=<catalogue.review.digest>` from the reviewed dry-run. It does not silently substitute a newly fetched digest. CLI activation remains disallowed in favor of the owner UI.

## Concurrency, audit and unchanged state

The review digest binds stored catalogue/provider/filter evidence, configured store and scope. Apply recomputes the review and rejects stale state with `catalogue_refresh_required` (409). A guard inside the existing D1 batch checks the fingerprint again before either update. Audit is in that same batch. D1 rolls the entire sequence back when a statement fails: [official batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Only changed flags get `updated_at` changes. Product records, identities, titles/slugs/descriptions, prices/currencies, images, Featured preference/order, categories/collections, publication intent, shipping, tax, merchant facts, payment/fulfillment settings, donations and orders remain untouched. Exact replay against the completed state returns an idempotent no-op without another audit; a changed catalogue still requires a fresh review. No migration or job framework was added.

## Reproducible fixture result

The fixture contains 25 products marked current plus one archived/provider-missing product; 26 variants total. One published variant is already sellable, one product is deliberately private, and five current variants have actual data exclusions: missing Catalog mapping, wrong store, fractional minor-unit price, NULL store evidence, malformed Sync Variant ID. Archived sellability is also stale. Valid records retain their older migration statuses.

| Measure | Before | After repair |
| --- | ---: | ---: |
| Current-presence products / variants | 25 / 25 | 25 / 25 |
| Eligible published variants | 19 | 19 |
| Eligible sellable variants | 1 | 19 |
| Eligible flags needing enablement | 18 | 0 |
| Unsafe sellable flags | 4 | 0 |
| Correctly unavailable exclusions | 3 | 7 |
| Deliberately unpublished products | 1 | 1 |
| Current variants with data blockers | 5 | 5 |

One Apply enables 18 and disables four. The archived disable is explicitly outside the all-current enablement scope. A record beyond the first 20-result page is persisted sellable. The five invalid variants, one private product's variant and one archive remain unavailable. Fix those data issues only if the owner intends those records for sale.

Local browser acceptance at 1440, 768 and 390px used real authenticated Admin handlers and ephemeral D1, with the handler receiving the exact production origin locally. It demonstrated blocked readiness → reviewed repair → persisted reload → catalogue ready → ENABLE STORE usable → both required confirmations → local activation/readback. Public projection contains exactly the 19 eligible products; checkout rejects all seven exclusions; no order is created. External browser requests are blocked and the commerce provider-call hook throws if invoked. Production-origin checks were not weakened.

## Trigger Studio presentation

The mismatch was caused by undefined `--panel-bg`/`--border-color` variables falling back to cool blue-grey colors, plus hardcoded cards/inputs. The section now follows the dashboard's warm dark/gold palette, actual font families, bordered metrics, matching editor/rule surfaces and responsive spacing. Runtime reporting has a readable status and separate telemetry. Failed rule loading shows a recoverable error, disables creation without usable rule data, and no longer claims loading or an empty activity history. Existing automation actions and authority are unchanged.

The local-D1 Trigger Studio harness covers CRUD, dry-run, persisted reload, schema-error recovery, Wheel integration, reduced motion and 1920/1440/768/390px geometry. Screenshots are under `.artifacts/event-automations/`; catalogue/activation screenshots and validation logs are under `.artifacts/catalogue-repair/`.

## Validation record

All commands used repository-pinned Node 22.16.0 and serial test execution:

| Command / focused suite | Observed result |
| --- | --- |
| `npm.cmd run test:authorization` | 16/16 passed |
| `npm.cmd run test:commerce-launch` | 3/3 passed |
| `node --test --test-concurrency=1 tests/catalogue-sellability.test.mjs tests/current-product-repair.test.mjs` | 6/6 passed; real handlers/D1, publication, guards, replay, NULL evidence and capability denial |
| `tests/product-merchandising.test.mjs` | 11 passed initially; the remaining fixture used a nonnumeric synthetic Sync Variant ID. Updated that intended-valid fixture to the actual numeric contract; its isolated retest passed |
| `tests/store-activation-agreements.test.mjs` | Eight tests passed in the grouped run; three encountered Miniflare `fetch failed` (including startup). Those three passed in the focused isolated rerun. The original grouped process remained open after reporting tests and was stopped; no repeated full suite run |
| Focused server rerun (`real protected`, `stale reviews`, `current Hidden`, `merchant shipping`, `safe unconventional`, `general browser projections`) | 6/6 passed |
| Final browser command below | 7/7 passed, including the three catalogue viewport subtests |
| `npm.cmd run lint` | Passed, zero errors; seven existing warnings, mostly ignored-release artifact copies |
| `npm.cmd run typecheck` and `npm.cmd run build` | Passed; existing Vite large-chunk advisory |
| `wrangler pages functions build functions --outfile .artifacts/catalogue-repair/functions-worker.js` | Compiled successfully with pinned Wrangler 4.60.0 |
| `npm.cmd run commerce:worker:build` | Successful local `--dry-run`; no upload/deployment |
| `git diff --check` | Passed |

Final browser command:

```powershell
node --test --test-concurrency=1 --test-name-pattern='catalogue review|operational Trigger|rapid Featured|Featured 409' tests/catalogue-sellability-browser.test.mjs tests/event-automations-browser.test.mjs tests/commerce-browser.test.mjs
```

The browser run verifies catalogue repair/owner activation at 1440/768/390, Trigger Studio at 1920/1440/768/390, rapid Featured request counts and recovery from 409/429/500/network failures. The synthetic catalogue's missing mapping, NULL provider-store evidence, wrong store, malformed ID and fractional minor-unit price stay excluded. Schema constraints themselves reject missing/zero stored prices; the fractional fixture additionally exercises the integer-only domain requirement without weakening the schema.

The README inventory and BUMP_NOTES were appended under existing current/pending `0.1.0-alpha.0`. No files removed and no migration created or edited. The existing fixture-backed mockup exercise's publication button locator was updated to the new explicit label; the captured-provider exercise itself was not rerun.

## Production steps still required

Separately authorize an Admin release after reviewing the local changes and existing deployment/schema state. This task introduces no migration. On the deployed Admin, the owner must read the live canonical plan, explicitly review/apply the desired catalogue scope, correct or separately publish intended excluded records, and recheck independent gates. Only then may Master Admin complete the existing final ENABLE STORE review. The screenshot's live Trigger Studio schema incompatibility is not repaired by CSS and still needs separately authorized schema/deployment investigation; no remote migration was attempted here.
