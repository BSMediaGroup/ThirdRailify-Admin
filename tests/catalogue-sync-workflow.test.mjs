import test from 'node:test';import assert from 'node:assert/strict';import sharp from 'sharp';
import {createCommerceDatabases,commerceEnvironment} from './commerce-test-helpers.mjs';
import {startCatalogueSync,advanceCatalogueSync,actCatalogueSync,catalogueSyncStatus,saveCatalogueSyncPolicy} from '../functions/_shared/catalogue-sync.js';
test('durable sync checkpoints, one confirmation publication, cancellation, retry and partial sibling failure',async t=>{
 const h=await createCommerceDatabases({withMedia:true});t.after(h.dispose);const env=commerceEnvironment(h,{PRINTFUL_STORE_ID:'18668025',PRINTFUL_API_TOKEN:'fixture',THIRDRAILIFY_PROFILE_MEDIA:h.media,THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN:'https://cdn.thirdrailify.com'}),db=h.commerceDb;
 await db.prepare("UPDATE commerce_settings SET value_json='\"printful_dynamic\"' WHERE setting_key='shipping_strategy'").run();
 const png=await sharp({create:{width:16,height:16,channels:3,background:'#aa9955'}}).png().toBuffer();let bad=true,calls=0;
 const get=async(url,init)=>{calls++;if(url.startsWith('https://files.cdn.printful.com/'))return bad&&url.includes('2.png')?new Response('',{status:503}):new Response(png,{headers:{'content-type':'image/png'}});assert.equal(init.method,'GET');const p=new URL(url).pathname;
 if(p==='/stores')return Response.json({result:[{id:18668025,type:'native',name:'Third Railify API'}]});
 if(p==='/store/products')return Response.json({result:[{id:1},{id:2}],paging:{offset:0,total:2,limit:20}});
 const id=Number(p.split('/').at(-1));return Response.json({result:{sync_product:{id,name:`Product ${id}`,variants:1},sync_variants:[{id:100+id,sync_product_id:id,variant_id:1000+id,product_id:358,retail_price:'5.00',currency:'CAD',synced:true,is_ignored:false,availability_status:'active',files:[{type:'preview',id,preview_url:`https://files.cdn.printful.com/files/${id}.png`,status:'ok'}]}]}});};
 let result=await startCatalogueSync(env,{accountId:'local'}),id=result.job.id;
 for(let i=0;i<6&&result.job.state==='reading';i++)result=await advanceCatalogueSync(env,id,get);
 assert.equal(result.job.state,'review');assert.equal(result.items.length,2);assert.ok(result.job.fingerprint);
 result=await actCatalogueSync(env,null,id,{action:'apply',items:result.items.map(i=>({providerId:i.providerId,selected:true,publish:true}))},get);
 for(let i=0;i<4&&result.job.state==='applying';i++)result=await advanceCatalogueSync(env,id,get);
 assert.equal(result.job.state,'partial');assert.equal(result.items[0].result.published,true);assert.equal(result.items[1].state,'failed');
 const p=await db.prepare("SELECT * FROM commerce_products WHERE id='printful-18668025-1'").first();assert.equal(p.checkout_environment,'live');assert.equal(p.visibility,'public');
 const before=p.updated_at;bad=false;await actCatalogueSync(env,null,id,{action:'retry'},get);for(let i=0;i<3;i++)result=await advanceCatalogueSync(env,id,get);assert.equal(result.job.state,'completed');assert.equal((await db.prepare('SELECT updated_at FROM commerce_products WHERE id=?').bind(p.id).first()).updated_at,before);
 const next=await startCatalogueSync(env,null);await actCatalogueSync(env,null,next.job.id,{action:'cancel'},get);const count=calls;await advanceCatalogueSync(env,next.job.id,get);assert.equal(calls,count);
 const settings=await catalogueSyncStatus(env);assert.equal(settings.policy.interval_minutes,0);await saveCatalogueSyncPolicy(env,{revision:settings.policy.revision,intervalMinutes:15,autoImport:true,publishNew:true});assert.equal((await catalogueSyncStatus(env)).policy.interval_minutes,15);
});
test('429 and interrupted pagination never remove catalogue rows',async t=>{
 const h=await createCommerceDatabases();t.after(h.dispose);const env=commerceEnvironment(h,{PRINTFUL_STORE_ID:'18668025'}),j=await startCatalogueSync(env,null);
 const r=await advanceCatalogueSync(env,j.job.id,async()=>new Response('',{status:429,headers:{'retry-after':'60'}}));assert.equal(r.job.state,'reading');assert.equal(r.job.errorCode,'printful_rate_limited');assert.ok(r.job.retryAt);assert.equal((await h.commerceDb.prepare('SELECT COUNT(*) n FROM commerce_products').first()).n,0);
});
test('duplicate provider IDs and incomplete review choices cannot advance publication',async t=>{
 const h=await createCommerceDatabases();t.after(h.dispose);const env=commerceEnvironment(h,{PRINTFUL_STORE_ID:'18668025'}),j=await startCatalogueSync(env,null);
 await advanceCatalogueSync(env,j.job.id,async()=>Response.json({result:[{id:18668025,type:'native',name:'Third Railify API'}]}));
 const r=await advanceCatalogueSync(env,j.job.id,async()=>Response.json({result:[{id:1},{id:1}],paging:{offset:0,total:2,limit:20}}));assert.equal(r.job.state,'reading');assert.ok(r.job.retryAt);assert.equal(r.items.length,0);
 await assert.rejects(actCatalogueSync(env,null,j.job.id,{action:'apply',items:[]}),e=>e.code==='sync_review_required');
 await actCatalogueSync(env,null,j.job.id,{action:'cancel'});await assert.rejects(actCatalogueSync(env,null,j.job.id,{action:'retry'}));assert.equal((await catalogueSyncStatus(env,j.job.id)).job.state,'cancelled');
});
