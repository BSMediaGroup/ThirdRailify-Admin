import { AuthFailure, accessForAccount, cleanText, nowIso, randomId } from "./auth-core.js";
import {
  accountSummary,
  activeAccount,
  auditStatement,
  enforceWheelRateLimit,
  getPublicWheel,
  getWheelSettings,
  officialSpinProjection,
  participantSnapshotHash,
  publicSummary,
  requireCreator,
  requireOfficialCooldown,
  requireWheelDb,
  resolveWheelAccess,
  secureBoundedInteger,
} from "./wheels-core.js";

const MAX_STAGE_WHEELS = 6;
const MAX_STAGES_PER_CREATOR = 20;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])$/;

export async function listPublicStages(env, input = {}) {
  const db = requireWheelDb(env);
  const search = clean(input.search, 80).toLowerCase();
  const sort = new Set(["recent", "title", "participants"]).has(input.sort) ? input.sort : "recent";
  const order = sort === "title" ? "title COLLATE NOCASE ASC, id ASC" : sort === "participants" ? "public_wheel_count DESC, title COLLATE NOCASE ASC" : "updated_at DESC, id ASC";
  const rows = await db.prepare(
    `SELECT s.*,
       (SELECT COUNT(*) FROM wheel_stage_items si JOIN wheels w ON w.id = si.wheel_id
        WHERE si.stage_id = s.id AND w.lifecycle = 'active' AND w.visibility = 'public') AS public_wheel_count
     FROM wheel_stages s
     WHERE s.lifecycle = 'active' AND s.visibility = 'public'
       AND (? = '' OR lower(s.title) LIKE ? ESCAPE '\\' OR lower(COALESCE(s.description, '')) LIKE ? ESCAPE '\\')
     ORDER BY ${order} LIMIT 100`,
  ).bind(search, `%${escapeLike(search)}%`, `%${escapeLike(search)}%`).all();
  const items = [];
  for (const row of rows?.results || []) {
    const wheels = await publicStageSummaries(env, row.id);
    if (wheels.length) items.push(stageSummary(row, wheels));
  }
  return { ok: true, items, count: items.length };
}

