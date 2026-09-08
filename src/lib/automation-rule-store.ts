import { useSyncExternalStore } from 'react';
import { AutomationRequestError, type Rule } from './automation-client';
type Request = <T>(path: string, token?: string, body?: unknown) => Promise<T>;
type RowState = { rule?: Rule; deleted?: boolean; pending?: boolean; enabled?: boolean; error?: string };
const rows = new Map<string, RowState>(); const listeners = new Set<() => void>(); let revision = 0;
const emit = () => { revision++; listeners.forEach(fn => fn()); };
export function publishRule(rule: Rule) { if (!rule.id) return; rows.set(rule.id, { rule }); emit(); }
export function removeRule(id: string) { rows.set(id, { deleted: true }); emit(); }
export function useRuleStore() { useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => revision); return rows; }
export function mergeRules(rules: Rule[], wheelId = '') {
  const all = new Map(rules.map(r => [r.id!, r]));
  for (const [id, state] of rows) {
    if (state.deleted) all.delete(id);
    else if (state.rule && (!wheelId || state.rule.targetWheelId === wheelId) && (state.rule.revision || 0) > (all.get(id)?.revision || 0)) all.set(id, state.rule);
  }
  return [...all.values()].filter(r => !wheelId || r.targetWheelId === wheelId);
}
export async function toggleRule(rule: Rule, csrf: string, request: Request) {
  if (!rule.id || rows.get(rule.id)?.pending) return;
  const saved = rows.get(rule.id)?.rule;
  const prior = saved && (saved.revision || 0) > (rule.revision || 0) ? saved : rule;
  rows.set(rule.id, { rule: prior, pending: true, enabled: !prior.enabled }); emit();
  try { const result = await request<{ rule: Rule }>('rules', csrf, { ...prior, enabled: !prior.enabled }); publishRule(result.rule); }
  catch (e) {
    let current = prior; let message = e instanceof Error ? e.message : 'Rule could not be saved.';
    if (e instanceof AutomationRequestError && e.status === 409) {
      try { const result = await request<{ rules: Rule[] }>(`rules?ruleId=${encodeURIComponent(rule.id)}`); const found = result.rules.find(r => r.id === rule.id); if (found) current = found; else { rows.set(rule.id, { deleted: true }); emit(); return; } message += ' Current rule refreshed; review before trying again.'; }
      catch { message += ' Refresh this rule before retrying.'; }
    }
    rows.set(rule.id, { rule: current, error: message }); emit();
  }
}
