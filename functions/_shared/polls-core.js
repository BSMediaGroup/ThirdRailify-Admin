import { validateStreamUrl, rumbleStreamUrl, detectedPollStreams } from './poll-streams.js';
import { paidSchema, activePaidContext, bonusOptions, creditProjection, publicPollPolicy } from './poll-credits.js';
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
import { normalizePollTrigger, validatePollTrigger } from "./poll-normalization.js";
import { projectPollMediaAsset } from "./poll-media.js";
import { heartbeatFreshness, heartbeatState } from "./heartbeat-freshness.js";

const STATES = new Set(["draft", "open", "closed", "archived"]);
const WEB_MODES = new Set(["anyone", "signed_in"]);
const STREAM_MODES = new Set(["automatic", "exact"]);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const SOURCE_SCOPE = /^(?:channel|user):[A-Za-z0-9_-]{1,180}$/;
const ID = /^[A-Za-z0-9_-]{8,180}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SERVICE_WINDOW_SECONDS = 300;
const PUBLIC_PAGE_SIZE = 12;
const PUBLIC_MAX_PAGE_SIZE = 48;

export function requirePollDb(env) {
  const db = env?.THIRDRAILIFY_COMMERCE_DB;
  if (!db || typeof db.prepare !== "function") throw new AuthFailure(503, "polls_database_not_configured", "Poll authority is not configured.");
  return db;
}

export async function readPollJson(request, maximumBytes = 64 * 1024) {
  if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    throw new AuthFailure(415, "content_type_invalid", "A JSON Poll request is required.");
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new AuthFailure(413, "request_too_large", "The Poll request is too large.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) throw new AuthFailure(413, "request_too_large", "The Poll request is too large.");
  try {
    const body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return { body, raw };
  } catch {
    throw new AuthFailure(400, "invalid_json", "The Poll request is invalid.");
  }
}

export async function listPublicPolls(env, input = {}, accountId = "") {
  const db = requirePollDb(env);
  const view = new Set(["open", "closed", "upcoming", "recent", "mine"]).has(input.view) ? input.view : "open";
  if (view === "mine" && !accountId) throw new AuthFailure(401, "authentication_required", "Sign in to view your Polls.");
  const search = clean(input.search, 100).toLowerCase();
  const page = boundedListInteger(input.page, 1, 10_000, 1);
  const pageSize = boundedListInteger(input.pageSize, 1, PUBLIC_MAX_PAGE_SIZE, PUBLIC_PAGE_SIZE);
  let where = view === "mine"
    ? "p.owner_account_id = ?"
    : view === "upcoming"
      ? "p.is_public = 1 AND p.state = 'draft' AND p.opened_at IS NULL"
      : view === "closed"
      ? "p.is_public = 1 AND p.state = 'closed' AND p.opened_at IS NOT NULL"
      : view === "recent"
        ? "p.is_public = 1 AND (p.state IN ('open','closed') OR (p.state='draft' AND p.opened_at IS NULL))"
        : "p.is_public = 1 AND p.state = 'open'";
  if (input.type && !['regular', 'abootnothing'].includes(input.type)) throw new AuthFailure(400, 'poll_type_invalid', 'Choose a supported Poll collection.');
  if (input.type) { await paidSchema(env); where += ` AND p.presentation_type='${input.type}'`; }
  const bindings = view === "mine" ? [accountId] : [];
  bindings.push(search, `%${escapeLike(search)}%`, `%${escapeLike(search)}%`);
  let order = view === "closed"
    ? "p.closed_at DESC, p.updated_at DESC, p.id ASC"
    : view === "open"
      ? "p.opened_at DESC, p.updated_at DESC, p.id ASC"
      : view === "recent"
        ? "CASE p.state WHEN 'open' THEN 0 ELSE 1 END, COALESCE(p.closed_at,p.opened_at,p.updated_at) DESC, p.id ASC"
        : "p.updated_at DESC, p.id ASC";
  if (input.type === 'abootnothing' && view === 'recent') order = "CASE p.state WHEN 'open' THEN 0 ELSE 1 END, CASE WHEN CAST(json_extract(p.presentation_json,'$.featuredOrder') AS INTEGER)>0 THEN 0 ELSE 1 END, CAST(json_extract(p.presentation_json,'$.featuredOrder') AS INTEGER), COALESCE(p.closed_at,p.opened_at,p.updated_at) DESC,p.id ASC";
  const predicate = `${where}
      AND (?='' OR lower(p.title) LIKE ? ESCAPE '\\' OR lower(COALESCE(p.description,'')) LIKE ? ESCAPE '\\')`;
  const [count, rows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM polls p WHERE ${predicate}`).bind(...bindings).first(),
    db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id=p.id) AS total_votes
    FROM polls p WHERE ${predicate}
    ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...bindings, pageSize, (page - 1) * pageSize).all(),
  ]);
  const items = await Promise.all((rows?.results || []).map((row) => projectSummary(env, row)));
  const total = Number(count?.count || 0);
  return { ok: true, view, items, count: items.length, page, pageSize, total, totalPages: total ? Math.ceil(total / pageSize) : 0, refreshedAt: nowIso() };
}

export async function getPublicPoll(env, slug, accountId = "", includePrivate = false) {
  const row = await requirePollDb(env).prepare("SELECT * FROM polls WHERE public_slug=? LIMIT 1").bind(clean(slug, 80)).first();
  if (!row) throw new AuthFailure(404, "poll_not_found", "This Poll was not found.");
  const access = await pollAccess(env, accountId, row);
  if (!(row.is_public && (new Set(["open", "closed"]).has(row.state) || (row.state === "draft" && !row.opened_at))) && !(includePrivate && access.canManage)) {
    throw new AuthFailure(404, "poll_not_found", "This Poll was not found.");
  }
  return { ok: true, poll: await projectDetail(env, row, accountId), access, refreshedAt: nowIso() };
}

export async function getPollCreatorAccess(env, accountId) {
  const account = accountId ? await activeAccount(env, accountId) : null;
  if (!account) return { ok: true, authenticated: false, canCreate: false, canManageAll: false };
  const admin = adminAccess(account);
  const grant = await requirePollDb(env).prepare("SELECT active,may_create_polls FROM poll_creator_grants WHERE account_id=?").bind(accountId).first();
  return { ok: true, authenticated: true, canCreate: admin.canManageAll || Boolean(grant?.active && grant?.may_create_polls), canManageAll: admin.canManageAll };
}

export async function incrementPollVotes(env, accountId, slug, input) {
  if (!(await getPollCreatorAccess(env, accountId)).canCreate) throw new AuthFailure(403, 'poll_increment_forbidden', 'An Admin or approved Poll account is required.');
  const db = requirePollDb(env);
  const amount = input.amount;
  if (!Number.isInteger(amount) || amount < 1 || amount > 10000) throw new AuthFailure(400, 'poll_increment_invalid', 'Choose a whole number from 1 to 10000.');
  const requestId = String(input.requestId || '');
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new AuthFailure(400, 'poll_increment_request_invalid', 'A valid request identifier is required.');
  const row = await db.prepare('SELECT * FROM polls WHERE public_slug=?').bind(slug).first();
  if (!row) throw new AuthFailure(404, 'poll_not_found', 'This Poll was not found.');
  const previous = await db.prepare('SELECT * FROM poll_manual_votes WHERE request_id=?').bind(requestId).first();
  if (previous) {
    if (previous.poll_id !== row.id || previous.option_id !== input.optionId || previous.actor_account_id !== accountId || previous.amount !== amount) throw new AuthFailure(409, 'poll_increment_request_conflict', 'This request identifier was already used.');
    return getPublicPoll(env, slug, accountId);
  }
  if (row.state !== 'open' || !row.is_public) throw new AuthFailure(409, 'poll_not_open', 'Additional votes require an open, listed Poll.');
  if (!await db.prepare('SELECT id FROM poll_options WHERE id=? AND poll_id=?').bind(String(input.optionId || ''), row.id).first()) throw new AuthFailure(400, 'poll_option_invalid', 'Choose an option from this Poll.');
  try {
    await db.prepare('INSERT INTO poll_manual_votes(request_id,poll_id,option_id,actor_account_id,amount,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING').bind(requestId, row.id, input.optionId, accountId, amount, nowIso()).run();
  } catch (error) {
    if (String(error).includes('poll_manual_vote_closed')) throw new AuthFailure(409, 'poll_not_open', 'This Poll closed before the votes were added.');
    throw error;
  }
  const recorded = await db.prepare('SELECT * FROM poll_manual_votes WHERE request_id=?').bind(requestId).first();
  if (recorded.poll_id !== row.id || recorded.option_id !== input.optionId || recorded.actor_account_id !== accountId || recorded.amount !== amount) throw new AuthFailure(409, 'poll_increment_request_conflict', 'This request identifier was already used.');
  return getPublicPoll(env, slug, accountId);
}

export async function getPollStreamCandidates(env, accountId, slug) {
  const row = await requireManagedPoll(env, accountId, slug);
  return detectedPollStreams(env, row.id);
}

export async function getCreatorRumbleDiscovery(env, accountId) {
  await requireCreator(env, accountId);
  return getSafeRumbleDiscovery(env);
}

// Sanitized discovery only; each caller must enforce its own capability boundary.
export async function getSafeRumbleDiscovery(env) {
  const heartbeat = await requirePollDb(env).prepare("SELECT runtime_json,heartbeat_at FROM bot_runtime_heartbeat WHERE singleton_id=1").first();
  if (!heartbeat) return { ok: true, provider: "rumble", botState: "offline", freshness: null, source: null, livestreams: [], message: "Rumble source discovery temporarily unavailable." };
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(heartbeat.heartbeat_at)) / 1000));
  const runtime = safeJson(heartbeat.runtime_json, {});
  const discovery = sanitizeRumbleDiscovery(runtime.rumbleDiscovery);
  const reportState = heartbeatState(ageSeconds, heartbeatFreshness(runtime));
  const botState = reportState === "online" ? "healthy" : reportState;
  return {
    ok: true,
    provider: "rumble",
    botState,
    discoveryState: heartbeatState(discovery?.observedAt ? Math.max(ageSeconds, (Date.now() - Date.parse(discovery.observedAt)) / 1000) : null, heartbeatFreshness(runtime)),
    freshness: { heartbeatAt: heartbeat.heartbeat_at, ageSeconds, providerResponseAt: discovery?.providerResponseAt || null, observedAt: discovery?.observedAt || null },
    source: discovery?.source || null,
    livestreams: discovery?.livestreams || [],
    message: discovery && botState !== "offline" ? null : "Rumble source discovery temporarily unavailable.",
  };
}

export async function listCreatorPolls(env, accountId, input = {}) {
  await requireCreator(env, accountId);
  return listPublicPolls(env, { ...input, view: "mine" }, accountId);
}

export async function createPoll(env, accountId, input, transactionExtension = null) {
  await requireCreator(env, accountId);
  const validated = validatePollInput(input, { creating: true });
  const db = requirePollDb(env);
  const id = `pol_${randomId()}`;
  const slug = await uniqueSlug(db, input.slug || validated.title);
  const timestamp = nowIso();
  const options = validateOptions(input.options);
  if (validated.presentationType === 'abootnothing' && options.length !== 2) throw new AuthFailure(400, 'poll_matchup_requires_two', 'Aboot Nothing requires exactly two opposing items.');
  const upgraded = await paidSchema(env, false);
  if (validated.presentationType !== 'regular' || input.presentation) await paidSchema(env);
  const metadata = upgraded ? [db.prepare('UPDATE polls SET presentation_type=?,presentation_json=? WHERE id=?').bind(validated.presentationType, JSON.stringify(validated.presentation), id)] : [];
  // Check media projection prerequisites before creating anything.
  if (!(await db.prepare("SELECT name FROM sqlite_master WHERE name='poll_media_assets'").first())) throw new AuthFailure(503, 'poll_media_schema_required', 'Apply the reviewed Poll media schema before creating Polls.');
  await db.batch([
    db.prepare(`INSERT INTO polls
      (id,public_slug,owner_account_id,title,description,state,is_public,web_voting_mode,rumble_enabled,rumble_source_scope,
       rumble_livestream_mode,rumble_livestream_id,requested_interval_seconds,theme_json,result_metadata_json,revision,created_at,updated_at)
      VALUES (?,?,?,?,?,'draft',1,?,?,?,?,?,?,?,'{}',1,?,?)`)
      .bind(id, slug, accountId, validated.title, validated.description, validated.webVotingMode, validated.rumbleEnabled ? 1 : 0,
        validated.rumbleSourceScope, validated.livestreamMode, validated.livestreamId, validated.intervalSeconds,
        JSON.stringify(validated.theme), timestamp, timestamp),
    ...options.map((option) => db.prepare(`INSERT INTO poll_options
      (id,poll_id,display_position,label,short_description,trigger_raw,trigger_normalized,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(option.id, id, option.position, option.label, option.description, option.triggerRaw, option.triggerNormalized, timestamp, timestamp)),
    ...metadata,
    ...(transactionExtension ? transactionExtension({ id, slug, options }) : []),
  ]);
  await activity(env, id, accountId, "poll_created", "success", { slug });
  return getPublicPoll(env, slug, accountId, true);
}

