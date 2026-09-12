import test from 'node:test';import assert from 'node:assert/strict';import {categoryShippingAmount,stickerShippingCategory} from '../functions/_shared/shipping-category-research.js';
test('exact sticker size identity and independent shipping groups',()=>{
 assert.equal(stickerShippingCategory('10163'),'Postcards, stickers');assert.equal(stickerShippingCategory('16362'),'Stickers with sizes (in): 15x3.75');assert.equal(stickerShippingCategory('unknown'),null);
 const table={reviewed:true,currency:'CAD',rules:[{catalogueVariantId:'10163',region:'AU',shipmentGroup:'stickers',firstAmount:700,additionalAmount:10},{catalogueVariantId:'16362',region:'AU',shipmentGroup:'large-stickers',firstAmount:750,additionalAmount:15},{catalogueVariantId:'999',region:'AU',shipmentGroup:'mugs',firstAmount:900,additionalAmount:400}]};
 assert.equal(categoryShippingAmount(table,[{catalogueVariantId:'10163',quantity:2},{catalogueVariantId:'999',quantity:1}],'AU','CAD'),1610);
 assert.throws(()=>categoryShippingAmount({...table,currency:'USD'},[{catalogueVariantId:'10163',quantity:1}],'AU','CAD'),/review/);assert.throws(()=>categoryShippingAmount(table,[{catalogueVariantId:'missing',quantity:1}],'AU','CAD'),/unknown/);assert.throws(()=>categoryShippingAmount({...table,reviewed:false},[],'AU','CAD'),/review/);
});
