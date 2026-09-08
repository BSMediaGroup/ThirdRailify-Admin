import { AuthFailure } from './auth-core.js';
import { requireWheelDb, resolveWheelAccess } from './wheels-core.js';
import { listAutomationRules, saveAutomationRule, deleteAutomationRule, dryRunAutomation } from './automation-core.js';

export async function wheelAutomations(env, accountId, slug, action, input) {
  const db = requireWheelDb(env);
  const wheel = await db.prepare('SELECT * FROM wheels WHERE public_slug=?').bind(slug).first();
  if (!wheel) throw new AuthFailure(404, 'wheel_not_found', 'Wheel not found.');
  const access = await resolveWheelAccess(env, accountId, wheel);
  if (!access.canEdit) throw new AuthFailure(403, 'wheel_edit_forbidden', 'Wheel editor access is required to manage automations.');
  if (wheel.editing_locked && !access.isMasterAdmin) throw new AuthFailure(423, 'wheel_edit_locked', 'Wheel editing is locked by Admin.');
  if (action === 'read') {
    const result = await listAutomationRules(env, wheel.id, input?.ruleId || '');
    return { ...result, wheels: [{ id: wheel.id, title: wheel.title, lifecycle: wheel.lifecycle, editing_locked: wheel.editing_locked }] };
  }
  const rule = action === 'test' ? input.rule : input;
  if (!rule || typeof rule !== 'object') throw new AuthFailure(400, 'automation_invalid', 'Rule is required.');
  if (rule.id) {
    const existing = await db.prepare('SELECT target_wheel_id FROM automation_rules WHERE id=? AND deleted_at IS NULL').bind(rule.id).first();
    if (!existing || existing.target_wheel_id !== wheel.id) throw new AuthFailure(404, 'automation_not_found', 'Rule not found on this Wheel.');
  }
  if (action === 'delete') return deleteAutomationRule(env, accountId, input);
  if (rule.targetWheelId !== wheel.id) throw new AuthFailure(403, 'automation_wheel_mismatch', 'Choose this Wheel as the automation target.');
  if (action === 'test') return dryRunAutomation(input);
  return saveAutomationRule(env, accountId, rule);
}
