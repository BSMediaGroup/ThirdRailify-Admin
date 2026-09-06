import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const release='X:/GIT/.releases/thirdrailify-admin-commerce-closure-20260906-final/dist';
const local=await readFile(release+'/index.html','utf8');
const assets=[...local.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m=>m[1]);
const evidence=[];
for(const origin of ['https://admin.thirdrailify.com','https://87c3ed2b.thirdrailify-admin.pages.dev']){
 const response=await fetch(origin+'/commerce',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
 const html=await response.text();for(const asset of assets)assert.ok(html.includes(asset));
 for(const asset of assets){const response=await fetch(origin+asset,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);const live=Buffer.from(await response.arrayBuffer());assert.deepEqual(live,await readFile(release+asset));evidence.push({origin,asset,sha256:createHash('sha256').update(live).digest('hex'),identical:true});}
}
await writeFile('output/store-closure-assets.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
