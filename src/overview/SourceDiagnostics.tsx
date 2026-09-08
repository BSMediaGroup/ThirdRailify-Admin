import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SourceId, SourceState } from './sources.mjs';
import './diagnostics.css';

export function SourceDiagnostics({sources, failures, sessionExpired, loading, retry, signIn}: {sources: SourceState[]; failures: SourceState[]; sessionExpired: boolean; loading: boolean; retry: (ids?: SourceId[]) => Promise<void>; signIn: () => void}) {
  const [copied, setCopied] = useState('');
  const summary = sessionExpired ? 'Session expired. Sign in to resume checks.' : failures.length ? failures.map(source => `${source.label}: ${source.error?.message} ${source.data ? 'Showing retained data.' : 'Data unavailable.'}`).join(' ') : '';
  const diagnostics = sources.map(({id,label,route,method,outcome,attemptAt,lastSuccess,durationMs,deadlineMs,httpStatus,reference,error,generation,nextRetry}) => ({component:label,id,route:route.split('?')[0],method:method || 'GET',outcome,attemptAt,lastSuccess,durationMs,deadlineMs,httpStatus,reference,category:error?.category,code:error?.code,generation,nextRetry}));
  async function copy() {try {await navigator.clipboard.writeText(JSON.stringify(diagnostics,null,2));setCopied('Diagnostics copied.');} catch {setCopied('Clipboard unavailable. Select details below to copy.');}}
  return <section className="overview-diagnostics" aria-label="Source health">
    <div role="status" aria-live="polite">{summary && <div className="overview-partial"><div><strong>{sessionExpired ? 'Session expired' : 'Partial operational snapshot'}</strong><p>{summary}</p></div></div>}</div>
    {sessionExpired ? <button type="button" onClick={signIn}>Sign in</button> : failures.length > 0 && <button type="button" disabled={loading} onClick={() => void retry(failures.map(s=>s.id))}>Retry affected sources</button>}
    <details><summary>Component diagnostics · {sources.length} eligible sources</summary>
      <p>Each source has its own check time. Operational state (such as an offline Bot or disabled integration) is separate from whether its data could be read.</p>
      <button type="button" onClick={() => void copy()}>Copy diagnostic details</button><span role="status">{copied}</span>
      <div className="overview-diagnostics__rows">{[...sources].sort((a,b) => Number(b.outcome === 'failure') - Number(a.outcome === 'failure')).map(source => <article key={source.id} data-source={source.id} data-outcome={source.outcome}>
        <h3>{source.label} <small>{source.outcome === 'failure' ? source.data ? 'Retained / stale' : 'Unavailable' : source.outcome === 'success' ? 'Read successful' : 'Checking'}</small></h3>
        <p>{source.error?.message}</p>
        <dl><div><dt>Latest check</dt><dd>{source.attemptAt || 'Not yet checked'}</dd></div><div><dt>Last updated / success</dt><dd>{source.lastSuccess || 'No successful observation'}</dd></div>
          <div><dt>Category / code</dt><dd>{source.error ? `${source.error.category} / ${source.error.code || 'No error code supplied'}` : 'None'}</dd></div>
          <div><dt>HTTP status</dt><dd>{source.httpStatus ?? 'No HTTP response'}</dd></div><div><dt>Duration / deadline</dt><dd>{source.durationMs === undefined ? 'Not measured' : `${source.durationMs} / ${source.deadlineMs} ms`}</dd></div>
          <div><dt>Request / generation</dt><dd>{source.method || 'GET'} {source.route.split('?')[0]} · {source.generation}</dd></div><div><dt>Reference</dt><dd>{source.reference || 'Not supplied'}</dd></div>
          <div><dt>Next check</dt><dd>{source.outcome === 'failure' ? source.nextRetry ? `At or after ${new Date(source.nextRetry).toISOString()} while visible` : 'Automatic retry stopped; resolve the issue, then retry.' : source.id === 'automations' ? 'Every 15 seconds while visible' : 'Every minute while visible'}</dd></div></dl>
        <Link to={source.to}>Open {source.label}</Link>
      </article>)}</div>
    </details>
  </section>;
}