export async function updatePoll(env, accountId, slug, input) {
  const db = requirePollDb(env);
  const row = await requireManagedPoll(env, accountId, slug);
  const revision = integer(input.revision, 1, 1_000_000, "poll_revision_invalid");
  if (revision !== Number(row.revision)) throw new AuthFailure(409, "poll_revision_conflict", "This Poll changed after it was loaded.");
  const validated = validatePollInput(input, { creating: false, current: row });
  const upgraded = await paidSchema(env, false);
  if (input.presentationType || input.presentation) await paidSchema(env);
  const existingOptions = await db.prepare('SELECT * FROM poll_options WHERE poll_id=? ORDER BY display_position').bind(row.id).all();
  if (validated.presentationType === 'abootnothing' && (input.options || existingOptions.results).length !== 2) throw new AuthFailure(400, 'poll_matchup_requires_two', 'Aboot Nothing requires exactly two stable options.');
  const hasVotes = Number((await db.prepare('SELECT COUNT(*) count FROM poll_votes WHERE poll_id=?').bind(row.id).first()).count) > 0;
  const manualSchema = await db.prepare("SELECT 1 FROM sqlite_master WHERE name='poll_manual_votes'").first();
  const hasCredits = upgraded && (Boolean(await db.prepare('SELECT 1 FROM poll_credit_lots WHERE poll_id=? LIMIT 1').bind(row.id).first()) || Boolean(manualSchema && await db.prepare('SELECT 1 FROM poll_manual_votes WHERE poll_id=? LIMIT 1').bind(row.id).first()));
  if ((hasVotes || hasCredits) && validated.presentationType !== (row.presentation_type || 'regular')) throw new AuthFailure(409, 'poll_structure_locked', 'The Poll category is locked after voting begins.');
  let structural = Array.isArray(input.options);
  const bracketSchema = await db.prepare("SELECT name FROM sqlite_schema WHERE name='aboot_poll_links'").first();
  const bracketLinked = bracketSchema && await db.prepare('SELECT id FROM aboot_poll_links WHERE poll_id=? AND active=1').bind(row.id).first();
  if (bracketLinked && validated.presentationType !== row.presentation_type) throw new AuthFailure(409, 'poll_bracket_identity_locked', 'Detach the canonical bracket link before changing this Poll category.');
  if (bracketLinked && structural) {
    const unchanged = input.options.length === existingOptions.results.length && input.options.every((o, i) => o.id === existingOptions.results[i].id && o.label === existingOptions.results[i].label && normalizePollTrigger(o.trigger) === existingOptions.results[i].trigger_normalized);
    if (!unchanged) throw new AuthFailure(409, 'poll_bracket_identity_locked', 'This Poll has a canonical bracket link. Detach it through the audited Studio correction workflow before changing opponent identities.');
    structural = false;
  }
  if (row.state === 'open' && structural) throw new AuthFailure(409, 'poll_structure_locked', 'Close the Poll before changing options or triggers.');
  if (structural && (hasVotes || hasCredits || row.state === 'open')) {
    const stable = input.options.length === existingOptions.results.length && input.options.every((o, i) => o.id === existingOptions.results[i].id && normalizePollTrigger(o.trigger) === existingOptions.results[i].trigger_normalized);
    if (!stable) throw new AuthFailure(409, 'poll_structure_locked', 'Option IDs and triggers are locked after voting begins.');
    structural = false;
  }
  if (row.state === "open" && structural) throw new AuthFailure(409, "poll_structure_locked", "Close the Poll before changing options or triggers.");
  const rumbleToggle = Object.prototype.hasOwnProperty.call(input, "rumbleEnabled") && validated.rumbleEnabled !== Boolean(row.rumble_enabled);
  const bindingChanged = validated.rumbleEnabled && Boolean(row.rumble_enabled) && (
    validated.rumbleSourceScope !== row.rumble_source_scope
    || validated.livestreamMode !== row.rumble_livestream_mode
    || validated.livestreamId !== row.rumble_livestream_id
  );
  if (row.state === "open" && bindingChanged) throw new AuthFailure(409, "poll_rumble_binding_locked", "Close the Poll before changing its active Rumble source or livestream binding.");
  const timestamp = nowIso();
  const nextRevision = Number(row.revision) + 1;
  const statements = [db.prepare(`UPDATE polls SET title=?,description=?,web_voting_mode=?,rumble_enabled=?,rumble_source_scope=?,
    rumble_livestream_mode=?,rumble_livestream_id=?,requested_interval_seconds=?,theme_json=?,revision=?,updated_at=?
    WHERE id=? AND revision=?`).bind(validated.title, validated.description, validated.webVotingMode, validated.rumbleEnabled ? 1 : 0,
      validated.rumbleSourceScope, validated.livestreamMode, validated.livestreamId, validated.intervalSeconds,
      JSON.stringify(validated.theme), nextRevision, timestamp, row.id, revision)];
  if (upgraded) statements.push(db.prepare('UPDATE polls SET presentation_type=?,presentation_json=? WHERE id=? AND revision=?').bind(validated.presentationType, JSON.stringify(validated.presentation), row.id, nextRevision));
  if (!structural && Array.isArray(input.options)) statements.push(...input.options.map(o => db.prepare('UPDATE poll_options SET label=?,short_description=? WHERE id=? AND poll_id=?').bind(required(o.label, 1, 160, 'poll_option_label_invalid'), optional(o.description, 240), o.id, row.id)));
  if (row.state === "open" && rumbleToggle) {
    if (validated.rumbleEnabled) {
      await requireRumbleLeaseAvailable(db, validated.rumbleSourceScope, row.id);
      statements.push(db.prepare("INSERT INTO poll_rumble_leases (source_scope,poll_id,poll_revision,acquired_at,updated_at) VALUES (?,?,?,?,?)")
        .bind(validated.rumbleSourceScope, row.id, nextRevision, timestamp, timestamp));
    }
    else statements.push(db.prepare("DELETE FROM poll_rumble_leases WHERE poll_id=?").bind(row.id));
  }
  if (structural) {
    const options = validateOptions(input.options);
    const existing = await db.prepare("SELECT id FROM poll_options WHERE poll_id=?").bind(row.id).all();
    for (const option of options) {
      const existingOwner = await db.prepare('SELECT poll_id FROM poll_options WHERE id=?').bind(option.id).first();
      if (existingOwner && existingOwner.poll_id !== row.id) throw new AuthFailure(400, 'poll_option_invalid', 'An option belongs to another Poll.');
    }
    const desiredIds = new Set(options.map((option) => option.id));
    const removed = (existing?.results || []).map((item) => item.id).filter((id) => !desiredIds.has(id));
    if (removed.length) {
      const used = await db.prepare(`SELECT COUNT(*) AS count FROM poll_votes WHERE poll_id=? AND option_id IN (${removed.map(() => "?").join(",")})`).bind(row.id, ...removed).first();
      if (Number(used?.count || 0)) throw new AuthFailure(409, "poll_option_has_votes", "An option with recorded votes cannot be removed.");
      statements.push(...removed.map((id) => db.prepare("DELETE FROM poll_options WHERE poll_id=? AND id=?").bind(row.id, id)));
    }
    statements.push(...options.map((option) => db.prepare(`INSERT INTO poll_options
      (id,poll_id,display_position,label,short_description,trigger_raw,trigger_normalized,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_position=excluded.display_position,label=excluded.label,
      short_description=excluded.short_description,trigger_raw=excluded.trigger_raw,trigger_normalized=excluded.trigger_normalized,updated_at=excluded.updated_at`)
      .bind(option.id, row.id, option.position, option.label, option.description, option.triggerRaw, option.triggerNormalized, timestamp, timestamp)));
  }
  const transactionGuard = await pollMutationGuard(env, row.id, revision);
  if (transactionGuard) { statements.unshift(transactionGuard[0]); statements.push(transactionGuard[1]); }
  try { await db.batch(statements); }
  catch (error) {
    if (/CHECK constraint failed: valid/.test(String(error?.message || error))) throw new AuthFailure(409, 'poll_revision_conflict', 'The Poll changed during this operation. Refresh and retry.');
    if (/UNIQUE constraint failed: poll_rumble_leases/i.test(String(error?.message || error))) throw new AuthFailure(409, "rumble_source_poll_conflict", "Another open Poll already owns this Rumble source.");
    throw error;
  }
  await activity(env, row.id, accountId, "poll_updated", "success", { revision: nextRevision, structural });
  return getPublicPoll(env, row.public_slug, accountId, true);
}

