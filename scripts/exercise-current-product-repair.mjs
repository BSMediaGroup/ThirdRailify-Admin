// Local acceptance only. No credentials are loaded; upstream provider data is a
// sanitized captured response replay. Admin handlers, auth, D1 and R2 are real.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { createCommerceDatabases, commerceEnvironment, insertTestProduct, insertTestVariant } from "../tests/commerce-test-helpers.mjs";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { onRequest as authRequest } from "../functions/api/auth/[[path]].js";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { commerceMediaResponse } from "../functions/_shared/commerce-media.js";
import { publicCataloguePayload } from "../functions/_shared/public-catalogue.js";
import { previewCurrentProductRepair } from "../functions/_shared/current-product-repair.js";
import { storefrontEligibility } from "../functions/_shared/storefront-eligibility.js";
import { onRequestGet as adminCatalogueRequest } from "../functions/api/public/commerce/catalogue.js";
import { onRequestGet as adminProductRequest } from "../functions/api/public/commerce/products/[slug].js";
import { onRequestGet as publicCatalogueRequest } from "../../ThirdRailify/functions/api/commerce/catalogue.js";
import { onRequestGet as publicProductRequest } from "../../ThirdRailify/functions/api/commerce/products/[slug].js";
const root=new URL('../.artifacts/printful-mockup-repair/',import.meta.url);
const load=async(name)=>JSON.parse(await readFile(new URL(name,root),'utf8'));
const [snapshot,responses,stored,assets]=await Promise.all(['provider-snapshot.json','provider-responses.json','stored-rows.json','downloaded-assets.json'].map(load));
const products=stored[2].results,variants=stored[3].results;
assert.deepEqual(products.map((p)=>p.target_printful_product_id).sort(),snapshot.products.map((p)=>p.id).sort());
const h=await createCommerceDatabases({withMedia:true});
const env=commerceEnvironment(h,{PRINTFUL_STORE_ID:snapshot.store.id,PRINTFUL_API_TOKEN:'local-replay-only',THIRDRAILIFY_PROFILE_MEDIA:h.media,THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN:'https://cdn.thirdrailify.com'});
const upstream=async(url,init)=>{
  assert.equal(init.method,'GET');
  const u=new URL(url);
  if(u.hostname==='api.printful.com') { const data=responses[u.pathname+u.search];assert.ok(data,`Missing captured ${u.pathname}`);return Response.json(data); }
  const asset=assets.find((a)=>a.sourceUrl===url);assert.ok(asset,`Missing decoded asset ${url}`);
  return new Response(await readFile(new URL(asset.filename,root)),{headers:{'Content-Type':asset.contentType}});
};
const sessionOrigin='https://thirdrailify-admin.pages.dev';
const servers=[];let browser;
try {
  for(const asset of assets) {
    const url=new URL(asset.sourceUrl);
    if(url.hostname==='cdn.thirdrailify.com' && /^\/commerce-media\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(url.pathname)) {
      assert.equal(url.pathname.split('/').at(-1).split('.')[0],asset.sha256,'Existing immutable reference must match its captured bytes');
      await h.media.put(`commerce/catalogue/${url.pathname.split('/').at(-1)}`,new Uint8Array(await readFile(new URL(asset.filename,root))),{httpMetadata:{contentType:asset.contentType}});
    }
  }
  for(const p of products) {
    await insertTestProduct(h.commerceDb,{id:p.id,slug:p.slug,title:p.title,status:p.status,visibility:p.visibility,unitAmount:p.unit_amount,targetPrintfulProductId:p.target_printful_product_id,migrationStatus:p.migration_status,isFeatured:p.is_featured,featuredOrder:p.featured_order});
    await copyColumns('commerce_products',p);
  }
  for(const v of variants) {
    const pv=snapshot.products.find((p)=>p.id===v.target_printful_product_id)?.variants.find((p)=>p.id===v.target_printful_sync_variant_id);
    await insertTestVariant(h.commerceDb,{id:v.id,productId:v.product_id,localVariantKey:`captured-${v.target_printful_sync_variant_id}`,status:v.status,visibility:v.visibility,isSellable:v.is_sellable,unitAmount:v.unit_amount,sizeLabel:pv?.size||null,colorLabel:pv?.color||null,targetPrintfulProductId:v.target_printful_product_id,targetPrintfulSyncVariantId:v.target_printful_sync_variant_id,targetCatalogueProductId:v.target_catalogue_product_id,targetCatalogueVariantId:v.target_catalogue_variant_id,migrationStatus:v.migration_status});
    const {legacy_file_mapping_count,...row}=v;void legacy_file_mapping_count;await copyColumns('commerce_product_variants',row);
  }
  const diagnostic=products.map((p)=>({id:p.id,syncProductId:p.target_printful_product_id,title:p.title,status:p.status,visibility:p.visibility,...storefrontEligibility(p,variants.filter((v)=>v.product_id===p.id),snapshot.store.id)}));
  await writeFile(new URL('per-product-diagnostic.json',root),JSON.stringify(diagnostic,null,2));
  const beforeProducts=(await h.commerceDb.prepare('SELECT id,status,visibility,is_featured,unit_amount,target_printful_product_id FROM commerce_products ORDER BY id').all()).results;
  const settings=(await h.commerceDb.prepare('SELECT * FROM commerce_settings ORDER BY setting_key').all()).results;
  await ensureEnvironmentMasters(env);const account=await loadAccountByEmail(env,'master-one@example.test');
  const created=await createSession(env,new Request(sessionOrigin,{headers:{Origin:sessionOrigin}}),account,sessionOrigin);
  const cookie=created.cookie.split(';')[0];const session={accountId:account.id};
  for(const [cwd,port] of [['X:/GIT/ThirdRailify-Admin',4197],['X:/GIT/ThirdRailify',4198]]) { const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd,stdio:'ignore',windowsHide:true});servers.push(server);await ready(`http://127.0.0.1:${port}`); }
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-features=LocalNetworkAccessChecks']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const apiLog=[];
  await context.route('**/api/**',async(route)=>{
    const r=route.request(),u=new URL(r.url());
    const headers=new Headers(r.headers());headers.set('Origin',sessionOrigin);headers.set('Cookie',cookie);
    const request=new Request(sessionOrigin+u.pathname+u.search,{method:r.method(),headers,...(r.method()==='POST'?{body:r.postDataBuffer()}: {})});
    let response;
    try {
      if(u.pathname.startsWith('/api/auth/')) response=await authRequest({request,env});
      else if(u.pathname.startsWith('/api/admin/commerce/')) response=await commerceRequest({request,env,data:{commerceFetch:upstream,schedulerRuntime:{intervalMs:0}}});
      else if(u.pathname==='/api/commerce/catalogue') response=await publicCatalogueRequest({env:{THIRDRAILIFY_ADMIN_ORIGIN:sessionOrigin},data:{fetchImpl:relay}});
      else if(u.pathname.startsWith('/api/commerce/products/')) response=await publicProductRequest({env:{THIRDRAILIFY_ADMIN_ORIGIN:sessionOrigin},params:{slug:decodeURIComponent(u.pathname.split('/').at(-1))},data:{fetchImpl:relay}});
      else response=Response.json({error:'unhandled_local_test_route'},{status:404});
    } catch(error) {response=Response.json({error:error.code||error.message},{status:error.status||500});}
    const body=Buffer.from(await response.arrayBuffer());
    apiLog.push({path:u.pathname,method:r.method(),status:response.status,...(u.pathname.includes('/repair/')?{response:JSON.parse(body.toString())}:{})});
    if(u.pathname.includes('/repair/') && response.status>=400) console.error(u.pathname,body.toString());
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body});
  });
  await context.route('https://cdn.thirdrailify.com/commerce-media/**',async(route)=>{
    const request=new Request(route.request().url());
    try {const response=await commerceMediaResponse(request,env);await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});}
    catch {await route.continue();} // Before-state references may exist only on the live read-only CDN.
  });
  for(const asset of assets) await context.route(asset.sourceUrl,async(route)=>route.fulfill({contentType:asset.contentType,body:await readFile(new URL(asset.filename,root))}));
  const page=await context.newPage();page.setDefaultTimeout(20000);
  await page.goto('http://127.0.0.1:4197/products');
  await page.getByRole('heading',{name:'Shop / Products',exact:true}).waitFor();
  await page.screenshot({path:path('admin-before.png'),fullPage:true});
  await page.getByRole('button',{name:'Bulk edit',exact:true}).click();
  await page.getByRole('button',{name:'Select current page',exact:true}).click();
  await page.getByRole('button',{name:'Show in store',exact:true}).click();
  const repair=page.getByRole('region',{name:'Current product repair'});
  await repair.getByRole('button',{name:'Refresh Printful mockups',exact:true}).click();
  await repair.getByRole('heading',{name:'Mockup refresh Preview'}).waitFor();
  for(const syncId of ['460338949','460339155','460339175']) {
    const product=products.find((p)=>p.target_printful_product_id===syncId);
    await repair.getByRole('checkbox',{name:`Keep reviewed thumbnail as primary: ${product.title}`,exact:true}).check();
  }
  const reviewed=page.waitForResponse((response)=>response.url().endsWith('/products/repair/preview') && response.request().postData()?.includes('approvedThumbnailIds'));
  await repair.getByRole('button',{name:'Update Preview with reviewed thumbnails',exact:true}).click();await reviewed;
  await repair.getByRole('heading',{name:'Mockup refresh Preview'}).waitFor();
  for(const width of [1440,768,390]) {await page.setViewportSize({width,height:1000});await page.screenshot({path:path(`media-preview-${width}.png`),fullPage:true});assert.equal(await overflow(page),false);}
  await page.setViewportSize({width:1440,height:1000});
  await repair.getByRole('textbox').fill(`APPLY MEDIA ${products.length}`);
  await repair.getByRole('button',{name:'Apply reviewed mockups',exact:true}).click();
  await repair.waitFor({state:'detached'});
  assert.deepEqual((await h.commerceDb.prepare('SELECT id,status,visibility,is_featured,unit_amount,target_printful_product_id FROM commerce_products ORDER BY id').all()).results,beforeProducts);
  await page.reload();await page.getByRole('heading',{name:'Shop / Products',exact:true}).waitFor();
  for(const syncId of ['460338949','460339155','460339175']) {
    const product=products.find((p)=>p.target_printful_product_id===syncId);
    await page.locator('.commerce-product-row').filter({has:page.getByText(product.title,{exact:true})}).getByRole('button',{name:'Edit product',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:product.title,exact:true});await dialog.waitFor();
    for(const width of [1440,768,390]) {await page.setViewportSize({width,height:1000});const media=dialog.locator('.product-media-editor');await media.scrollIntoViewIfNeeded();await media.locator('img').evaluateAll((images)=>Promise.all(images.map((img)=>img.decode())));await media.screenshot({path:path(`editor-media-${syncId}-${width}.png`)});await page.screenshot({path:path(`editor-${syncId}-${width}.png`)});assert.equal(await overflow(page),false);}
    await dialog.getByRole('button',{name:'Close editor',exact:true}).click();
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Bulk edit',exact:true}).click();await page.getByRole('button',{name:'Select current page',exact:true}).click();await page.getByRole('button',{name:'Show in store',exact:true}).click();
  const publication=page.getByRole('region',{name:'Current product repair'});
  await publication.getByRole('button',{name:'Publish product with eligible variants',exact:true}).click();
  await publication.getByRole('heading',{name:'Publication Preview'}).waitFor();
  await publication.getByRole('textbox').fill(`APPLY PUBLICATION ${products.length}`);
  await page.screenshot({path:path('publication-preview.png'),fullPage:true});
  await publication.getByRole('button',{name:'Apply reviewed publication',exact:true}).click();await publication.waitFor({state:'detached'});
  const projected=await publicCataloguePayload(env);assert.equal(projected.products.length,products.length);assert.equal(projected.products.reduce((sum,p)=>sum+p.variants.length,0),variants.length);assert.equal(projected.checkoutEnabled,false);
  assert.deepEqual((await h.commerceDb.prepare('SELECT * FROM commerce_settings ORDER BY setting_key').all()).results,settings);
  const after=(await h.commerceDb.prepare('SELECT id,status,visibility,safe_metadata_json FROM commerce_products ORDER BY id').all()).results;
  await writeFile(new URL('local-persisted-after.json',root),JSON.stringify(after,null,2));await writeFile(new URL('local-public-projection.json',root),JSON.stringify(projected,null,2));
  const noOp=await previewCurrentProductRepair(env,session,{kind:'media',productIds:products.map((p)=>p.id)},upstream,{intervalMs:0});assert.equal(noOp.changes,0);await writeFile(new URL('local-second-preview.json',root),JSON.stringify(noOp,null,2));
  const publicPage=await context.newPage();
  for(const width of [1440,768,390]) {
    await publicPage.setViewportSize({width,height:1000});await publicPage.goto('http://127.0.0.1:4198/shop');await publicPage.locator('.product-card').first().waitFor();
    const reject=publicPage.getByRole('button',{name:'Reject non-essential',exact:true});if(await reject.count())await reject.click();
    for(const img of await publicPage.locator('.product-card img').all()){await img.scrollIntoViewIfNeeded();await img.evaluate((image)=>image.decode());}
    await publicPage.evaluate(()=>window.scrollTo(0,0));await publicPage.screenshot({path:path(`public-shop-${width}.png`),fullPage:true});assert.equal(await overflow(publicPage),false);
    for(const syncId of ['460338949','460339155','460339175']) {
      const product=products.find((p)=>p.target_printful_product_id===syncId);await publicPage.goto(`http://127.0.0.1:4198/shop/${product.slug}`);await publicPage.locator('.product-media__stage img').waitFor();await publicPage.locator('.product-media__stage img').evaluate((img)=>img.decode());await publicPage.locator('.product-media__stage').screenshot({path:path(`public-image-${syncId}-${width}.png`)});await publicPage.screenshot({path:path(`public-detail-${width}.png`),fullPage:true});assert.equal(await overflow(publicPage),false);
    }
  }
  await publicPage.reload();await publicPage.locator('.product-media__stage img').waitFor();
  const hero=projected.products.find((p)=>products.find((stored)=>stored.id===p.id)?.target_printful_product_id==='466984948');
  await publicPage.goto(`http://127.0.0.1:4198/shop/${hero.slug}`);await publicPage.locator('#product-variant').waitFor();
  const first=hero.variants[0],other=hero.variants.find((v)=>v.image!==first.image);assert.ok(other);
  await publicPage.locator('#product-variant').selectOption(other.id);await publicPage.waitForFunction((url)=>document.querySelector('.product-media__stage img')?.getAttribute('src')===url,other.image);
  await publicPage.locator('.product-media__stage img').evaluate((img)=>img.decode());await publicPage.locator('.product-media').screenshot({path:path('public-variant-and-gallery-390.png')});
  await publicPage.getByRole('button',{name:'Add selected variant',exact:true}).click();await publicPage.goto('http://127.0.0.1:4198/cart');await publicPage.locator('.cart-page-row__image img').waitFor();await publicPage.screenshot({path:path('public-cart-390.png'),fullPage:true});
  await writeFile(new URL('local-api-evidence.json',root),JSON.stringify(apiLog.filter((entry)=>entry.path.includes('/repair/')),null,2));
  console.log(JSON.stringify({source:'captured provider + sanitized stored-state replay',products:products.length,variants:variants.length,mediaPreviewApply:true,publicationPreviewApply:true,secondMediaPreviewChanges:noOp.changes,widths:[1440,768,390],checkoutEnabled:projected.checkoutEnabled}));
} catch(error) {
  if(browser) for(const context of browser.contexts()) for(const page of context.pages()) {console.error((await page.locator('body').innerText()).slice(0,5000));await page.screenshot({path:path('acceptance-failure.png'),fullPage:true}).catch(()=>{});}
  throw error;
} finally {if(browser)await browser.close();for(const server of servers)server.kill();await h.dispose();}
async function copyColumns(table,row) {const entries=Object.entries(row).filter(([key])=>key!=='id');await h.commerceDb.prepare(`UPDATE ${table} SET ${entries.map(([key])=>`${key}=?`).join(',')} WHERE id=?`).bind(...entries.map(([,value])=>value),row.id).run();}
function path(name){return new URL(name,root).pathname.replace(/^\//,'');}
async function ready(url){for(let attempt=0;attempt<60;attempt++){try{if((await fetch(url)).ok)return;}catch{}await new Promise((resolve)=>setTimeout(resolve,250));}throw new Error('Local Vite did not start');}
async function overflow(page){return page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);}
async function relay(url,init) {assert.ok(!init.method || init.method==='GET');const u=new URL(url);assert.equal(u.origin,sessionOrigin);return u.pathname.endsWith('/catalogue')?adminCatalogueRequest({env}):adminProductRequest({env,params:{slug:decodeURIComponent(u.pathname.split('/').at(-1))}});}
