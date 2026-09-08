import { useCallback, useEffect, useRef, useState } from 'react';
import { acceptResult, deriveSources, initialSources, readSource, type SourceId } from './sources.mjs';

export function useOverviewSources(eligibleKey: string, csrfToken: string) {
  const [sources, setSources] = useState(() => initialSources(eligibleKey.split(',') as SourceId[]));
  const state = useRef(sources);
  const active = useRef(false);
  const sequence = useRef(0);
  const pending = useRef(new Map<SourceId, {controller: AbortController; promise: Promise<void>}>());
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async (ids?: SourceId[], automatic = false) => {
    if (!active.current || deriveSources(state.current).sessionExpired) return;
    const eligible = eligibleKey.split(',') as SourceId[];
    const selected = (ids || eligible).filter(id => eligible.includes(id));
    const work = selected.map(id => {
      const existing = pending.current.get(id); if (existing) return existing.promise;
      const source = state.current[id];
      if (!automatic && source.attemptAt && Date.now() - Date.parse(source.attemptAt) < 1000) return Promise.resolve();
      if (source.outcome === 'failure' && (automatic ? !source.nextRetry || source.nextRetry > Date.now() : source.error?.retryAfterMs && source.nextRetry && source.nextRetry > Date.now())) return Promise.resolve();
      const controller = new AbortController(); const generation = ++sequence.current;
      const promise = readSource(id, {csrfToken, signal: controller.signal}).then(result => {
        if (!active.current || controller.signal.aborted || pending.current.get(id)?.controller !== controller || result.outcome === 'cancelled') return;
        state.current = {...state.current, [id]: acceptResult(state.current[id], result, generation)};
        setSources(state.current);
      }).finally(() => {
        if (pending.current.get(id)?.controller === controller) pending.current.delete(id);
        if (active.current) setLoading(pending.current.size > 0);
      });
      pending.current.set(id, {controller, promise}); return promise;
    });
    setLoading(pending.current.size > 0); await Promise.all(work);
  }, [csrfToken, eligibleKey]);
  useEffect(() => {
    active.current = true; state.current = initialSources(eligibleKey.split(',') as SourceId[]); setSources(state.current);
    void refresh();
    let ticks = 0;
    // Runtime keeps its established 15-second read cadence; other internal sources check each minute.
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      ticks++;
      const ids = (eligibleKey.split(',') as SourceId[]).filter(id => id === 'automations' || ticks % 4 === 0 || state.current[id].outcome === 'failure');
      void refresh(ids, true);
    }, 15000);
    const visible = () => { if (!document.hidden) {ticks = 0; void refresh(undefined, true);} };
    document.addEventListener('visibilitychange', visible);
    const requests = pending.current;
    return () => { active.current = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); for (const entry of requests.values()) entry.controller.abort(); requests.clear(); };
  }, [eligibleKey, refresh]);
  return {sources, loading, refresh, health: deriveSources(sources)};
}