export async function changePollLifecycle(env, accountId, slug, input) {
  const db = requirePollDb(env);
  const row = await requireManagedPoll(env, accountId, slug);
  const action = clean(input.action, 20);
  if (action === "reset") return resetPollToUpcoming(env, accountId, row, input);
  const revision = integer(input.revision, 1, 1_000_000, "poll_revision_invalid");
  if (revision !== Number(row.revision)) throw new AuthFailure(409, "poll_revision_conflict", "This Poll changed after it was loaded.");
  const transitions = { open: new Set(["draft", "closed"]), close: new Set(["open"]), archive: new Set(["draft", "closed"]), restore: new Set(["archived"]) };
  if (!transitions[action]?.has(row.state)) throw new AuthFailure(409, "poll_lifecycle_invalid", "That Poll lifecycle transition is not allowed.");
  const target = action === "open" ? "open" : action === "close" ? "closed" : action === "archive" ? "archived" : "draft";
  if (action === "open") {
    const optionCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM poll_options WHERE poll_id=?").bind(row.id).first())?.count || 0);
    if (optionCount < 2) throw new AuthFailure(409, "poll_options_required", "A Poll needs at least two options before opening.");
    if (row.rumble_enabled && !SOURCE_SCOPE.test(String(row.rumble_source_scope || ""))) throw new AuthFailure(409, "rumble_source_required", "Choose a valid Rumble source before opening.");
    if (row.rumble_enabled) await requireRumbleLeaseAvailable(db, row.rumble_source_scope, row.id);
  }
  const timestamp = nowIso();
  const nextRevision = Number(row.revision) + 1;
  const statements = [];
  if (action === "open" && row.rumble_enabled) {
    statements.push(db.prepare("INSERT INTO poll_rumble_leases (source_scope,poll_id,poll_revision,acquired_at,updated_at) VALUES (?,?,?,?,?)")
      .bind(row.rumble_source_scope, row.id, nextRevision, timestamp, timestamp));
  }
  if (action === "close" || action === "archive") statements.push(db.prepare("DELETE FROM poll_rumble_leases WHERE poll_id=?").bind(row.id));
  statements.push(db.prepare(`UPDATE polls SET state=?,is_public=CASE WHEN ?='open' THEN 1 WHEN ?='archived' THEN 0 WHEN ?='draft' AND opened_at IS NULL THEN 1 ELSE is_public END,revision=?,updated_at=?,
    opened_at=CASE WHEN ?='open' THEN ? ELSE opened_at END,
    closed_at=CASE WHEN ?='closed' THEN ? WHEN ?='open' THEN NULL ELSE closed_at END
    WHERE id=? AND revision=?`).bind(target, target, target, target, nextRevision, timestamp,
      target, timestamp, target, timestamp, target, row.id, revision));
  const transactionGuard = await pollMutationGuard(env, row.id, revision);
  if (transactionGuard) { statements.unshift(transactionGuard[0]); statements.push(transactionGuard[1]); }
  try { await db.batch(statements); }
  catch (error) {
    if (/CHECK constraint failed: valid/.test(String(error?.message || error))) throw new AuthFailure(409, 'poll_revision_conflict', 'The Poll changed during this operation. Refresh and retry.');
    if (/UNIQUE constraint failed: poll_rumble_leases/i.test(String(error?.message || error))) throw new AuthFailure(409, "rumble_source_poll_conflict", "Another open Poll already owns this Rumble source.");
    throw error;
  }
  await activity(env, row.id, accountId, `poll_${action}ed`, "success", { revision: nextRevision });
  return getPublicPoll(env, row.public_slug, accountId, true);
}

async function resetPollToUpcoming(env, accountId, row, input) {
  const db = requirePollDb(env);
  if (!(await getPollCreatorAccess(env, accountId)).canManageAll) throw new AuthFailure(403, 'poll_reset_admin_required', 'Only an Admin can reset a Poll.');
  if (!['open','closed','archived'].includes(row.state) || !row.opened_at) throw new AuthFailure(409, 'poll_reset_state_invalid', 'Only a previously opened Poll can be reset.');
  if (input.revision !== row.revision) throw new AuthFailure(409, 'poll_revision_conflict', 'This Poll changed. Refresh before resetting.');
  if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE name='poll_result_history'").first()) throw new AuthFailure(503,'poll_reset_schema_required','Poll reset requires migration 0044.');
  const snapshot = await projectSummary(env,row);
  const historyId = randomId(), guard = randomId(), timestamp = nowIso();
  const publicSnapshot = { title: snapshot.title, openedAt: snapshot.openedAt, closedAt: snapshot.closedAt, totalVotes: snapshot.totalVotes, unallocatedDiscarded: snapshot.credits?.unresolved || 0, options: snapshot.options.map(o => ({ id:o.id,label:o.label,votes:o.votes,ordinaryVotes:o.ordinaryVotes,bonusVotes:o.bonusVotes,manualVotes:o.manualVotes })) };
  try { await db.batch([
    db.prepare('INSERT INTO poll_credit_guards VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM polls WHERE id=? AND revision=? AND results_revision=?) THEN 1 ELSE 0 END)').bind(guard,row.id,row.revision,row.results_revision),
    db.prepare("INSERT INTO poll_result_history VALUES (?,?,?,?,(SELECT COALESCE(json_group_array(json_object('source',source_namespace,'voterHash',voter_key_hash,'optionId',option_id,'actorLabel',actor_label,'createdAt',created_at,'updatedAt',updated_at)),'[]') FROM poll_votes WHERE poll_id=?),?)").bind(historyId,row.id,accountId,JSON.stringify(publicSnapshot),row.id,timestamp),
    db.prepare('DELETE FROM poll_rumble_leases WHERE poll_id=?').bind(row.id),
    db.prepare("UPDATE polls SET state='draft',is_public=1,opened_at=NULL,closed_at=NULL,revision=revision+1,results_revision=results_revision+1,updated_at=? WHERE id=?").bind(timestamp,row.id),
    db.prepare("INSERT INTO poll_credit_audit(id,lot_id,actor_account_id,action,reason,before_json,after_json,created_at) SELECT lower(hex(randomblob(16))),id,?,'discarded','Poll reset to Upcoming',json_object('waiting',waiting,'review',unreconciled),json_object('discarded',waiting+unreconciled),? FROM poll_credit_lots WHERE poll_id=? AND waiting+unreconciled>0").bind(accountId,timestamp,row.id),
    db.prepare("UPDATE poll_credit_lots SET discarded=discarded+waiting+unreconciled,waiting=0,unreconciled=0,reason='poll_reset',revision=revision+1,updated_at=? WHERE poll_id=? AND waiting+unreconciled>0").bind(timestamp,row.id),
    db.prepare('INSERT OR IGNORE INTO poll_reset_windows SELECT id,? FROM poll_voting_windows WHERE poll_id=?').bind(historyId,row.id),
    db.prepare('INSERT OR IGNORE INTO poll_reset_credit_lots SELECT id,? FROM poll_credit_lots WHERE poll_id=?').bind(historyId,row.id),
    db.prepare('INSERT OR IGNORE INTO poll_reset_manual_votes SELECT request_id,? FROM poll_manual_votes WHERE poll_id=?').bind(historyId,row.id),
    db.prepare('DELETE FROM poll_votes WHERE poll_id=?').bind(row.id),
    db.prepare('DELETE FROM poll_credit_guards WHERE id=?').bind(guard),
  ]); } catch (error) { if (String(error).includes('CHECK constraint failed: valid')) throw new AuthFailure(409,'poll_revision_conflict','Votes changed while resetting. Refresh and retry.'); throw error; }
  await activity(env,row.id,accountId,'poll_reset_to_upcoming','success',{historyId});
  return getPublicPoll(env,row.public_slug,accountId,true);
}

