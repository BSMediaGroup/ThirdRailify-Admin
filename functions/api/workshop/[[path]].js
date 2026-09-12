import { AuthFailure, requireSession, requireCsrf, readJsonBody, jsonResponse, errorResponse, requireAuthDb, createHandoff, normalizeOrigin, safeReturnPath, serializeAccount } from '../../_shared/auth-core.js';
import { requireAdminCapability } from '../../_shared/admin-capabilities.js';
import { workshopAccess } from '../../_shared/workshop-policy.js';

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url), path = url.pathname.slice('/api/workshop/'.length);
    const session = await requireSession(env, request), db = requireAuthDb(env);
    const policy = await workshopAccess(db, session.accountId);
    if (request.method === 'GET' && path === 'session') return jsonResponse({ ok: true, authenticated: true, account: session.account, csrfToken: session.csrfToken, workshop: { ...policy, account: undefined } });
    if (request.method !== 'GET') {
      if (request.headers.get('origin') !== normalizeOrigin(env.THIRDRAILIFY_ADMIN_ORIGIN)) throw new AuthFailure(403, 'origin_not_allowed', 'Use the Admin site for Workshop access changes.');
      await requireCsrf(request, session);
    }
    if (request.method === 'POST' && path === 'open') {
      if (!policy.allowed) throw new AuthFailure(403, 'workshop_denied', 'Workshop access is required.');
      const body = await readJsonBody(request);
      const target = normalizeOrigin(env.THIRDRAILIFY_LAB_ORIGIN);
      if (target !== 'https://lab.thirdrailify.com') throw new AuthFailure(503, 'lab_not_configured', 'Lab is not configured.');
      const handoff = await createHandoff(env, session.accountId, target, safeReturnPath(body.returnTo, '/'));
      const destination = new URL('/', target); destination.searchParams.set('handoff', handoff.code);
      return jsonResponse({ ok: true, handoffUrl: destination.href });
    }
    await requireAdminCapability(env, session, 'workshop.access.manage');
    if (request.method === 'GET' && path === 'accounts') {
      const page = Math.max(1, Math.min(10000, Number(url.searchParams.get('page')) || 1));
      const query = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      const search = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
      const where = "display_name LIKE ? ESCAPE '\\' OR email_normalized LIKE ? ESCAPE '\\' OR id = ?";
      const rows = await db.prepare(`SELECT * FROM accounts WHERE ${where} ORDER BY display_name, id LIMIT 20 OFFSET ?`).bind(search, search, query, (page - 1) * 20).all();
      const total = await db.prepare(`SELECT count(*) AS n FROM accounts WHERE ${where}`).bind(search, search, query).first();
      const items = [];
      for (const row of rows.results || []) items.push({ account: await serializeAccount(env, row), workshop: { ...await workshopAccess(db, row.id), account: undefined } });
      return jsonResponse({ ok: true, items, total: total.n, page, pageSize: 20, canOpen: policy.allowed });
    }
    const match = path.match(/^accounts\/([\w-]{1,100})(?:\/(history))?$/);
    if (!match) throw new AuthFailure(404, 'not_found', 'Workshop route not found.');
    const targetId = match[1], current = await workshopAccess(db, targetId);
    if (!current.account) throw new AuthFailure(404, 'account_not_found', 'Account not found.');
    if (request.method === 'GET' && match[2]) {
      const rows = await db.prepare('SELECT a.*, actor.display_name AS actor_name FROM workshop_access_audit a JOIN accounts actor ON actor.id=a.actor_id WHERE a.account_id=? ORDER BY a.revision DESC LIMIT 100').bind(targetId).all();
      return jsonResponse({ ok: true, items: rows.results || [] });
    }
    if (request.method !== 'PUT' || match[2]) throw new AuthFailure(405, 'method_not_allowed', 'Use PUT to update access.');
    const master = session.account.adminLevel === 'master';
    if (current.account.admin_level === 'master' || current.account.source === 'env_master') throw new AuthFailure(403, 'protected_master', 'Master recovery access is protected.');
    if (!master && (targetId === session.accountId || current.account.role === 'admin')) throw new AuthFailure(403, 'delegation_denied', 'Only a Master can change another administrator’s Workshop suspension.');
    const body = await readJsonBody(request);
    if (!['granted','suspended','revoked'].includes(body.state) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new AuthFailure(400, 'invalid_access', 'A valid state and revision are required.');
    const expires = body.expiresAt || null;
    if (expires && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expires) || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now())) throw new AuthFailure(400, 'invalid_expiry', 'Expiry must be a future UTC date.');
    if (body.revision !== (current.grant?.revision || 0)) throw new AuthFailure(409, 'revision_conflict', 'Access changed. Reload this account before saving.');
    const timestamp = new Date().toISOString(), revision = body.revision + 1, auditId = crypto.randomUUID();
    const note = String(body.note || '').trim().slice(0, 1000);
    const next = { state: body.state, expiresAt: expires, note, revision };
    const result = await db.batch([
      db.prepare(`INSERT INTO workshop_access (account_id,state,expires_at,revision,changed_by,changed_at,note)
        SELECT ?,?,?,?,?,?,? WHERE ?=0 OR EXISTS (SELECT 1 FROM workshop_access WHERE account_id=? AND revision=?)
        ON CONFLICT(account_id) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at,revision=excluded.revision,changed_by=excluded.changed_by,changed_at=excluded.changed_at,note=excluded.note WHERE workshop_access.revision=?`)
        .bind(targetId, body.state, expires, revision, session.accountId, timestamp, note, body.revision, targetId, body.revision, body.revision),
      db.prepare(`INSERT INTO workshop_access_audit (id,account_id,actor_id,revision,previous_json,next_json,created_at)
        SELECT ?,?,?,?,?,?,? WHERE changes()=1`).bind(auditId, targetId, session.accountId, revision, JSON.stringify(current.grant), JSON.stringify(next), timestamp),
    ]);
    if (result[0].meta.changes !== 1) throw new AuthFailure(409, 'revision_conflict', 'Access changed. Reload this account before saving.');
    return jsonResponse({ ok: true, workshop: { ...await workshopAccess(db, targetId), account: undefined } });
  } catch (error) { return errorResponse(error, request, env); }
}
