import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCES,initialSources,acceptResult,deriveSources,readSource} from '../src/overview/sources.mjs';
import {onRequest} from '../functions/api/admin/_middleware.js';
const ids=Object.keys(SOURCES);
const success={outcome:'success',data:{count:0},lastSuccess:'2026-09-08T00:00:00Z',error:null};
const fail={outcome:'failure',httpStatus:503,error:{category:'upstream_http_error',code:'unavailable',message:'Unavailable',retryAfterMs:null}};
test('all seven independent failures retain neighbours; recovery reconciles all selectors',()=>{
 for(const id of ids){let state=initialSources(ids);for(const key of ids)state[key]=acceptResult(state[key],success,1,0);
 state[id]=acceptResult(state[id],fail,2,15000);assert.equal(deriveSources(state).reporting,6);assert.deepEqual(deriveSources(state).failed.map(s=>s.id),[id]);assert.deepEqual(state[id].data,{count:0});assert.equal(state[id].lastSuccess,success.lastSuccess);
 state[id]=acceptResult(state[id],success,3,30000);assert.equal(deriveSources(state).failed.length,0);assert.equal(deriveSources(state).reporting,7);assert.equal(state[id].error,null);
 }
});
test('late success/failure and intentional cancellation cannot replace accepted generation',()=>{
 let source=acceptResult(initialSources(ids).status,success,3);assert.equal(acceptResult(source,fail,2),source);
 source=acceptResult(source,fail,4);assert.equal(acceptResult(source,success,3),source);assert.equal(acceptResult(source,{outcome:'cancelled'},5),source);
});
test('restricted sources are excluded, session failure is one session incident, retries stop',()=>{
 const state=initialSources(['status']);assert.equal(deriveSources(state).expected,1);assert.equal(state.automations.outcome,'not_applicable');
 state.status=acceptResult(state.status,{...fail,httpStatus:401,error:{...fail.error,category:'session_expired'}},1);assert.equal(deriveSources(state).sessionExpired,true);assert.equal(deriveSources(state).failed.length,0);assert.equal(state.status.nextRetry,null);
 let source=initialSources(ids).status;for(let i=1;i<=4;i++)source=acceptResult(source,fail,i,0);assert.equal(source.nextRetry,null);
});
for(const [status,code,category] of [[401,'session_expired','session_expired'],[403,'capability_required','access_denied'],[429,'rate_limited','upstream_http_error'],[503,'unavailable','upstream_http_error'],[503,'service_schema_mismatch','schema_not_ready'],[503,'watch_management_not_configured','missing_configuration']])test(`safe HTTP ${status} ${code}`,async()=>{
 const result=await readSource('status',{fetcher:async()=>Response.json({ok:false,error:code,message:'PRIVATE SQL SECRET'},{status,headers:{'Retry-After':'30','X-Overview-Reference':'safe-reference'}})});
 assert.equal(result.error.category,category);assert.equal(result.httpStatus,status);assert.equal(result.reference,'safe-reference');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|SQL|SECRET/);assert.equal(result.error.retryAfterMs,30000);
});
test('HTML and malformed JSON are invalid, network failures have no fabricated status',async()=>{
 for(const response of [new Response('<html/>',{headers:{'Content-Type':'text/html'}}),new Response('{',{headers:{'Content-Type':'application/json'}}),Response.json({ok:true})]){const result=await readSource('status',{fetcher:async()=>response});assert.equal(result.error.category,'invalid_response');}
 const result=await readSource('status',{fetcher:async()=>{throw new TypeError('private network text');}});assert.equal(result.error.category,'network_failure');assert.equal(result.httpStatus,undefined);
});
test('deadline settles even if fetch ignores abort; intentional cancellation is separate',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const request=readSource('status',{deadlineMs:10000,fetcher:()=>new Promise(()=>{})});t.mock.timers.tick(10000);assert.equal((await request).error.category,'timeout');
 const controller=new AbortController();const cancelled=readSource('status',{signal:controller.signal,fetcher:()=>new Promise(()=>{})});controller.abort();assert.equal((await cancelled).outcome,'cancelled');
});
test('valid empty/disabled data succeeds',async()=>{
 for(const [id,data] of [['status',{configuration:{oauthProviders:[]},accounts:{total:0}}],['automations',{runtime:{state:'offline'},config:{}}],['banner',{config:{normal:{enabled:false,messages:[]},live:{enabled:false}}}],['watch',{summary:{retained:0},episodes:[]}]] ) assert.equal((await readSource(id,{fetcher:async()=>Response.json({ok:true,...data})})).outcome,'success');
});
test('diagnostic middleware retains response contract, no-store and bounded reference log',async t=>{
 const logs=[];t.mock.method(console,'warn',x=>logs.push(x));
 const body={ok:false,error:'safe_code',message:'private body stays out of logs'};
 const response=await onRequest({request:new Request('https://admin.thirdrailify.com/api/admin/status'),next:async()=>Response.json(body,{status:503})});
 assert.deepEqual(await response.json(),body);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('x-overview-reference'));assert.equal(logs.length,1);assert.doesNotMatch(logs[0],/private body/);
});
