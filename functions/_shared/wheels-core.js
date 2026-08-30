import {
  AuthFailure,
  accessForAccount,
  cleanText,
  hmacSha256,
  loadAccountById,
  nowIso,
  randomId,
  serializeAccount,
  timingSafeEqual,
} from "./auth-core.js";
import { mediaForWheel, retireSegmentMediaAssets, validateSegmentMediaReferences } from "./wheel-media.js";

const MAX_ENTRIES = 1000;
const MAX_BODY_BYTES = 384 * 1024;
const HEX = /^#[0-9a-f]{6}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])$/;
const ROLES = new Set(["owner", "editor", "spinner"]);
const PRESETS = new Set(["third-rail-gold", "live-wire-red", "gina-violet", "high-voltage-mono", "signal-teal", "after-hours", "high-voltage-hazard", "rail-strike", "goated-circuit", "night-signal", "custom"]);
const CELEBRATIONS = new Set(["subtle", "normal", "strong"]);
const PATTERNS = new Set(["diagonal-stripes", "reverse-stripes", "zigzag", "dots", "checkers", "triangles", "chevrons", "waves", "third-rail-bolts"]);
const SPIN_SOUNDS = new Set(["classic-tick", "relay-click", "arc-pulse", "mechanical-ratchet", "soft-tick", "silent"]);
const WINNER_SOUNDS = new Set(["gold-rise", "broadcast-hit", "voltage-chime", "crimson-impact", "synth-fanfare", "short-burst", "silent"]);
const DEFAULT_CONFIG = Object.freeze({
  themePreset: "third-rail-gold",
  palette: ["#f3c928", "#b8182f", "#f3f0e5", "#5b2c83"],
  paletteStyles: ["#f3c928", "#b8182f", "#f3f0e5", "#5b2c83"].map((color) => ({ mode: "solid", color })),
  pointerAccent: "#f3c928",
  centreTreatment: "bolt",
  backgroundIntensity: "high",
  labelContrast: "light",
  spinDurationMs: 6500,
  tickingSoundEnabled: true,
  spinSoundPreset: "classic-tick",
  winnerSoundEnabled: true,
  winnerSoundPreset: "gold-rise",
  celebrationEnabled: true,
  confettiEnabled: true,
  fireworksEnabled: true,
  winnerLightingEnabled: true,
  celebrationIntensity: "normal",
  backgroundEnabled: true,
  backgroundFocalX: 50,
  backgroundFocalY: 50,
  backgroundImageOpacity: 72,
  backgroundOverlayIntensity: 58,
  winnerMessageTemplate: "Signal locked: {winner}",
  publicHistoryVisible: true,
});

export function requireWheelDb(env) {
  const db = env?.THIRDRAILIFY_COMMERCE_DB;
  if (!db || typeof db.prepare !== "function") throw new AuthFailure(503, "wheels_database_not_configured", "Wheel authority is not configured.");
  return db;
}

export async function readWheelJson(request, maxBytes = MAX_BODY_BYTES) {
  if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    throw new AuthFailure(415, "content_type_invalid", "A JSON request body is required.");
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new AuthFailure(413, "request_too_large", "The wheel request is too large.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new AuthFailure(413, "request_too_large", "The wheel request is too large.");
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return { body: value, raw };
  } catch {
    throw new AuthFailure(400, "invalid_json", "The wheel request body is invalid.");
  }
}

export async function verifyWheelInternalRequest(request, env, rawBody) {
  const secret = String(env?.THIRDRAILIFY_COMMUNITY_API_SECRET || "");
  const timestamp = String(request.headers.get("x-thirdrailify-timestamp") || "");
  const signature = String(request.headers.get("x-thirdrailify-signature") || "");
  if (!secret || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new AuthFailure(401, "internal_signature_invalid", "The internal wheel request could not be verified.");
  }
  const bytes = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : new Uint8Array(rawBody || []);
  const digest = await digestHex(bytes);
  const pathname = new URL(request.url).pathname;
  const expected = await hmacSha256(secret, `${timestamp}\n${request.method}\n${pathname}\n${digest}`);
  if (!timingSafeEqual(expected, signature)) throw new AuthFailure(401, "internal_signature_invalid", "The internal wheel request could not be verified.");
}

export async function listPublicWheels(env, input = {}) {
  const db = requireWheelDb(env);
  const search = clean(input.search, 80).toLowerCase();
  const sort = new Set(["recent", "title", "participants"]).has(input.sort) ? input.sort : "recent";
  const order = sort === "title" ? "title COLLATE NOCASE ASC, id ASC" : sort === "participants" ? "participant_count DESC, title COLLATE NOCASE ASC" : "display_order ASC, updated_at DESC";
  const rows = await db.prepare(
    `SELECT id, public_slug, title, description, owner_account_id, config_json, participant_count, public_demo_spin_enabled,
            official_spin_enabled, latest_official_spin_at, updated_at, display_order,
            EXISTS (SELECT 1 FROM wheel_entries e WHERE e.wheel_id = wheels.id AND e.state = 'active' AND e.weight != 1) AS is_weighted
     FROM wheels
     WHERE lifecycle = 'active' AND visibility = 'public' AND (? = '' OR lower(title) LIKE ? OR lower(COALESCE(description, '')) LIKE ?)
     ORDER BY ${order} LIMIT 100`,
  ).bind(search, `%${escapeLike(search)}%`, `%${escapeLike(search)}%`).all();
  return { ok: true, items: await Promise.all((rows?.results || []).map(async (row) => ({ ...publicSummary(row), owner: await publicWheelOwner(env, row.owner_account_id) }))), count: (rows?.results || []).length };
}

export async function getPublicWheel(env, slug, accountId = "") {
  const wheel = await wheelBySlug(env, slug);
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  const access = accountId ? await resolveWheelAccess(env, accountId, wheel) : emptyAccess();
  const publicVisible = wheel.lifecycle === "active" && wheel.visibility === "public";
  if (!publicVisible && !access.canViewPrivate) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  const [entries, history, media, owner] = await Promise.all([
    entriesForWheel(env, wheel.id, access.canEdit),
    publicHistory(env, wheel, 10),
    mediaForWheel(env, wheel.id, { public: publicVisible }),
    publicWheelOwner(env, wheel.owner_account_id),
  ]);
  return { ok: true, wheel: publicDetail(wheel, entries, history, access, media, owner), access: accessProjection(access, wheel) };
}

export async function getCreatorAccess(env, accountId) {
  const account = await activeAccount(env, accountId);
  if (!account) return { ok: true, authenticated: false, canCreate: false, isMasterAdmin: false };
  const master = accessForAccount(account).isMasterAdmin;
  const db = requireWheelDb(env);
  const [grant, wheelCount, stageCount] = await Promise.all([
    db.prepare("SELECT active, may_create_wheels, maximum_owned_wheels FROM wheel_creator_grants WHERE account_id = ?").bind(accountId).first(),
    db.prepare("SELECT COUNT(*) AS count FROM wheels WHERE owner_account_id = ? AND lifecycle != 'archived'").bind(accountId).first(),
    db.prepare("SELECT COUNT(*) AS count FROM wheel_stages WHERE owner_account_id = ? AND lifecycle != 'archived'").bind(accountId).first(),
  ]);
  return { ok: true, authenticated: true, canCreate: master || Boolean(grant?.active && grant?.may_create_wheels), isMasterAdmin: master, maximumOwnedWheels: master ? 100 : Number(grant?.maximum_owned_wheels || 20), ownedWheelCount: Number(wheelCount?.count || 0), maximumOwnedStages: master ? 100 : 20, ownedStageCount: Number(stageCount?.count || 0) };
}

