import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const csvPath = resolve(process.argv[2] || join(root, "migrations", "WildGoats.csv"));
const sourceRoot = dirname(csvPath);
const outputRoot = resolve(process.argv[3] || join(root, "output", "goats-wix-import"));
const importedAt = "2026-08-28T00:00:00.000Z";

const csv = await readFile(csvPath, "utf8");
const records = parseCsv(csv);
if (records.length !== 9) throw new Error(`Expected 9 Wix GOAT rows; found ${records.length}.`);
if (records.some((row) => row.approved !== "true" || row.Status !== "PUBLISHED")) throw new Error("Every imported Wix GOAT must be approved and published in the source export.");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, "media"), { recursive: true });

const manifest = { format: "thirdrailify-wix-goats-v1", source: csvPath, importedAt, submissions: [], media: [] };
const sql = ["PRAGMA foreign_keys = ON;"];

for (const row of records) {
  const id = requiredUuid(row.ID, "ID");
  const slug = String(row["Wild Goats (Item)"] || "").replace(/^\/?goats\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(slug)) throw new Error(`Invalid public slug for ${row["Uploader Name"]}.`);
  const location = JSON.parse(row["Goat Location"]);
  const subdivisions = Array.isArray(location.subdivisions) ? location.subdivisions : [];
  const region = subdivisions.find((part) => part.type === "ADMINISTRATIVE_AREA_LEVEL_1");
  const country = String(location.country || subdivisions.find((part) => part.type === "COUNTRY")?.code || "").toUpperCase();
  const formatted = String(location.formatted || "").trim();
  const city = cityFromLocation(formatted, region?.name, country);
  const productSlug = productSlugFromUrl(row["Product URL"]);
  const uploadedAt = iso(row["Upload Date"] || row["Created Date"]);
  const updatedAt = iso(row["Updated Date"] || uploadedAt);
  const publishedAt = iso(row["Publish Date"] || uploadedAt);
  const reference = `WIX-${id.slice(0, 8).toUpperCase()}`;
  const values = {
    id, reference, slug, email: row["Uploader Email"], name: row["Uploader Name"], description: row["Merchandise Description"] || "Legacy GOATS in the Wild submission.",
    productSlug, productName: row.productName, city, region: region?.name || "", country, formatted,
    latitude: Number(location.location?.latitude), longitude: Number(location.location?.longitude),
    ownerId: row.ownerId || row.Owner, productUrl: row["Product URL"], uploadedAt, updatedAt, publishedAt,
    likes: nonNegativeInt(row.likesCount), dislikes: nonNegativeInt(row.dislikesCount), comments: nonNegativeInt(row.commentCount),
  };
  if (!Number.isFinite(values.latitude) || !Number.isFinite(values.longitude)) throw new Error(`Invalid location for ${values.name}.`);

  sql.push(`INSERT OR IGNORE INTO community_submissions (
    id, reference_code, public_slug, status, is_published, submitter_email, display_name, description,
    product_id, product_slug_snapshot, product_name_snapshot, rating, city, region, country_code,
    public_location_label, public_latitude, public_longitude, location_confirmed_at, consent_version,
    consented_at, created_at, submitted_at, updated_at, approved_at, version, comment_mode, reaction_mode,
    legacy_source, legacy_source_id, legacy_owner_id, legacy_product_url, legacy_uploaded_at, legacy_updated_at,
    legacy_like_count, legacy_dislike_count, legacy_comment_count
  ) VALUES (
    ${q(values.id)}, ${q(values.reference)}, ${q(values.slug)}, 'approved', 1, ${q(values.email)}, ${q(values.name)}, ${q(values.description)},
    (SELECT id FROM commerce_products WHERE slug = ${q(values.productSlug)} LIMIT 1), ${q(values.productSlug)}, ${q(values.productName)}, NULL,
    ${q(values.city)}, ${q(values.region || null)}, ${q(values.country)}, ${q(values.formatted)}, ${values.latitude}, ${values.longitude}, ${q(values.publishedAt)},
    'legacy-wix-cms-import-2026-08', ${q(values.uploadedAt)}, ${q(values.uploadedAt)}, ${q(values.uploadedAt)}, ${q(values.updatedAt)}, ${q(values.publishedAt)},
    1, 'inherit', 'inherit', 'wix-wild-goats', ${q(values.id)}, ${q(values.ownerId)}, ${q(values.productUrl)}, ${q(values.uploadedAt)}, ${q(values.updatedAt)},
    ${values.likes}, ${values.dislikes}, ${values.comments}
  );`);

  const folder = join(sourceRoot, values.name);
  const files = await sourceFiles(folder);
  const requested = requestedMedia(row, files);
  for (const [index, media] of requested.entries()) {
    const seed = `${id}:${media.role}:${index}:${media.file}`;
    const mediaId = deterministicUuid(seed);
    const outputName = `${mediaId}.webp`;
    const outputPath = join(outputRoot, "media", outputName);
    await sharp(join(folder, media.file), { animated: false, failOn: "error" }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).webp({ quality: 86, effort: 5 }).toFile(outputPath);
    const bytes = await readFile(outputPath);
    const metadata = await sharp(bytes).metadata();
    const hash = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `goats/private/${id}/${mediaId}-${hash.slice(0, 16)}.webp`;
    const byteSize = (await stat(outputPath)).size;
    sql.push(`INSERT OR IGNORE INTO community_media (id, submission_id, role, sort_order, object_key, content_type, byte_size, width, height, sha256, processing_state, created_at)
      VALUES (${q(mediaId)}, ${q(id)}, ${q(media.role)}, ${media.sortOrder}, ${q(objectKey)}, 'image/webp', ${byteSize}, ${metadata.width}, ${metadata.height}, ${q(hash)}, 'ready', ${q(importedAt)});`);
    manifest.media.push({ id: mediaId, submissionId: id, role: media.role, sortOrder: media.sortOrder, source: join(folder, media.file), file: join("media", outputName).replaceAll("\\", "/"), objectKey, contentType: "image/webp", byteSize, width: metadata.width, height: metadata.height, sha256: hash });
  }
  const eventId = deterministicUuid(`${id}:wix-import-event`);
  sql.push(`INSERT OR IGNORE INTO community_moderation_events (id, submission_id, actor_account_id, event_type, metadata_json, created_at)
    VALUES (${q(eventId)}, ${q(id)}, NULL, 'approved', ${q(JSON.stringify({ source: "wix-wild-goats", sourceId: id, importedAt }))}, ${q(importedAt)});`);
  manifest.submissions.push({ ...values, mediaCount: requested.length });
}

