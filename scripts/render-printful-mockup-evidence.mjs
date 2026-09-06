import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { chromium } from "playwright-core";
const root = new URL("../.artifacts/printful-mockup-repair/", import.meta.url);
const snapshot = JSON.parse(await readFile(new URL("provider-snapshot.json", root), "utf8"));
await mkdir(new URL("images/", root), { recursive: true });
const assets = [];
for (const url of new Set(snapshot.products.flatMap((p) => p.images))) {
  if (!['files.cdn.printful.com','images-api.printful.com','mockup-api.printful.com','cdn.thirdrailify.com'].includes(new URL(url).hostname)) throw new Error('Unexpected image host');
  const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok || !/^image\//.test(response.headers.get("content-type") || "")) throw new Error("Image unavailable");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new Error("Image too large"); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  const decoded = await sharp(bytes, { limitInputPixels: 40_000_000 }).raw().toBuffer({ resolveWithObject: true });
  const info = await sharp(bytes).metadata();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filename = `images/${sha256}.${info.format === 'jpeg' ? 'jpg' : info.format}`;
  await writeFile(new URL(filename, root), bytes);
  assets.push({ sourceUrl: url, filename, sha256, contentType: response.headers.get('content-type'), bytes: size, width: decoded.info.width, height: decoded.info.height });
}
await writeFile(new URL("downloaded-assets.json", root), JSON.stringify(assets,null,2));
const escape = (s) => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const html = `<!doctype html><meta charset="utf-8"><title>Current merchant mockup evidence</title><style>body{background:#16191c;color:#eee;font:16px system-ui;margin:24px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}article{border:1px solid #777;padding:12px}img{width:145px;height:180px;object-fit:contain;background:white}small{display:block}h2{font-size:17px}</style><h1>Actual current Printful preview files</h1><p>${escape(snapshot.retrievedAt)} — ${snapshot.counts.products} products / ${snapshot.counts.variants} variants. API-exposed images; dashboard gallery completeness is not asserted.</p><main>${snapshot.products.map((p) => `<article><h2>${escape(p.name)}</h2><small>Sync Product ${p.id} · ${p.variants.length} variants</small>${p.images.map((url) => `<img src="${assets.find((a) => a.sourceUrl === url).filename}" alt="${escape(p.name)}">`).join('')}<small>${p.imageSelection.completeness}; ${p.imageSelection.catalogueCandidatesRejected} catalogue candidates rejected</small></article>`).join('')}</main>`;
await writeFile(new URL("provider-contact-sheet.html", root), html);
const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try { const page=await browser.newPage({viewport:{width:1500,height:1000}}); await page.goto(new URL('provider-contact-sheet.html',root).href); await page.locator('img').evaluateAll((images)=>Promise.all(images.map((img)=>img.decode()))); await page.screenshot({path:new URL('provider-contact-sheet.png',root).pathname.replace(/^\//,''),fullPage:true}); }
finally { await browser.close(); }
console.log(JSON.stringify({products:snapshot.products.length,decodedAssets:assets.length,bytes:assets.reduce((sum,a)=>sum+a.bytes,0)}));
