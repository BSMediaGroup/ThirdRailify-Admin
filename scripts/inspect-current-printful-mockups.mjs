// GET-only, sanitized evidence. Never writes provider or production state.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readCurrentPrintfulSnapshot } from "../functions/_shared/current-catalogue-reconciliation.js";
const env = { ...Object.fromEntries((await readFile(new URL("../.env", import.meta.url), "utf8").catch(() => "")).split(/\r?\n/).flatMap((line) => { const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); return m ? [[m[1], m[2].replace(/^(['"])(.*)\1$/, "$2")]] : []; })), ...process.env };
const roles = [];
const responses = {};
const snapshot = await readCurrentPrintfulSnapshot(env, async (url, init) => {
  if (init.method !== "GET") throw new Error("GET only");
  const response = await fetch(url, init);
  if (response.ok) {
    const data = await response.clone().json();
    if (/\/store\/products\/\d+$/.test(url)) {
      const { sync_product: p, sync_variants: variants } = data.result;
      responses[new URL(url).pathname] = { code: 200, result: {
        sync_product: Object.fromEntries(["id","external_id","name","thumbnail_url","is_ignored","status","variants","synced"].filter((key) => p[key] !== undefined).map((key) => [key,p[key]])),
        sync_variants: variants.map((v) => ({ ...Object.fromEntries(["id","external_id","sync_product_id","product_id","variant_id","name","sku","size","color","options","synced","is_ignored","availability_status","retail_price","currency","product"].filter((key) => v[key] !== undefined).map((key) => [key,v[key]])), files: (v.files || []).map((f) => Object.fromEntries(["id","type","status","visible","mime_type", ...(f.type === "preview" ? ["url","preview_url","thumbnail_url"] : [])].filter((key) => f[key] !== undefined).map((key) => [key,f[key]]))) })) } };
    } else if (new URL(url).pathname === "/stores") responses["/stores"] = { code:200, result:data.result.filter((store) => String(store.id) === String(env.PRINTFUL_STORE_ID)).map(({id,name,type}) => ({id,name,type})) };
    else responses[new URL(url).pathname + new URL(url).search] = { code:200, paging:data.paging, result:data.result.map(({id,external_id,name}) => ({id,external_id,name})) };
  }
  if (/\/store\/products\/\d+$/.test(url) && response.ok) {
    const { result } = await response.clone().json();
    roles.push({ productId: String(result.sync_product.id), files: result.sync_variants.map((v) => ({ variantId: String(v.id), files: (v.files || []).map((f) => ({ id: f.id, type: f.type, status: f.status, visible: f.visible, hasOriginal: Boolean(f.url), hasPreview: Boolean(f.preview_url), hasThumbnail: Boolean(f.thumbnail_url) })) })) });
  }
  return response;
});
const destination = new URL("../.artifacts/printful-mockup-repair/", import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(new URL("provider-snapshot.json", destination), JSON.stringify({ ...snapshot, roles }, null, 2));
await writeFile(new URL("provider-responses.json", destination), JSON.stringify(responses, null, 2));
console.log(JSON.stringify({ retrievedAt: snapshot.retrievedAt, store: snapshot.store, counts: snapshot.counts, fingerprint: snapshot.fingerprint, products: snapshot.products.map((p) => ({ id: p.id, title: p.name, variants: p.variants.length, selectedImages: p.images.length, ...p.imageSelection, images: undefined })), evidence: destination.pathname }, null, 2));
