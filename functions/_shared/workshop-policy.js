// Canonical Workshop use policy. Lab packages this module with a source hash;
// every decision reads current canonical account and permission rows.
export async function workshopAccess(db, accountId, now = new Date().toISOString()) {
  if (!db?.prepare) throw new Error('Workshop account authority unavailable');
  // Readiness is required even for Masters; never accept a partial schema.
  const grant = await db.prepare('SELECT * FROM workshop_access WHERE account_id = ?').bind(accountId).first();
  const denials = await db.prepare("SELECT capability FROM admin_role_capability_denials WHERE role='full'").all();
  const account = await db.prepare('SELECT id, display_name, avatar_url, role, admin_level, status, source FROM accounts WHERE id = ?').bind(accountId).first();
  const result = { allowed: false, source: 'account_unavailable', canManageAccess: false, canManageProviders: false, canManageProfileRestrictions: false, grant, account };
  if (!account || account.status !== 'active') return result;
  const master = account.role === 'admin' && account.admin_level === 'master';
  const full = account.role === 'admin' && account.admin_level === 'full';
  const denied = new Set((denials.results || []).map(x => x.capability));
  result.canManageAccess = master || (full && !denied.has('workshop.access.manage'));
  result.canManageProviders = master || (full && !denied.has('workshop.providers.manage'));
  result.canManageProfileRestrictions = master;
  if (master) return { ...result, allowed: true, source: 'master_policy' };
  if (grant?.state === 'suspended') return { ...result, source: 'explicit_suspension' };
  if (full) return { ...result, allowed: !denied.has('workshop.use'), source: denied.has('workshop.use') ? 'capability_denial' : 'full_admin_policy' };
  if (grant?.state !== 'granted') return { ...result, source: 'approval_required' };
  if (grant.expires_at && grant.expires_at <= now) return { ...result, source: 'grant_expired' };
  return { ...result, allowed: true, source: 'explicit_grant' };
}
