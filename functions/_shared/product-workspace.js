import { AuthFailure, nowIso } from "./auth-core.js";
import { requireCommerceDb, merchandisingProductPayload, updateMerchandisingProduct, updateMerchandisingVariant } from "./commerce-core.js";
import { storefrontEligibility, protectedTestProduct } from "./storefront-eligibility.js";
import { transactionGuard } from "./commerce-transaction-guards.js";
import { ingestCommerceProductMedia } from "./commerce-media.js";
import { weightToMilligrams } from "./shipping-ratebook.js";

const parse = v => JSON.parse(v || "{}");
const fail = (code, message) => { throw new AuthFailure(409, code, message); };
export async function readCatalogueInput(request) {
  if (!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json')) throw new AuthFailure(415,'content_type_invalid','Send JSON product data.');
  if (!request.body) throw new AuthFailure(400,'request_invalid','Product data is required.');
  const reader=request.body.getReader(),chunks=[];let length=0;
  try { for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>256*1024)throw new AuthFailure(413,'request_too_large','Product data exceeds 256 KB.');chunks.push(value);} } finally { await reader.cancel(); }
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new AuthFailure(400,'request_json_invalid','Product data must be valid JSON.');}
}
async function state(db, id) {
  const product = await db.prepare("SELECT * FROM commerce_products WHERE id=?").bind(id).first();
  if (!product) throw new AuthFailure(404, "commerce_product_not_found", "Product not found.");
  const variants = (await db.prepare("SELECT * FROM commerce_product_variants WHERE product_id=? ORDER BY id").bind(id).all()).results;
  const weights = (await db.prepare("SELECT * FROM commerce_shipping_weights WHERE product_id=? ORDER BY id").bind(id).all()).results;
  const policy = await db.prepare("SELECT value_json FROM commerce_settings WHERE setting_key='shipping_strategy'").first();
  const shippingPolicy = await db.prepare("SELECT * FROM commerce_shipping_policy WHERE id='primary'").first();
  const value = { product, variants, weights, policy, shippingPolicy };
  const revision = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map(b => b.toString(16).padStart(2,"0")).join("");
  return { ...value, revision, shippingStrategy: policy ? parse(policy.value_json) : null };
}
export async function productWorkspace(env, session, id) {
  const db = requireCommerceDb(env), current = await state(db, id);
  const payload = await merchandisingProductPayload(env, session, id);
  return { ...payload, revision: current.revision, weights: current.weights, shippingStrategy: current.shippingStrategy,
    readiness: storefrontEligibility(current.product, current.variants, env.PRINTFUL_STORE_ID, { shippingStrategy: current.shippingStrategy, weights: current.weights }),
    mediaAssignments: current.variants.map(v => ({ variantId: v.id, images: parse(v.safe_metadata_json).assignedImages || [], providerImage: parse(v.safe_metadata_json).providerImage || null })),
    providerValues: current.variants.map(v=>({variantId:v.id,...parse(v.safe_metadata_json).providerValues})),
  };
}

