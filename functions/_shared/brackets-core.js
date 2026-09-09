import { AuthFailure, nowIso } from './auth-core.js';
import { createPoll, getPublicPoll } from './polls-core.js';
import { paidSchema } from './poll-credits.js';
import { hasSchemaObjects } from './schema-capabilities.js';
import { sanitizeWheelMedia } from './wheel-media.js';
import { uid, validate, generate, duplicate, referenceTemplate, safeGraph, opponents, descendants, protectedMatchIds } from '../../src/brackets/model.mjs';

const fail = (status, code, message) => { throw new AuthFailure(status, code, message); };
const parse = value => JSON.parse(value);
const rows = async statement => (await statement.all()).results || [];
const dbFor = env => env.THIRDRAILIFY_COMMERCE_DB;
export async function bracketReady(env) {
  const db = dbFor(env);
  const ready = await hasSchemaObjects(db, ['aboot_brackets','aboot_publications','aboot_poll_links','aboot_decisions','aboot_audit','aboot_guards','aboot_media'], 'table');
  if (!ready) fail(503, 'bracket_schema_required', 'Apply reviewed Matchup Studio migration 0043 before saving.');
  await paidSchema(env);
  return db;
}
async function record(env, id) { const db = await bracketReady(env); const b = await db.prepare('SELECT * FROM aboot_brackets WHERE id=?').bind(id).first(); if (!b) fail(404, 'bracket_not_found', 'This bracket was not found.'); return b; }
const decision = d => ({ id: d.id, matchId: d.match_id, winnerId: d.winner_id, source: d.source, scores: parse(d.scores_json), fingerprint: d.fingerprint, linkId: d.link_id, reason: d.reason, createdAt: d.created_at });
const link = l => ({ id: l.id, matchId: l.match_id, pollId: l.poll_id, mapping: parse(l.mapping_json) });
async function state(env, b) {
  const db = dbFor(env);
  return { graph: parse(b.draft_json), decisions: (await rows(db.prepare('SELECT * FROM aboot_decisions WHERE bracket_id=? AND superseded=0').bind(b.id))).map(decision), links: (await rows(db.prepare('SELECT * FROM aboot_poll_links WHERE bracket_id=? AND active=1').bind(b.id))).map(link) };
}
function guard(db, sql, bindings) { return db.prepare(`INSERT INTO aboot_guards(id,valid) VALUES (?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`).bind(uid('guard'), ...bindings); }
function revisionGuard(db, b) { return guard(db, 'SELECT revision=? FROM aboot_brackets WHERE id=?', [b.revision, b.id]); }
async function write(env, b, actor, input, action, extra = [], change = {}, audit = {}) {
  const db = dbFor(env);
  if (!/^[a-zA-Z0-9_-]{8,90}$/.test(input.requestId || '')) fail(400, 'bracket_request_id', 'A stable action request ID is required.');
  const previous = await db.prepare('SELECT action FROM aboot_audit WHERE bracket_id=? AND request_id=?').bind(b.id, input.requestId).first();
  if (previous) { if (previous.action !== action) fail(409, 'bracket_request_reused', 'This action ID was used for another operation.'); return; }
  if (Number(input.revision) !== Number(b.revision)) fail(409, 'bracket_revision_conflict', 'Another administrator saved changes. Your draft is retained; reload or export it before merging.');
  const timestamp = nowIso();
  try { await db.batch([
    revisionGuard(db, b), ...extra,
    db.prepare('UPDATE aboot_brackets SET title=?,draft_json=?,publication_id=?,public_slug=?,finalized=?,archived=?,revision=revision+1,updated_at=? WHERE id=?').bind(change.title ?? b.title, change.draft_json ?? b.draft_json, change.publication_id === undefined ? b.publication_id : change.publication_id, change.public_slug === undefined ? b.public_slug : change.public_slug, change.finalized ?? b.finalized, change.archived ?? b.archived, timestamp, b.id),
    db.prepare('INSERT INTO aboot_audit VALUES (?,?,?,?,?,?,?)').bind(uid('audit'), b.id, input.requestId, action, actor, JSON.stringify({ ...audit, matchId: input.matchId || null, reason: String(input.reason || '').slice(0, 2000), revision: b.revision, publicationId: change.publication_id || null }), timestamp),
    db.prepare('DELETE FROM aboot_guards'),
  ]); } catch (error) { if (/constraint|valid|unique/i.test(String(error))) fail(409, 'bracket_changed', 'Bracket or source changed during this action. Reload and review; no partial decision was saved.'); throw error; }
}
function insertDecision(db, id, actor, d) {
  return db.prepare('INSERT INTO aboot_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,0)').bind(uid('decision'), id, d.matchId, d.winnerId, d.source, JSON.stringify(d.scores || [null, null]), d.fingerprint || null, d.linkId || null, d.reason, actor, nowIso());
}
export async function createBracket(env, actor, input) {
  const db = await bracketReady(env), id = input.id;
  if (!/^bracket_[a-zA-Z0-9_-]{16,70}$/.test(id || '')) fail(400, 'bracket_id_required', 'A stable new bracket ID is required.');
  const existing = await db.prepare('SELECT id,created_by FROM aboot_brackets WHERE id=?').bind(id).first();
  if (existing) { if (existing.created_by !== actor) fail(409, 'bracket_exists', 'This bracket ID is in use.'); return adminBracket(env, id, actor); }
  const template = input.template === 'reference' ? referenceTemplate() : null;
  let graph;
  if (input.duplicateId) graph = duplicate((await state(env, await record(env, input.duplicateId))).graph);
  else graph = template?.graph || (input.graph ? duplicate(input.graph) : generate(Number(input.size || 16), String(input.title || 'Untitled season')));
  graph = validate(graph);
  // Imports never inherit storage ownership, active links or accepted decisions.
  if (!template) { graph.presentation.feature = null; graph.presentation.cover = null; for (const c of graph.contenders) c.image = null; }
  const at = nowIso();
  await db.batch([
    db.prepare('INSERT INTO aboot_brackets(id,title,draft_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id, graph.title, JSON.stringify(graph), actor, at, at),
    ...(template?.historical || []).map(d => insertDecision(db, id, actor, d)),
    db.prepare('INSERT INTO aboot_audit VALUES (?,?,?,?,?,?,?)').bind(uid('audit'), id, id, 'create', actor, JSON.stringify({ template: input.template || null, duplicateId: input.duplicateId || null }), at),
  ]);
  return adminBracket(env, id, actor);
}
export async function bracketLibrary(env, search = '', archived = false) {
  const db = await bracketReady(env);
  const list = await rows(db.prepare('SELECT * FROM aboot_brackets WHERE archived=? AND title LIKE ? ORDER BY updated_at DESC LIMIT 100').bind(archived ? 1 : 0, `%${String(search).slice(0, 140)}%`));
  return { ok: true, items: await Promise.all(list.map(async b => { const s = await state(env, b); return { id: b.id, title: b.title, revision: b.revision, published: !!b.publication_id, finalized: !!b.finalized, updatedAt: b.updated_at, cover: s.graph.presentation.cover, size: s.graph.size, contenders: s.graph.contenders.length, matches: s.graph.matches.length, linked: s.links.length, completed: s.decisions.length, next: s.graph.matches.find(m => !s.decisions.some(d => d.matchId === m.id) && opponents(s.graph, m, s.decisions).every(Boolean))?.id || null }; })) };
}
async function pollSource(env, l, actor = '') {
  const db = dbFor(env), row = await db.prepare('SELECT * FROM polls WHERE id=?').bind(l.pollId).first();
  if (!row || (!actor && (!row.is_public || !(['open', 'closed'].includes(row.state) || (row.state === 'draft' && !row.opened_at))))) return { state: 'unavailable', fingerprint: null, protected: true };
  let p; try { p = (await getPublicPoll(env, row.public_slug, actor, Boolean(actor))).poll; } catch (e) { if (e.status === 404 || e.statusCode === 404) return { state: 'unavailable', fingerprint: null, protected: true }; throw e; }
  const mapping = Object.entries(l.mapping);
  const valid = p.presentationType === 'abootnothing' && p.options.length === 2 && mapping.length === 2 && new Set(mapping.map(x => x[1])).size === 2 && mapping.every(([, id]) => p.options.some(o => o.id === id));
  const ranked = [...p.options].sort((a, b) => b.votes - a.votes);
  const status = !valid ? 'mapping_changed' : p.state === 'open' ? 'open' : p.state === 'draft' ? 'scheduled' : p.state !== 'closed' ? 'unavailable' : !p.credits?.settled ? 'unsettled' : p.totalVotes === 0 ? 'no_votes' : ranked[0].votes === ranked[1].votes ? 'tie' : 'settled';
  const fingerprint = JSON.stringify([p.id, p.revision, p.resultsRevision, p.state, p.credits?.unresolved, p.options.map(o => [o.id, o.votes])]);
  return { state: status, fingerprint, winnerId: status === 'settled' ? mapping.find(([, oid]) => oid === ranked[0].id)?.[0] : null, scores: Object.fromEntries(mapping.map(([cid, oid]) => [cid, p.options.find(o => o.id === oid)?.votes ?? null])), pollId: p.id, slug: p.slug, title: p.title, public: p.public, revision: p.revision, resultsRevision: p.resultsRevision, unresolved: p.credits?.unresolved || 0, totalVotes: p.totalVotes };
}
async function sources(env, links, actor) { return Object.fromEntries(await Promise.all(links.map(async l => [l.matchId, await pollSource(env, l, actor)]))); }
function reviews(s, sourceMap) {
  const direct = s.decisions.filter(d => d.linkId && (sourceMap[d.matchId]?.fingerprint !== d.fingerprint || (d.source === 'poll' && sourceMap[d.matchId]?.state !== 'settled'))).map(d => d.matchId);
  return [...new Set(direct.flatMap(id => [id, ...descendants(s.graph, id)]))];
}
export async function adminBracket(env, id, actor) {
  const b = await record(env, id), s = await state(env, b), sourceMap = await sources(env, s.links, actor);
  const publication = b.publication_id ? await dbFor(env).prepare('SELECT graph_json FROM aboot_publications WHERE id=?').bind(b.publication_id).first() : null;
  return { ok: true, bracket: { id: b.id, revision: b.revision, finalized: !!b.finalized, archived: !!b.archived, published: !!b.publication_id, publicationId: b.publication_id, slug: b.public_slug, updatedAt: b.updated_at, ...s, sources: sourceMap, needsReview: reviews(s, sourceMap), publication: publication ? parse(publication.graph_json) : null } };
}
async function validateAssets(db, id, graph) {
  for (const asset of new Set([graph.presentation.feature, graph.presentation.cover, ...graph.contenders.map(c => c.image)].filter(Boolean))) {
    if (!await db.prepare('SELECT id FROM aboot_media WHERE id=? AND bracket_id=?').bind(asset, id).first()) fail(400, 'bracket_media_owner', 'Artwork must belong to this bracket.');
  }
}
function structure(graph, protectedIds) {
  const matches = graph.matches.filter(m => protectedIds.has(m.id));
  const placed = new Set(matches.flatMap(m => m.slots.filter(s => s.kind === 'contender').map(s => s.ref)));
  return JSON.stringify({ size: graph.size,
    topology: graph.matches.map(m => [m.id, m.round, m.position, m.slots.map(s => [s.id, m.round ? s.kind : null, m.round ? s.ref : null])]).sort(),
    matches: matches.map(m => [m.id, m.slots]).sort(),
    contenders: graph.contenders.filter(c => placed.has(c.id)).map(c => [c.id, c.name, c.seed]).sort(),
  });
}
export async function mutateBracket(env, id, actor, input) {
  const b = await record(env, id), db = dbFor(env), s = await state(env, b), action = input.action;
  if (await db.prepare('SELECT id FROM aboot_audit WHERE bracket_id=? AND request_id=? AND action=?').bind(id, String(input.requestId || ''), String(action)).first()) return adminBracket(env, id, actor);
  if (b.finalized && !['reopen', 'unpublish', 'archive', 'correct_result'].includes(action)) fail(409, 'bracket_final_locked', 'Reopen this finalized bracket with a reason before editing.');
  if (b.archived && action !== 'restore') fail(409, 'bracket_archived', 'Restore this archived bracket before editing.');
  const change = {}, extra = [], audit = {};
  if (action === 'save') {
    const graph = validate(input.graph); await validateAssets(db, id, graph);
    const protectedIds = new Set(protectedMatchIds(s.graph, [...s.links, ...s.decisions]));
    if (protectedIds.size && structure(graph, protectedIds) !== structure(s.graph, protectedIds)) fail(409, 'bracket_structure_locked', 'Linked or decided matches protect contender identity. Use correction/detach or duplicate as a new draft.');
    change.draft_json = JSON.stringify(graph); change.title = graph.title;
  } else if (action === 'publish') {
    const graph = validate(s.graph); graph.presentation = validate({ ...graph, presentation: input.presentation }).presentation;
    if (!graph.presentation.title || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(graph.presentation.slug)) fail(400, 'bracket_publication_invalid', 'Review a public title and a 3–80 character lowercase URL slug.');
    if (graph.matches.some(m => m.round === 0 && m.slots.some(slot => slot.kind === 'placeholder'))) fail(409, 'bracket_field_incomplete', 'Place contenders or explicit byes in every starting slot before publication.');
    await validateAssets(db, id, graph);
    const publicationId = uid('publication');
    extra.push(db.prepare('INSERT INTO aboot_publications VALUES (?,?,?,?,?)').bind(publicationId, id, JSON.stringify(safeGraph(graph)), actor, nowIso()));
    change.publication_id = publicationId; change.public_slug = graph.presentation.slug; change.draft_json = JSON.stringify(graph);
  } else if (action === 'unpublish' || action === 'archive') { change.publication_id = null; if (action === 'archive') change.archived = 1;
  } else if (action === 'restore') change.archived = 0;
  else if (action === 'reopen') { reason(input); change.finalized = 0; }
  else if (action === 'finalize') {
    const sourceMap = await sources(env, s.links, actor);
    if (reviews(s, sourceMap).length || s.decisions.length !== s.graph.matches.length) fail(409, 'bracket_not_resolved', 'Resolve every required match and all source reviews before finalizing.');
    for (const l of s.links) if (sourceMap[l.matchId]?.state !== 'settled' && s.decisions.find(d => d.matchId === l.matchId)?.source !== 'override') fail(409, 'bracket_unsettled', 'A linked outcome is not settled.');
    for (const l of s.links) extra.push(...sourceGuards(db, l, sourceMap[l.matchId]));
    change.finalized = 1;
  } else if (action === 'link') {
    const m = match(s, input.matchId), pair = opponents(s.graph, m, s.decisions); ready(pair);
    if (reviews(s, await sources(env, s.links, actor)).includes(m.id)) fail(409, 'bracket_upstream_review', 'Resolve the upstream source review before linking another deciding Poll.');
    if (s.links.some(l => l.matchId === m.id)) fail(409, 'bracket_link_exists', 'Detach the existing link before selecting another Poll.');
    if (s.decisions.some(d => d.matchId === m.id)) { if (input.authority !== 'poll') fail(409, 'bracket_authority_review', 'Explicitly choose Poll authority; the historical decision remains in audit.'); await protectDownstream(env, s, m.id); extra.push(db.prepare('UPDATE aboot_decisions SET superseded=1 WHERE bracket_id=? AND match_id=? AND superseded=0').bind(id, m.id)); }
    const l = { id: uid('link'), matchId: m.id, pollId: String(input.pollId), mapping: input.mapping || {} };
    if (Object.keys(l.mapping).length !== 2 || !pair.every(c => l.mapping[c.id])) fail(400, 'bracket_mapping_invalid', 'Map each stable contender explicitly to a distinct Poll option.');
    const source = await pollSource(env, l, actor);
    if (['unavailable', 'mapping_changed'].includes(source.state)) fail(400, 'bracket_poll_incompatible', 'Choose a manageable two-option Aboot Poll with valid option mappings.');
    const p = (await getPublicPoll(env, source.slug, actor, true)).poll;
    if (!pair.every(c => p.options.find(o => o.id === l.mapping[c.id])?.label.normalize('NFKC').trim().toLowerCase() === c.name.normalize('NFKC').trim().toLowerCase())) fail(400, 'bracket_opponent_mismatch', 'Mapped Poll opponents must match the bracket contenders. Review the names and explicit option order.');
    extra.push(...sourceGuards(db, l, source), db.prepare('INSERT INTO aboot_poll_links VALUES (?,?,?,?,?,1,?)').bind(l.id, id, m.id, l.pollId, JSON.stringify(l.mapping), nowIso()));
  } else if (action === 'detach') {
    const m = match(s, input.matchId); reason(input); await protectDownstream(env, s, m.id);
    extra.push(db.prepare('UPDATE aboot_poll_links SET active=0 WHERE bracket_id=? AND match_id=?').bind(id, m.id), db.prepare('UPDATE aboot_decisions SET superseded=1 WHERE bracket_id=? AND match_id=? AND superseded=0').bind(id, m.id));
  } else if (action === 'rollback') {
    reason(input); const m = match(s, input.matchId); await protectDownstream(env, s, m.id);
    for (const mid of [m.id, ...descendants(s.graph, m.id)]) extra.push(db.prepare('UPDATE aboot_decisions SET superseded=1 WHERE bracket_id=? AND match_id=? AND superseded=0').bind(id, mid));
  } else if (action === 'reconcile') {
    reason(input);
    const m = match(s, input.matchId), previous = s.decisions.find(d => d.matchId === m.id), l = s.links.find(l => l.matchId === m.id);
    if (!previous || !l || previous.linkId !== l.id) fail(409, 'bracket_reconcile_missing', 'Choose a match with an accepted linked Poll result.');
    const sourceMap = await sources(env, s.links, actor), source = sourceMap[m.id];
    const ancestorsInReview = s.decisions.some(d => d.matchId !== m.id && descendants(s.graph, d.matchId).includes(m.id) && reviews(s, sourceMap).includes(d.matchId));
    if (ancestorsInReview) fail(409, 'bracket_upstream_review', 'Update the earlier changed result first.');
    if (source.state !== 'settled' || !source.winnerId) fail(409, 'bracket_result_ineligible', 'Close and settle the linked Poll with a unique winner before updating the bracket.');
    if (source.fingerprint !== input.fingerprint) fail(409, 'bracket_result_changed', 'Poll result changed. Review the latest result before confirming.');
    const pair = opponents(s.graph, m, s.decisions); ready(pair);
    if (!pair.some(c => c.id === source.winnerId)) fail(409, 'bracket_mapping_invalid', 'The current Poll winner does not match the resolved opponents.');
    if (source.winnerId !== previous.winnerId) await protectDownstream(env, s, m.id);
    const d = { matchId: m.id, source: 'poll', winnerId: source.winnerId, scores: pair.map(c => source.scores[c.id]), linkId: l.id, fingerprint: source.fingerprint, reason: input.reason.trim() };
    const snapshot = value => ({ winnerId: value.winnerId, winnerName: pair.find(c => c.id === value.winnerId)?.name || value.winnerId, source: value.source, scores: value.scores });
    audit.previousResult = { decisionId: previous.id, ...snapshot(previous) }; audit.replacementResult = snapshot(d);
    extra.push(...sourceGuards(db, l, source), db.prepare('UPDATE aboot_decisions SET superseded=1 WHERE bracket_id=? AND id=? AND superseded=0').bind(id, previous.id), insertDecision(db, id, actor, d));
  } else if (action === 'correct_result') {
    reason(input);
    const m = match(s, input.matchId), previous = s.decisions.find(d => d.matchId === m.id), pair = opponents(s.graph, m, s.decisions);
    if (!previous || !['historical', 'manual', 'bye'].includes(previous.source) || previous.linkId || s.links.some(l => l.matchId === m.id)) fail(409, 'bracket_correction_source', 'Only an accepted historical/manual result or explicit bye can be edited here. Use Poll correction for linked results.');
    if (reviews(s, await sources(env, s.links, actor)).includes(m.id)) fail(409, 'bracket_upstream_review', 'Resolve the upstream source review before correcting this result.');
    const d = { matchId: m.id, source: previous.source, winnerId: input.winnerId, scores: input.scores, reason: input.reason.trim() };
    if (previous.source === 'bye') {
      if (pair.filter(Boolean).length !== 1 || !m.slots.some(slot => slot.kind === 'bye')) fail(409, 'bracket_bye_invalid', 'This is no longer a valid explicit bye.');
      d.winnerId = pair.find(Boolean).id; d.scores = [null, null];
    } else ready(pair);
    if (!pair.some(c => c?.id === d.winnerId)) fail(400, 'bracket_winner_invalid', 'The winner must be a resolved opponent.');
    if (!Array.isArray(d.scores) || d.scores.length !== 2 || d.scores.some(n => n !== null && (!Number.isSafeInteger(n) || n < 0 || n > 1000000000))) fail(400, 'bracket_scores_invalid', 'Scores must be non-negative integers or unknown.');
    if (d.winnerId !== previous.winnerId) await protectDownstream(env, s, m.id);
    const snapshot = value => ({ winnerId: value.winnerId, winnerName: pair.find(c => c?.id === value.winnerId)?.name || value.winnerId, source: value.source, scores: value.scores });
    audit.previousResult = { decisionId: previous.id, ...snapshot(previous) }; audit.replacementResult = snapshot(d);
    extra.push(db.prepare('UPDATE aboot_decisions SET superseded=1 WHERE bracket_id=? AND id=? AND superseded=0').bind(id, previous.id), insertDecision(db, id, actor, d));
  } else if (action === 'advance') {
    const m = match(s, input.matchId), pair = opponents(s.graph, m, s.decisions), l = s.links.find(x => x.matchId === m.id);
    if (s.decisions.some(d => d.matchId === m.id)) fail(409, 'bracket_already_advanced', 'This match has an accepted decision. Review correction before changing it.');
    const sourceMap = await sources(env, s.links, actor);
    if (reviews(s, sourceMap).includes(m.id)) fail(409, 'bracket_upstream_review', 'An upstream result needs review.');
    const d = { matchId: m.id, winnerId: input.winnerId, source: input.source, reason: String(input.reason || '').trim(), scores: input.scores || [null, null] };
    if (l) {
      ready(pair); const source = sourceMap[m.id];
      if (source.fingerprint !== input.fingerprint) fail(409, 'bracket_result_changed', 'Poll result changed. Review the current result before confirming.');
      if (d.source === 'poll') { if (source.state !== 'settled' || !source.winnerId) fail(409, 'bracket_result_ineligible', 'Only a closed, settled, nonempty unique Poll winner can advance.'); d.winnerId = source.winnerId; d.scores = pair.map(c => source.scores[c.id]); d.reason = 'Administrator confirmed the settled Poll result.'; }
      else { if (d.source !== 'override' || !['settled', 'tie', 'no_votes'].includes(source.state)) fail(409, 'bracket_override_ineligible', 'A labelled override requires a closed, settled Poll.'); reason(input); d.scores = pair.map(c => source.scores[c.id]); }
      d.fingerprint = source.fingerprint; d.linkId = l.id; extra.push(...sourceGuards(db, l, source));
    } else if (d.source === 'bye') {
      if (pair.filter(Boolean).length !== 1 || !m.slots.some(slot => slot.kind === 'bye')) fail(409, 'bracket_bye_invalid', 'Only an explicit bye opposite a resolved contender can advance.'); d.winnerId = pair.find(Boolean).id; d.scores = [null, null]; d.reason = 'Explicit bye; no votes or scores awarded.';
    } else { ready(pair); if (!['manual', 'historical'].includes(d.source)) fail(400, 'bracket_source_invalid', 'Choose a historical/manual result.'); reason(input); }
    if (!pair.some(c => c?.id === d.winnerId)) fail(400, 'bracket_winner_invalid', 'The winner must be a resolved opponent.');
    if (!Array.isArray(d.scores) || d.scores.length !== 2 || d.scores.some(n => n !== null && (!Number.isSafeInteger(n) || n < 0 || n > 1000000000))) fail(400, 'bracket_scores_invalid', 'Scores must be non-negative integers or unknown.');
    extra.push(insertDecision(db, id, actor, d));
  } else fail(400, 'bracket_action_invalid', 'Unknown bracket action.');
  await write(env, b, actor, input, action, extra, change, audit);
  return adminBracket(env, id, actor);
}
function reason(input) { if (typeof input.reason !== 'string' || input.reason.trim().length < 5 || input.reason.length > 2000) fail(400, 'bracket_reason_required', 'Enter a clear reason (5–2000 characters) for this audited decision.'); }
function match(s, id) { const m = s.graph.matches.find(x => x.id === id); if (!m) fail(404, 'bracket_match_missing', 'This match was not found.'); return m; }
function ready(pair) { if (!pair.every(Boolean) || pair[0].id === pair[1].id) fail(409, 'bracket_opponents_unresolved', 'Resolve two distinct opponents first.'); }
function sourceGuards(db, l, source) { return [guard(db, 'SELECT revision=? AND results_revision=? FROM polls WHERE id=?', [source.revision, source.resultsRevision, l.pollId])]; }
async function protectDownstream(env, s, id) {
  const affected = descendants(s.graph, id);
  if (s.links.some(l => affected.includes(l.matchId))) fail(409, 'bracket_downstream_linked', 'A downstream Poll is protected. Deliberately detach downstream links first; its votes and credits will remain intact.');
  if (s.decisions.some(d => affected.includes(d.matchId))) fail(409, 'bracket_downstream_decided', 'Roll back downstream decisions from the final round first. Audit history is retained.');
}
export async function correctionPreview(env, id, matchId, actor) {
  const b = await record(env, id), s = await state(env, b), affected = [matchId, ...descendants(s.graph, matchId)];
  return { ok: true, revision: b.revision, affected: affected.map(mid => ({ match: match(s, mid), decision: s.decisions.find(d => d.matchId === mid) || null, link: s.links.find(l => l.matchId === mid) || null })), sources: await sources(env, s.links.filter(l => affected.includes(l.matchId)), actor) };
}
export async function matchAudit(env, id, matchId) {
  const b = await record(env, id), s = await state(env, b); match(s, matchId);
  const db = dbFor(env);
  const decisions = await rows(db.prepare('SELECT * FROM aboot_decisions WHERE bracket_id=? AND match_id=? ORDER BY created_at DESC,rowid DESC').bind(id, matchId));
  const events = await rows(db.prepare("SELECT * FROM aboot_audit WHERE bracket_id=? AND json_extract(details_json,'$.matchId')=? ORDER BY created_at DESC,rowid DESC").bind(id, matchId));
  return { ok: true, decisions: decisions.map(d => ({ ...decision(d), actor: d.actor, superseded: !!d.superseded })), events: events.map(e => ({ id: e.id, action: e.action, actor: e.actor, createdAt: e.created_at, details: parse(e.details_json) })) };
}
export async function pollPicker(env, actor, search = '', page = 1) {
  const db = await bracketReady(env), p = Math.max(1, Math.min(100000, Number(page) || 1));
  const where = "presentation_type='abootnothing' AND title LIKE ?"; const term = `%${String(search).slice(0, 140)}%`;
  const list = await rows(db.prepare(`SELECT public_slug,id FROM polls WHERE ${where} ORDER BY updated_at DESC,id LIMIT 20 OFFSET ?`).bind(term, (p - 1) * 20));
  return { ok: true, page: p, total: (await db.prepare(`SELECT COUNT(*) total FROM polls WHERE ${where}`).bind(term).first()).total, items: await Promise.all(list.map(async row => ({ ...(await getPublicPoll(env, row.public_slug, actor, true)).poll, bracketLink: await db.prepare('SELECT bracket_id,match_id FROM aboot_poll_links WHERE poll_id=? AND active=1').bind(row.id).first() }))) };
}
export async function publicBrackets(env, slug = '') {
  const db = await bracketReady(env);
  if (!slug) {
    const list = await rows(db.prepare('SELECT b.id,b.public_slug,p.graph_json FROM aboot_brackets b JOIN aboot_publications p ON p.id=b.publication_id WHERE b.archived=0 ORDER BY b.updated_at DESC LIMIT 100'));
    return { ok: true, items: list.map(b => ({ id: b.id, slug: b.public_slug, ...parse(b.graph_json).presentation })) };
  }
  const b = await db.prepare('SELECT b.*,p.graph_json FROM aboot_brackets b JOIN aboot_publications p ON p.id=b.publication_id WHERE b.public_slug=? AND b.archived=0').bind(slug).first();
  if (!b) fail(404, 'bracket_not_found', 'This Season Roadmap is not published.');
  const s = await state(env, b); s.graph = parse(b.graph_json);
  s.links = s.links.filter(l => s.graph.matches.some(m => m.id === l.matchId));
  const sourceMap = await sources(env, s.links, ''), hidden = new Set(s.links.filter(l => sourceMap[l.matchId]?.protected).flatMap(l => [l.matchId, ...descendants(s.graph, l.matchId)]));
  const review = reviews(s, sourceMap);
  return { ok: true, bracket: { id: b.id, publicationId: b.publication_id, slug: b.public_slug, graph: s.graph, finalized: !!b.finalized && !review.length && !hidden.size, needsReview: review.filter(id => !hidden.has(id)), decisions: s.decisions.filter(d => !hidden.has(d.matchId) && s.graph.matches.some(m => m.id === d.matchId)).map(d => ({ matchId: d.matchId, winnerId: d.winnerId, source: d.source, scores: d.scores })), sources: Object.fromEntries(Object.entries(sourceMap).map(([id, x]) => [id, x.protected ? { state: 'unavailable' } : { state: x.state, slug: x.slug, scores: x.scores, title: x.title }])) } };
}
export async function importBracketImage(env, id, actor, value, fetchImpl = fetch) {
  const b = await record(env, id);
  if (b.finalized || b.archived) fail(409, 'bracket_image_locked', 'Reopen or restore this bracket before adding images.');
  let url;
  try { url = new URL(String(value || '').trim()); } catch { fail(400, 'bracket_image_url', 'Enter a valid public HTTPS image URL.'); }
  const host = url.hostname.toLowerCase();
  if (url.href.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|test)$/.test(host) || host.endsWith('.home.arpa')) fail(400, 'bracket_image_url', 'Use a public HTTPS image URL without credentials or a custom port.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(url.href, { method: 'GET', headers: { Accept: 'image/png,image/jpeg,image/webp' }, redirect: 'manual', signal: controller.signal });
    if (!response.ok || response.status >= 300) fail(400, 'bracket_image_url_unavailable', 'The image could not be downloaded. Use the final direct image URL or upload the file.');
    const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
    if (!['image/png','image/jpeg','image/webp'].includes(type)) { await response.body?.cancel(); fail(415, 'bracket_image_type', 'The URL must point directly to a PNG, JPG or WebP image.'); }
    const limit = 8 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); fail(413, 'image_too_large', 'Choose an image below 8 MB.'); }
    const reader = response.body?.getReader(); if (!reader) fail(400, 'bracket_image_empty', 'The image URL returned no image.');
    const chunks = []; let length = 0;
    try { while (true) { const { done, value: chunk } = await reader.read(); if (done) break; length += chunk.byteLength; if (length > limit) fail(413, 'image_too_large', 'Choose an image below 8 MB.'); chunks.push(chunk); } } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return await uploadBracketMedia(env, id, actor, bytes, type);
  } catch (error) { if (error instanceof AuthFailure) throw error; fail(400, 'bracket_image_url_unavailable', 'The image could not be downloaded. Check the URL or upload the file.'); }
  finally { clearTimeout(timer); }
}
export async function uploadBracketMedia(env, id, actor, bytes, type) {
  await record(env, id); if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) fail(415, 'bracket_image_type', 'Choose PNG, JPG or WebP.');
  const image = sanitizeWheelMedia(new Uint8Array(bytes), type, 'background'), assetId = uid('asset'), key = `brackets/${id}/${assetId}`;
  const db = dbFor(env); const total = await db.prepare('SELECT COUNT(*) total FROM aboot_media WHERE bracket_id=?').bind(id).first();
  if (total.total >= 256) fail(409, 'bracket_media_limit', 'This bracket has reached its 256 saved image limit.');
  await env.THIRDRAILIFY_PROFILE_MEDIA.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
  try { await db.prepare('INSERT INTO aboot_media VALUES (?,?,?,?,?,?,?)').bind(assetId, id, key, image.contentType, image.bytes.byteLength, actor, nowIso()).run(); } catch (e) { await env.THIRDRAILIFY_PROFILE_MEDIA.delete(key); throw e; }
  return { ok: true, assetId };
}
export async function bracketMedia(env, assetId, authorized = false) {
  const db = await bracketReady(env), asset = await db.prepare('SELECT * FROM aboot_media WHERE id=?').bind(assetId).first();
  if (!asset) fail(404, 'bracket_image_missing', 'This image is unavailable.');
  if (!authorized) {
    const b = await db.prepare('SELECT p.graph_json FROM aboot_brackets b JOIN aboot_publications p ON p.id=b.publication_id WHERE b.id=? AND b.archived=0').bind(asset.bracket_id).first();
    const graph = b && parse(b.graph_json);
    if (!graph || ![graph.presentation.feature, graph.presentation.cover, ...graph.contenders.map(c => c.image)].includes(assetId)) fail(404, 'bracket_image_private', 'This image is not published.');
  }
  const object = await env.THIRDRAILIFY_PROFILE_MEDIA.get(asset.object_key); if (!object) fail(404, 'bracket_image_missing', 'This image is unavailable.');
  return new Response(object.body, { headers: { 'Content-Type': asset.content_type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function createMatchPoll(env, id, actor, input) {
  const b = await record(env, id), s = await state(env, b), db = dbFor(env), m = match(s, input.matchId);
  const existing = s.links.find(l => l.matchId === m.id);
  if (existing) return adminBracket(env, id, actor);
  if (!/^[a-zA-Z0-9_-]{8,90}$/.test(input.requestId || '')) fail(400, 'bracket_request_id', 'A stable action request ID is required.');
  if (b.finalized || b.archived || Number(input.revision) !== b.revision) fail(409, 'bracket_changed', 'Reload an editable bracket before creating a Poll.');
  const pair = opponents(s.graph, m, s.decisions); ready(pair);
  if (reviews(s, await sources(env, s.links, actor)).includes(m.id)) fail(409, 'bracket_upstream_review', 'Resolve the upstream source review before creating another deciding Poll.');
  if (s.decisions.some(d => d.matchId === m.id)) fail(409, 'bracket_historical_authority', 'Review and roll back the historical decision before creating a deciding Poll.');
  const map = Object.fromEntries(pair.map(c => [c.id, uid('opt')]));
  // The existing Poll authority validates and writes the Poll. Its internal batch extension
  // commits the bracket link and revision in the SAME transaction, including concurrent retries.
  const options = pair.map((c, i) => ({ id: map[c.id], label: c.name, description: c.description.slice(0, 240), trigger: input.poll?.options?.[i]?.trigger || String(i + 1) }));
  const pollInput = { ...input.poll, title: String(input.poll?.title || `${pair[0].name} vs ${pair[1].name}`).slice(0, 140), presentationType: 'abootnothing', options, rumbleEnabled: false };
  const staged = [];
  try {
    for (const [index, contender] of pair.entries()) {
      if (!contender.image) continue;
      const asset = await db.prepare('SELECT * FROM aboot_media WHERE id=? AND bracket_id=?').bind(contender.image, id).first();
      if (!asset) fail(409, 'bracket_artwork_missing', 'Saved contender artwork is unavailable.');
      const object = await env.THIRDRAILIFY_PROFILE_MEDIA.get(asset.object_key);
      if (!object) fail(409, 'bracket_artwork_missing', 'Saved contender artwork is unavailable.');
      const bytes = new Uint8Array(await object.arrayBuffer()), image = sanitizeWheelMedia(bytes, asset.content_type, 'centre');
      const mediaId = crypto.randomUUID().replaceAll('-', ''), key = `polls/bracket-clones/${mediaId}`;
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', image.bytes)), b => b.toString(16).padStart(2, '0')).join('');
      await env.THIRDRAILIFY_PROFILE_MEDIA.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
      staged.push({ mediaId, key, image, digest, optionId: options[index].id });
    }
    await createPoll(env, actor, pollInput, ({ id: pollId }) => [
    revisionGuard(db, b),
    ...staged.map(a => db.prepare("INSERT INTO poll_media_assets (id,poll_id,poll_option_id,purpose,object_key,sha256,content_type,byte_size,width,height,original_filename,lifecycle,uploaded_by_account_id,created_at,updated_at) VALUES (?,?,?,'option',?,?,?,?,?,?,?,'active',?,?,?)").bind(a.mediaId, pollId, a.optionId, a.key, a.digest, a.image.contentType, a.image.bytes.byteLength, a.image.width, a.image.height, 'bracket-artwork', actor, nowIso(), nowIso())),
    db.prepare('INSERT INTO aboot_poll_links VALUES (?,?,?,?,?,1,?)').bind(uid('link'), id, m.id, pollId, JSON.stringify(map), nowIso()),
    db.prepare('UPDATE aboot_brackets SET revision=revision+1,updated_at=? WHERE id=?').bind(nowIso(), id),
    db.prepare('INSERT INTO aboot_audit VALUES (?,?,?,?,?,?,?)').bind(uid('audit'), id, String(input.requestId), 'create_poll', actor, JSON.stringify({ matchId: m.id, pollId }), nowIso()),
    db.prepare('DELETE FROM aboot_guards'),
    ]);
  } catch (e) {
    // A post-commit response failure must never delete media retained by the committed Poll.
    for (const a of staged) if (!await db.prepare('SELECT id FROM poll_media_assets WHERE id=?').bind(a.mediaId).first()) await env.THIRDRAILIFY_PROFILE_MEDIA.delete(a.key).catch(() => {});
    throw e;
  }
  return adminBracket(env, id, actor);
}