export async function getWheelAccess(env, accountId, slug) {
  const wheel = await wheelBySlug(env, slug);
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  const access = await resolveWheelAccess(env, accountId, wheel);
  if ((wheel.visibility !== "public" || wheel.lifecycle !== "active") && !access.canViewPrivate) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  return { ok: true, access: accessProjection(access, wheel) };
}

export async function createWheel(env, accountId, input) {
  const creator = await requireCreator(env, accountId);
  await enforceWheelRateLimit(env, "create", accountId, 10, 3600);
  const db = requireWheelDb(env);
  const owned = Number((await db.prepare("SELECT COUNT(*) AS count FROM wheels WHERE owner_account_id = ? AND lifecycle != 'archived'").bind(accountId).first())?.count || 0);
  if (owned >= creator.maximumOwnedWheels) throw new AuthFailure(409, "wheel_limit_reached", "This creator has reached the active wheel limit.");
  const title = requiredText(input.title, 1, 100, "wheel_title_invalid");
  const slug = await uniqueSlug(db, input.slug || title);
  const description = optionalText(input.description, 280);
  const visibility = input.visibility === "hidden" ? "hidden" : "public";
  const lifecycle = input.lifecycle === "draft" ? "draft" : "active";
  const config = validateConfig(input.config || {});
  const entries = validateEntries(input.entries || [], { newIds: true });
  if (segmentAssetIds(config, entries).length) throw new AuthFailure(400, "wheel_segment_media_invalid", "Create the wheel before assigning wheel-owned segment images.");
  const id = randomId(); const timestamp = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO wheels (
      id, reference_code, public_slug, title, description, lifecycle, visibility, owner_account_id,
      display_order, revision, spin_sequence, official_spin_enabled, public_demo_spin_enabled,
      editing_locked, official_spinning_locked, config_json, participant_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 1, 1, 0, 0, ?, ?, ?, ?)`).bind(
      id, `WHL-${id.slice(0, 8).toUpperCase()}`, slug, title, description, lifecycle, visibility, accountId,
      JSON.stringify(config), entries.length, timestamp, timestamp,
    ),
    db.prepare("INSERT INTO wheel_access (wheel_id, account_id, role, active, granted_by_account_id, created_at, updated_at) VALUES (?, ?, 'owner', 1, ?, ?, ?)").bind(id, accountId, accountId, timestamp, timestamp),
    ...entries.map((entry, index) => entryInsert(db, id, entry, index, timestamp)),
    auditStatement(db, id, accountId, null, "wheel_created", { slug, visibility, lifecycle, participantCount: entries.length }, timestamp),
  ]);
  return getPublicWheel(env, slug, accountId);
}

export async function saveWheel(env, accountId, slug, input) {
  await enforceWheelRateLimit(env, "save", accountId, 60, 3600);
  const db = requireWheelDb(env); const wheel = await wheelBySlug(env, slug);
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  const access = await resolveWheelAccess(env, accountId, wheel);
  if (!access.canEdit) throw new AuthFailure(403, "wheel_edit_forbidden", "Editor access is required.");
  if (wheel.editing_locked && !access.isMasterAdmin) throw new AuthFailure(423, "wheel_edit_locked", "Wheel editing is locked by Admin.");
  const expectedRevision = positiveInteger(input.revision, "wheel_revision_invalid", 2_147_483_647);
  if (expectedRevision !== Number(wheel.revision)) throw new AuthFailure(409, "wheel_revision_conflict", "The wheel changed. Reload it before saving.");
  const title = requiredText(input.title, 1, 100, "wheel_title_invalid");
  const description = optionalText(input.description, 280);
  const config = validateConfig(input.config || {});
  const requestedEntries = validateEntries(input.entries || []);
  const referencedSegmentAssets = segmentAssetIds(config, requestedEntries);
  await validateSegmentMediaReferences(env, wheel.id, referencedSegmentAssets);
  const previousEntries = await entriesForWheel(env, wheel.id, true); const previousSegmentAssets = segmentAssetIds(validateConfig(parseJson(wheel.config_json, DEFAULT_CONFIG)), previousEntries);
  const currentEntryRows = await db.prepare("SELECT id FROM wheel_entries WHERE wheel_id = ?").bind(wheel.id).all();
  const currentEntryIds = new Set((currentEntryRows?.results || []).map((row) => row.id));
  const usedEntryIds = new Set();
  const entries = requestedEntries.map((entry) => {
    const id = currentEntryIds.has(entry.id) && !usedEntryIds.has(entry.id) ? entry.id : randomId();
    usedEntryIds.add(id);
    return { ...entry, id };
  });
  const visibility = input.visibility === "hidden" ? "hidden" : "public";
  const timestamp = nowIso();
  const savedRevision = expectedRevision + 1;
  const result = await db.batch([
    db.prepare(`UPDATE wheels SET title = ?, description = ?, visibility = ?, config_json = ?, participant_count = ?, revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`).bind(title, description, visibility, JSON.stringify(config), entries.length, timestamp, wheel.id, expectedRevision),
    db.prepare("DELETE FROM wheel_entries WHERE wheel_id = ? AND EXISTS (SELECT 1 FROM wheels WHERE id = ? AND revision = ? AND updated_at = ?)").bind(wheel.id, wheel.id, savedRevision, timestamp),
    ...entries.map((entry, index) => entryInsertConditional(db, wheel.id, entry, index, timestamp, savedRevision)),
    db.prepare(`INSERT INTO wheel_audit_events (id, wheel_id, actor_account_id, target_account_id, event_type, metadata_json, created_at)
      SELECT ?, id, ?, NULL, 'wheel_saved', ?, ? FROM wheels WHERE id = ? AND revision = ? AND updated_at = ?`).bind(
      randomId(), accountId, JSON.stringify({ previousRevision: expectedRevision, participantCount: entries.length }), timestamp,
      wheel.id, savedRevision, timestamp,
    ),
  ]);
  if (Number(result?.[0]?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "wheel_revision_conflict", "The wheel changed. Reload it before saving.");
  await retireSegmentMediaAssets(env, wheel, previousSegmentAssets.filter((id) => !referencedSegmentAssets.includes(id)), accountId);
  return getPublicWheel(env, slug, accountId);
}

export async function changeWheelLifecycle(env, accountId, slug, input) {
  const db = requireWheelDb(env); const wheel = await wheelBySlug(env, slug);
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  const access = await resolveWheelAccess(env, accountId, wheel);
  if (!access.canEdit) throw new AuthFailure(403, "wheel_edit_forbidden", "Owner or editor access is required.");
  const action = String(input.action || "");
  if (!new Set(["archive", "restore", "publish", "hide"]).has(action)) throw new AuthFailure(400, "wheel_lifecycle_invalid", "The wheel lifecycle action is invalid.");
  if (wheel.editing_locked && !access.isMasterAdmin) throw new AuthFailure(423, "wheel_edit_locked", "Wheel editing is locked by Admin.");
  if (action === "restore" && !access.isMasterAdmin) throw new AuthFailure(403, "master_admin_required", "Admin must restore archived wheels.");
  const lifecycle = action === "archive" ? "archived" : action === "restore" || action === "publish" ? "active" : wheel.lifecycle;
  const visibility = action === "hide" ? "hidden" : wheel.visibility;
  const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE wheels SET lifecycle = ?, visibility = ?, revision = revision + 1, archived_at = ?, updated_at = ? WHERE id = ?").bind(lifecycle, visibility, lifecycle === "archived" ? timestamp : null, timestamp, wheel.id),
    auditStatement(db, wheel.id, accountId, null, `wheel_${action}`, {}, timestamp),
  ]);
  return getPublicWheel(env, slug, accountId);
}

export async function performOfficialSpin(env, accountId, slug, input) {
  await enforceWheelRateLimit(env, "official_spin", accountId, 30, 60);
  const db = requireWheelDb(env); const wheel = await wheelBySlug(env, slug);
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  const access = await resolveWheelAccess(env, accountId, wheel);
  if (!access.canSpinOfficially) throw new AuthFailure(403, "official_spin_forbidden", "Official spinner access is required.");
  if (wheel.lifecycle !== "active") throw new AuthFailure(409, "wheel_archived", "Archived or draft wheels cannot record official draws.");
  if (!wheel.official_spin_enabled || wheel.official_spinning_locked) throw new AuthFailure(423, "official_spin_locked", "Official drawing is locked.");
  const expectedRevision = positiveInteger(input.revision, "wheel_revision_invalid", 2_147_483_647);
  const idempotencyKey = requiredText(input.idempotencyKey, 16, 120, "idempotency_key_invalid");
  if (Object.hasOwn(input, "winner") || Object.hasOwn(input, "winningEntryId")) throw new AuthFailure(400, "client_winner_forbidden", "Official winners are selected only by the server.");
  const existing = await db.prepare("SELECT * FROM wheel_official_spins WHERE wheel_id = ? AND idempotency_key = ?").bind(wheel.id, idempotencyKey).first();
  if (existing) return { ok: true, spin: await officialSpinProjection(existing), idempotent: true };
  await requireOfficialCooldown(env, wheel);
  if (expectedRevision !== Number(wheel.revision)) throw new AuthFailure(409, "wheel_revision_conflict", "The wheel changed. Reload it before drawing.");
  const entries = (await entriesForWheel(env, wheel.id, false)).filter((entry) => entry.state === "active");
  if (entries.length < 2) throw new AuthFailure(409, "participants_insufficient", "At least two active participants are required for an official draw.");
  const totalWeight = entries.reduce((total, entry) => total + entry.weight, 0);
  const draw = secureBoundedInteger(totalWeight);
  let cursor = draw; let winner = entries[entries.length - 1];
  for (const entry of entries) { if (cursor < entry.weight) { winner = entry; break; } cursor -= entry.weight; }
  const snapshotHash = await participantSnapshotHash(entries);
  const spinId = randomId(); const timestamp = nowIso(); const sequence = Number(wheel.spin_sequence || 0);
  let result;
  try {
    result = await db.batch([
      db.prepare(`INSERT INTO wheel_official_spins (
        id, wheel_id, wheel_revision, participant_snapshot_hash, winning_entry_id, winning_label_snapshot,
        winning_weight_snapshot, performed_by_account_id, result_type, idempotency_key, created_at
      ) SELECT ?, id, revision, ?, ?, ?, ?, ?, 'official', ?, ? FROM wheels
        WHERE id = ? AND revision = ? AND spin_sequence = ? AND lifecycle = 'active'
          AND official_spin_enabled = 1 AND official_spinning_locked = 0`).bind(
        spinId, snapshotHash, winner.id, winner.label, winner.weight, accountId, idempotencyKey, timestamp,
        wheel.id, expectedRevision, sequence,
      ),
      db.prepare("UPDATE wheels SET spin_sequence = spin_sequence + 1, latest_official_spin_at = ?, updated_at = ? WHERE id = ? AND revision = ? AND spin_sequence = ?").bind(timestamp, timestamp, wheel.id, expectedRevision, sequence),
      db.prepare("INSERT INTO wheel_audit_events (id, wheel_id, actor_account_id, event_type, metadata_json, created_at) SELECT ?, wheel_id, ?, 'official_spin_recorded', ?, ? FROM wheel_official_spins WHERE id = ?").bind(randomId(), accountId, JSON.stringify({ spinId, wheelRevision: expectedRevision, snapshotHash }), timestamp, spinId),
    ]);
  } catch (error) {
    const repeated = await db.prepare("SELECT * FROM wheel_official_spins WHERE wheel_id = ? AND idempotency_key = ?").bind(wheel.id, idempotencyKey).first();
    if (repeated) return { ok: true, spin: await officialSpinProjection(repeated), idempotent: true };
    throw error;
  }
  if (Number(result?.[0]?.meta?.changes || 0) !== 1) {
    const repeated = await db.prepare("SELECT * FROM wheel_official_spins WHERE wheel_id = ? AND idempotency_key = ?").bind(wheel.id, idempotencyKey).first();
    if (repeated) return { ok: true, spin: await officialSpinProjection(repeated), idempotent: true };
    throw new AuthFailure(409, "official_spin_conflict", "The wheel changed or another official draw started. Reload before drawing again.");
  }
  return { ok: true, spin: await officialSpinProjection({ id: spinId, wheel_id: wheel.id, wheel_revision: expectedRevision, participant_snapshot_hash: snapshotHash, winning_entry_id: winner.id, winning_label_snapshot: winner.label, winning_weight_snapshot: winner.weight, created_at: timestamp }), idempotent: false };
}

export async function applyWinnerAction(env, accountId, slug, input) {
  await enforceWheelRateLimit(env, "winner_action", accountId, 60, 3600);
  const db = requireWheelDb(env); const wheel = await wheelBySlug(env, slug);
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  const access = await resolveWheelAccess(env, accountId, wheel);
  if (!access.canEdit) throw new AuthFailure(403, "wheel_edit_forbidden", "Editor access is required.");
  if (wheel.editing_locked && !access.isMasterAdmin) throw new AuthFailure(423, "wheel_edit_locked", "Wheel editing is locked by Admin.");
  const action = String(input.action || ""); const entryId = requiredText(input.entryId, 1, 80, "entry_id_invalid");
  if (!new Set(["keep", "hide", "remove", "remove-matching"]).has(action)) throw new AuthFailure(400, "winner_action_invalid", "The winner action is invalid.");
  const entry = await db.prepare("SELECT * FROM wheel_entries WHERE wheel_id = ? AND id = ?").bind(wheel.id, entryId).first();
  if (!entry) throw new AuthFailure(404, "entry_not_found", "The participant entry was not found.");
  if (action === "keep") return getPublicWheel(env, slug, accountId);
  const timestamp = nowIso();
  const mutation = action === "hide"
    ? db.prepare("UPDATE wheel_entries SET state = 'hidden', updated_at = ? WHERE wheel_id = ? AND id = ?").bind(timestamp, wheel.id, entryId)
    : action === "remove-matching"
      ? db.prepare("DELETE FROM wheel_entries WHERE wheel_id = ? AND display_label = ?").bind(wheel.id, entry.display_label)
      : db.prepare("DELETE FROM wheel_entries WHERE wheel_id = ? AND id = ?").bind(wheel.id, entryId);
  await db.batch([
    mutation,
    db.prepare("UPDATE wheels SET participant_count = (SELECT COUNT(*) FROM wheel_entries WHERE wheel_id = ?), revision = revision + 1, updated_at = ? WHERE id = ?").bind(wheel.id, timestamp, wheel.id),
    auditStatement(db, wheel.id, accountId, null, `winner_${action.replace("-", "_")}`, { entryId, label: entry.display_label }, timestamp),
  ]);
  return getPublicWheel(env, slug, accountId);
}

export async function adminWheelLibrary(env) {
  const db = requireWheelDb(env);
  const rows = await db.prepare(`SELECT w.*,
    (SELECT winning_label_snapshot FROM wheel_official_spins s WHERE s.wheel_id = w.id ORDER BY s.created_at DESC LIMIT 1) AS latest_winner,
    (SELECT created_at FROM wheel_official_spins s WHERE s.wheel_id = w.id ORDER BY s.created_at DESC LIMIT 1) AS latest_result_at
    FROM wheels w ORDER BY w.updated_at DESC, w.id`).all();
  return { ok: true, items: await Promise.all((rows?.results || []).map((row) => adminWheelSummary(env, row))) };
}

export async function adminWheelDetail(env, id) {
  const row = await requireWheelDb(env).prepare("SELECT * FROM wheels WHERE id = ?").bind(clean(id, 80)).first();
  if (!row) throw new AuthFailure(404, "wheel_not_found", "The wheel was not found.");
  const [entries, access, results] = await Promise.all([entriesForWheel(env, row.id, true), wheelAccessRows(env, row.id), resultRows(env, row.id, 100)]);
  return { ok: true, item: { ...(await adminWheelSummary(env, row)), config: validateConfig(parseJson(row.config_json, DEFAULT_CONFIG)), entries, access, results: results.map(adminResultProjection), media: await mediaForWheel(env, row.id, { includeDeleted: true }) } };
}

export async function adminWheelAccess(env) {
  const db = requireWheelDb(env);
  const [grants, assignments] = await Promise.all([
    db.prepare("SELECT * FROM wheel_creator_grants ORDER BY active DESC, updated_at DESC").all(),
    db.prepare("SELECT a.*, w.title AS wheel_title, w.public_slug FROM wheel_access a JOIN wheels w ON w.id = a.wheel_id ORDER BY a.active DESC, a.updated_at DESC").all(),
  ]);
  return {
    ok: true,
    grants: await Promise.all((grants?.results || []).map(async (row) => ({ account: await accountSummary(env, row.account_id), active: Boolean(row.active), mayCreate: Boolean(row.may_create_wheels), maximumOwnedWheels: row.maximum_owned_wheels, updatedAt: row.updated_at }))),
    assignments: await Promise.all((assignments?.results || []).map(async (row) => ({ wheelId: row.wheel_id, wheelTitle: row.wheel_title, wheelSlug: row.public_slug, account: await accountSummary(env, row.account_id), role: row.role, active: Boolean(row.active), updatedAt: row.updated_at }))),
  };
}

export async function adminWheelResults(env, input = {}) {
  const db = requireWheelDb(env); const search = clean(input.search, 100).toLowerCase();
  const rows = await db.prepare(`SELECT s.*, w.title AS wheel_title, w.public_slug
    FROM wheel_official_spins s JOIN wheels w ON w.id = s.wheel_id
    WHERE (? = '' OR lower(w.title) LIKE ? OR lower(s.winning_label_snapshot) LIKE ? OR lower(s.performed_by_account_id) LIKE ?)
    ORDER BY s.created_at DESC LIMIT 500`).bind(search, `%${escapeLike(search)}%`, `%${escapeLike(search)}%`, `%${escapeLike(search)}%`).all();
  return { ok: true, items: await Promise.all((rows?.results || []).map(async (row) => ({ ...adminResultProjection(row), wheelTitle: row.wheel_title, wheelSlug: row.public_slug, performer: await accountSummary(env, row.performed_by_account_id), voidedBy: row.voided_by_account_id ? await accountSummary(env, row.voided_by_account_id) : null }))) };
}

export async function searchWheelAccounts(env, query = "") {
  const search = clean(query, 100).toLowerCase();
  const rows = await env.THIRDRAILIFY_AUTH_DB.prepare(`SELECT * FROM accounts WHERE status = 'active' AND (? = '' OR lower(display_name) LIKE ? OR lower(COALESCE(email_normalized, '')) LIKE ?) ORDER BY display_name COLLATE NOCASE LIMIT 50`).bind(search, `%${escapeLike(search)}%`, `%${escapeLike(search)}%`).all();
  return { ok: true, accounts: await Promise.all((rows?.results || []).map((row) => serializeAccount(env, row))) };
}

export async function mutateCreatorGrant(env, actorId, input) {
  await enforceWheelRateLimit(env, "admin_grant", actorId, 60, 3600);
  const db = requireWheelDb(env); const accountId = requiredText(input.accountId, 1, 160, "account_id_invalid");
  if (!await activeAccount(env, accountId)) throw new AuthFailure(404, "account_not_found", "The account was not found or is inactive.");
  const action = input.action === "revoke" ? "revoke" : "approve"; const timestamp = nowIso();
  const maximum = input.maximumOwnedWheels == null ? null : positiveInteger(input.maximumOwnedWheels, "wheel_limit_invalid", 100);
  await db.batch([
    db.prepare(`INSERT INTO wheel_creator_grants (account_id, active, may_create_wheels, maximum_owned_wheels, granted_by_account_id, created_at, updated_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET active = excluded.active, may_create_wheels = excluded.may_create_wheels,
      maximum_owned_wheels = excluded.maximum_owned_wheels, granted_by_account_id = excluded.granted_by_account_id,
      updated_at = excluded.updated_at, revoked_at = excluded.revoked_at`).bind(accountId, action === "approve" ? 1 : 0, action === "approve" && input.mayCreate !== false ? 1 : 0, maximum, actorId, timestamp, timestamp, action === "revoke" ? timestamp : null),
    auditStatement(db, null, actorId, accountId, action === "approve" ? "creator_grant_approved" : "creator_grant_revoked", { mayCreate: input.mayCreate !== false, maximum }, timestamp),
  ]);
  return adminWheelAccess(env);
}

export async function mutateWheelAssignment(env, actorId, input) {
  await enforceWheelRateLimit(env, "admin_assignment", actorId, 120, 3600);
  const db = requireWheelDb(env); const wheelId = requiredText(input.wheelId, 1, 80, "wheel_id_invalid"); const accountId = requiredText(input.accountId, 1, 160, "account_id_invalid");
  const wheel = await db.prepare("SELECT * FROM wheels WHERE id = ?").bind(wheelId).first();
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "The wheel was not found.");
  if (!await activeAccount(env, accountId)) throw new AuthFailure(404, "account_not_found", "The account was not found or is inactive.");
  const action = input.action === "revoke" ? "revoke" : "assign"; const role = ROLES.has(input.role) ? input.role : "spinner"; const timestamp = nowIso();
  if (role === "owner" && action === "assign") {
    await db.batch([
      db.prepare("UPDATE wheel_access SET role = 'editor', updated_at = ? WHERE wheel_id = ? AND role = 'owner'").bind(timestamp, wheelId),
      db.prepare("UPDATE wheels SET owner_account_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(accountId, timestamp, wheelId),
      assignmentUpsert(db, wheelId, accountId, "owner", 1, actorId, timestamp),
      auditStatement(db, wheelId, actorId, accountId, "wheel_owner_transferred", { previousOwner: wheel.owner_account_id }, timestamp),
    ]);
  } else {
    if (action === "revoke" && accountId === wheel.owner_account_id) throw new AuthFailure(409, "owner_assignment_required", "Transfer ownership before revoking the owner.");
    await db.batch([
      assignmentUpsert(db, wheelId, accountId, role, action === "assign" ? 1 : 0, actorId, timestamp),
      auditStatement(db, wheelId, actorId, accountId, action === "assign" ? "wheel_access_assigned" : "wheel_access_revoked", { role }, timestamp),
    ]);
  }
  return adminWheelAccess(env);
}

export async function mutateWheelControl(env, actorId, input) {
  await enforceWheelRateLimit(env, "admin_control", actorId, 120, 3600);
  const db = requireWheelDb(env); const wheelId = requiredText(input.wheelId, 1, 80, "wheel_id_invalid"); const action = String(input.action || "");
  const allowed = new Set(["hide", "show", "lock-edit", "unlock-edit", "lock-spin", "unlock-spin", "archive", "restore", "delete"]);
  if (!allowed.has(action)) throw new AuthFailure(400, "wheel_control_invalid", "The wheel control action is invalid.");
  const wheel = await db.prepare("SELECT * FROM wheels WHERE id = ?").bind(wheelId).first(); if (!wheel) throw new AuthFailure(404, "wheel_not_found", "The wheel was not found.");
  if (action === "delete") {
    const spins = Number((await db.prepare("SELECT COUNT(*) AS count FROM wheel_official_spins WHERE wheel_id = ?").bind(wheelId).first())?.count || 0);
    if (spins) throw new AuthFailure(409, "wheel_delete_history", "A wheel with official history cannot be hard-deleted.");
    await db.batch([auditStatement(db, null, actorId, null, "wheel_hard_deleted", { wheelId, title: wheel.title }, nowIso()), db.prepare("DELETE FROM wheels WHERE id = ?").bind(wheelId)]);
    return adminWheelLibrary(env);
  }
  const values = {
    visibility: action === "hide" ? "hidden" : action === "show" ? "public" : wheel.visibility,
    edit: action === "lock-edit" ? 1 : action === "unlock-edit" ? 0 : wheel.editing_locked,
    spin: action === "lock-spin" ? 1 : action === "unlock-spin" ? 0 : wheel.official_spinning_locked,
    lifecycle: action === "archive" ? "archived" : action === "restore" ? "active" : wheel.lifecycle,
  };
  const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE wheels SET visibility = ?, editing_locked = ?, official_spinning_locked = ?, lifecycle = ?, archived_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(values.visibility, values.edit, values.spin, values.lifecycle, values.lifecycle === "archived" ? timestamp : null, timestamp, wheelId),
    auditStatement(db, wheelId, actorId, null, `admin_${action.replace("-", "_")}`, {}, timestamp),
  ]);
  return adminWheelLibrary(env);
}

export async function voidOfficialResult(env, actorId, input) {
  await enforceWheelRateLimit(env, "admin_void", actorId, 60, 3600);
  const db = requireWheelDb(env); const spinId = requiredText(input.spinId, 1, 80, "spin_id_invalid"); const reason = requiredText(input.reason, 3, 500, "void_reason_invalid"); const timestamp = nowIso();
  const result = await db.batch([
    db.prepare("UPDATE wheel_official_spins SET voided_at = ?, void_reason = ?, voided_by_account_id = ? WHERE id = ? AND voided_at IS NULL").bind(timestamp, reason, actorId, spinId),
    db.prepare("INSERT INTO wheel_audit_events (id, wheel_id, actor_account_id, event_type, metadata_json, created_at) SELECT ?, wheel_id, ?, 'official_spin_voided', ?, ? FROM wheel_official_spins WHERE id = ? AND voided_at = ? AND voided_by_account_id = ?").bind(randomId(), actorId, JSON.stringify({ spinId, reason }), timestamp, spinId, timestamp, actorId),
  ]);
  if (Number(result?.[0]?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "result_void_unavailable", "The result was not found or is already voided.");
  return adminWheelResults(env);
}

export async function getWheelSettings(env) {
  const row = await requireWheelDb(env).prepare("SELECT value_json, revision, updated_at FROM wheel_settings WHERE setting_key = 'global'").first();
  return { ok: true, settings: parseJson(row?.value_json, {}), revision: Number(row?.revision || 1), updatedAt: row?.updated_at || null };
}

export async function saveWheelSettings(env, actorId, input) {
  await enforceWheelRateLimit(env, "admin_settings", actorId, 30, 3600);
  const revision = positiveInteger(input.revision, "wheel_revision_invalid", 2_147_483_647);
  const settings = {
    defaultTheme: PRESETS.has(input.defaultTheme) ? input.defaultTheme : "third-rail-gold",
    maximumParticipants: positiveInteger(input.maximumParticipants || MAX_ENTRIES, "maximum_participants_invalid", MAX_ENTRIES),
    maximumWheelsPerCreator: positiveInteger(input.maximumWheelsPerCreator || 20, "maximum_wheels_invalid", 100),
    officialSpinCooldownSeconds: positiveInteger(input.officialSpinCooldownSeconds || 2, "cooldown_invalid", 60),
    defaultCelebrationIntensity: CELEBRATIONS.has(input.defaultCelebrationIntensity) ? input.defaultCelebrationIntensity : legacyCelebration(input.defaultCelebrationIntensity),
    defaultPublicHistory: input.defaultPublicHistory !== false,
  };
  const timestamp = nowIso(); const result = await requireWheelDb(env).prepare("UPDATE wheel_settings SET value_json = ?, revision = revision + 1, updated_at = ?, updated_by_account_id = ? WHERE setting_key = 'global' AND revision = ?").bind(JSON.stringify(settings), timestamp, actorId, revision).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "wheel_revision_conflict", "Wheel settings changed. Reload before saving.");
  return getWheelSettings(env);
}

export function secureBoundedInteger(maxExclusive, randomValues = (array) => crypto.getRandomValues(array)) {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0xffffffff) throw new AuthFailure(400, "weight_total_invalid", "The total participant weight is invalid.");
  const range = 0x100000000; const limit = range - (range % maxExclusive); const values = new Uint32Array(1);
  do { randomValues(values); } while (values[0] >= limit);
  return values[0] % maxExclusive;
}

export async function participantSnapshotHash(entries) {
  const canonical = entries
    .filter((entry) => entry.state === "active")
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((entry) => [entry.id, entry.label, entry.order, entry.weight, entry.colour || null]);
  return digestHex(new TextEncoder().encode(JSON.stringify(canonical)));
}

function validateEntries(input, options = {}) {
  if (!Array.isArray(input) || input.length > MAX_ENTRIES) throw new AuthFailure(400, "participants_invalid", `Use between 0 and ${MAX_ENTRIES} participant entries.`);
  return input.map((value, index) => {
    if (!value || typeof value !== "object") throw new AuthFailure(400, "participant_invalid", "A participant entry is invalid.");
    const colour = value.colour == null || value.colour === "" ? null : clean(value.colour, 7);
    if (colour && !HEX.test(colour)) throw new AuthFailure(400, "participant_colour_invalid", "Participant colours must be six-digit hex values.");
    const style = value.style == null ? null : validateSegmentStyle(value.style, colour || DEFAULT_CONFIG.palette[index % DEFAULT_CONFIG.palette.length]);
    return { id: !options.newIds && /^[a-f0-9-]{16,80}$/i.test(String(value.id || "")) ? String(value.id) : randomId(), label: requiredText(value.label, 1, 120, "participant_label_invalid"), order: index, weight: positiveInteger(value.weight ?? 1, "participant_weight_invalid", 100000), colour: style?.color || colour?.toUpperCase() || null, style, state: value.state === "hidden" ? "hidden" : "active" };
  });
}

function validateConfig(input) {
  const rawPalette = Array.isArray(input.palette) ? input.palette : DEFAULT_CONFIG.palette;
  if (rawPalette.length > 12 || rawPalette.some((value) => !HEX.test(clean(value, 7)))) throw new AuthFailure(400, "wheel_palette_invalid", "Palette colours must be six-digit hex values.");
  const palette = rawPalette.map((value) => clean(value, 7).toUpperCase());
  const custom = input.themePreset === "custom";
  if (palette.length < (custom ? 1 : 2) || (custom && palette.length > 5)) throw new AuthFailure(400, "wheel_palette_invalid", custom ? "Custom palettes require between one and five valid colours." : "Choose at least two valid palette colours.");
  const pointer = clean(input.pointerAccent || DEFAULT_CONFIG.pointerAccent, 7);
  if (!HEX.test(pointer)) throw new AuthFailure(400, "wheel_pointer_invalid", "The pointer accent must be a six-digit hex colour.");
  const duration = positiveInteger(input.spinDurationMs || DEFAULT_CONFIG.spinDurationMs, "spin_duration_invalid", 60000);
  if (duration < 2000) throw new AuthFailure(400, "spin_duration_invalid", "Spin duration must be between 2 and 60 seconds.");
  const template = requiredText(input.winnerMessageTemplate || DEFAULT_CONFIG.winnerMessageTemplate, 1, 160, "winner_message_invalid");
  const paletteStyles = input.paletteStyles == null ? palette.map((color) => ({ mode: "solid", color })) : validatePaletteStyles(input.paletteStyles, palette, custom);
  return {
    themePreset: PRESETS.has(input.themePreset) ? input.themePreset : DEFAULT_CONFIG.themePreset,
    palette,
    paletteStyles,
    pointerAccent: pointer.toUpperCase(),
    centreTreatment: input.centreTreatment === "signal" ? "signal" : input.centreTreatment === "ring" ? "ring" : "bolt",
    backgroundIntensity: input.backgroundIntensity === "low" ? "low" : input.backgroundIntensity === "medium" ? "medium" : "high",
    labelContrast: input.labelContrast === "dark" ? "dark" : "light",
    spinDurationMs: duration,
    tickingSoundEnabled: input.tickingSoundEnabled !== false,
    spinSoundPreset: validatePreset(input.spinSoundPreset, SPIN_SOUNDS, "classic-tick", "spin_sound_preset_invalid"),
    winnerSoundEnabled: input.winnerSoundEnabled !== false,
    winnerSoundPreset: validatePreset(input.winnerSoundPreset, WINNER_SOUNDS, "gold-rise", "winner_sound_preset_invalid"),
    celebrationEnabled: input.celebrationEnabled !== false && input.celebrationIntensity !== "off",
    confettiEnabled: input.confettiEnabled !== false,
    fireworksEnabled: input.fireworksEnabled !== false,
    winnerLightingEnabled: input.winnerLightingEnabled !== false,
    celebrationIntensity: CELEBRATIONS.has(input.celebrationIntensity) ? input.celebrationIntensity : legacyCelebration(input.celebrationIntensity),
    backgroundEnabled: input.backgroundEnabled !== false,
    backgroundFocalX: boundedPercent(input.backgroundFocalX, DEFAULT_CONFIG.backgroundFocalX),
    backgroundFocalY: boundedPercent(input.backgroundFocalY, DEFAULT_CONFIG.backgroundFocalY),
    backgroundImageOpacity: boundedPercent(input.backgroundImageOpacity, DEFAULT_CONFIG.backgroundImageOpacity),
    backgroundOverlayIntensity: boundedPercent(input.backgroundOverlayIntensity, DEFAULT_CONFIG.backgroundOverlayIntensity),
    winnerMessageTemplate: template,
    publicHistoryVisible: input.publicHistoryVisible !== false,
  };
}

async function requireCreator(env, accountId) {
  const account = await activeAccount(env, accountId); if (!account) throw new AuthFailure(401, "authentication_required", "Sign in to create a wheel.");
  const master = accessForAccount(account).isMasterAdmin; const grant = await requireWheelDb(env).prepare("SELECT * FROM wheel_creator_grants WHERE account_id = ?").bind(accountId).first();
  if (!master && !(grant?.active && grant?.may_create_wheels)) throw new AuthFailure(403, "creator_approval_required", "Wheel creation requires Admin approval.");
  return { account, isMasterAdmin: master, maximumOwnedWheels: master ? 100 : Number(grant.maximum_owned_wheels || 20) };
}

async function resolveWheelAccess(env, accountId, wheel) {
  const account = await activeAccount(env, accountId); if (!account) return emptyAccess();
  const isMasterAdmin = accessForAccount(account).isMasterAdmin;
  const assignment = await requireWheelDb(env).prepare("SELECT role, active FROM wheel_access WHERE wheel_id = ? AND account_id = ?").bind(wheel.id, accountId).first();
  const role = assignment?.active ? assignment.role : null;
  return { accountId, isMasterAdmin, role, canViewPrivate: isMasterAdmin || Boolean(role), canEdit: isMasterAdmin || role === "owner" || role === "editor", canSpinOfficially: isMasterAdmin || role === "owner" || role === "editor" || role === "spinner" };
}

function emptyAccess() { return { accountId: "", isMasterAdmin: false, role: null, canViewPrivate: false, canEdit: false, canSpinOfficially: false }; }
function accessProjection(access, wheel) { return { role: access.role, isMasterAdmin: access.isMasterAdmin, canEdit: access.canEdit && (!wheel.editing_locked || access.isMasterAdmin), canSpinOfficially: access.canSpinOfficially && wheel.lifecycle === "active" && Boolean(wheel.official_spin_enabled) && (!wheel.official_spinning_locked || access.isMasterAdmin), editingLocked: Boolean(wheel.editing_locked), officialSpinLocked: Boolean(wheel.official_spinning_locked), revision: access.canViewPrivate ? Number(wheel.revision) : undefined }; }

async function activeAccount(env, accountId) { const row = await loadAccountById(env, clean(accountId, 160)); return row?.status === "active" ? serializeAccount(env, row) : null; }
async function accountSummary(env, accountId) { const account = await activeAccount(env, accountId); return account ? { id: account.id, displayName: account.displayName, email: account.email, role: account.role, adminLevel: account.adminLevel } : { id: accountId, displayName: "Unavailable account", email: null, role: "user", adminLevel: "none" }; }
async function publicWheelOwner(env, accountId) { const account = await activeAccount(env, accountId); return account ? { displayName: account.displayName, avatarUrl: account.avatarUrl || null } : { displayName: "Unavailable creator", avatarUrl: null }; }

async function wheelBySlug(env, slug) { return requireWheelDb(env).prepare("SELECT * FROM wheels WHERE public_slug = ? COLLATE NOCASE LIMIT 1").bind(clean(slug, 80)).first(); }
async function entriesForWheel(env, wheelId, includeHidden) { const rows = await requireWheelDb(env).prepare(`SELECT id, display_label, display_order, weight, segment_colour, segment_style_json, state FROM wheel_entries WHERE wheel_id = ? ${includeHidden ? "" : "AND state = 'active'"} ORDER BY display_order, id`).bind(wheelId).all(); return (rows?.results || []).map((row) => ({ id: row.id, label: row.display_label, order: Number(row.display_order), weight: Number(row.weight), colour: row.segment_colour, style: row.segment_style_json ? parseJson(row.segment_style_json, null) : null, state: row.state })); }
async function publicHistory(env, wheel, limit) { const config = parseJson(wheel.config_json, DEFAULT_CONFIG); if (!config.publicHistoryVisible) return []; return (await resultRows(env, wheel.id, limit)).map(officialProjection); }
async function resultRows(env, wheelId, limit) { const rows = await requireWheelDb(env).prepare("SELECT * FROM wheel_official_spins WHERE wheel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(wheelId, limit).all(); return rows?.results || []; }

function publicSummary(row) { const config = parseJson(row.config_json, DEFAULT_CONFIG); return { slug: row.public_slug, title: row.title, description: row.description, participantCount: Number(row.participant_count), weighted: Boolean(row.is_weighted), themePreset: config.themePreset, palette: config.palette, demoEnabled: Boolean(row.public_demo_spin_enabled), officialEnabled: Boolean(row.official_spin_enabled), latestOfficialAt: row.latest_official_spin_at || null, updatedAt: row.updated_at || null, directoryOrder: Number(row.display_order || 0) }; }
function publicDetail(wheel, entries, history, access, media, owner) { const config = validateConfig(parseJson(wheel.config_json, DEFAULT_CONFIG)); return { slug: wheel.public_slug, title: wheel.title, description: wheel.description, lifecycle: wheel.lifecycle, visibility: access.canViewPrivate ? wheel.visibility : "public", owner, createdAt: wheel.created_at, updatedAt: wheel.updated_at, participantCount: entries.filter((entry) => entry.state === "active").length, weighted: entries.some((entry) => entry.weight !== 1), entries, config, media, demoEnabled: Boolean(wheel.public_demo_spin_enabled), officialEnabled: Boolean(wheel.official_spin_enabled), latestOfficialResult: history[0] || null, recentOfficialResults: history, revision: access.canViewPrivate ? Number(wheel.revision) : undefined }; }
function officialProjection(row) { return { id: row.id, type: "official", winningEntryId: row.winning_entry_id, winningLabel: row.winning_label_snapshot, winningWeight: Number(row.winning_weight_snapshot), wheelRevision: Number(row.wheel_revision), snapshotHash: row.participant_snapshot_hash, createdAt: row.created_at, voided: Boolean(row.voided_at) }; }
export async function officialAnimationPlan(row) {
  const seed = new TextEncoder().encode(`thirdrailify-spin-plan-v1\n${row.id}\n${row.wheel_id}\n${row.participant_snapshot_hash}`);
  const digest = await crypto.subtle.digest("SHA-256", seed); const view = new DataView(digest);
  return { version: "spin-plan-v1", landingFraction: (view.getUint32(0, false) + .5) / 0x100000000, turnRandom: (view.getUint32(4, false) + .5) / 0x100000000 };
}
export async function officialSpinProjection(row) { return { ...officialProjection(row), animationPlan: await officialAnimationPlan(row) }; }
function adminResultProjection(row) { return { ...officialProjection(row), wheelId: row.wheel_id, performedByAccountId: row.performed_by_account_id, idempotencyKey: row.idempotency_key, voidedAt: row.voided_at || null, voidReason: row.void_reason || null, voidedByAccountId: row.voided_by_account_id || null }; }
async function adminWheelSummary(env, row) { return { id: row.id, reference: row.reference_code, slug: row.public_slug, title: row.title, description: row.description, lifecycle: row.lifecycle, visibility: row.visibility, owner: await accountSummary(env, row.owner_account_id), participantCount: Number(row.participant_count), revision: Number(row.revision), officialEnabled: Boolean(row.official_spin_enabled), demoEnabled: Boolean(row.public_demo_spin_enabled), editingLocked: Boolean(row.editing_locked), spinLocked: Boolean(row.official_spinning_locked), latestWinner: row.latest_winner || null, latestResultAt: row.latest_result_at || row.latest_official_spin_at || null, updatedAt: row.updated_at }; }
async function wheelAccessRows(env, wheelId) { const rows = await requireWheelDb(env).prepare("SELECT * FROM wheel_access WHERE wheel_id = ? ORDER BY active DESC, role, created_at").bind(wheelId).all(); return Promise.all((rows?.results || []).map(async (row) => ({ account: await accountSummary(env, row.account_id), role: row.role, active: Boolean(row.active), updatedAt: row.updated_at }))); }

function entryInsert(db, wheelId, entry, index, timestamp) { return db.prepare("INSERT INTO wheel_entries (id, wheel_id, display_label, display_order, weight, segment_colour, segment_style_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(entry.id, wheelId, entry.label, index, entry.weight, entry.colour, entry.style ? JSON.stringify(entry.style) : null, entry.state, timestamp, timestamp); }
function entryInsertConditional(db, wheelId, entry, index, timestamp, revision) { return db.prepare(`INSERT INTO wheel_entries (id, wheel_id, display_label, display_order, weight, segment_colour, segment_style_json, state, created_at, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM wheels WHERE id = ? AND revision = ? AND updated_at = ?)`
).bind(entry.id, wheelId, entry.label, index, entry.weight, entry.colour, entry.style ? JSON.stringify(entry.style) : null, entry.state, timestamp, timestamp, wheelId, revision, timestamp); }

function validatePaletteStyles(value, palette, custom) {
  if (!Array.isArray(value) || value.length !== palette.length || value.length > (custom ? 5 : 12)) throw new AuthFailure(400, "wheel_palette_styles_invalid", "Palette styles must align exactly with the palette.");
  return value.map((style, index) => validateSegmentStyle(style, palette[index]));
}
function validateSegmentStyle(value, fallbackColor) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthFailure(400, "segment_style_invalid", "A segment style is invalid.");
  const mode = clean(value.mode || "solid", 12); const color = clean(value.color || fallbackColor, 7).toUpperCase();
  if (!HEX.test(color)) throw new AuthFailure(400, "segment_style_colour_invalid", "Segment colours must be six-digit hex values.");
  if (mode === "solid") return { mode, color };
  if (mode === "pattern") { const pattern = clean(value.pattern, 40); const patternColor = clean(value.patternColor, 7).toUpperCase(); if (!PATTERNS.has(pattern) || !HEX.test(patternColor)) throw new AuthFailure(400, "segment_pattern_invalid", "Choose a supported pattern and six-digit pattern colour."); return { mode, color, pattern, patternColor }; }
  if (mode === "image") { const imageAssetId = clean(value.imageAssetId, 80); if (!/^[a-f0-9-]{16,80}$/i.test(imageAssetId)) throw new AuthFailure(400, "segment_image_invalid", "Choose a valid wheel-owned segment image."); return { mode, color, imageAssetId }; }
  throw new AuthFailure(400, "segment_fill_mode_invalid", "Segment fill mode must be solid, pattern, or image.");
}
function segmentAssetIds(config, entries) { const ids = new Set(); for (const style of [...(config.paletteStyles || []), ...(entries || []).map((entry) => entry.style).filter(Boolean)]) if (style.mode === "image") ids.add(style.imageAssetId); return [...ids]; }
function validatePreset(value, allowed, fallback, code) { if (value == null || value === "") return fallback; const preset = clean(value, 40); if (!allowed.has(preset)) throw new AuthFailure(400, code, "Choose a supported generated sound preset."); return preset; }
function assignmentUpsert(db, wheelId, accountId, role, active, actorId, timestamp) { return db.prepare(`INSERT INTO wheel_access (wheel_id, account_id, role, active, granted_by_account_id, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(wheel_id, account_id) DO UPDATE SET role = excluded.role, active = excluded.active, granted_by_account_id = excluded.granted_by_account_id, updated_at = excluded.updated_at, revoked_at = excluded.revoked_at`).bind(wheelId, accountId, role, active, actorId, timestamp, timestamp, active ? null : timestamp); }
function auditStatement(db, wheelId, actorId, targetId, type, metadata, timestamp) { return db.prepare("INSERT INTO wheel_audit_events (id, wheel_id, actor_account_id, target_account_id, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(randomId(), wheelId, actorId || null, targetId || null, type, metadata ? JSON.stringify(metadata) : null, timestamp); }

async function enforceWheelRateLimit(env, category, identifier, limit, windowSeconds) {
  const secret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || ""); if (!secret) throw new AuthFailure(503, "rate_limit_not_configured", "Wheel mutation protection is not configured.");
  const db = requireWheelDb(env); const keyHash = await hmacSha256(secret, `wheels\n${category}\n${clean(identifier, 160)}`); const row = await db.prepare("SELECT * FROM wheel_rate_limits WHERE key_hash = ? AND category = ?").bind(keyHash, category).first();
  const now = Date.now(); const expired = !row || now - Date.parse(row.window_started_at) >= windowSeconds * 1000; const count = expired ? 1 : Number(row.request_count || 0) + 1; const timestamp = nowIso(now); const blockedUntil = count > limit ? new Date(now + Math.min(windowSeconds, 900) * 1000).toISOString() : null;
  await db.prepare(`INSERT INTO wheel_rate_limits (key_hash, category, window_started_at, request_count, blocked_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key_hash, category) DO UPDATE SET window_started_at = excluded.window_started_at, request_count = excluded.request_count, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`).bind(keyHash, category, expired ? timestamp : row.window_started_at, count, blockedUntil, timestamp).run();
  if (blockedUntil || (row?.blocked_until && Date.parse(row.blocked_until) > now)) throw new AuthFailure(429, "wheel_rate_limited", "Too many wheel changes. Try again shortly.", { "Retry-After": String(Math.min(windowSeconds, 900)) });
}

export async function requireOfficialCooldown(env, wheel, now = Date.now()) {
  if (!wheel?.latest_official_spin_at) return;
  const settings = await getWheelSettings(env); const seconds = Math.max(1, Number(settings.settings.officialSpinCooldownSeconds || 2));
  const remaining = Date.parse(wheel.latest_official_spin_at) + seconds * 1000 - now;
  if (remaining > 0) throw new AuthFailure(429, "official_spin_cooldown", "This Wheel is still inside its official-spin cooldown.", { "Retry-After": String(Math.max(1, Math.ceil(remaining / 1000))) });
}

async function uniqueSlug(db, value) { const base = slugify(value) || `wheel-${randomId().slice(0, 8)}`; for (let index = 0; index < 10; index += 1) { const candidate = index ? `${base.slice(0, 71)}-${randomId().slice(0, 6)}` : base; if (!await db.prepare("SELECT id FROM wheels WHERE public_slug = ? COLLATE NOCASE").bind(candidate).first()) return candidate; } throw new AuthFailure(409, "wheel_slug_unavailable", "A unique wheel URL could not be created."); }
function slugify(value) { const slug = String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, ""); return SLUG.test(slug) ? slug : slug.length >= 3 ? slug : ""; }
function clean(value, max) { return cleanText(value, max); }
function requiredText(value, min, max, code) { const result = clean(value, max); if (result.length < min) throw new AuthFailure(400, code, "A required wheel field is invalid."); return result; }
function optionalText(value, max) { const result = clean(value, max); return result || null; }
function positiveInteger(value, code, max) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new AuthFailure(400, code, "A wheel number is outside the allowed range."); return number; }
function boundedPercent(value, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : fallback; }
function legacyCelebration(value) { return value === "restrained" ? "subtle" : value === "full" ? "normal" : DEFAULT_CONFIG.celebrationIntensity; }
function parseJson(value, fallback) { try { const parsed = JSON.parse(String(value || "")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback; } catch { return fallback; } }
function escapeLike(value) { return String(value).replace(/[\\%_]/g, (match) => `\\${match}`); }
async function digestHex(bytes) { const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export { DEFAULT_CONFIG, MAX_ENTRIES, accountSummary, activeAccount, auditStatement, enforceWheelRateLimit, publicSummary, publicWheelOwner, requireCreator, resolveWheelAccess, validateConfig, validateEntries };