export async function changePollVisibility(env, accountId, slug, input) {
  const db = requirePollDb(env);
  const row = await requireManagedPoll(env, accountId, slug);
  const revision = integer(input.revision, 1, 1_000_000, "poll_revision_invalid");
  if (revision !== Number(row.revision)) throw new AuthFailure(409, "poll_revision_conflict", "This Poll changed after it was loaded.");
  if (row.state !== "closed" && !(row.state === "draft" && !row.opened_at)) throw new AuthFailure(409, "poll_visibility_state_invalid", "Only Upcoming or closed Polls can be shown in or hidden from the gallery.");
  if (typeof input.public !== "boolean") throw new AuthFailure(400, "poll_visibility_invalid", "Choose whether this Poll is listed in the public gallery.");
  const isPublic = input.public ? 1 : 0;
  if (Number(row.is_public) === isPublic) return getPublicPoll(env, row.public_slug, accountId, true);
  const timestamp = nowIso();
  const nextRevision = Number(row.revision) + 1;
  const result = await db.prepare("UPDATE polls SET is_public=?,revision=?,updated_at=? WHERE id=? AND revision=? AND (state='closed' OR (state='draft' AND opened_at IS NULL))")
    .bind(isPublic, nextRevision, timestamp, row.id, revision).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "poll_revision_conflict", "This Poll changed after it was loaded.");
  await activity(env, row.id, accountId, "poll_visibility_changed", "success", { public: Boolean(isPublic), revision: nextRevision });
  return getPublicPoll(env, row.public_slug, accountId, true);
}

async function pollMutationGuard(env, id, revision) {
  if (!await paidSchema(env, false)) return null;
  const db = requirePollDb(env), token = randomId();
  return [db.prepare('INSERT INTO poll_credit_guards VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM polls WHERE id=? AND revision=?) THEN 1 ELSE 0 END)').bind(token, id, revision), db.prepare('DELETE FROM poll_credit_guards WHERE id=?').bind(token)];
}
async function requireRumbleLeaseAvailable(db, sourceScope, pollId) {
  const conflict = await db.prepare(`SELECT p.title,p.public_slug FROM poll_rumble_leases l
    JOIN polls p ON p.id=l.poll_id WHERE l.source_scope=? AND l.poll_id<>? LIMIT 1`).bind(sourceScope, pollId).first();
  if (conflict) throw new AuthFailure(409, "rumble_source_poll_conflict", `The open Poll “${clean(conflict.title, 80)}” already owns this Rumble source.`);
}

export async function submitWebVote(env, actor, slug, input) {
  const db = requirePollDb(env);
  const poll = await db.prepare("SELECT * FROM polls WHERE public_slug=? LIMIT 1").bind(clean(slug, 80)).first();
  if (!poll) throw new AuthFailure(404, "poll_not_found", "This Poll was not found.");
  if (poll.state !== "open" || !poll.is_public) throw new AuthFailure(409, "poll_not_open", "This Poll is not accepting votes.");
  if (poll.web_voting_mode === "signed_in" && actor.namespace !== "web_account") throw new AuthFailure(401, "authentication_required", "Sign in to vote in this Poll.");
  const optionId = clean(input.optionId, 180);
  if (!ID.test(optionId)) throw new AuthFailure(400, "poll_option_invalid", "Choose a valid Poll option.");
  const voterHash = await voterKeyHash(env, actor.namespace, actor.key);
  await enforcePollRateLimit(env, "web_vote", `${poll.id}:${voterHash}`, 60, 60);
  const previous = await db.prepare("SELECT option_id FROM poll_votes WHERE poll_id=? AND source_namespace=? AND voter_key_hash=?")
    .bind(poll.id, actor.namespace, voterHash).first();
  const timestamp = nowIso();
  const result = await db.prepare(`INSERT INTO poll_votes (poll_id,source_namespace,voter_key_hash,option_id,actor_label,created_at,updated_at)
    SELECT p.id,?,?,?,?,?,? FROM polls p JOIN poll_options o ON o.poll_id=p.id AND o.id=? WHERE p.id=? AND p.state='open' AND p.revision=?
    ON CONFLICT(poll_id,source_namespace,voter_key_hash) DO UPDATE SET option_id=excluded.option_id,updated_at=excluded.updated_at`)
    .bind(actor.namespace, voterHash, optionId, actor.label || null, timestamp, timestamp, optionId, poll.id, poll.revision).run();
  if (Number(result?.meta?.changes || 0) < 1) throw new AuthFailure(409, "poll_closed_during_submission", "The Poll closed before the vote could be recorded.");
  const changed = Boolean(previous && previous.option_id !== optionId);
  const repeated = Boolean(previous && previous.option_id === optionId);
  await activity(env, poll.id, actor.accountId || null, repeated ? "web_vote_noop" : changed ? "web_vote_changed" : "web_vote_recorded", "success", { source: actor.namespace });
  const detail = await projectDetail(env, poll, actor.accountId || "", { namespace: actor.namespace, voterHash });
  return { ok: true, poll: detail, vote: { optionId, repeated, changed }, refreshedAt: nowIso() };
}

export async function adminPollLibrary(env, input = {}) {
  const state = STATES.has(input.state) ? input.state : "all";
  const owner = clean(input.owner, 160);
  const type = clean(input.type, 20);
  if (type && !['regular', 'abootnothing'].includes(type)) throw new AuthFailure(400, 'poll_type_invalid', 'Choose a supported Poll collection.');
  if (type) await paidSchema(env);
  const db = requirePollDb(env);
  const rows = await db.prepare(`SELECT p.*,(SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id=p.id) AS total_votes
    FROM polls p WHERE (?='all' OR p.state=?) AND (?='' OR p.owner_account_id=?) ${type ? 'AND p.presentation_type=?' : ''} ORDER BY p.updated_at DESC LIMIT 250`)
    .bind(state, state, owner, owner, ...(type ? [type] : [])).all();
  return { ok: true, items: await Promise.all((rows?.results || []).map((row) => projectSummary(env, row))), count: (rows?.results || []).length };
}

export async function adminPollAccess(env) {
  const db = requirePollDb(env);
  const grants = await db.prepare("SELECT * FROM poll_creator_grants ORDER BY updated_at DESC LIMIT 250").all();
  return { ok: true, grants: await Promise.all((grants?.results || []).map(async (row) => ({ ...row, account: await accountProjection(env, row.account_id) }))) };
}

export async function mutatePollCreatorGrant(env, actorAccountId, input) {
  const accountId = clean(input.accountId, 160);
  const action = clean(input.action, 20);
  if (!accountId || !new Set(["approve", "revoke"]).has(action)) throw new AuthFailure(400, "poll_grant_invalid", "Choose an account and a valid creator action.");
  const account = await activeAccount(env, accountId);
  if (!account) throw new AuthFailure(404, "account_not_found", "That account was not found.");
  const timestamp = nowIso();
  await requirePollDb(env).prepare(`INSERT INTO poll_creator_grants (account_id,active,may_create_polls,granted_by_account_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET active=excluded.active,may_create_polls=excluded.may_create_polls,
    granted_by_account_id=excluded.granted_by_account_id,updated_at=excluded.updated_at`)
    .bind(accountId, action === "approve" ? 1 : 0, action === "approve" ? 1 : 0, actorAccountId, timestamp, timestamp).run();
  await activity(env, null, actorAccountId, `poll_creator_${action}d`, "success", { targetAccountId: accountId });
  return adminPollAccess(env);
}

