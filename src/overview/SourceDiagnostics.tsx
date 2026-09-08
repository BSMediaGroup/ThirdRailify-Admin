import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminIcon } from '../components/AdminIcon';
import type { SourceId, SourceState } from './sources.mjs';
import './diagnostics.css';

export function SourceDiagnostics({sources, failures, sessionExpired, loading, retry, signIn}: {sources: SourceState[]; failures: SourceState[]; sessionExpired: boolean; loading: boolean; retry: (ids?: SourceId[]) => Promise<void>; signIn: () => void}) {
  const reporting = sources.filter(source => source.outcome === 'success').length;
  const health = sessionExpired || failures.length ? 'attention' : reporting === sources.length ? 'ready' : 'checking';
  const icons = { status: 'users', analytics: 'analytics', commerce: 'commerce', watch: 'watch', goats: 'goats', banner: 'content', automations: 'automations' } as const;
  const [copied, setCopied] = useState('');
  const summary = sessionExpired ? 'Session expired. Sign in to resume checks.' : failures.length ? failures.map(source => `${source.label}: ${source.error?.message} ${source.data ? 'Showing retained data.' : 'Data unavailable.'}`).join(' ') : '';
  const diagnostics = sources.map(({id,label,route,method,outcome,attemptAt,lastSuccess,durationMs,deadlineMs,httpStatus,reference,error,generation,nextRetry}) => ({component:label,id,route:route.split('?')[0],method:method || 'GET',outcome,attemptAt,lastSuccess,durationMs,deadlineMs,httpStatus,reference,category:error?.category,code:error?.code,generation,nextRetry}));
  async function copy() {try {await navigator.clipboard.writeText(JSON.stringify(diagnostics,null,2));setCopied('Diagnostics copied.');} catch {setCopied('Clipboard unavailable. Select details below to copy.');}}
  return <section className="overview-diagnostics" data-health={health} aria-label="Source health">
    <div role="status" aria-live="polite">{summary && <div className="overview-partial"><div><strong>{sessionExpired ? 'Session expired' : 'Partial operational snapshot'}</strong><p>{summary}</p></div></div>}</div>
    {sessionExpired ? <button type="button" onClick={signIn}>Sign in</button> : failures.length > 0 && <button type="button" disabled={loading} onClick={() => void retry(failures.map(s=>s.id))}>Retry affected sources</button>}
    <details className="overview-diagnostics__panel">
      <summary className="overview-diagnostics__toggle">
        <span className="overview-diagnostics__emblem"><AdminIcon name="integrations" size={24} /></span>
        <span className="overview-diagnostics__heading"><span className="overview-diagnostics__eyebrow">Authority checks</span><strong>Component diagnostics</strong><span className="overview-diagnostics__caption">{sources.length} eligible sources <span aria-hidden="true">/</span> Check history &amp; recovery</span></span>
        <span className="overview-diagnostics__health"><i aria-hidden="true" />{sessionExpired ? 'Sign-in required' : failures.length ? `${failures.length} need attention` : `${reporting}/${sources.length} reporting`}</span>
        <span className="overview-diagnostics__disclosure"><span className="when-closed">View details</span><span className="when-open">Hide details</span><span className="overview-diagnostics__chevron"><AdminIcon name="chevron" size={18} /></span></span>
      </summary>
      <div className="overview-diagnostics__body">
      <div className="overview-diagnostics__toolbar"><p>Read status, last successful updates and recovery details for each authority. Source checks run independently.</p>
      <div><button type="button" onClick={() => void copy()}><AdminIcon name="content" size={15} />Copy diagnostic details</button><span className="overview-diagnostics__copy-status" role="status">{copied}</span></div></div>
      <div className="overview-diagnostics__rows">{[...sources].sort((a,b) => Number(b.outcome === 'failure') - Number(a.outcome === 'failure')).map(source => <article key={source.id} data-source={source.id} data-outcome={source.outcome}>
        <header className="overview-diagnostics__card-header"><span className="overview-diagnostics__source-icon"><AdminIcon name={icons[source.id]} size={18} /></span><h3>{source.label}</h3><span className="overview-diagnostics__result"><i aria-hidden="true" />{source.outcome === 'failure' ? source.data ? 'Retained / stale' : 'Unavailable' : source.outcome === 'success' ? 'Read successful' : 'Checking'}</span></header>
        {source.error && <p className="overview-diagnostics__reason">{source.error.message}</p>}
        <dl><div><dt>Latest check</dt><dd>{source.attemptAt || 'Not yet checked'}</dd></div><div><dt>Last updated / success</dt><dd>{source.lastSuccess || 'No successful observation'}</dd></div>
          <div><dt>Category / code</dt><dd>{source.error ? `${source.error.category} / ${source.error.code || 'No error code supplied'}` : 'None'}</dd></div>
          <div><dt>HTTP status</dt><dd>{source.httpStatus ?? 'No HTTP response'}</dd></div><div><dt>Duration / deadline</dt><dd>{source.durationMs === undefined ? 'Not measured' : `${source.durationMs} / ${source.deadlineMs} ms`}</dd></div>
          <div><dt>Request / generation</dt><dd>{source.method || 'GET'} {source.route.split('?')[0]} · {source.generation}</dd></div><div><dt>Reference</dt><dd>{source.reference || 'Not supplied'}</dd></div>
          <div><dt>Next check</dt><dd>{source.outcome === 'failure' ? source.nextRetry ? `At or after ${new Date(source.nextRetry).toISOString()} while visible` : 'Automatic retry stopped; resolve the issue, then retry.' : source.id === 'automations' ? 'Every 15 seconds while visible' : 'Every minute while visible'}</dd></div></dl>
        <Link className="overview-diagnostics__destination" to={source.to}>Open {source.label}<AdminIcon name="arrow" size={15} /></Link>
      </article>)}</div>
      </div>
    </details>
  </section>;
}
