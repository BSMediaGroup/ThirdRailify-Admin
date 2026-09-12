import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {catalogueFixture} from './catalogue-repair-fixture.mjs';
import {publicCataloguePayload,publicProductPayload} from '../functions/_shared/public-catalogue.js';
import {authoritativeCartLines} from '../functions/_shared/shipping-core.js';
test('Public selection uses canonical exact-variant media and retains the general gallery at three widths',async t=>{
 const f=await catalogueFixture(t),id='repair-product-1';
 const first=await f.db.prepare('SELECT * FROM commerce_product_variants WHERE product_id=?').bind(id).first();
 first.id='public-browser-second';first.local_variant_key='public-browser-second';first.target_printful_sync_variant_id='987654321';first.size_label='L';first.safe_metadata_json=JSON.stringify({assignedImages:[{url:'https://example.test/large.png',alt:'Large design'},{url:'https://example.test/back.png',alt:'Large back'}],mediaAssignmentSource:'operator'});
 const entries=Object.entries(first);await f.db.prepare(`INSERT INTO commerce_product_variants(${entries.map(([k])=>k).join(',')}) VALUES(${entries.map(()=>'?').join(',')})`).bind(...entries.map(([,v])=>v)).run();
 await f.db.prepare("UPDATE commerce_product_variants SET size_label='S' WHERE id='repair-variant-1'").run();
 const row=await f.db.prepare('SELECT slug FROM commerce_products WHERE id=?').bind(id).first();
 const projection=await publicProductPayload(f.env,row.slug);assert.equal(projection.product.variants.find(v=>v.id===first.id).images.length,2);
 const lines=await authoritativeCartLines(f.db,[{productId:id,variantId:first.id,quantity:1}],{environment:'live',gate:'shipping_quote'});assert.equal(lines[0].imageUrl,'https://example.test/large.png');
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4197','--strictPort'],{cwd:'X:/GIT/ThirdRailify',windowsHide:true,stdio:'ignore'});t.after(()=>server.kill());for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:4197')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});t.after(()=>browser.close());const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.hostname==='example.test')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="gold"/></svg>'});if(u.pathname==='/api/commerce/catalogue')return route.fulfill({json:await publicCataloguePayload(f.env)});if(u.pathname.startsWith('/api/commerce/products/'))return route.fulfill({json:await publicProductPayload(f.env,row.slug)});if(u.pathname.startsWith('/api/'))return route.fulfill({json:{ok:true,items:[],authenticated:false}});if(u.hostname==='127.0.0.1'){const r=await fetch(u);return route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:Buffer.from(await r.arrayBuffer())});}return route.abort();});
 await page.goto('http://127.0.0.1:4197/shop/'+row.slug,{waitUntil:'commit'});
 for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});await page.getByLabel('Size',{exact:true}).selectOption('L');await page.waitForFunction(()=>document.querySelector('.product-media__expand img')?.getAttribute('src')==='https://example.test/large.png');assert.equal(await page.locator('.product-media__expand img').getAttribute('alt'),'Large design');assert.ok(await page.locator('.product-media__gallery button').count()>=3);await page.getByLabel('Size',{exact:true}).selectOption('S');await page.waitForFunction(()=>document.querySelector('.product-media__expand img')?.getAttribute('src')==='https://example.test/fixture.png');await page.screenshot({path:`.wrangler/printful-workflow-20260912/browser/public-${width}.png`});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);}
 assert.deepEqual(errors,[]);
});