export async function automationsStatus(env) {
  const db = requirePollDb(env);
  const [config, heartbeat, activePoll, activityRows] = await Promise.all([
    db.prepare("SELECT * FROM bot_automation_config WHERE singleton_id=1").first(),
    db.prepare("SELECT * FROM bot_runtime_heartbeat WHERE singleton_id=1").first(),
    db.prepare(`SELECT p.* FROM poll_rumble_leases l JOIN polls p ON p.id=l.poll_id LIMIT 1`).first(),
    db.prepare("SELECT * FROM poll_activity_events ORDER BY created_at DESC LIMIT 40").all(),
  ]);
  const runtime = safeJson(heartbeat?.runtime_json, {});
  const ageSeconds = heartbeat ? Math.max(0, Math.floor((Date.now() - Date.parse(heartbeat.heartbeat_at)) / 1000)) : null;
  const freshness = heartbeatFreshness(runtime);
  return {
    ok: true,
    config: { desiredRevision: Number(config?.desired_revision || 1), desiredState: safeJson(config?.desired_state_json, {}), updatedAt: config?.updated_at || null },
    runtime: heartbeat ? { ...runtime, startupInstanceId: heartbeat.startup_instance_id, botVersion: heartbeat.bot_version, desiredRevision: Number(heartbeat.desired_revision), appliedRevision: Number(heartbeat.applied_revision), heartbeatAt: heartbeat.heartbeat_at, ageSeconds, freshness, state: heartbeatState(ageSeconds, freshness) } : { state: "offline", configured: false },
    activePoll: activePoll ? await projectDetail(env, activePoll) : null,
    deferred: { processControl: true, generalTriggerStudio: false, rants: false, wheelExecution: false },
    activity: activityRows?.results || [],
  };
}

export async function updateAutomationConfig(env, actorAccountId, input) {
  const db = requirePollDb(env);
  const current = await db.prepare("SELECT * FROM bot_automation_config WHERE singleton_id=1").first();
  const expected = integer(input.revision, 1, 1_000_000, "config_revision_invalid");
  if (expected !== Number(current?.desired_revision || 1)) throw new AuthFailure(409, "config_revision_conflict", "Bot configuration changed after it was loaded.");
  const state = validateDesiredState(input.desiredState, safeJson(current?.desired_state_json, {}));
  const revision = expected + 1;
  const result = await db.prepare("UPDATE bot_automation_config SET desired_revision=?,desired_state_json=?,updated_by_account_id=?,updated_at=? WHERE singleton_id=1 AND desired_revision=?")
    .bind(revision, JSON.stringify(state), actorAccountId, nowIso(), expected).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "config_revision_conflict", "Bot configuration changed during update.");
  await activity(env, null, actorAccountId, "bot_desired_config_changed", "success", { revision });
  return automationsStatus(env);
}

export async function verifyBotServiceRequest(request, env, rawBody = "") {
  const secret = String(env?.THIRDRAILIFY_BOT_ADMIN_SECRET || "");
  const timestamp = String(request.headers.get("x-thirdrailify-timestamp") || "");
  const requestId = String(request.headers.get("x-thirdrailify-request-id") || "");
  const signature = String(request.headers.get("x-thirdrailify-signature") || "");
  if (!secret) throw new AuthFailure(503, "bot_service_not_configured", "Bot service authentication is not configured.");
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > SERVICE_WINDOW_SECONDS || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) {
    throw new AuthFailure(401, "bot_signature_invalid", "The bot service request could not be verified.");
  }
  const bytes = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : new Uint8Array(rawBody || []);
  const digest = await digestHex(bytes);
  const pathname = new URL(request.url).pathname;
  const expected = await hmacSha256(secret, `${request.method}\n${pathname}\n${timestamp}\n${requestId}\n${digest}`);
  if (!timingSafeEqual(expected, signature)) throw new AuthFailure(401, "bot_signature_invalid", "The bot service request could not be verified.");
  const db = requirePollDb(env);
  const timestampIso = nowIso();
  await db.prepare("DELETE FROM bot_service_nonces WHERE expires_at < ?").bind(timestampIso).run();
  try {
    await db.prepare("INSERT INTO bot_service_nonces (request_id,route,received_at,expires_at) VALUES (?,?,?,?)")
      .bind(requestId, pathname, timestampIso, nowIso(Date.now() + SERVICE_WINDOW_SECONDS * 1000)).run();
  } catch (error) {
    if (/UNIQUE constraint/i.test(String(error?.message || error))) throw new AuthFailure(409, "bot_request_replayed", "The bot service request was already received.");
    throw error;
  }
}

export async function verifyPublicPollRequest(request, env, rawBody = "") {
  const secret = String(env?.THIRDRAILIFY_COMMUNITY_API_SECRET || "");
  const timestamp = String(request.headers.get("x-thirdrailify-timestamp") || "");
  const requestId = String(request.headers.get("x-thirdrailify-request-id") || "");
  const signature = String(request.headers.get("x-thirdrailify-signature") || "");
  if (!secret) throw new AuthFailure(503, "poll_public_relay_not_configured", "The Public Poll relay is not configured.");
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > SERVICE_WINDOW_SECONDS || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) {
    throw new AuthFailure(401, "poll_signature_invalid", "The Public Poll request could not be verified.");
  }
  const bytes = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : new Uint8Array(rawBody || []);
  const digest = await digestHex(bytes); const pathname = new URL(request.url).pathname;
  const expected = await hmacSha256(secret, `${request.method}\n${pathname}\n${timestamp}\n${requestId}\n${digest}`);
  if (!timingSafeEqual(expected, signature)) throw new AuthFailure(401, "poll_signature_invalid", "The Public Poll request could not be verified.");
  await retainServiceNonce(env, requestId, pathname);
}

export async function botDesiredConfig(env) {
  const db = requirePollDb(env);
  const config = await db.prepare("SELECT * FROM bot_automation_config WHERE singleton_id=1").first();
  return { ok: true, revision: Number(config?.desired_revision || 1), desiredState: safeJson(config?.desired_state_json, {}), fetchedAt: nowIso() };
}

export async function synchronizeBotDesiredConfig(env, input) {
  const db = requirePollDb(env);
  const current = await db.prepare("SELECT * FROM bot_automation_config WHERE singleton_id=1").first();
  const expected = integer(input.revision, 1, 1_000_000, "config_revision_invalid");
  if (expected !== Number(current?.desired_revision || 1)) throw new AuthFailure(409, "config_revision_conflict", "Bot configuration changed after it was loaded.");
  const state = validateDesiredState(input.desiredState, safeJson(current?.desired_state_json, {}));
  const revision = expected + 1;
  const result = await db.prepare("UPDATE bot_automation_config SET desired_revision=?,desired_state_json=?,updated_by_account_id=NULL,updated_at=? WHERE singleton_id=1 AND desired_revision=?")
    .bind(revision, JSON.stringify(state), nowIso(), expected).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "config_revision_conflict", "Bot configuration changed during synchronization.");
  await activity(env, null, null, "slash_command_config_synchronized", "success", { revision });
  return botDesiredConfig(env);
}

export async function botActivePoll(env) {
  const row = await requirePollDb(env).prepare(`SELECT p.* FROM poll_rumble_leases l JOIN polls p ON p.id=l.poll_id
    WHERE p.state='open' AND p.rumble_enabled=1 LIMIT 1`).first();
  if (!row) return { ok: true, activePoll: null, fetchedAt: nowIso() };
  const options = await optionsForPoll(env, row.id);
  const paidContext = await activePaidContext(env, row, options);
  return { ok: true, activePoll: { id: row.id, paidContext, presentationType: row.presentation_type || "regular", revision: Number(row.revision), openedAt: row.opened_at, sourceScope: row.rumble_source_scope,
    livestreamMode: row.rumble_livestream_mode, livestreamId: row.rumble_livestream_id || null, requestedIntervalSeconds: Number(row.requested_interval_seconds),
    options: options.map((option) => ({ id: option.id, normalizedTrigger: option.normalizedTrigger })) }, fetchedAt: nowIso() };
}