await writeFile(join(outputRoot, "import.sql"), `${sql.join("\n\n")}\n`, "utf8");
await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Built ${manifest.submissions.length} submissions and ${manifest.media.length} media objects in ${outputRoot}.`);

function requestedMedia(row, files) {
  const main = findFile(row.Photo, files, row["Uploader Name"], "Photo");
  const profile = findFile(row["Profile Image"], files, row["Uploader Name"], "Profile Image");
  const photoAsset = wixAssetId(row.Photo);
  const gallery = parseGallery(row.Gallery).map((entry) => {
    if (photoAsset && wixAssetId(entry.src) === photoAsset) return main;
    if (entry.fileName && files.some((file) => file.toLowerCase() === String(entry.fileName).toLowerCase())) return files.find((file) => file.toLowerCase() === String(entry.fileName).toLowerCase());
    return findFile(entry.src || entry.title || entry.slug, files, row["Uploader Name"], "Gallery");
  });
  const result = [{ role: "main", sortOrder: 0, file: main }];
  if (profile) result.push({ role: "profile", sortOrder: 0, file: profile });
  const seenGallery = new Set([main.toLowerCase(), profile?.toLowerCase()].filter(Boolean));
  for (const file of [...gallery, ...files]) {
    if (seenGallery.has(file.toLowerCase())) continue;
    seenGallery.add(file.toLowerCase());
    result.push({ role: "gallery", sortOrder: result.filter((item) => item.role === "gallery").length, file });
  }
  if (result.filter((item) => item.role === "gallery").length > 5) throw new Error(`Too many gallery images for ${row["Uploader Name"]}.`);
  return result;
}

async function sourceFiles(folder) {
  return (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
}
function parseGallery(value) { if (!value) return []; const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
function findFile(value, files, owner, field) {
  if (!value) return "";
  const decoded = decodeURIComponent(String(value).split("#", 1)[0]);
  const wanted = basename(decoded).toLowerCase();
  const direct = files.find((file) => file.toLowerCase() === wanted);
  if (direct) return direct;
  const wantedStem = stem(wanted).replace(/^[a-f0-9]+_[a-f0-9]+~mv2$/i, "");
  const candidate = files.find((file) => { const localStem = stem(file).toLowerCase(); return localStem === wantedStem || localStem.startsWith(wantedStem) || wantedStem.startsWith(localStem) || decoded.toLowerCase().includes(file.toLowerCase()); });
  if (candidate) return candidate;
  throw new Error(`${field} media for ${owner} does not match a local file (${wanted}).`);
}
function stem(value) { return basename(value, extname(value)); }
function wixAssetId(value) { return String(value || "").match(/\/v1\/([^/]+)/)?.[1]?.toLowerCase() || ""; }
function productSlugFromUrl(value) { const match = String(value || "").match(/\/product-page\/([^/?#]+)/i); if (!match) throw new Error(`Invalid Wix product URL: ${value}`); return match[1].toLowerCase(); }
function cityFromLocation(formatted, region, country) { const first = formatted.split(",", 1)[0].trim(); return first && first !== "USA" && first !== "Canada" && first !== "Australia" ? first : region || country; }
function requiredUuid(value, field) { const text = String(value || "").toLowerCase(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) throw new Error(`Invalid ${field}.`); return text; }
function deterministicUuid(seed) { const hex = createHash("sha256").update(seed).digest("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`; }
function iso(value) { const date = new Date(value); if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`); return date.toISOString(); }
function nonNegativeInt(value) { const number = Number(value || 0); if (!Number.isInteger(number) || number < 0) throw new Error(`Invalid aggregate count: ${value}`); return number; }
function q(value) { return value == null || value === "" ? "NULL" : `'${String(value).replaceAll("'", "''")}'`; }

function parseCsv(input) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const headers = rows.shift()?.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value) || [];
  return rows.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}
