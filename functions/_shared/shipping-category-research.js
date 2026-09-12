// Research is never an active ratebook. Categories require exact Catalog IDs,
// reviewed currency/regions and explicit independently-shipped groups.
export function categoryShippingAmount(table, lines, region, currency) {
  if (!table?.reviewed || table.currency !== currency || !Array.isArray(table.rules)) throw new Error('category_rates_require_review');
  const groups = new Map();
  for (const line of lines) {
    const matches=table.rules.filter(r=>r.catalogueVariantId===line.catalogueVariantId&&r.region===region);
    if(matches.length!==1||!Number.isSafeInteger(line.quantity)||line.quantity<1)throw new Error('category_mapping_unknown');
    const rule=matches[0];if(!rule.shipmentGroup||![rule.firstAmount,rule.additionalAmount].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('category_group_or_price_unknown');
    const group=groups.get(rule.shipmentGroup)||[];group.push({rule,quantity:line.quantity});groups.set(rule.shipmentGroup,group);
  }
  let total=0;
  for(const group of groups.values()){
    const first=group.reduce((a,b)=>a.rule.firstAmount>=b.rule.firstAmount?a:b);
    total+=first.rule.firstAmount+group.reduce((sum,item)=>sum+item.rule.additionalAmount*(item.quantity-(item===first?1:0)),0);
  }
  if(!Number.isSafeInteger(total)||total>2147483647)throw new Error('category_total_invalid');return total;
}
export function stickerShippingCategory(catalogueVariantId) {
  if (['10163','10164','10165'].includes(String(catalogueVariantId))) return 'Postcards, stickers';
  if (String(catalogueVariantId)==='16362') return 'Stickers with sizes (in): 15x3.75';
  return null;
}