export async function recordBotHeartbeat(env, input) {
  const instanceId = boundedId(input.startupInstanceId, "bot_instance_invalid");
  const version = clean(input.botVersion, 40);
  if (!version) throw new AuthFailure(400, "bot_version_invalid", "Bot version is required.");
  const desired = integer(input.desiredRevision, 0, 1_000_000, "config_revision_invalid");
  const applied = integer(input.appliedRevision, 0, 1_000_000, "config_revision_invalid");
  const runtime = sanitizeRuntime(input.runtime);
  runtime.pollCreditProtocol = input.runtime?.pollCreditProtocol === 2 ? 2 : 0;
  runtime.pollCreditWindowId = clean(input.runtime?.pollCreditWindowId, 180);
  runtime.pollCreditPolicyRevision = Number.isSafeInteger(input.runtime?.pollCreditPolicyRevision) ? input.runtime.pollCreditPolicyRevision : 0;
  runtime.pollCreditBacklog = Number.isSafeInteger(input.runtime?.pollCreditBacklog) ? input.runtime.pollCreditBacklog : 0;
  runtime.pollCreditFault = clean(input.runtime?.pollCreditFault, 80);
  const timestamp = nowIso();
  await requirePollDb(env).prepare(`INSERT INTO bot_runtime_heartbeat
    (singleton_id,startup_instance_id,bot_version,desired_revision,applied_revision,runtime_json,heartbeat_at,updated_at)
    VALUES (1,?,?,?,?,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET startup_instance_id=excluded.startup_instance_id,
    bot_version=excluded.bot_version,desired_revision=excluded.desired_revision,applied_revision=excluded.applied_revision,
    runtime_json=excluded.runtime_json,heartbeat_at=excluded.heartbeat_at,updated_at=excluded.updated_at`)
    .bind(instanceId, version, desired, applied, JSON.stringify(runtime), timestamp, timestamp).run();
  return { ok: true, receivedAt: timestamp };
}

export async function ingestRumbleVotes(env, input) {
  const pollId = boundedId(input.pollId, "poll_id_invalid");
  const revision = integer(input.pollRevision, 1, 1_000_000, "poll_revision_invalid");
  const events = Array.isArray(input.events) ? input.events : [];
  if (!events.length || events.length > 100) throw new AuthFailure(400, "vote_batch_invalid", "Submit between 1 and 100 Rumble vote events.");
  const db = requirePollDb(env);
  const poll = await db.prepare("SELECT * FROM polls WHERE id=? LIMIT 1").bind(pollId).first();
  if (!poll || poll.state !== "open" || !poll.rumble_enabled) throw new AuthFailure(409, "poll_not_open", "The active Poll is no longer accepting Rumble votes.");
  if (Number(poll.revision) !== revision) throw new AuthFailure(409, "stale_poll_revision", "Refresh the active Poll before sending more votes.");
  const accepted = { accepted: 0, duplicate: 0, noOp: 0, changed: 0 };
  for (const event of events) {
    const parsed = validateRumbleEvent(event, poll);
    const exists = await db.prepare("SELECT event_fingerprint FROM poll_rumble_event_fingerprints WHERE event_fingerprint=?").bind(parsed.fingerprint).first();
    if (exists) { accepted.duplicate += 1; continue; }
    const option = await db.prepare("SELECT id FROM poll_options WHERE poll_id=? AND id=?").bind(poll.id, parsed.optionId).first();
    if (!option) throw new AuthFailure(400, "poll_option_invalid", "A Rumble vote referenced an option outside this Poll.");
    const actorHash = await voterKeyHash(env, "rumble_chat", parsed.actorKey);
    const prior = await db.prepare("SELECT option_id FROM poll_votes WHERE poll_id=? AND source_namespace='rumble_chat' AND voter_key_hash=?").bind(poll.id, actorHash).first();
    const timestamp = nowIso();
    try {
      const results = await db.batch([
        db.prepare(`INSERT INTO poll_rumble_event_fingerprints
          (event_fingerprint,poll_id,poll_revision,option_id,source_scope,livestream_id,actor_key_hash,actor_label,provider_event_at,ingested_at)
          SELECT ?,p.id,?,?,?,?,?,?,?,? FROM polls p WHERE p.id=? AND p.state='open' AND p.revision=?`)
          .bind(parsed.fingerprint, revision, parsed.optionId, parsed.sourceScope, parsed.livestreamId, actorHash, parsed.actorLabel, parsed.providerEventAt, timestamp, poll.id, revision),
        db.prepare(`INSERT INTO poll_votes (poll_id,source_namespace,voter_key_hash,option_id,actor_label,created_at,updated_at)
          SELECT id,'rumble_chat',?,?,?,?,? FROM polls WHERE id=? AND state='open' AND revision=?
          ON CONFLICT(poll_id,source_namespace,voter_key_hash) DO UPDATE SET option_id=excluded.option_id,actor_label=excluded.actor_label,updated_at=excluded.updated_at`)
          .bind(actorHash, parsed.optionId, parsed.actorLabel, timestamp, timestamp, poll.id, revision),
      ]);
      if (results.some((result) => Number(result?.meta?.changes || 0) < 1)) throw new AuthFailure(409, "poll_closed_during_ingestion", "The Poll closed before this Rumble vote could be recorded.");
    } catch (error) {
      if (/UNIQUE constraint/i.test(String(error?.message || error))) { accepted.duplicate += 1; continue; }
      throw error;
    }
    if (prior?.option_id === parsed.optionId) accepted.noOp += 1;
    else if (prior) accepted.changed += 1;
    else accepted.accepted += 1;
  }
  return { ok: true, ...accepted, pollRevision: revision };
}

async function projectSummary(env, row) {
  const publicVisible = Boolean(row.is_public) && (new Set(["open", "closed"]).has(row.state) || (row.state === "draft" && !row.opened_at));
  const [options, banner] = await Promise.all([
    optionResults(env, row.id, publicVisible),
    requirePollDb(env).prepare("SELECT * FROM poll_media_assets WHERE poll_id=? AND purpose='banner' AND lifecycle='active' LIMIT 1").bind(row.id).first(),
  ]);
  return { streamUrl: rumbleStreamUrl(safeJson(row.presentation_json, {}).streamUrl), id: row.id, presentationType: row.presentation_type || "regular", presentation: safeJson(row.presentation_json, {}), resultsRevision: Number(row.results_revision || 0), credits: await creditProjection(env, row.id), votingPolicy: await publicPollPolicy(env, row.id), slug: row.public_slug, title: row.title, description: row.description || null, state: row.state,
    public: Boolean(row.is_public), upcoming: row.state === "draft" && !row.opened_at, webVotingMode: row.web_voting_mode, rumbleEnabled: Boolean(row.rumble_enabled),
    rumbleSourceScope: row.rumble_source_scope || null, revision: Number(row.revision), totalVotes: options.reduce((sum, item) => sum + item.votes, 0),
    options, ordinaryVoterIdentities: options.reduce((sum, item) => sum + item.ordinaryVotes, 0), owner: await accountProjection(env, row.owner_account_id), theme: projectTheme(safeJson(row.theme_json, {})),
    media: { banner: projectPollMediaAsset(banner, env, publicVisible) }, updatedAt: row.updated_at, openedAt: row.opened_at || null, closedAt: row.closed_at || null };
}

async function projectDetail(env, row, accountId = "", voteIdentity = null) {
  const summary = await projectSummary(env, row);
  let currentVote = null;
  if (voteIdentity?.voterHash) currentVote = await requirePollDb(env).prepare("SELECT option_id FROM poll_votes WHERE poll_id=? AND source_namespace=? AND voter_key_hash=?")
    .bind(row.id, voteIdentity.namespace, voteIdentity.voterHash).first();
  else if (accountId) currentVote = await requirePollDb(env).prepare("SELECT option_id FROM poll_votes WHERE poll_id=? AND source_namespace='web_account' AND voter_key_hash=?")
    .bind(row.id, await voterKeyHash(env, "web_account", `account:${accountId}`)).first();
  const historyReady = await requirePollDb(env).prepare("SELECT 1 FROM sqlite_master WHERE name='poll_result_history'").first();
  const history = historyReady ? (await requirePollDb(env).prepare('SELECT id,snapshot_json,created_at FROM poll_result_history WHERE poll_id=? ORDER BY created_at DESC LIMIT 100').bind(row.id).all()).results.map(h => ({ id:h.id,resetAt:h.created_at,...JSON.parse(h.snapshot_json) })) : [];
  return { ...summary, history, livestreamMode: row.rumble_livestream_mode, livestreamId: row.rumble_livestream_id || null,
    requestedIntervalSeconds: Number(row.requested_interval_seconds), currentVoteOptionId: currentVote?.option_id || null };
}

async function optionResults(env, pollId, publicVisible = false) {
  const rows = await requirePollDb(env).prepare(`SELECT o.*,a.id AS image_asset_id,a.purpose AS image_purpose,a.poll_option_id AS image_option_id,
    a.content_type AS image_content_type,a.byte_size AS image_byte_size,a.width AS image_width,a.height AS image_height,
    a.sha256 AS image_sha256,a.original_filename AS image_original_filename,a.created_at AS image_created_at,
    (SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id=o.poll_id AND v.option_id=o.id) AS votes
    FROM poll_options o LEFT JOIN poll_media_assets a ON a.poll_option_id=o.id AND a.purpose='option' AND a.lifecycle='active'
    WHERE o.poll_id=? ORDER BY o.display_position`).bind(pollId).all();
  const bonuses = await bonusOptions(env, pollId);
  const manualReady = await requirePollDb(env).prepare("SELECT 1 FROM sqlite_master WHERE name='poll_manual_votes'").first();
  const historyReady = await requirePollDb(env).prepare("SELECT 1 FROM sqlite_master WHERE name='poll_result_history'").first();
  const manualRows = manualReady ? (await requirePollDb(env).prepare(`SELECT option_id,SUM(amount) AS votes FROM poll_manual_votes WHERE poll_id=? ${historyReady ? 'AND request_id NOT IN (SELECT request_id FROM poll_reset_manual_votes)' : ''} GROUP BY option_id`).bind(pollId).all()).results : [];
  const manual = new Map((manualRows || []).map(row => [row.option_id, Number(row.votes)]));
  return (rows?.results || []).map((row) => ({ id: row.id, position: Number(row.display_position), label: row.label,
    description: row.short_description || null, trigger: row.trigger_raw, normalizedTrigger: row.trigger_normalized, votes: Number(row.votes || 0) + (bonuses.get(row.id) || 0) + (manual.get(row.id) || 0), manualVotes: manual.get(row.id) || 0, ordinaryVotes: Number(row.votes || 0), bonusVotes: bonuses.get(row.id) || 0,
    image: projectPollMediaAsset(row.image_asset_id ? { id: row.image_asset_id, purpose: row.image_purpose, poll_option_id: row.image_option_id,
      content_type: row.image_content_type, byte_size: row.image_byte_size, width: row.image_width, height: row.image_height,
      sha256: row.image_sha256, original_filename: row.image_original_filename, created_at: row.image_created_at } : null, env, publicVisible) }));
}