export async function listOwnedStages(env, accountId) {
  const actor = await activeAccount(env, accountId);
  if (!actor) throw new AuthFailure(401, "authentication_required", "Sign in to manage Stages.");
  const master = accessForAccount(actor).isMasterAdmin;
  const rows = await requireWheelDb(env).prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM wheel_stage_items i WHERE i.stage_id = s.id) AS wheel_count
     FROM wheel_stages s WHERE (? = 1 OR s.owner_account_id = ?) ORDER BY s.updated_at DESC, s.id ASC LIMIT 100`,
  ).bind(master ? 1 : 0, accountId).all();
  return { ok: true, items: (rows?.results || []).map((row) => ({ slug: row.public_slug, title: row.title, description: row.description, visibility: row.visibility, lifecycle: row.lifecycle, wheelCount: Number(row.wheel_count), revision: Number(row.revision), updatedAt: row.updated_at })), count: rows?.results?.length || 0 };
}

export async function listAccessibleWheels(env, accountId, input = {}) {
  const actor = await activeAccount(env, accountId);
  if (!actor) throw new AuthFailure(401, "authentication_required", "Sign in to choose Stage wheels.");
  const db = requireWheelDb(env); const master = accessForAccount(actor).isMasterAdmin;
  const search = clean(input.search, 80).toLowerCase();
  const scope = new Set(["public", "mine", "accessible"]).has(input.scope) ? input.scope : "accessible";
  const rows = await db.prepare(
    `SELECT w.*,
       EXISTS (SELECT 1 FROM wheel_entries e WHERE e.wheel_id = w.id AND e.state = 'active' AND e.weight != 1) AS is_weighted,
       (SELECT role FROM wheel_access a WHERE a.wheel_id = w.id AND a.account_id = ? AND a.active = 1 LIMIT 1) AS assigned_role
     FROM wheels w
     WHERE w.lifecycle = 'active'
       AND (? = 1 OR w.visibility = 'public' OR w.owner_account_id = ? OR EXISTS (
         SELECT 1 FROM wheel_access a WHERE a.wheel_id = w.id AND a.account_id = ? AND a.active = 1
       ))
       AND (? = 'accessible' OR (? = 'public' AND w.visibility = 'public') OR (? = 'mine' AND w.owner_account_id = ?))
       AND (? = '' OR lower(w.title) LIKE ? ESCAPE '\\' OR lower(COALESCE(w.description, '')) LIKE ? ESCAPE '\\')
     ORDER BY w.title COLLATE NOCASE ASC, w.id ASC LIMIT 200`,
  ).bind(accountId, master ? 1 : 0, accountId, accountId, scope, scope, scope, accountId, search, `%${escapeLike(search)}%`, `%${escapeLike(search)}%`).all();
  const items = (rows?.results || []).map((row) => {
    const role = row.owner_account_id === accountId ? "owner" : row.assigned_role || null;
    const canEdit = master || role === "owner" || role === "editor";
    const canSpin = master || canEdit || role === "spinner";
    return { ...publicSummary(row), visibility: row.visibility === "public" ? "public" : "private", capability: canEdit ? "Edit" : canSpin && row.official_spin_enabled ? "Official" : "Demo", canEdit, canSpinOfficially: Boolean(canSpin && row.official_spin_enabled && !row.official_spinning_locked) };
  });
  return { ok: true, items, count: items.length };
}

export async function getStage(env, slug, accountId = "") {
  const stage = await stageBySlug(env, slug);
  if (!stage) throw new AuthFailure(404, "stage_not_found", "This Stage was not found.");
  const actor = accountId ? await activeAccount(env, accountId) : null;
  const master = Boolean(actor && accessForAccount(actor).isMasterAdmin);
  const owner = Boolean(actor && stage.owner_account_id === accountId);
  const publiclyVisible = stage.lifecycle === "active" && stage.visibility === "public";
  if (!publiclyVisible && !owner && !master) throw new AuthFailure(404, "stage_not_found", "This Stage was not found.");
  const rows = await stageItemRows(env, stage.id); const wheels = [];
  for (const row of rows) {
    try {
      const payload = await getPublicWheel(env, row.public_slug, owner || master ? accountId : "");
      if (!owner && !master && (payload.wheel.lifecycle !== "active" || payload.wheel.visibility !== "public")) continue;
      wheels.push({ position: Number(row.position), unavailable: false, wheel: payload.wheel, access: payload.access });
    } catch (error) {
      if (owner || master) wheels.push({ position: Number(row.position), reference: `unavailable:${Number(row.position)}`, unavailable: true, wheel: null, access: null });
      else if (!(error instanceof AuthFailure && error.status === 404)) throw error;
    }
  }
  if (!wheels.some((item) => !item.unavailable) && !owner && !master) throw new AuthFailure(404, "stage_unavailable", "This Stage has no public wheels available.");
  const exposeRevision = Boolean(actor);
  return { ok: true, stage: { slug: stage.public_slug, title: stage.title, description: stage.description, visibility: stage.visibility, lifecycle: stage.lifecycle, revision: exposeRevision ? Number(stage.revision) : undefined, updatedAt: stage.updated_at, wheels }, access: { isOwner: owner, isMasterAdmin: master, canEdit: owner || master, revision: exposeRevision ? Number(stage.revision) : undefined } };
}

export async function performStageOfficialSpinAll(env, accountId, slug, input) {
  const db = requireWheelDb(env); const stage = await stageBySlug(env, slug); const actor = await activeAccount(env, accountId);
  if (!stage) throw new AuthFailure(404, "stage_not_found", "This Stage was not found.");
  if (!actor) throw new AuthFailure(401, "authentication_required", "Sign in to record Official All results.");
  const master = accessForAccount(actor).isMasterAdmin; const owner = stage.owner_account_id === accountId;
  if (stage.lifecycle !== "active" || (stage.visibility !== "public" && !owner && !master)) throw new AuthFailure(404, "stage_not_found", "This Stage was not found.");
  if (Object.hasOwn(input, "winner") || Object.hasOwn(input, "winners")) throw new AuthFailure(400, "client_winner_forbidden", "Official winners are selected only by the server.");
  const batchKey = requiredText(input.batchKey, 16, 80, "batch_idempotency_key_invalid");
  if (!/^[a-f0-9-]+$/i.test(batchKey)) throw new AuthFailure(400, "batch_idempotency_key_invalid", "The Official All batch key is invalid.");
  if (!Array.isArray(input.wheels) || input.wheels.length < 1 || input.wheels.length > MAX_STAGE_WHEELS) throw new AuthFailure(400, "stage_spin_all_wheels_invalid", "Official All requires the expected ordered Stage Wheels.");
  const expected = input.wheels.map((item, position) => ({ position, slug: clean(item?.slug, 80), revision: positiveInteger(item?.revision, "wheel_revision_invalid", 2_147_483_647) }));
  if (expected.some((item) => !SLUG.test(item.slug))) throw new AuthFailure(400, "stage_spin_all_wheels_invalid", "Official All contains an invalid Wheel reference.");
  const recovery = [];
  for (const item of expected) {
    const wheel = await db.prepare("SELECT * FROM wheels WHERE public_slug=? COLLATE NOCASE LIMIT 1").bind(item.slug).first();
    const idempotencyKey = await stageWheelIdempotencyKey(stage.id, batchKey, item.position, item.slug);
    const existing = wheel ? await db.prepare("SELECT * FROM wheel_official_spins WHERE wheel_id=? AND idempotency_key=? LIMIT 1").bind(wheel.id, idempotencyKey).first() : null;
    recovery.push({ item, wheel, idempotencyKey, existing });
  }
  if (recovery.every((item) => item.existing)) return stageSpinAllResponse(recovery, true);
  if (recovery.some((item) => item.existing)) throw new AuthFailure(409, "stage_spin_all_incomplete", "The Official All batch is in an unexpected incomplete state. No retry was written.");
  const expectedStageRevision = positiveInteger(input.stageRevision, "stage_revision_invalid", 2_147_483_647);
  const stageRows = await officialStageItemRows(env, stage.id); const issues = [];
  if (expectedStageRevision !== Number(stage.revision)) issues.push({ wheel: "Stage", code: "stage_revision_conflict", message: "Stage composition changed." });
  if (stageRows.length !== expected.length) issues.push({ wheel: "Stage", code: "stage_wheel_count_changed", message: "Stage Wheel membership changed." });
  for (let index = 0; index < expected.length; index += 1) {
    const current = stageRows[index]; const requested = expected[index];
    if (!current || current.public_slug.toLowerCase() !== requested.slug.toLowerCase()) issues.push({ wheel: current?.title || requested.slug, code: "stage_wheel_order_changed", message: "Wheel order or membership changed." });
    else if (Number(current.revision) !== requested.revision) issues.push({ wheel: current.title, code: "wheel_revision_conflict", message: "Edit revision changed." });
  }
  await enforceWheelRateLimit(env, "stage_spin_all", `${accountId}:${stage.id}`, 10, 60);
  for (let index = 0; index < expected.length; index += 1) await enforceWheelRateLimit(env, "official_spin", accountId, 30, 60);
  const settings = await getWheelSettings(env); const cooldownSeconds = Math.max(1, Number(settings.settings.officialSpinCooldownSeconds || 2)); const now = Date.now(); const timestamp = nowIso(now); const cutoff = new Date(now - cooldownSeconds * 1000).toISOString();
  const prepared = [];
  for (let index = 0; index < stageRows.length; index += 1) {
    const wheel = stageRows[index]; const expectedItem = expected[index]; if (!expectedItem || wheel.public_slug.toLowerCase() !== expectedItem.slug.toLowerCase()) continue;
    const access = await resolveWheelAccess(env, accountId, wheel);
    if (!access.canSpinOfficially) issues.push({ wheel: wheel.title, code: "official_spin_forbidden", message: "Official permission unavailable." });
    if (wheel.lifecycle !== "active") issues.push({ wheel: wheel.title, code: "wheel_inactive", message: "Wheel is not active." });
    if (!wheel.official_spin_enabled || wheel.official_spinning_locked) issues.push({ wheel: wheel.title, code: "official_spin_locked", message: "Official spin is locked." });
    try { await requireOfficialCooldown(env, wheel, now); } catch (error) { if (error instanceof AuthFailure) issues.push({ wheel: wheel.title, code: error.code, message: "Official cooldown is active." }); else throw error; }
    const entries = await officialEntries(env, wheel.id);
    if (entries.length < 2) issues.push({ wheel: wheel.title, code: "participants_insufficient", message: "At least two active participants are required." });
    if (!access.canSpinOfficially || wheel.lifecycle !== "active" || !wheel.official_spin_enabled || wheel.official_spinning_locked || entries.length < 2 || Number(wheel.revision) !== expectedItem.revision) continue;
    const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0); let cursor = secureBoundedInteger(totalWeight); let winner = entries[entries.length - 1];
    for (const entry of entries) { if (cursor < entry.weight) { winner = entry; break; } cursor -= entry.weight; }
    prepared.push({ wheel, item: expectedItem, entries, winner, snapshotHash: await participantSnapshotHash(entries), spinId: randomId(), sequence: Number(wheel.spin_sequence || 0), idempotencyKey: recovery[index].idempotencyKey });
  }
  if (issues.length) throw new AuthFailure(409, "stage_spin_all_preflight_failed", "Official All cannot start.", {}, uniqueIssues(issues));
  if (prepared.length !== stageRows.length) throw new AuthFailure(409, "stage_spin_all_preflight_failed", "Official All cannot start.");
  const statements = [];
  for (const plan of prepared) {
    statements.push(
      db.prepare(`INSERT INTO wheel_official_spins (
        id,wheel_id,wheel_revision,participant_snapshot_hash,winning_entry_id,winning_label_snapshot,
        winning_weight_snapshot,performed_by_account_id,result_type,idempotency_key,created_at
      ) SELECT ?,?,?,?,?,?,CASE WHEN
        EXISTS (SELECT 1 FROM wheel_stages s JOIN wheel_stage_items i ON i.stage_id=s.id
          WHERE s.id=? AND s.revision=? AND s.lifecycle='active' AND i.position=? AND i.wheel_id=?)
        AND EXISTS (SELECT 1 FROM wheels w WHERE w.id=? AND w.revision=? AND w.spin_sequence=? AND w.lifecycle='active'
          AND w.official_spin_enabled=1 AND w.official_spinning_locked=0 AND (w.latest_official_spin_at IS NULL OR w.latest_official_spin_at<=?))
        AND (?=1 OR EXISTS (SELECT 1 FROM wheel_access a WHERE a.wheel_id=? AND a.account_id=? AND a.active=1 AND a.role IN ('owner','editor','spinner')))
        THEN ? ELSE 0 END,?,'official',?,?`).bind(
        plan.spinId, plan.wheel.id, plan.item.revision, plan.snapshotHash, plan.winner.id, plan.winner.label,
        stage.id, expectedStageRevision, plan.item.position, plan.wheel.id,
        plan.wheel.id, plan.item.revision, plan.sequence, cutoff,
        master ? 1 : 0, plan.wheel.id, accountId,
        plan.winner.weight, accountId, plan.idempotencyKey, timestamp,
      ),
      db.prepare("UPDATE wheels SET spin_sequence=spin_sequence+1,latest_official_spin_at=?,updated_at=? WHERE id=? AND revision=? AND spin_sequence=?").bind(timestamp, timestamp, plan.wheel.id, plan.item.revision, plan.sequence),
      db.prepare("INSERT INTO wheel_audit_events (id,wheel_id,actor_account_id,event_type,metadata_json,created_at) VALUES (?,?,?,'official_spin_recorded',?,?)").bind(randomId(), plan.wheel.id, accountId, JSON.stringify({ spinId: plan.spinId, wheelRevision: plan.item.revision, snapshotHash: plan.snapshotHash, stageId: stage.id, batch: true }), timestamp),
    );
  }
  let results;
  try { results = await db.batch(statements); }
  catch (error) {
    const repeated = [];
    for (const item of recovery) repeated.push({ ...item, existing: item.wheel ? await db.prepare("SELECT * FROM wheel_official_spins WHERE wheel_id=? AND idempotency_key=? LIMIT 1").bind(item.wheel.id, item.idempotencyKey).first() : null });
    if (repeated.every((item) => item.existing)) return stageSpinAllResponse(repeated, true);
    throw error;
  }
  if (prepared.some((_, index) => Number(results?.[index * 3]?.meta?.changes || 0) !== 1 || Number(results?.[index * 3 + 1]?.meta?.changes || 0) !== 1)) throw new AuthFailure(409, "stage_spin_all_conflict", "A Wheel changed while Official All was starting.");
  return { ok: true, mode: "official", idempotent: false, results: await Promise.all(prepared.map(async (plan) => ({ position: plan.item.position, wheelSlug: plan.wheel.public_slug, wheelTitle: plan.wheel.title, spin: await officialSpinProjection({ id: plan.spinId, wheel_id: plan.wheel.id, wheel_revision: plan.item.revision, participant_snapshot_hash: plan.snapshotHash, winning_entry_id: plan.winner.id, winning_label_snapshot: plan.winner.label, winning_weight_snapshot: plan.winner.weight, created_at: timestamp }) }))) };
}

export async function createStage(env, accountId, input) {
  const creator = await requireCreator(env, accountId); const db = requireWheelDb(env);
  await enforceWheelRateLimit(env, "stage_create", accountId, 10, 3600);
  const owned = Number((await db.prepare("SELECT COUNT(*) AS count FROM wheel_stages WHERE owner_account_id = ? AND lifecycle != 'archived'").bind(accountId).first())?.count || 0);
  const maximum = creator.isMasterAdmin ? 100 : MAX_STAGES_PER_CREATOR;
  if (owned >= maximum) throw new AuthFailure(409, "stage_limit_reached", "This creator has reached the active Stage limit.");
  const normalized = await normalizeStageInput(env, accountId, input); const id = randomId(); const slug = await uniqueStageSlug(db, input.slug || normalized.title); const timestamp = nowIso();
  await db.batch([
    db.prepare("INSERT INTO wheel_stages (id,public_slug,title,description,owner_account_id,visibility,lifecycle,revision,created_at,updated_at) VALUES (?,?,?,?,?,?, 'active',1,?,?)").bind(id, slug, normalized.title, normalized.description, accountId, normalized.visibility, timestamp, timestamp),
    ...normalized.wheels.map((wheel, position) => db.prepare("INSERT INTO wheel_stage_items (stage_id,wheel_id,position,created_at,updated_at) VALUES (?,?,?,?,?)").bind(id, wheel.id, position, timestamp, timestamp)),
    auditStatement(db, null, accountId, null, "stage_created", { stageId: id, slug, visibility: normalized.visibility, wheelCount: normalized.wheels.length }, timestamp),
  ]);
  return getStage(env, slug, accountId);
}

export async function saveStage(env, accountId, slug, input) {
  await enforceWheelRateLimit(env, "stage_save", accountId, 60, 3600);
  const db = requireWheelDb(env); const stage = await requireStageEditor(env, accountId, slug);
  const expectedRevision = positiveInteger(input.revision, "stage_revision_invalid", 2_147_483_647);
  if (expectedRevision !== Number(stage.revision)) throw new AuthFailure(409, "stage_revision_conflict", "The Stage changed. Reload it before saving.");
  const normalized = await normalizeStageInput(env, accountId, input, stage.id); const timestamp = nowIso(); const nextRevision = expectedRevision + 1;
  const result = await db.batch([
    db.prepare("UPDATE wheel_stages SET title=?,description=?,visibility=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(normalized.title, normalized.description, normalized.visibility, timestamp, stage.id, expectedRevision),
    db.prepare("DELETE FROM wheel_stage_items WHERE stage_id=? AND EXISTS (SELECT 1 FROM wheel_stages WHERE id=? AND revision=? AND updated_at=?)").bind(stage.id, stage.id, nextRevision, timestamp),
    ...normalized.wheels.map((wheel, position) => db.prepare("INSERT INTO wheel_stage_items (stage_id,wheel_id,position,created_at,updated_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM wheel_stages WHERE id=? AND revision=? AND updated_at=?)").bind(stage.id, wheel.id, position, timestamp, timestamp, stage.id, nextRevision, timestamp)),
    db.prepare("INSERT INTO wheel_audit_events (id,wheel_id,actor_account_id,event_type,metadata_json,created_at) SELECT ?,NULL,?,'stage_saved',?,? WHERE EXISTS (SELECT 1 FROM wheel_stages WHERE id=? AND revision=? AND updated_at=?)").bind(randomId(), accountId, JSON.stringify({ stageId: stage.id, previousRevision: expectedRevision, wheelCount: normalized.wheels.length, visibility: normalized.visibility }), timestamp, stage.id, nextRevision, timestamp),
  ]);
  if (Number(result?.[0]?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "stage_revision_conflict", "The Stage changed. Reload it before saving.");
  return getStage(env, slug, accountId);
}

export async function archiveStage(env, accountId, slug) {
  const db = requireWheelDb(env); const stage = await requireStageEditor(env, accountId, slug); const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE wheel_stages SET lifecycle='archived',revision=revision+1,archived_at=?,updated_at=? WHERE id=?").bind(timestamp, timestamp, stage.id),
    auditStatement(db, null, accountId, null, "stage_archived", { stageId: stage.id }, timestamp),
  ]);
  return getStage(env, slug, accountId);
}

export async function adminStageLibrary(env) {
  const rows = await requireWheelDb(env).prepare("SELECT s.*,(SELECT COUNT(*) FROM wheel_stage_items i WHERE i.stage_id=s.id) AS wheel_count FROM wheel_stages s ORDER BY s.updated_at DESC,s.id ASC LIMIT 250").all();
  return { ok: true, items: await Promise.all((rows?.results || []).map(async (row) => ({ id: row.id, slug: row.public_slug, title: row.title, description: row.description, owner: await accountSummary(env, row.owner_account_id), visibility: row.visibility, lifecycle: row.lifecycle, revision: Number(row.revision), wheelCount: Number(row.wheel_count), createdAt: row.created_at, updatedAt: row.updated_at }))) };
}

export async function adminMutateStage(env, actorId, input) {
  const db = requireWheelDb(env); const id = clean(input.stageId, 80); const action = String(input.action || "");
  if (!new Set(["hide", "archive", "restore", "delete"]).has(action)) throw new AuthFailure(400, "stage_admin_action_invalid", "Choose a valid Stage action.");
  await enforceWheelRateLimit(env, "admin_stage", actorId, 120, 3600);
  const stage = await db.prepare("SELECT * FROM wheel_stages WHERE id=? LIMIT 1").bind(id).first();
  if (!stage) throw new AuthFailure(404, "stage_not_found", "This Stage was not found.");
  const timestamp = nowIso();
  if (action === "delete") {
    if (input.confirmDelete !== true) throw new AuthFailure(400, "stage_delete_confirmation_required", "Confirm the Stage deletion.");
    await db.batch([auditStatement(db, null, actorId, null, "stage_hard_deleted", { stageId: id, slug: stage.public_slug, wheelRecordsDeleted: 0 }, timestamp), db.prepare("DELETE FROM wheel_stages WHERE id=?").bind(id)]);
  } else {
    const visibility = action === "hide" ? "private" : stage.visibility;
    const lifecycle = action === "archive" ? "archived" : action === "restore" ? "active" : stage.lifecycle;
    await db.batch([
      db.prepare("UPDATE wheel_stages SET visibility=?,lifecycle=?,revision=revision+1,archived_at=?,updated_at=? WHERE id=?").bind(visibility, lifecycle, lifecycle === "archived" ? timestamp : null, timestamp, id),
      auditStatement(db, null, actorId, null, `admin_stage_${action}`, { stageId: id }, timestamp),
    ]);
  }
  return adminStageLibrary(env);
}

async function normalizeStageInput(env, accountId, input, currentStageId = "") {
  const title = requiredText(input.title, 1, 100, "stage_title_invalid"); const description = optionalText(input.description, 280);
  const visibility = input.visibility === "public" ? "public" : "private";
  if (!Array.isArray(input.wheelSlugs) || input.wheelSlugs.length < 1 || input.wheelSlugs.length > MAX_STAGE_WHEELS) throw new AuthFailure(400, "stage_wheel_count_invalid", "A Stage must contain between one and six wheels.");
  const identifiers = input.wheelSlugs.map((value) => clean(value, 80));
  if (identifiers.some((value) => !value) || new Set(identifiers.map((value) => value.toLowerCase())).size !== identifiers.length) throw new AuthFailure(400, "stage_wheels_invalid", "Stage wheels must be unique valid references.");
  const db = requireWheelDb(env); const wheels = [];
  for (const identifier of identifiers) {
    const unavailable = identifier.match(/^unavailable:([0-5])$/);
    const wheel = unavailable && currentStageId
      ? await db.prepare("SELECT w.* FROM wheel_stage_items i JOIN wheels w ON w.id=i.wheel_id WHERE i.stage_id=? AND i.position=? LIMIT 1").bind(currentStageId, Number(unavailable[1])).first()
      : await db.prepare("SELECT * FROM wheels WHERE id=? OR public_slug=? COLLATE NOCASE LIMIT 1").bind(identifier, identifier).first();
    if (!wheel || wheel.lifecycle !== "active") throw new AuthFailure(400, "stage_wheel_unavailable", "Every Stage wheel must be active and accessible.");
    if (visibility === "public" && wheel.visibility !== "public") throw new AuthFailure(400, "public_stage_private_wheel", "A Public Stage may contain only active Public wheels.");
    const access = await resolveWheelAccess(env, accountId, wheel);
    if (!unavailable && wheel.visibility !== "public" && !access.canViewPrivate) throw new AuthFailure(403, "stage_wheel_forbidden", "You do not have access to one of the selected wheels.");
    wheels.push(wheel);
  }
  return { title, description, visibility, wheels };
}

async function requireStageEditor(env, accountId, slug) {
  const stage = await stageBySlug(env, slug); if (!stage) throw new AuthFailure(404, "stage_not_found", "This Stage was not found.");
  const actor = await activeAccount(env, accountId); const master = Boolean(actor && accessForAccount(actor).isMasterAdmin);
  if (!actor || (!master && stage.owner_account_id !== accountId)) throw new AuthFailure(403, "stage_edit_forbidden", "Stage owner access is required.");
  return stage;
}

async function stageBySlug(env, slug) { return requireWheelDb(env).prepare("SELECT * FROM wheel_stages WHERE public_slug=? COLLATE NOCASE LIMIT 1").bind(clean(slug, 80)).first(); }
async function stageItemRows(env, stageId) { const rows = await requireWheelDb(env).prepare("SELECT i.position,w.public_slug FROM wheel_stage_items i JOIN wheels w ON w.id=i.wheel_id WHERE i.stage_id=? ORDER BY i.position").bind(stageId).all(); return rows?.results || []; }
async function officialStageItemRows(env, stageId) { const rows = await requireWheelDb(env).prepare("SELECT i.position,w.* FROM wheel_stage_items i JOIN wheels w ON w.id=i.wheel_id WHERE i.stage_id=? ORDER BY i.position").bind(stageId).all(); return rows?.results || []; }
async function officialEntries(env, wheelId) { const rows = await requireWheelDb(env).prepare("SELECT id,display_label,display_order,weight,segment_colour,state FROM wheel_entries WHERE wheel_id=? AND state='active' ORDER BY display_order,id").bind(wheelId).all(); return (rows?.results || []).map((row) => ({ id: row.id, label: row.display_label, order: Number(row.display_order), weight: Number(row.weight), colour: row.segment_colour, state: row.state })); }
async function stageWheelIdempotencyKey(stageId, batchKey, position, slug) { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`thirdrailify-stage-spin-all-v1\n${stageId}\n${batchKey}\n${position}\n${slug.toLowerCase()}`))); return `stage-all-v1:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`; }
async function stageSpinAllResponse(rows, idempotent) { return { ok: true, mode: "official", idempotent, results: await Promise.all(rows.map(async ({ item, wheel, existing }) => ({ position: item.position, wheelSlug: wheel.public_slug, wheelTitle: wheel.title, spin: await officialSpinProjection(existing) }))) }; }
function uniqueIssues(issues) { const seen = new Set(); return issues.filter((issue) => { const key = `${issue.wheel}\n${issue.code}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
async function publicStageSummaries(env, stageId) {
  const rows = await requireWheelDb(env).prepare(
    `SELECT i.position,w.*,
       EXISTS (SELECT 1 FROM wheel_entries e WHERE e.wheel_id=w.id AND e.state='active' AND e.weight!=1) AS is_weighted
     FROM wheel_stage_items i JOIN wheels w ON w.id=i.wheel_id
     WHERE i.stage_id=? AND w.lifecycle='active' AND w.visibility='public' ORDER BY i.position`,
  ).bind(stageId).all();
  return (rows?.results || []).map((row) => ({ position: Number(row.position), ...publicSummary(row) }));
}
function stageSummary(row, wheels) { return { type: "stage", slug: row.public_slug, title: row.title, description: row.description, wheelCount: wheels.length, visibility: "public", wheels, updatedAt: row.updated_at }; }
async function uniqueStageSlug(db, value) { const base = slugify(value) || `stage-${randomId().slice(0, 8)}`; for (let index = 0; index < 10; index += 1) { const candidate = index ? `${base.slice(0, 71)}-${randomId().slice(0, 6)}` : base; if (!await db.prepare("SELECT id FROM wheel_stages WHERE public_slug=? COLLATE NOCASE").bind(candidate).first()) return candidate; } throw new AuthFailure(409, "stage_slug_unavailable", "A unique Stage URL could not be created."); }
function slugify(value) { const slug = String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, ""); return SLUG.test(slug) ? slug : slug.length >= 3 ? slug : ""; }
function clean(value, max) { return cleanText(value, max); }
function requiredText(value, min, max, code) { const result = clean(value, max); if (result.length < min) throw new AuthFailure(400, code, "A required Stage field is invalid."); return result; }
function optionalText(value, max) { const result = clean(value, max); return result || null; }
function positiveInteger(value, code, max) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new AuthFailure(400, code, "A Stage revision is outside the allowed range."); return number; }
function escapeLike(value) { return String(value).replace(/[\\%_]/g, (match) => `\\${match}`); }

export { MAX_STAGE_WHEELS, MAX_STAGES_PER_CREATOR };
