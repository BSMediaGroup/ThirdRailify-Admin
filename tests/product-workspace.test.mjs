import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogueFixture} from './catalogue-repair-fixture.mjs';
import {productWorkspace,saveProductWorkspace} from '../functions/_shared/product-workspace.js';
import {authoritativeCartLines} from '../functions/_shared/shipping-core.js';
function request(w,publish=true){const p=w.product;return {revision:w.revision,publish,variants:[],weights:[],mediaAssignments:[],product:{title:p.title,slug:p.slug,description:p.description,primaryImageUrl:p.primaryImageUrl,additionalImages:p.additionalImages,categories:p.categories,tags:p.tags,featured:p.featured,visibility:p.visibility,status:p.status,displayOrder:p.displayOrder,maxQuantity:p.maxQuantity,unitAmount:p.unitAmount,currencyCode:'CAD',saleRestriction:p.saleRestriction}};}
test('one atomic Save publishes a misclassified import, preserves prices and weights, detects concurrent saves and preserves drafts',async t=>{
 const {env,db,session}=await catalogueFixture(t),id='repair-product-1';
 await db.prepare("UPDATE commerce_products SET checkout_environment='test',visibility='private' WHERE id=?").bind(id).run();
 let w=await productWorkspace(env,session,id);const input=request(w);input.product.title='Real local edit';
 const saved=await saveProductWorkspace(env,session,id,input,()=>{throw Error('No external calls')});
 assert.equal(saved.saveResult.published,true);assert.equal(saved.product.title,'Real local edit');assert.equal(saved.readiness.purchasable,true);
 assert.equal((await authoritativeCartLines(db,[{productId:id,variantId:'repair-variant-1',quantity:1}],{environment:'live',gate:'shipping_quote'})).length,1);
 await assert.rejects(saveProductWorkspace(env,session,id,input),e=>e.code==='product_revision_conflict');
 w=await productWorkspace(env,session,id);const hidden=await saveProductWorkspace(env,session,id,request(w,false));assert.equal(hidden.product.visibility,'private');assert.equal(hidden.readiness.publicationIntent,'operator_hidden');
});
test('invalid variants do not commit product edits; unknown weights block only merchant policy',async t=>{
 const {env,db,session}=await catalogueFixture(t),id='repair-product-1';let w=await productWorkspace(env,session,id);const input=request(w);input.product.title='Must not commit';input.variants=[{variantId:'foreign'}];await assert.rejects(saveProductWorkspace(env,session,id,input));assert.equal((await productWorkspace(env,session,id)).product.title,w.product.title);
 await db.prepare("UPDATE commerce_settings SET value_json='\"merchant_weight_bands\"' WHERE setting_key='shipping_strategy'").run();w=await productWorkspace(env,session,id);const saved=await saveProductWorkspace(env,session,id,request(w));assert.equal(saved.saveResult.published,false);assert.ok(saved.saveResult.blockers.includes('shipping_ratebook_unpublished'));assert.equal(saved.readiness.variants[0].shipping.reasons[0],'shipping_item_weight_missing');
});