async function optionsForPoll(env, pollId) { return optionResults(env, pollId); }

async function accountProjection(env, accountId) {
  try {
    const row = await loadAccountById(env, accountId);
    const account = await serializeAccount(env, row);
    return account ? { id: account.id, displayName: account.displayName, avatarUrl: account.avatarUrl || null, adminLevel: account.adminLevel || null } : { id: accountId, displayName: "Unavailable account", avatarUrl: null, adminLevel: null };
  } catch { return { id: accountId, displayName: "Unavailable account", avatarUrl: null, adminLevel: null }; }
}

async function activeAccount(env, accountId) {
  const row = await loadAccountById(env, accountId);
  if (!row) return null;
  const account = await serializeAccount(env, row);
  return account?.status === "active" ? account : null;
}

function adminAccess(account) { return { canManageAll: Boolean(accessForAccount(account).isAdmin && new Set(["full", "master"]).has(account.adminLevel)) }; }

async function requireCreator(env, accountId) {
  const account = await activeAccount(env, accountId);
  if (!account) throw new AuthFailure(401, "authentication_required", "Sign in with an active account.");
  if (adminAccess(account).canManageAll) return account;
  const grant = await requirePollDb(env).prepare("SELECT active,may_create_polls FROM poll_creator_grants WHERE account_id=?").bind(accountId).first();
  if (!grant?.active || !grant?.may_create_polls) throw new AuthFailure(403, "poll_creator_not_approved", "Poll creation requires an Admin creator grant.");
  return account;
}

async function pollAccess(env, accountId, poll) {
  if (!accountId) return { canManage: false, canManageAll: false, isOwner: false };
  const account = await activeAccount(env, accountId);
  const canManageAll = Boolean(account && adminAccess(account).canManageAll);
  const isOwner = poll.owner_account_id === accountId;
  return { canManage: canManageAll || isOwner, canManageAll, isOwner };
}

async function requireManagedPoll(env, accountId, slug) {
  const row = await requirePollDb(env).prepare("SELECT * FROM polls WHERE public_slug=? LIMIT 1").bind(clean(slug, 80)).first();
  if (!row) throw new AuthFailure(404, "poll_not_found", "This Poll was not found.");
  if (!(await pollAccess(env, accountId, row)).canManage) throw new AuthFailure(403, "poll_owner_required", "Only the owner or an Admin may manage this Poll.");
  return row;
}

function validatePollInput(input, { creating, current = {} }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AuthFailure(400, "poll_input_invalid", "Poll details are required.");
  const title = required(input.title ?? current.title, 1, 140, "poll_title_invalid");
  const description = optional(input.description ?? current.description, 2000);
  const webVotingMode = clean(input.webVotingMode ?? current.web_voting_mode ?? "anyone", 30);
  if (!WEB_MODES.has(webVotingMode)) throw new AuthFailure(400, "poll_voting_mode_invalid", "Choose a supported web voting mode.");
  const rumbleEnabled = Boolean(input.rumbleEnabled ?? current.rumble_enabled);
  const rumbleSourceScope = optional(input.rumbleSourceScope ?? current.rumble_source_scope, 200);
  if (rumbleEnabled && !SOURCE_SCOPE.test(rumbleSourceScope || "")) throw new AuthFailure(400, "rumble_source_invalid", "Use channel:<id> or user:<id> for the Rumble source.");
  const livestreamMode = clean(input.livestreamMode ?? current.rumble_livestream_mode ?? "automatic", 20);
  if (!STREAM_MODES.has(livestreamMode)) throw new AuthFailure(400, "rumble_livestream_mode_invalid", "Choose automatic or exact livestream selection.");
  const livestreamId = optional(input.livestreamId ?? current.rumble_livestream_id, 160);
  if (livestreamMode === "exact" && !livestreamId) throw new AuthFailure(400, "rumble_livestream_required", "Enter the exact livestream ID.");
  const intervalSeconds = integer(input.requestedIntervalSeconds ?? current.requested_interval_seconds ?? 15, 10, 30, "poll_interval_invalid");
  const theme = input.theme && typeof input.theme === "object" && !Array.isArray(input.theme) ? sanitizeTheme(input.theme) : safeJson(current.theme_json, {});
  const presentationType = input.presentationType ?? current.presentation_type ?? 'regular';
  if (!['regular', 'abootnothing'].includes(presentationType)) throw new AuthFailure(400, 'poll_type_invalid', 'Choose regular or Aboot Nothing.');
  const presentation = input.presentation ?? safeJson(current.presentation_json, {});
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) throw new AuthFailure(400, 'poll_presentation_invalid', 'Invalid matchup appearance.');
  const colors = presentation.colors ?? ['#f3c928', '#a9b7da'];
  if (!Array.isArray(colors) || colors.length !== 2 || colors.some(c => !/^#[0-9a-f]{6}$/i.test(c))) throw new AuthFailure(400, 'poll_presentation_invalid', 'Choose two six-digit feature colours.');
  return { presentationType, presentation: { colors, streamUrl: validateStreamUrl(input.streamUrl !== undefined ? input.streamUrl : presentation.streamUrl !== undefined ? presentation.streamUrl : safeJson(current.presentation_json, {}).streamUrl), context: optional(presentation.context, 160), featuredOrder: integer(presentation.featuredOrder ?? 0, 0, 999, 'poll_feature_order_invalid') }, title, description, webVotingMode, rumbleEnabled, rumbleSourceScope: rumbleEnabled ? rumbleSourceScope : null,
    livestreamMode, livestreamId: livestreamMode === "exact" ? livestreamId : null, intervalSeconds, theme, creating };
}

function validateOptions(values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 12) throw new AuthFailure(400, "poll_options_invalid", "A Poll requires 2 to 12 options.");
  const triggers = new Set();
  return values.map((value, position) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthFailure(400, "poll_option_invalid", "Each Poll option must be an object.");
    const label = required(value.label, 1, 160, "poll_option_label_invalid");
    const triggerRaw = String(value.trigger ?? position + 1);
    const triggerNormalized = validatePollTrigger(triggerRaw);
    if (!triggerNormalized) throw new AuthFailure(400, "poll_trigger_invalid", "Poll triggers must contain 1 to 64 safe characters after normalization.");
    if (triggers.has(triggerNormalized)) throw new AuthFailure(409, "poll_trigger_collision", "Poll triggers must be unique after normalization.");
    triggers.add(triggerNormalized);
    return { id: ID.test(String(value.id || "")) ? String(value.id) : `opt_${randomId()}`, position, label,
      description: optional(value.description, 240), triggerRaw: triggerRaw.normalize("NFKC").trim(), triggerNormalized };
  });
}

function validateRumbleEvent(event, poll) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new AuthFailure(400, "rumble_event_invalid", "A Rumble vote event is invalid.");
  const fingerprint = clean(event.eventFingerprint, 64).toLowerCase();
  const sourceScope = clean(event.sourceScope, 200);
  const livestreamId = clean(event.livestreamId, 160);
  const actorKey = clean(event.actorKey, 300);
  const actorLabel = optional(event.actorLabel, 100);
  const optionId = clean(event.optionId, 180);
  const providerTime = new Date(event.providerEventAt);
  if (!Number.isFinite(providerTime.getTime())) throw new AuthFailure(400, "rumble_event_invalid", "A Rumble vote event has an invalid provider timestamp.");
  const providerEventAt = providerTime.toISOString();
  if (!SHA256.test(fingerprint) || sourceScope !== poll.rumble_source_scope || !livestreamId || !actorKey || !ID.test(optionId)) throw new AuthFailure(400, "rumble_event_invalid", "A Rumble vote event failed authority validation.");
  if (poll.rumble_livestream_mode === "exact" && livestreamId !== poll.rumble_livestream_id) throw new AuthFailure(409, "rumble_livestream_mismatch", "The vote came from a different livestream.");
  if (Date.parse(providerEventAt) < Date.parse(poll.opened_at)) throw new AuthFailure(409, "rumble_event_before_open", "Messages sent before the Poll opened cannot vote.");
  return { fingerprint, sourceScope, livestreamId, actorKey, actorLabel, optionId, providerEventAt };
}

