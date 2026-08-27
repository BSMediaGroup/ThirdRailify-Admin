# Watch V2 Admin workspace

`/watch` is the authenticated Master Admin visibility workspace for the Public Watch archive. It reads the current broadcast summary and retained archive and presents a compact control-room header, retained/visible/hidden/unfilled/current-signal strip, current signal title/platform/timing, and a dense retained-episode list with stable content identity, public route, date, platform, thumbnail/fallback, and visibility state.

The only mutations are show/hide one retained episode and show/hide all retained episodes. Bulk hide requires confirmation. There is no manual episode creation, provider lookup, URL/ID entry, metadata editing, deletion, scrape, or synthetic archive injection. Empty state is supported; staging fills only as real completed broadcasts arrive through the existing signed Public ingest.

## Request path

1. The authenticated browser sends `POST /api/admin/watch` to the Admin origin with its session cookie and CSRF token.
2. The Admin Function requires a Master Admin session, exact origin, valid CSRF, bounded JSON/action/episode ID, and the existing `watch` rate limit.
3. The Function signs a bodyless `GET /api/watch/manage` for reads and the existing JSON `POST /api/watch/manage` for mutations using the already-configured encrypted `THIRDRAILIFY_COMMUNITY_API_SECRET` and existing HMAC format.
4. Public verifies timestamp, digest, and signature, then invokes the existing `THIRDRAILIFY_PUBLIC_STATE` Durable Object binding.
5. The Durable Object serializes visibility and ingest changes and mutates the distinct SQLite archive record atomically.
6. Successful visibility actions are written through the existing Admin audit path.

The browser never receives the shared secret and cannot call the Durable Object directly. Admin has no Durable Object binding. Public has no commerce D1 or R2 binding. No new secret or Cloudflare resource is required.

Hidden episodes remain retained and consume one of the 24 slots, but Public list/detail/navigation/featured projections omit them. Hidden records have no public route in the Admin projection. A current-snapshot read failure is represented as an absent current signal without discarding the authoritative archive response. The Public gallery represents hidden and unfilled positions as truthful, non-clickable placeholders.

The workspace remains operational rather than promotional: summary cells stay compact, unknown authority values render as em dashes instead of inferred zeros, bulk controls sit directly above the archive list, and per-record actions restore focus after mutation. The bulk-hide dialog retains explicit confirmation and focus restoration. Desktop, tablet, and 390-pixel layouts preserve readable controls without converting the page into a separate data or security architecture.
