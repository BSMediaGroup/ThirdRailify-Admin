import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const ADMIN_ORIGIN = String(process.env.THIRDRAILIFY_ADMIN_ORIGIN || "https://admin.thirdrailify.com").replace(/\/$/, "");
const MEDIA_ORIGIN = String(process.env.THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN || "https://cdn.thirdrailify.com").replace(/\/$/, "");
const CATALOGUE_URL = `${ADMIN_ORIGIN}/api/public/commerce/catalogue`;
const BUCKET = "thirdrailify-profile-media";
const MAX_BYTES = 10 * 1024 * 1024;
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = join(tmpdir(), `thirdrailify-commerce-media-${runId}`);
const upload = process.argv.includes("--upload");

const catalogueResponse = await fetch(CATALOGUE_URL, { headers: { Accept: "application/json" } });
if (!catalogueResponse.ok) throw new Error(`Catalogue request failed with ${catalogueResponse.status}.`);
const catalogue = await catalogueResponse.json();
if (!catalogue?.ok || !Array.isArray(catalogue.products) || catalogue.products.length !== 49) throw new Error("The live authoritative 49-product catalogue was not returned.");
await mkdir(outputDirectory, { recursive: false });

const sourceUrls = [...new Set(catalogue.products.flatMap((product) => product.images || []))];
const assetsBySource = new Map();
await concurrent(sourceUrls, 8, async (sourceUrl, index) => {
  const response = await fetch(sourceUrl, { headers: { Accept: "image/webp,image/png,image/jpeg" }, redirect: "error" });
  if (!response.ok) throw new Error(`Image ${index + 1}/${sourceUrls.length} returned ${response.status}: ${sourceUrl}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error(`Image ${index + 1}/${sourceUrls.length} has an invalid size: ${sourceUrl}`);
  const metadata = await sharp(bytes).metadata();
  const extension = metadata.format === "jpeg" ? "jpg" : metadata.format;
  const contentType = extension === "jpg" ? "image/jpeg" : extension === "png" || extension === "webp" ? `image/${extension}` : "";
  if (!contentType || !metadata.width || !metadata.height) throw new Error(`Image ${index + 1}/${sourceUrls.length} is not a valid JPG, PNG, or WebP: ${sourceUrl}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = `${sha256}.${extension}`;
  const file = join(outputDirectory, name);
  await writeFile(file, bytes, { flag: "wx" }).catch((error) => { if (error?.code !== "EEXIST") throw error; });
  assetsBySource.set(sourceUrl, { sourceUrl, sha256, name, file, objectKey: `commerce/catalogue/${name}`, contentType, bytes: bytes.length, width: metadata.width, height: metadata.height, url: `${MEDIA_ORIGIN}/commerce-media/${name}` });
});

const uniqueAssets = [...new Map([...assetsBySource.values()].map((asset) => [asset.sha256, asset])).values()];
const products = catalogue.products.map((product) => {
  const assets = product.images.map((url) => assetsBySource.get(url));
  if (assets.some((asset) => !asset)) throw new Error(`Product ${product.id} has an unresolved media source.`);
  return { id: product.id, sourcePrimary: product.images[0], primaryImage: assets[0].url, publicImages: assets.map((asset) => asset.url), assetHashes: assets.map((asset) => asset.sha256) };
});
const migrationTimestamp = new Date().toISOString();
const sql = products.map((product) => `UPDATE commerce_products\nSET safe_metadata_json = json_set(safe_metadata_json, '$.publicImage', ${sqlText(product.primaryImage)}, '$.publicImages', json(${sqlText(JSON.stringify(product.publicImages))}), '$.targetThumbnail', ${sqlText(product.primaryImage)}, '$.commerceMedia', json(${sqlText(JSON.stringify({ schema: "thirdrailify-commerce-media-v1", migratedAt: migrationTimestamp, assetHashes: product.assetHashes }))}))\nWHERE id = ${sqlText(product.id)} AND json_extract(safe_metadata_json, '$.publicImage') = ${sqlText(product.sourcePrimary)};`).join("\n\n") + "\n\nSELECT COUNT(*) AS remaining_external_images FROM commerce_products WHERE instr(safe_metadata_json, 'static.wixstatic.com') > 0;\n";
const manifestFile = join(outputDirectory, "manifest.json");
const sqlFile = join(outputDirectory, "apply-commerce-media.sql");
await writeFile(manifestFile, JSON.stringify({ generatedAt: migrationTimestamp, catalogueUrl: CATALOGUE_URL, mediaOrigin: MEDIA_ORIGIN, productCount: products.length, sourceUrlCount: sourceUrls.length, uniqueAssetCount: uniqueAssets.length, totalBytes: uniqueAssets.reduce((total, asset) => total + asset.bytes, 0), assets: uniqueAssets, products }, null, 2));
await writeFile(sqlFile, sql);

if (upload) {
  let completed = 0;
  await concurrent(uniqueAssets, 6, async (asset) => {
    await run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "r2", "object", "put", `${BUCKET}/${asset.objectKey}`, "--file", asset.file, "--content-type", asset.contentType, "--cache-control", "public, max-age=31536000, immutable", "--remote", "--cwd", process.cwd()]);
    completed += 1;
    if (completed % 25 === 0 || completed === uniqueAssets.length) process.stdout.write(`Uploaded ${completed}/${uniqueAssets.length}\n`);
  });
}

process.stdout.write(`${JSON.stringify({ outputDirectory, manifestFile, sqlFile, products: products.length, sourceUrls: sourceUrls.length, uniqueAssets: uniqueAssets.length, totalBytes: uniqueAssets.reduce((total, asset) => total + asset.bytes, 0), uploaded: upload }, null, 2)}\n`);

function sqlText(value) { return `'${String(value).replaceAll("'", "''")}'`; }
async function concurrent(values, limit, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor; cursor += 1; await worker(values[index], index); }
  }));
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Wrangler upload failed (${code}): ${stderr.slice(-2000)}`)));
  });
}