function validateDesiredState(input, current) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AuthFailure(400, "bot_config_invalid", "Bot desired state must be an object.");
  const discord = input.discord && typeof input.discord === "object" ? input.discord : current.discord || {};
  const rumble = input.rumble && typeof input.rumble === "object" ? input.rumble : current.rumble || {};
  return { discord: { notificationChannelId: optional(discord.notificationChannelId, 32), mentionRoleId: optional(discord.mentionRoleId, 32) },
    rumble: { enabled: Boolean(rumble.enabled), intervalSeconds: integer(rumble.intervalSeconds ?? current.rumble?.intervalSeconds ?? 120, 30, 86_400, "rumble_interval_invalid"),
      pollIntervalSeconds: integer(rumble.pollIntervalSeconds ?? 15, 10, 30, "poll_interval_invalid") }, processControl: "deferred" };
}

function sanitizeRuntime(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const allowed = ["discordConnected","rumbleConfigured","lastConfigSync","lastRumbleFetch","sourceLabel","sourceScopeType","livestreamId","livestreamTitle","pollLeaseActive","activePollId","activePollRevision","pollingIntervalSeconds","lastProviderTime","lastAcceptedVoteTime","backlogMayBeTruncated","errorCode","providerState","configSyncState","nextPollAt","backoffSeconds","counters"];
  const result = Object.fromEntries(allowed.filter((key) => key in value).map((key) => [key, sanitizeRuntimeValue(value[key])]));
  if (value.eventAutomation && typeof value.eventAutomation === 'object') {
    const eventKeys = ['raidNoticeVersion','unsupportedRules','activeRules','pending','dropped','malformed','transitions','lastTransition','lastSnapshotAt','lastConfigAt','lastFault','backoffSeconds'];
    result.eventAutomation = Object.fromEntries(eventKeys.filter(key => key in value.eventAutomation).map(key => [key, sanitizeRuntimeValue(value.eventAutomation[key])]));
  }
  const discovery = sanitizeRumbleDiscovery(value.rumbleDiscovery);
  if (discovery) result.rumbleDiscovery = discovery;
  return result;
}
function sanitizeRuntimeValue(value) { if (typeof value === "boolean" || typeof value === "number") return value; if (typeof value === "string") return clean(value, 240); if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [clean(key, 40), typeof item === "number" ? item : clean(item, 80)])); return null; }
function sanitizeTheme(value) { if ("accent" in value && !/^#[0-9a-f]{6}$/i.test(String(value.accent || ""))) throw new AuthFailure(400, "poll_theme_invalid", "Choose a valid six-digit feature tint."); return projectTheme(value); }
function projectTheme(value) { return { accent: /^#[0-9a-f]{6}$/i.test(String(value?.accent || "")) ? String(value.accent).toLowerCase() : "#f3c928", layout: new Set(["bars", "compact"]).has(value?.layout) ? value.layout : "bars" }; }
function sanitizeRumbleDiscovery(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input.source && typeof input.source === "object" && !Array.isArray(input.source) ? input.source : null;
  const scope = clean(source?.scope, 200); const type = clean(source?.type, 20); const id = clean(source?.id, 180);
  if (!SOURCE_SCOPE.test(scope) || !new Set(["channel", "user"]).has(type) || scope !== `${type}:${id}`) return null;
  const livestreams = (Array.isArray(input.livestreams) ? input.livestreams : []).slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const streamId = clean(item.id, 160); const title = clean(item.title, 240); if (!streamId || !title || typeof item.isLive !== "boolean") return [];
    const watching = Number(item.watchingNow); return [{ id: streamId, title, isLive: item.isLive, createdOn: optional(item.createdOn, 80), scheduledOn: optional(item.scheduledOn, 80), visibility: optional(item.visibility, 40), watchingNow: Number.isFinite(watching) ? Math.max(0, Math.min(10_000_000, Math.floor(watching))) : null }];
  });
  return { provider: "rumble", source: { scope, type, id, displayName: clean(source.displayName, 100) || id }, providerResponseAt: optional(input.providerResponseAt, 80), observedAt: optional(input.observedAt, 80), livestreams };
}

async function voterKeyHash(env, namespace, key) {
  const secret = String(env?.THIRDRAILIFY_POLL_VOTER_SECRET || env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || "");
  if (!secret) throw new AuthFailure(503, "poll_voter_secret_not_configured", "Poll voter protection is not configured.");
  return hmacSha256(secret, `poll-voter-v1\n${namespace}\n${key}`);
}

async function enforcePollRateLimit(env, category, identifier, limit, windowSeconds) {
  const secret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || "");
  if (!secret) throw new AuthFailure(503, "rate_limit_not_configured", "Poll abuse protection is not configured.");
  const db = requirePollDb(env); const keyHash = await hmacSha256(secret, `polls\n${category}\n${identifier}`);
  const row = await db.prepare("SELECT * FROM poll_rate_limits WHERE key_hash=? AND category=?").bind(keyHash, category).first();
  const now = Date.now(); if (row?.blocked_until && Date.parse(row.blocked_until) > now) throw new AuthFailure(429, "poll_rate_limited", "Too many Poll requests.", { "Retry-After": "60" });
  const expired = !row || now - Date.parse(row.window_started_at) >= windowSeconds * 1000; const count = expired ? 1 : Number(row.request_count || 0) + 1;
  const blockedUntil = count > limit ? nowIso(now + windowSeconds * 1000) : null; const timestamp = nowIso(now);
  await db.prepare(`INSERT INTO poll_rate_limits (key_hash,category,window_started_at,request_count,blocked_until,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(key_hash,category) DO UPDATE SET window_started_at=excluded.window_started_at,request_count=excluded.request_count,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at`)
    .bind(keyHash, category, expired ? timestamp : row.window_started_at, count, blockedUntil, timestamp).run();
  if (blockedUntil) throw new AuthFailure(429, "poll_rate_limited", "Too many Poll requests.", { "Retry-After": String(windowSeconds) });
}

async function activity(env, pollId, actorAccountId, eventType, result, metadata = null) {
  await requirePollDb(env).prepare(`INSERT INTO poll_activity_events (id,poll_id,actor_account_id,event_type,result,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(`pae_${randomId()}`, pollId || null, actorAccountId || null, clean(eventType, 80), clean(result, 30), metadata ? JSON.stringify(metadata).slice(0, 1000) : null, nowIso()).run();
}

async function retainServiceNonce(env, requestId, pathname) {
  const db = requirePollDb(env); const timestampIso = nowIso();
  await db.prepare("DELETE FROM bot_service_nonces WHERE expires_at < ?").bind(timestampIso).run();
  try {
    await db.prepare("INSERT INTO bot_service_nonces (request_id,route,received_at,expires_at) VALUES (?,?,?,?)")
      .bind(requestId, pathname, timestampIso, nowIso(Date.now() + SERVICE_WINDOW_SECONDS * 1000)).run();
  } catch (error) {
    if (/UNIQUE constraint/i.test(String(error?.message || error))) throw new AuthFailure(409, "service_request_replayed", "The signed service request was already received.");
    throw error;
  }
}

async function uniqueSlug(db, value) { const base = slugify(value); for (let index = 0; index < 100; index += 1) { const candidate = index || new Set(["new", "abootnothing", "access", "mine", "discovery", "media"]).has(base) ? `${base.slice(0, Math.max(2, 76 - String(index).length))}-${index + 1}` : base; if (!(await db.prepare("SELECT id FROM polls WHERE public_slug=?").bind(candidate).first())) return candidate; } throw new AuthFailure(409, "poll_slug_conflict", "A unique Poll URL could not be allocated."); }
function slugify(value) { const slug = String(value || "poll").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80); return SLUG.test(slug) ? slug : `poll-${randomId().slice(0, 8)}`; }
function required(value, minimum, maximum, code) { const text = clean(value, maximum); if (text.length < minimum || String(value ?? "").trim().length > maximum) throw new AuthFailure(400, code, "A required Poll field is outside its allowed length."); return text; }
function optional(value, maximum) { const text = clean(value, maximum); return text || null; }
function clean(value, maximum) { return Array.from(String(value ?? ""), (character) => { const point = character.codePointAt(0) || 0; return point < 32 || point === 127 ? " " : character; }).join("").replace(/\s+/g, " ").trim().slice(0, maximum); }
function integer(value, minimum, maximum, code) { const result = Number(value); if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new AuthFailure(400, code, "A Poll numeric field is outside its allowed range."); return result; }
function boundedListInteger(value, minimum, maximum, fallback) { const result = Number(value); return Number.isSafeInteger(result) && result >= minimum && result <= maximum ? result : fallback; }
function boundedId(value, code) { const result = clean(value, 180); if (!ID.test(result)) throw new AuthFailure(400, code, "A required identifier is invalid."); return result; }
function safeJson(value, fallback) { try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback; } catch { return fallback; } }
function escapeLike(value) { return value.replace(/[\\%_]/g, "\\$&"); }
async function digestHex(bytes) { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export { normalizePollTrigger };
