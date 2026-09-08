export const SOURCES = Object.freeze({
  status: { label: 'Accounts', route: '/api/admin/status', to: '/access' },
  analytics: { label: 'Analytics', route: '/api/admin/analytics?range=24h', to: '/analytics' },
  commerce: { label: 'Commerce', route: '/api/admin/commerce/overview', to: '/commerce' },
  watch: { label: 'Watch', route: '/api/admin/watch', to: '/watch', method: 'POST' },
  goats: { label: 'GOATS', route: '/api/admin/goats/overview', to: '/goats' },
  banner: { label: 'Site content', route: '/api/admin/banner', to: '/content' },
  automations: { label: 'Bot runtime', route: '/api/admin/automations', to: '/automations' },
});
const messages = { timeout: 'The check exceeded its deadline.', network_failure: 'No response was received.', invalid_response: 'The response did not match the expected JSON contract.', session_expired: 'Your session has expired. Sign in again.', access_denied: 'The server denied this entitled check. Review access configuration.', schema_not_ready: 'Required schema is not ready.', missing_configuration: 'Required configuration is missing.', upstream_http_error: 'The server returned an unsuccessful response.', unexpected_internal_failure: 'The check could not be completed.' };
const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : null;
export function classifyError(status, code) {
  if(status===401) return 'session_expired';
  if(status===403) return 'access_denied';
  if(/schema|migration/.test(code || '')) return 'schema_not_ready';
  if(/not_configured|missing_configuration/.test(code || '')) return 'missing_configuration';
  return 'upstream_http_error';
}
function valid(id, p) {
  if(!p || p.ok !== true) return false;
  if(id==='status')return !!(p.configuration && p.accounts && Array.isArray(p.configuration.oauthProviders));
  if(id==='analytics')return !!(p.windows && p.selected && p.coverage && p.revenue && Array.isArray(p.series) && Array.isArray(p.pages) && Array.isArray(p.geography));
  if(id==='commerce')return !!(p.counts && p.posture);
  if(id==='watch')return !!(p.summary && Array.isArray(p.episodes));
  if(id==='goats')return !!(p.counts && p.email && Array.isArray(p.recent));
  if(id==='banner')return !!(p.config?.normal && p.config?.live && Array.isArray(p.config.normal.messages));
  return !!(p.runtime && p.config);
}
export async function readSource(id, { signal, csrfToken, deadlineMs=12000, fetcher=fetch, now=Date.now }={}) {
  const start=now(); const controller=new AbortController();let expired=false;let response;
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;controller.abort();reject(new Error('deadline'));},deadlineMs);});
  const abort=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});if(controller.signal.aborted)reject(new Error('cancelled'));});
  const base={attemptAt:new Date(start).toISOString(),deadlineMs,httpStatus:undefined,reference:null};
  try {
    const work=async()=>{
      const config=SOURCES[id];
      response=await fetcher(config.route,{method:config.method||'GET',credentials:'include',cache:'no-store',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(id==='watch'?{'Content-Type':'application/json','X-CSRF-Token':csrfToken}: {})},...(id==='watch'?{body:JSON.stringify({action:'read'})}:{})});
      const reference=response.headers.get('x-overview-reference') || response.headers.get('cf-ray');
      base.reference=reference && /^[a-zA-Z0-9-]{1,80}$/.test(reference)?reference:null;
      base.httpStatus=response.status;
      const json=response.headers.get('content-type')?.includes('application/json');
      const payload=json?await response.json().catch(()=>null):null;
      if(!response.ok){const code=safeCode(payload?.error);const category=classifyError(response.status,code);const retry=response.headers.get('retry-after');const seconds=retry && /^\d+$/.test(retry)?Number(retry):null;const date=retry?Date.parse(retry):NaN;throw {category,code,retryAfterMs:seconds!==null?seconds*1000:Number.isFinite(date)?Math.max(0,date-now()):null};}
      if(!valid(id,payload))throw {category:'invalid_response',code:'invalid_response'};
      return id==='automations'?{...payload,receivedAt:now()}:payload;
    };
    const data=await Promise.race([work(),deadline,abort]);
    return {...base,outcome:'success',data,lastSuccess:new Date(now()).toISOString(),durationMs:Math.max(0,now()-start),error:null};
  }catch(error){
    if(signal?.aborted&&!expired)return {...base,outcome:'cancelled'};
    const category=expired?'timeout':error.category || (error instanceof TypeError?'network_failure':'unexpected_internal_failure');
    return {...base,outcome:'failure',durationMs:Math.max(0,now()-start),error:{category,code:error.code||null,message:messages[category],retryAfterMs:error.retryAfterMs??null}};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
export function initialSources(eligible) {return Object.fromEntries(Object.keys(SOURCES).map(id=>[id,{id,...SOURCES[id],outcome:eligible.includes(id)?'pending':'not_applicable',data:null,error:null,lastSuccess:null,generation:0,failures:0,nextRetry:null}]));}
export function acceptResult(previous,result,generation,now=Date.now()) {
  if(result.outcome==='cancelled'||generation<previous.generation)return previous;
  const success=result.outcome==='success';const failures=success?0:previous.failures+1;
  const retryable=!success && ['timeout','network_failure'].includes(result.error.category) || !success && result.error.category==='upstream_http_error' && (result.httpStatus===429 || result.httpStatus>=500);
  const nextRetry=retryable&&failures<=3?now+Math.max(result.error.retryAfterMs||0,Math.min(60000,15000*2**(failures-1))):null;
  return {...previous,...result,httpStatus:result.httpStatus,reference:result.reference,generation,failures,nextRetry,data:success?result.data:previous.data,lastSuccess:success?result.lastSuccess:previous.lastSuccess};
}
export function deriveSources(sources) {
  const eligible=Object.values(sources).filter(s=>s.outcome!=='not_applicable');
  const failed=eligible.filter(s=>s.outcome==='failure');const sessionExpired=failed.some(s=>s.error.category==='session_expired');
  return {eligible,failed:sessionExpired?[]:failed,sessionExpired,reporting:eligible.filter(s=>s.outcome==='success').length,expected:eligible.length};
}
