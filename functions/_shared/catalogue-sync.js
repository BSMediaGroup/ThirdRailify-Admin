import {AuthFailure,nowIso,randomId} from './auth-core.js';
import {requireCommerceDb} from './commerce-core.js';
import {buildCurrentCataloguePlan,loadLocalCatalogue,normalizeProduct,upsertProductStatements} from './current-catalogue-reconciliation.js';
import {stageCatalogueMedia} from './commerce-media.js';
import {storefrontEligibility,protectedTestProduct} from './storefront-eligibility.js';
import {transactionGuard,CATALOGUE_AUTHORITY_SQL} from './commerce-transaction-guards.js';
const STORE='18668025',parse=v=>JSON.parse(v||'{}');
const fail=(code,message)=>{throw new AuthFailure(409,code,message)};
const hash=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v))))].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function catalogueSyncStatus(env,id=null){
 const db=requireCommerceDb(env),policy=await db.prepare("SELECT * FROM commerce_sync_policy WHERE id='printful'").first();
 const job=id?await db.prepare('SELECT * FROM commerce_sync_jobs WHERE id=?').bind(id).first():await db.prepare('SELECT * FROM commerce_sync_jobs ORDER BY created_at DESC LIMIT 1').first();
 const shippingSetting=await db.prepare("SELECT value_json FROM commerce_settings WHERE setting_key='shipping_strategy'").first();
 const strategy=parse(shippingSetting?.value_json);
 const localVariants=(await db.prepare("SELECT id,product_id,target_printful_sync_variant_id,unit_amount FROM commerce_product_variants WHERE provider_store_id=?").bind(STORE).all()).results;
 const weights=(await db.prepare("SELECT product_id,variant_id,weight_mg FROM commerce_shipping_weights").all()).results;
 const items=job?(await db.prepare('SELECT * FROM commerce_sync_items WHERE job_id=? ORDER BY provider_id').bind(job.id).all()).results:[];
 return {ok:true,policy,shippingStrategy:strategy,job:job?{id:job.id,state:job.state,phase:job.phase,fingerprint:job.fingerprint,errorCode:job.error_code,retryAt:job.retry_at,updatedAt:job.updated_at}:null,items:items.map(i=>{const p=parse(i.source_json);return {providerId:i.provider_id,localId:i.local_id,state:i.state,selected:!!i.selected,publish:!!i.publish,errorCode:i.error_code,title:p.name||i.provider_id,image:p.images?.[0]||null,variants:p.variants||[],warnings:[...(p.reviewReasons||[]),...(p.variants||[]).flatMap(v=>{const local=localVariants.find(r=>r.target_printful_sync_variant_id===v.id);const mass=weights.find(w=>w.variant_id===local?.id&&w.weight_mg>0)||weights.find(w=>w.product_id===i.local_id&&w.variant_id===null&&w.weight_mg>0);return [...(!v.catalogueVariantId?[`${v.name}: Catalog mapping missing; purchase blocked`]:[]),...(strategy==='merchant_weight_bands'&&!mass?[`${v.name}: effective weight missing; purchase blocked; open Shipping`]:[]),...(v.availabilityStatus!=='active'?[`${v.name}: provider unavailable; variant remains draft`]:[]),...(local&&local.unit_amount!==v.unitAmount?[`${v.name}: manual price ${local.unit_amount} preserved; provider ${v.unitAmount} CAD cents`]:[])];})],result:parse(i.result_json)};})};
}
export async function startCatalogueSync(env,session,scheduled=false){
 if(String(env.PRINTFUL_STORE_ID)!==STORE)fail('sync_store_invalid','The native Printful store must be configured.');
 const db=requireCommerceDb(env),id=`sync_${randomId()}`,time=nowIso();
 await db.prepare("INSERT INTO commerce_sync_jobs(id,store_id,state,phase,actor_account_id,scheduled,created_at,updated_at) VALUES (?,?,'reading','identity',?,?,?,?)").bind(id,STORE,session?.accountId||null,scheduled?1:0,time,time).run();return catalogueSyncStatus(env,id);
}
export async function saveCatalogueSyncPolicy(env,input){
 const db=requireCommerceDb(env);if(!input||![0,15,30,60].includes(input.intervalMinutes)||typeof input.autoImport!=='boolean'||typeof input.publishNew!=='boolean')fail('sync_policy_invalid','Choose Off, 15, 30 or 60 minutes.');
 const baseline=(await db.prepare("SELECT target_printful_product_id id FROM commerce_products WHERE provider_store_id=?").bind(STORE).all()).results.map(p=>p.id);
 const result=await db.prepare("UPDATE commerce_sync_policy SET revision=revision+1,interval_minutes=?,auto_import=?,publish_new=?,baseline_json=?,next_run_at=?,updated_at=? WHERE id='printful' AND revision=?").bind(input.intervalMinutes,input.autoImport?1:0,input.publishNew?1:0,JSON.stringify(baseline),input.intervalMinutes?nowIso(Date.now()+input.intervalMinutes*60000):null,nowIso(),input.revision).run();
 if(result.meta.changes!==1)fail('sync_policy_conflict','Sync settings changed. Reload before saving.');return catalogueSyncStatus(env);
}
export async function actCatalogueSync(env,session,id,input,fetchImpl=fetch){
 const db=requireCommerceDb(env);if(input.action==='step')return advanceCatalogueSync(env,id,fetchImpl);
 if(input.action==='cancel'){await db.prepare("UPDATE commerce_sync_jobs SET state='cancelled',lease_token=NULL,updated_at=? WHERE id=? AND state IN ('reading','review','applying')").bind(nowIso(),id).run();return catalogueSyncStatus(env,id);}
 if(input.action==='retry'){await db.batch([transactionGuard(db,"EXISTS(SELECT 1 FROM commerce_sync_jobs WHERE id=? AND state IN ('failed','partial'))",[id]),db.prepare("UPDATE commerce_sync_items SET state=CASE WHEN source_json IS NULL THEN 'pending' ELSE 'selected' END,attempts=0,error_code=NULL WHERE job_id=? AND state='failed'").bind(id),db.prepare("UPDATE commerce_sync_jobs SET state=CASE WHEN phase='apply' THEN 'applying' ELSE 'reading' END,error_code=NULL,attempts=0,retry_at=NULL WHERE id=? AND state IN ('failed','partial')").bind(id)]);return catalogueSyncStatus(env,id);}
 if(input.action!=='apply'||!Array.isArray(input.items)||input.items.length>1000||new Set(input.items.map(i=>i.providerId)).size!==input.items.length)fail('sync_action_invalid','Review the selected products first.');
 const job=await db.prepare('SELECT * FROM commerce_sync_jobs WHERE id=?').bind(id).first();if(job?.state!=='review')fail('sync_review_required','Wait for the complete provider snapshot.');
 const expected=(await db.prepare('SELECT provider_id FROM commerce_sync_items WHERE job_id=?').bind(id).all()).results.map(r=>r.provider_id);if(input.items.length!==expected.length||input.items.some(i=>!expected.includes(i.providerId)))fail('sync_choices_incomplete','Review each provider product exactly once.');
 const statements=[];for(const item of input.items){if(typeof item.selected!=='boolean'||typeof item.publish!=='boolean')fail('sync_choice_invalid','Choose publication for each product.');statements.push(db.prepare("UPDATE commerce_sync_items SET selected=?,publish=?,state=? WHERE job_id=? AND provider_id=? AND source_json IS NOT NULL").bind(item.selected?1:0,item.publish?1:0,item.selected?'selected':'skipped',id,item.providerId));}
 statements.unshift(transactionGuard(db,"EXISTS(SELECT 1 FROM commerce_sync_jobs WHERE id=? AND state='review')",[id]));statements.push(db.prepare("UPDATE commerce_sync_jobs SET state='applying',phase='apply',updated_at=? WHERE id=?").bind(nowIso(),id));await db.batch(statements);return catalogueSyncStatus(env,id);
}
export async function advanceCatalogueSync(env,id,fetchImpl=fetch){
 const db=requireCommerceDb(env),token=randomId(),time=nowIso();
 const claim=await db.prepare("UPDATE commerce_sync_jobs SET lease_token=?,lease_until=? WHERE id=? AND state IN ('reading','applying') AND (retry_at IS NULL OR retry_at<=?) AND (lease_until IS NULL OR lease_until<?)").bind(token,nowIso(Date.now()+90000),id,time,time).run();if(claim.meta.changes!==1)return catalogueSyncStatus(env,id);
 const job=await db.prepare('SELECT * FROM commerce_sync_jobs WHERE id=?').bind(id).first(),source=parse(job.source_json);
 const guarded=list=>db.batch([transactionGuard(db,"EXISTS(SELECT 1 FROM commerce_sync_jobs WHERE id=? AND lease_token=? AND state IN ('reading','applying'))",[id,token]),...list]);
 const get=async path=>{const response=await fetchImpl(`https://api.printful.com${path}`,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${env.PRINTFUL_API_TOKEN}`,...(path==='/stores'?{}:{'X-PF-Store-Id':STORE})},signal:AbortSignal.timeout(20000)});if(!response.ok){const error=new Error(response.status===429?'printful_rate_limited':response.status>=500?'printful_temporarily_unavailable':'printful_read_failed');error.retryAfter=Number(response.headers.get('retry-after'))||0;throw error;}return response.json();};
 try{
  if(job.phase==='identity'){
   const result=await get('/stores'),store=result.result?.find(s=>String(s.id)===STORE);if(!store||store.type!=='native'||store.name!=='Third Railify API')fail('sync_store_identity_invalid','The configured native store could not be verified.');
   await guarded([db.prepare("UPDATE commerce_sync_jobs SET phase='pages',source_json=? WHERE id=?").bind(JSON.stringify({store:{id:STORE,name:store.name,type:store.type},offset:0,total:null}),id)]);
  }else if(job.phase==='pages'){
   const result=await get(`/store/products?offset=${source.offset}&limit=20`),rows=result.result,paging=result.paging;
   if(!Array.isArray(rows)||!paging||paging.offset!==source.offset||!Number.isInteger(paging.total)||paging.total<1||paging.total>1000||!rows.length||source.total!==null&&source.total!==paging.total||rows.some(p=>!/^\d+$/.test(String(p.id))))fail('sync_snapshot_incomplete','Printful pagination was incomplete. No absence decisions were made.');
   source.total=paging.total;source.offset+=rows.length;if(source.offset>source.total)fail('sync_snapshot_incomplete','Printful returned inconsistent totals.');
   const policy=await db.prepare("SELECT * FROM commerce_sync_policy WHERE id='printful'").first();
   const statements=[];for(const p of rows){const existing=await db.prepare('SELECT id,visibility,safe_metadata_json FROM commerce_products WHERE provider_store_id=? AND target_printful_product_id=?').bind(STORE,String(p.id)).first();const wants=existing?parse(existing.safe_metadata_json).publicationIntent==='operator_publish'||existing.visibility==='public':!!policy.publish_new;statements.push(db.prepare('INSERT INTO commerce_sync_items(job_id,provider_id,local_id,publish,updated_at) VALUES(?,?,?,?,?)').bind(id,String(p.id),existing?.id||null,wants?1:0,time));}
   statements.push(db.prepare('UPDATE commerce_sync_jobs SET phase=?,source_json=? WHERE id=?').bind(source.offset===source.total?'details':'pages',JSON.stringify(source),id));await guarded(statements);
  }else if(job.phase==='details'){
   const item=await db.prepare("SELECT * FROM commerce_sync_items WHERE job_id=? AND state='pending' ORDER BY provider_id LIMIT 1").bind(id).first();
   if(item){const payload=await get(`/store/products/${item.provider_id}`);const product=normalizeProduct(payload.result,{id:item.provider_id,name:payload.result?.sync_product?.name});await guarded([db.prepare("UPDATE commerce_sync_items SET source_json=?,state='review',updated_at=? WHERE job_id=? AND provider_id=?").bind(JSON.stringify(product),time,id,item.provider_id)]);}
   else {const rows=(await db.prepare('SELECT source_json FROM commerce_sync_items WHERE job_id=?').bind(id).all()).results;const products=rows.map(r=>parse(r.source_json));const ids=products.flatMap(p=>p.variants.map(v=>v.id));if(rows.length!==source.total||new Set(ids).size!==ids.length)fail('sync_snapshot_incomplete','Duplicate IDs or incomplete provider detail.');await guarded([db.prepare("UPDATE commerce_sync_jobs SET state='review',fingerprint=?,updated_at=? WHERE id=?").bind(await hash(products),time,id)]);}
  }else if(job.phase==='apply'){
   const item=await db.prepare("SELECT * FROM commerce_sync_items WHERE job_id=? AND state='selected' ORDER BY provider_id LIMIT 1").bind(id).first();
   if(!item){const failed=await db.prepare("SELECT COUNT(*) n FROM commerce_sync_items WHERE job_id=? AND state='failed'").bind(id).first();await guarded([db.prepare('UPDATE commerce_sync_jobs SET state=?,updated_at=? WHERE id=?').bind(failed.n?'partial':'completed',time,id),...(!failed.n?[db.prepare("UPDATE commerce_sync_policy SET last_success_at=? WHERE id='printful'").bind(time)]:[])]);}
   else {try{
    const fresh=normalizeProduct((await get(`/store/products/${item.provider_id}`)).result,{id:item.provider_id,name:parse(item.source_json).name});if(await hash(fresh)!==await hash(parse(item.source_json)))fail('sync_source_changed','Provider values changed after review. Start a fresh sync.');
    const all=(await db.prepare('SELECT source_json FROM commerce_sync_items WHERE job_id=?').bind(id).all()).results.map(r=>parse(r.source_json)),snapshot={store:source.store,products:all,counts:{products:all.length,variants:all.flatMap(p=>p.variants).length},fingerprint:job.fingerprint,retrievedAt:job.created_at};
    const authority=(await db.prepare(CATALOGUE_AUTHORITY_SQL).first()).fingerprint;
    const local=await loadLocalCatalogue(db),plan=buildCurrentCataloguePlan(snapshot,local),entry=plan.items.find(p=>p.providerProductId===item.provider_id&&p.desired);
    if(!entry||entry.blocker)fail('sync_identity_review','This provider identity needs review.');
    if(entry.desired.variantChanges.archived>Math.max(2,entry.desired.variants.length/2))fail('sync_destructive_review','Unusually many variants retired. Explicit reconciliation review is required.');
    const desired=entry.desired,old=local.products.find(p=>p.id===desired.id);
    if(old&&protectedTestProduct({safe_metadata_json:JSON.stringify(old.metadata)}))fail('sync_test_excluded','Deliberate test fixture is excluded.');
    const assets=await stageCatalogueMedia(env,[...new Set([...desired.metadata.publicImage?[desired.metadata.publicImage]:[],...(desired.metadata.publicImages||[]),...entry.provider.variants.flatMap(v=>v.customerPreviewUrls.slice(0,1))])],fetchImpl);
    const canonical=url=>assets.find(a=>a.sourceUrl===url)?.url||url;
    desired.metadata.publicImage=canonical(desired.metadata.publicImage);desired.metadata.publicImages=desired.metadata.publicImages.map(canonical);desired.metadata.providerAssets=assets;
    desired.metadata.publicationIntent=item.publish?'operator_publish':'operator_hidden';
    const policy=await db.prepare("SELECT value_json FROM commerce_settings WHERE setting_key='shipping_strategy'").first();
    const weights=(await db.prepare('SELECT * FROM commerce_shipping_weights WHERE product_id=?').bind(desired.id).all()).results;
    const product={id:desired.id,status:'active',visibility:'public',checkout_environment:'live',requires_shipping:1,currency_code:'CAD',provider_presence:'current',provider_store_id:STORE,provider_reconciliation_status:desired.reconciliationStatus,target_printful_product_id:desired.providerProductId,safe_metadata_json:JSON.stringify(desired.metadata)};
    const variants=desired.variants.map(v=>({id:v.id,currency_code:'CAD',unit_amount:v.unitAmount,provider_presence:'current',provider_store_id:STORE,is_ignored:v.ignored,availability_status:v.availability,fulfillment_provider:'printful',target_printful_sync_variant_id:v.providerVariantId,target_catalogue_variant_id:v.catalogueVariantId,target_printful_product_id:desired.providerProductId,fulfillment_mapping_status:v.mappingStatus,status:'active',visibility:'public',is_sellable:1,safe_metadata_json:JSON.stringify(v.metadata)}));
    const readiness=storefrontEligibility(product,variants,STORE,{shippingStrategy:policy?parse(policy.value_json):null,weights});
    const allowed=readiness.variants.filter(v=>v.eligible&&v.shipping.ready&&parse(variants.find(r=>r.id===v.id).safe_metadata_json).publicationIntent!=='operator_hidden').map(v=>v.id);
    const shippingPolicy=await db.prepare("SELECT active_ratebook_id,revision FROM commerce_shipping_policy WHERE id='primary'").first();
    const policyReady=parse(policy?.value_json)==='printful_dynamic'||parse(policy?.value_json)==='merchant_weight_bands'&&!!shippingPolicy?.active_ratebook_id;
    const publish=item.publish&&readiness.canPublish&&allowed.length>0&&policyReady;
    for(const v of desired.variants){const enabled=publish&&allowed.includes(v.id);v.status=enabled?'active':'disabled';v.visibility=enabled?'public':'private';v.sellable=enabled?1:0;v.metadata.publicationIntent ||= 'operator_publish';const pv=entry.provider.variants.find(p=>p.id===v.providerVariantId);v.metadata.providerImage=canonical(pv?.customerPreviewUrls[0])||null;v.metadata.providerImageSource=pv?.customerPreviews[0]||null;}
    const writes=upsertProductStatements(db,{...entry,action:entry.action==='insert'?'insert':'update'},snapshot,time);
    writes.unshift(transactionGuard(db,`(${CATALOGUE_AUTHORITY_SQL}) IS ?`,[authority]));
    writes.unshift(transactionGuard(db,"(SELECT value_json FROM commerce_settings WHERE setting_key='shipping_strategy') IS ?",[policy?.value_json??null]));
    if(shippingPolicy)writes.unshift(transactionGuard(db,"EXISTS(SELECT 1 FROM commerce_shipping_policy WHERE id='primary' AND revision=? AND active_ratebook_id IS ?)",[shippingPolicy.revision,shippingPolicy.active_ratebook_id]));
    writes.unshift(transactionGuard(db,"(SELECT json_group_array(json_array(id,revision,weight_mg)) FROM (SELECT * FROM commerce_shipping_weights WHERE product_id=? ORDER BY id)) IS ?",[desired.id,JSON.stringify([...weights].sort((a,b)=>a.id.localeCompare(b.id)).map(w=>[w.id,w.revision,w.weight_mg]))]));
    writes.push(db.prepare("UPDATE commerce_products SET status=?,visibility=?,checkout_environment=CASE WHEN ?=1 AND COALESCE(json_extract(safe_metadata_json,'$.saleRestriction.enabled'),0)=0 THEN 'live' ELSE checkout_environment END WHERE id=?").bind(publish?'active':'disabled',publish?'public':'private',publish?1:0,desired.id));
    writes.push(db.prepare("UPDATE commerce_sync_items SET local_id=?,state='completed',result_json=?,updated_at=? WHERE job_id=? AND provider_id=?").bind(desired.id,JSON.stringify({published:!!publish,blockers:readiness.productReasons,variants:readiness.variants.map(v=>({id:v.id,reasons:[...v.reasons,...v.shipping.reasons]}))}),time,id,item.provider_id));await guarded(writes);
   }catch(error){await guarded([db.prepare("UPDATE commerce_sync_items SET state='failed',attempts=attempts+1,error_code=?,updated_at=? WHERE job_id=? AND provider_id=?").bind(error.code||'sync_item_failed',time,id,item.provider_id)]);}}
  }
 }catch(error){await db.prepare("UPDATE commerce_sync_jobs SET attempts=attempts+1,retry_at=?,error_code=?,state=CASE WHEN attempts>=4 THEN 'failed' ELSE state END WHERE id=? AND lease_token=?").bind(nowIso(Date.now()+Math.min(900000,Math.max(error.retryAfter*1000||0,30000*2**job.attempts))),error.code||error.message||'sync_read_failed',id,token).run();}
 finally{await db.prepare('UPDATE commerce_sync_jobs SET lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?').bind(nowIso(),id,token).run();}
 return catalogueSyncStatus(env,id);
}
export async function processScheduledCatalogueSync(env){
 const db=requireCommerceDb(env),policy=await db.prepare("SELECT * FROM commerce_sync_policy WHERE id='printful'").first();
 let job=await db.prepare("SELECT * FROM commerce_sync_jobs WHERE state IN ('reading','applying') ORDER BY created_at LIMIT 1").first();
 if(!job&&policy.interval_minutes&&policy.next_run_at<=nowIso()&&!await db.prepare("SELECT 1 FROM commerce_sync_jobs WHERE state='review'").first()){
  const started=await startCatalogueSync(env,null,true);job={id:started.job.id,scheduled:1};await db.prepare("UPDATE commerce_sync_policy SET next_run_at=? WHERE id='printful'").bind(nowIso(Date.now()+policy.interval_minutes*60000)).run();
 }
 if(job){const deadline=Date.now()+20000;for(let step=0;step<25&&Date.now()<deadline;step++){const result=await advanceCatalogueSync(env,job.id);if(result.job.state==='review'&&job.scheduled&&policy.auto_import){await actCatalogueSync(env,null,job.id,{action:'apply',items:result.items.map(i=>({providerId:i.providerId,selected:true,publish:i.publish}))});continue;}if(!['reading','applying'].includes(result.job.state)||result.job.retryAt&&Date.parse(result.job.retryAt)>Date.now())break;}}
}