// Existing authenticated mutation validators build their normal statements into
// a staging buffer. No D1 writes occur until all fields and assets have passed.
function bufferedDb(db, statements) {
  const wrap = native => ({
    bind: (...args) => wrap(native.bind(...args)),
    first: (...args) => native.first(...args), all: (...args) => native.all(...args),
    run: async () => { statements.push(native); return { success: true, meta: { changes: 1 } }; },
    native,
  });
  return { prepare: sql => wrap(db.prepare(sql)), batch: async list => { statements.push(...list.map(s => s.native || s)); return list.map(() => ({ success: true, meta: { changes: 1 } })); } };
}
export async function saveProductWorkspace(env, session, id, input, fetchImpl = fetch) {
  if (!input || Object.keys(input).some(k => !["revision","product","variants","publish","weights","mediaAssignments"].includes(k)) || typeof input.publish !== "boolean" || !Array.isArray(input.variants) || input.variants.length > 200 || !Array.isArray(input.weights) || !Array.isArray(input.mediaAssignments)) fail("product_workspace_invalid", "Review the product fields before saving.");
  const db = requireCommerceDb(env), before = await state(db,id);
  if (input.revision !== before.revision) fail("product_revision_conflict", "This product changed in another session. Reload and review your edits.");
  if (before.product.provider_presence !== "current" || before.product.provider_store_id !== String(env.PRINTFUL_STORE_ID) || before.product.archived_at) fail("product_not_current", "Only current-store products can be saved here.");
  if (input.publish && protectedTestProduct(before.product)) fail("product_test_locked", "This deliberate test product cannot be published to production.");
  for (const list of [input.variants,input.mediaAssignments]) if (new Set(list.map(v=>v.variantId)).size !== list.length || list.some(v=>!before.variants.some(row=>row.id===v.variantId))) fail("product_variant_identity_invalid", "Every variant must belong to this product, once only.");
  const timestamp = nowIso(), writes = [], stageEnv = { ...env, THIRDRAILIFY_COMMERCE_DB: bufferedDb(db,writes) };
  const edit = { ...input.product, visibility: input.publish ? "public" : "private", status: input.publish ? "active" : "disabled" };
  const allUrls = [...new Set([edit.primaryImageUrl,...(edit.additionalImages || []),...input.mediaAssignments.flatMap(a => (a.images || []).map(i=>i.url))].filter(Boolean))];
  if (allUrls.length > 25 || input.mediaAssignments.some(a=>!Array.isArray(a.images) || a.images.length>25 || a.images.some(i=>typeof i.url!=="string" || typeof i.alt!=="string" || i.alt.length>240))) fail("product_media_invalid", "Use up to 25 images with short alt text.");
  const existing = new Set([parse(before.product.safe_metadata_json).publicImage,...(parse(before.product.safe_metadata_json).publicImages || []),...before.variants.flatMap(v=>(parse(v.safe_metadata_json).assignedImages||[]).map(i=>i.url))]);
  const introduced = allUrls.filter(u=>!existing.has(u));
  const staged = introduced.length ? await ingestCommerceProductMedia(env,session,id,{imageUrls:introduced},fetchImpl) : {assets:[]};
  const canonical = url => staged.assets[introduced.indexOf(url)]?.url || url;
  edit.primaryImageUrl = edit.primaryImageUrl ? canonical(edit.primaryImageUrl) : null;
  edit.additionalImages = (edit.additionalImages || []).map(canonical);
  await updateMerchandisingProduct(stageEnv,session,id,edit);
  const variants = before.variants.map(v=>({...v}));
  for (const {variantId,...fields} of input.variants) {
    await updateMerchandisingVariant(stageEnv,session,id,variantId,fields);
    const row=variants.find(v=>v.id===variantId);
    Object.assign(row, {unit_amount:fields.unitAmount,status:fields.status,visibility:fields.visibility,is_sellable:fields.sellable?1:0,availability_status:fields.availability,safe_metadata_json:JSON.stringify({...parse(row.safe_metadata_json),publicationIntent:fields.sellable&&fields.visibility==='public'?'operator_publish':'operator_hidden'})});
  }
  const weights = before.weights.map(w=>({...w}));
  if (input.weights.length > 201 || new Set(input.weights.map(w=>w.variantId)).size !== input.weights.length) fail("product_weights_invalid","Select each weight once.");
  for (const weight of input.weights) {
    if (weight.variantId !== null && !variants.some(v=>v.id===weight.variantId)) fail("product_weight_identity_invalid","Weight variant does not belong to this product.");
    const mg = weight.value === null ? null : weightToMilligrams(weight.value, weight.unit);
    const key = weight.variantId ? `variant:${weight.variantId}` : `product:${id}`;
    const old = weights.find(w=>w.id===key), next = {id:key,product_id:id,variant_id:weight.variantId,weight_mg:mg,provenance:"operator_entered",revision:(old?.revision||0)+1,updated_at:timestamp};
    if (old) Object.assign(old,next); else weights.push(next);
    writes.push(db.prepare("INSERT INTO commerce_shipping_weights(id,product_id,variant_id,weight_mg,provenance,revision,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET weight_mg=excluded.weight_mg,provenance=excluded.provenance,revision=excluded.revision,updated_at=excluded.updated_at").bind(key,id,weight.variantId,mg,next.provenance,next.revision,timestamp));
  }
  const product = {...before.product,status:edit.status,visibility:edit.visibility,checkout_environment:input.publish?"live":before.product.checkout_environment,safe_metadata_json:JSON.stringify({...parse(before.product.safe_metadata_json),publicImage:edit.primaryImageUrl,saleRestriction:edit.saleRestriction,publicationIntent:input.publish?"operator_publish":"operator_hidden"})};
  const readiness = storefrontEligibility(product,variants,env.PRINTFUL_STORE_ID,{shippingStrategy:before.shippingStrategy,weights});
  const blockers = [...readiness.productReasons];
  if (before.shippingStrategy === "merchant_weight_bands" && !before.shippingPolicy?.active_ratebook_id) blockers.push("shipping_ratebook_unpublished");
  if (!["printful_dynamic","merchant_weight_bands"].includes(before.shippingStrategy)) blockers.push("shipping_policy_unknown");
  const saleRestricted = edit.saleRestriction?.enabled === true;
  const eligibleIds = readiness.variants.filter(v=>v.eligible && (v.shipping.ready || saleRestricted) && parse(variants.find(row=>row.id===v.id).safe_metadata_json).publicationIntent !== "operator_hidden" && input.variants.find(e=>e.variantId===v.id)?.sellable !== false).map(v=>v.id);
  if (!eligibleIds.length) blockers.push("no_purchase_ready_variants");
  const published = input.publish && blockers.length===0;
  writes.push(db.prepare("UPDATE commerce_products SET checkout_environment=CASE WHEN ?=1 AND ?=0 THEN 'live' ELSE checkout_environment END,visibility=?,status=?,safe_metadata_json=json_set(safe_metadata_json,'$.publicationIntent',?,'$.workspaceSavedAt',?),updated_at=? WHERE id=?").bind(published?1:0,saleRestricted?1:0,published?"public":"private",published?"active":"disabled",input.publish?"operator_publish":"operator_hidden",timestamp,timestamp,id));
  for (const v of variants) {
    const enabled = published && eligibleIds.includes(v.id);
    writes.push(db.prepare("UPDATE commerce_product_variants SET status=?,visibility=?,is_sellable=?,updated_at=? WHERE id=?").bind(enabled?"active":"disabled",enabled?"public":"private",enabled?1:0,timestamp,v.id));
  }
  for (const assignment of input.mediaAssignments) writes.push(db.prepare("UPDATE commerce_product_variants SET safe_metadata_json=json_set(safe_metadata_json,'$.assignedImages',json(?),'$.mediaAssignmentSource','operator'),updated_at=? WHERE id=?").bind(JSON.stringify(assignment.images.map(i=>({url:canonical(i.url),alt:i.alt}))),timestamp,assignment.variantId));
  const latest = await state(db,id);
  if (latest.revision !== before.revision) fail("product_revision_conflict","Product or shipping policy changed during media staging. Reload and review.");
  const guards = [];
  for (const [table,records] of [["commerce_products",[before.product]],["commerce_product_variants",before.variants],["commerce_shipping_weights",before.weights]]) for (const row of records) {
    const entries=Object.entries(row);guards.push(transactionGuard(db,`EXISTS(SELECT 1 FROM ${table} WHERE ${entries.map(([k])=>`${k} IS ?`).join(" AND ")})`,entries.map(([,v])=>v)));
  }
  guards.push(transactionGuard(db,"(SELECT COUNT(*) FROM commerce_product_variants WHERE product_id=?)=?",[id,before.variants.length]));
  guards.push(transactionGuard(db,"(SELECT COUNT(*) FROM commerce_shipping_weights WHERE product_id=?)=?",[id,before.weights.length]));
  guards.push(transactionGuard(db,"(SELECT value_json FROM commerce_settings WHERE setting_key='shipping_strategy') IS ?",[before.policy?.value_json??null]));
  if(before.shippingPolicy) guards.push(transactionGuard(db,"EXISTS(SELECT 1 FROM commerce_shipping_policy WHERE id='primary' AND revision=? AND active_ratebook_id IS ?)",[before.shippingPolicy.revision,before.shippingPolicy.active_ratebook_id]));
  try { await db.batch([...guards,...writes]); } catch(error) { if (/commerce_transaction_conflict|malformed JSON/.test(String(error))) fail("product_revision_conflict","Concurrent changes prevented this save. Reload and review."); throw error; }
  return {...await productWorkspace(env,session,id),saveResult:{published,desiredPublication:input.publish,blockers,message:published?"Product saved and published.":input.publish?`Saved as draft — ${blockers.join(", ")}`:"Product saved as draft."}};
}
