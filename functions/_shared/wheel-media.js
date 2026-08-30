import {
  AuthFailure,
  accessForAccount,
  cleanText,
  hmacSha256,
  loadAccountById,
  nowIso,
  randomId,
} from "./auth-core.js";

const MEDIA_BINDING = "THIRDRAILIFY_PROFILE_MEDIA";
const PURPOSES = new Set(["background", "centre", "segment_fill"]);
const TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/bmp", "bmp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"],
]);
const LIMITS = Object.freeze({
  background: { bytes: 8 * 1024 * 1024, maxWidth: 10000, maxHeight: 10000, maxPixels: 40_000_000 },
  centre: { bytes: 4 * 1024 * 1024, maxWidth: 5000, maxHeight: 5000, maxPixels: 12_000_000 },
  segment_fill: { bytes: 2 * 1024 * 1024, staticBytes: Math.floor(1.5 * 1024 * 1024), svgBytes: 512 * 1024, maxWidth: 2048, maxHeight: 2048, maxPixels: 4_194_304, maxActiveAssets: 20, maxActiveBytes: 12 * 1024 * 1024 },
});

export async function uploadWheelMedia(env, slugValue, purposeValue, accountIdValue, bytesValue, declaredType, filenameValue = "") {
  const slug = clean(slugValue, 80); const purpose = normalizePurpose(purposeValue); const accountId = clean(accountIdValue, 160);
  const db = requireDb(env); const wheel = await db.prepare("SELECT * FROM wheels WHERE public_slug = ? COLLATE NOCASE LIMIT 1").bind(slug).first();
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  await requireEditor(env, wheel, accountId);
  await enforceMediaRateLimit(env, accountId, "wheel_media_upload", 20, 3600);
  const image = sanitizeWheelMedia(new Uint8Array(bytesValue || []), declaredType, purpose);
  const bucket = requireBucket(env); const id = randomId(); const timestamp = nowIso(); const hash = await digestHex(image.bytes);
  if (purpose === "segment_fill") {
    const duplicate = await db.prepare("SELECT * FROM wheel_media_assets WHERE wheel_id = ? AND purpose = 'segment_fill' AND sha256 = ? AND lifecycle = 'active' LIMIT 1").bind(wheel.id, hash).first();
    if (duplicate) return { ok: true, reused: true, asset: projectAsset(duplicate) };
    const usage = await db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM wheel_media_assets WHERE wheel_id = ? AND purpose = 'segment_fill' AND lifecycle = 'active'").bind(wheel.id).first();
    if (Number(usage?.count || 0) >= LIMITS.segment_fill.maxActiveAssets || Number(usage?.bytes || 0) + image.bytes.byteLength > LIMITS.segment_fill.maxActiveBytes) throw new AuthFailure(409, "wheel_segment_media_budget_exceeded", "A wheel may use at most 20 active segment images and 12 MB combined.");
  }
  const objectKey = `wheels/${wheel.id}/${purpose}/${hash}-${id}.${TYPES.get(image.contentType)}`;
  const previous = purpose === "segment_fill" ? null : await db.prepare("SELECT id, object_key FROM wheel_media_assets WHERE wheel_id = ? AND purpose = ? AND lifecycle = 'active'").bind(wheel.id, purpose).first();
  const filename = cleanFilename(filenameValue, TYPES.get(image.contentType));
  await bucket.put(objectKey, image.bytes, { httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { sha256: hash, purpose } });
  try {
    await db.batch([
      ...(purpose === "segment_fill" ? [] : [db.prepare("UPDATE wheel_media_assets SET lifecycle = 'deleted', deleted_at = ?, updated_at = ? WHERE wheel_id = ? AND purpose = ? AND lifecycle = 'active'").bind(timestamp, timestamp, wheel.id, purpose)]),
      db.prepare(`INSERT INTO wheel_media_assets
        (id, wheel_id, purpose, object_key, sha256, content_type, byte_size, width, height, original_filename, lifecycle, uploaded_by_account_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).bind(id, wheel.id, purpose, objectKey, hash, image.contentType, image.bytes.byteLength, image.width, image.height, filename, accountId, timestamp, timestamp),
      audit(db, wheel.id, accountId, "wheel_media_uploaded", { assetId: id, purpose, contentType: image.contentType, bytes: image.bytes.byteLength, width: image.width, height: image.height, replacedAssetId: previous?.id || null }, timestamp),
    ]);
  } catch (error) {
    await bucket.delete(objectKey).catch(() => {});
    throw error;
  }
  if (previous?.object_key) await bucket.delete(previous.object_key).catch(() => {});
  return { ok: true, reused: false, asset: projectAsset({ id, purpose, content_type: image.contentType, byte_size: image.bytes.byteLength, width: image.width, height: image.height, sha256: hash, original_filename: filename, created_at: timestamp }) };
}

export async function removeWheelMedia(env, slugValue, purposeValue, accountIdValue) {
  const slug = clean(slugValue, 80); const purpose = normalizePurpose(purposeValue); const accountId = clean(accountIdValue, 160);
  const db = requireDb(env); const wheel = await db.prepare("SELECT * FROM wheels WHERE public_slug = ? COLLATE NOCASE LIMIT 1").bind(slug).first();
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  await requireEditor(env, wheel, accountId); await enforceMediaRateLimit(env, accountId, "wheel_media_remove", 30, 3600);
  const asset = await db.prepare("SELECT * FROM wheel_media_assets WHERE wheel_id = ? AND purpose = ? AND lifecycle = 'active'").bind(wheel.id, purpose).first();
  if (!asset) return { ok: true, removed: false, purpose };
  await retireAsset(env, wheel, asset, accountId, "wheel_media_removed");
  return { ok: true, removed: true, purpose };
}

export async function adminRemoveWheelMedia(env, wheelIdValue, assetIdValue, actorIdValue) {
  const wheelId = clean(wheelIdValue, 80); const assetId = clean(assetIdValue, 80); const actorId = clean(actorIdValue, 160); const db = requireDb(env);
  const wheel = await db.prepare("SELECT * FROM wheels WHERE id = ?").bind(wheelId).first();
  if (!wheel) throw new AuthFailure(404, "wheel_not_found", "This wheel was not found.");
  const asset = await db.prepare("SELECT * FROM wheel_media_assets WHERE id = ? AND wheel_id = ? AND lifecycle = 'active'").bind(assetId, wheelId).first();
  if (!asset) throw new AuthFailure(404, "wheel_media_not_found", "The wheel image was not found.");
  await enforceMediaRateLimit(env, actorId, "admin_wheel_media_remove", 60, 3600);
  await retireAsset(env, wheel, asset, actorId, "admin_wheel_media_removed");
  return { ok: true, removed: true, assetId };
}

export async function mediaForWheel(env, wheelId, options = {}) {
  const rows = await requireDb(env).prepare(`SELECT id, purpose, content_type, byte_size, width, height, sha256, original_filename, created_at, lifecycle
    FROM wheel_media_assets WHERE wheel_id = ? ${options.includeDeleted ? "" : "AND lifecycle = 'active'"}
    ORDER BY purpose, created_at DESC`).bind(wheelId).all();
  if (options.includeDeleted) return (rows?.results || []).map((row) => ({ ...projectAsset(row), lifecycle: row.lifecycle }));
  const projected = { background: null, centre: null, segmentFills: [] };
  for (const row of rows?.results || []) { if (row.purpose === "segment_fill") projected.segmentFills.push(projectAsset(row)); else if (!projected[row.purpose]) projected[row.purpose] = projectAsset(row); }
  return projected;
}

export async function validateSegmentMediaReferences(env, wheelId, assetIds) {
  const unique = [...new Set(assetIds || [])];
  if (unique.length > LIMITS.segment_fill.maxActiveAssets) throw new AuthFailure(400, "wheel_segment_media_count_invalid", "A wheel may reference at most 20 unique segment images.");
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  const rows = await requireDb(env).prepare(`SELECT id, byte_size FROM wheel_media_assets WHERE wheel_id = ? AND purpose = 'segment_fill' AND lifecycle = 'active' AND id IN (${placeholders})`).bind(wheelId, ...unique).all();
  if ((rows?.results || []).length !== unique.length) throw new AuthFailure(400, "wheel_segment_media_invalid", "Every segment image must belong to this wheel and remain active.");
  const bytes = (rows.results || []).reduce((total, row) => total + Number(row.byte_size || 0), 0);
  if (bytes > LIMITS.segment_fill.maxActiveBytes) throw new AuthFailure(400, "wheel_segment_media_budget_exceeded", "Referenced segment images exceed the 12 MB wheel budget.");
  return rows.results;
}

export async function retireSegmentMediaAssets(env, wheel, assetIds, actorId) {
  const remove = [...new Set(assetIds || [])]; if (!remove.length) return; const db = requireDb(env); const placeholders = remove.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT * FROM wheel_media_assets WHERE wheel_id = ? AND purpose = 'segment_fill' AND lifecycle = 'active' AND id IN (${placeholders})`).bind(wheel.id, ...remove).all();
  for (const asset of rows?.results || []) await retireSegmentAssetIfUnreferenced(env, wheel, asset, actorId);
}

export async function wheelMediaResponse(env, assetIdValue, request, accountIdValue = "") {
  const assetId = clean(assetIdValue, 80); const db = requireDb(env);
  const row = await db.prepare(`SELECT a.*, w.lifecycle AS wheel_lifecycle, w.visibility AS wheel_visibility, w.owner_account_id
    FROM wheel_media_assets a JOIN wheels w ON w.id = a.wheel_id WHERE a.id = ? AND a.lifecycle = 'active' LIMIT 1`).bind(assetId).first();
  if (!row) throw new AuthFailure(404, "wheel_media_not_found", "The wheel image was not found.");
  const publicVisible = row.wheel_lifecycle === "active" && row.wheel_visibility === "public";
  if (!publicVisible && !await mayViewHidden(env, row, clean(accountIdValue, 160))) throw new AuthFailure(404, "wheel_media_not_found", "The wheel image was not found.");
  const object = await requireBucket(env).get(row.object_key);
  if (!object) throw new AuthFailure(404, "wheel_media_not_found", "The wheel image was not found.");
  const headers = new Headers({
    "Cache-Control": publicVisible ? "public, max-age=31536000, immutable" : "private, no-store",
    "Content-Type": row.content_type,
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: `\"${row.sha256}\"`,
    "X-Content-Type-Options": "nosniff",
  });
  if (row.content_type === "image/svg+xml") headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  const size = Number(object.size || row.byte_size); if (size > 0) headers.set("Content-Length", String(size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

export function sanitizeWheelMedia(bytes, declaredType, purposeValue) {
  const purpose = normalizePurpose(purposeValue); const limit = LIMITS[purpose];
  if (!bytes.byteLength) throw new AuthFailure(400, "wheel_media_empty", "Choose a non-empty image.");
  if (bytes.byteLength > limit.bytes) throw new AuthFailure(413, "wheel_media_too_large", `Choose a ${purpose} image no larger than ${limit.bytes / 1024 / 1024} MB.`);
  const detected = detectType(bytes); const declared = normalizeType(declaredType);
  if (!detected || (declared && declared !== detected)) throw new AuthFailure(415, "wheel_media_format_invalid", "Use a valid PNG, JPG, BMP, WebP, GIF, or safe SVG image.");
  if (purpose !== "segment_fill" && detected === "image/gif") throw new AuthFailure(415, "wheel_media_format_invalid", "GIF is supported only for segment fills.");
  if (purpose === "segment_fill") { const exactLimit = detected === "image/svg+xml" ? limit.svgBytes : detected === "image/gif" ? limit.bytes : limit.staticBytes; if (bytes.byteLength > exactLimit) throw new AuthFailure(413, "wheel_media_too_large", `This segment image exceeds its ${Math.round(exactLimit / 1024)} KiB format budget.`); }
  let safeBytes = bytes; let dimensions;
  if (detected === "image/svg+xml") {
    const svg = validateSvg(bytes); safeBytes = new TextEncoder().encode(svg.source); dimensions = svg;
  } else { if (detected === "image/gif" && !validGif(bytes)) throw new AuthFailure(415, "wheel_media_gif_invalid", "The GIF image structure is invalid."); dimensions = rasterDimensions(bytes, detected); }
  if (!dimensions?.width || !dimensions?.height || dimensions.width > limit.maxWidth || dimensions.height > limit.maxHeight || dimensions.width * dimensions.height > limit.maxPixels) {
    throw new AuthFailure(413, "wheel_media_dimensions_invalid", `The ${purpose} image dimensions are outside the supported range.`);
  }
  return { bytes: safeBytes, contentType: detected, width: dimensions.width, height: dimensions.height };
}

function validateSvg(bytes) {
  if (bytes.byteLength > 512 * 1024) throw new AuthFailure(413, "wheel_media_svg_too_complex", "The SVG document is too large.");
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").trim(); } catch { throw new AuthFailure(415, "wheel_media_svg_invalid", "The SVG document is not valid UTF-8."); }
  if (!/^<svg[\s>]/i.test(source) || !/<\/svg>\s*$/i.test(source) || (source.match(/</g) || []).length > 4000) throw new AuthFailure(415, "wheel_media_svg_invalid", "The SVG document is invalid or too complex.");
  const unsafe = /<\s*(?:script|foreignObject|iframe|object|embed|audio|video|canvas|link|meta)\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:|javascript:)|url\s*\(\s*["']?\s*(?:https?:|\/\/|data:)|@import|<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i;
  if (unsafe.test(source)) throw new AuthFailure(415, "wheel_media_svg_unsafe", "The SVG contains executable or external content.");
  const root = source.match(/^<svg\b([^>]*)>/i)?.[1] || "";
  const width = numericSvgDimension(root.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1]); const height = numericSvgDimension(root.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1]);
  const viewBox = root.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const viewWidth = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? Math.abs(viewBox[2]) : 0; const viewHeight = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? Math.abs(viewBox[3]) : 0;
  return { source, width: Math.round(width || viewWidth), height: Math.round(height || viewHeight) };
}

function detectType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 24 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 26 && ascii(bytes, 0, 2) === "BM") return "image/bmp";
  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 512))).replace(/^\uFEFF/, "").trimStart();
  if (/^<svg[\s>]/i.test(head)) return "image/svg+xml";
  return "";
}

function rasterDimensions(bytes, type) {
  if (type === "image/png") return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  if (type === "image/bmp") return { width: Math.abs(i32le(bytes, 18)), height: Math.abs(i32le(bytes, 22)) };
  if (type === "image/webp") return webpDimensions(bytes);
  if (type === "image/jpeg") return jpegDimensions(bytes);
  if (type === "image/gif") return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  return null;
}
function jpegDimensions(bytes) { let offset = 2; while (offset + 9 < bytes.length) { if (bytes[offset] !== 0xff) { offset += 1; continue; } const marker = bytes[offset + 1]; if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; } const length = (bytes[offset + 2] << 8) | bytes[offset + 3]; if (length < 2 || offset + length + 2 > bytes.length) break; if (new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]).has(marker)) return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] }; offset += length + 2; } return null; }
function webpDimensions(bytes) { const chunk = ascii(bytes, 12, 16); if (chunk === "VP8X" && bytes.length >= 30) return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) }; if (chunk === "VP8 " && bytes.length >= 30) return { width: ((bytes[27] << 8) | bytes[26]) & 0x3fff, height: ((bytes[29] << 8) | bytes[28]) & 0x3fff }; if (chunk === "VP8L" && bytes.length >= 25) { const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0; return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; } return null; }
function validGif(bytes) { if (bytes.length < 14 || bytes[bytes.length - 1] !== 0x3b) return false; let imageDescriptors = 0; for (let index = 13; index < bytes.length - 1; index += 1) if (bytes[index] === 0x2c) imageDescriptors += 1; return imageDescriptors >= 1; }

async function retireAsset(env, wheel, asset, actorId, eventType) { const db = requireDb(env); const timestamp = nowIso(); await db.batch([db.prepare("UPDATE wheel_media_assets SET lifecycle = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ? AND lifecycle = 'active'").bind(timestamp, timestamp, asset.id), audit(db, wheel.id, actorId, eventType, { assetId: asset.id, purpose: asset.purpose }, timestamp)]); await requireBucket(env).delete(asset.object_key).catch(() => {}); }
async function retireSegmentAssetIfUnreferenced(env, wheel, asset, actorId) {
  const db = requireDb(env); const timestamp = nowIso();
  const result = await db.batch([
    db.prepare(`UPDATE wheel_media_assets SET lifecycle = 'deleted', deleted_at = ?, updated_at = ?
      WHERE id = ? AND wheel_id = ? AND purpose = 'segment_fill' AND lifecycle = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM wheels w, json_each(json_extract(w.config_json, '$.paletteStyles')) style
        WHERE w.id = ? AND json_extract(style.value, '$.mode') = 'image' AND json_extract(style.value, '$.imageAssetId') = ?
        UNION ALL
        SELECT 1 FROM wheel_entries e
        WHERE e.wheel_id = ? AND json_extract(e.segment_style_json, '$.mode') = 'image' AND json_extract(e.segment_style_json, '$.imageAssetId') = ?
      )`).bind(timestamp, timestamp, asset.id, wheel.id, wheel.id, asset.id, wheel.id, asset.id),
    db.prepare(`INSERT INTO wheel_audit_events (id, wheel_id, actor_account_id, target_account_id, event_type, metadata_json, created_at)
      SELECT ?, ?, ?, NULL, 'wheel_segment_media_unreferenced', ?, ?
      WHERE EXISTS (SELECT 1 FROM wheel_media_assets WHERE id = ? AND lifecycle = 'deleted' AND updated_at = ?)`).bind(randomId(), wheel.id, actorId, JSON.stringify({ assetId: asset.id, purpose: asset.purpose }), timestamp, asset.id, timestamp),
  ]);
  if (Number(result?.[0]?.meta?.changes || 0) === 1) await requireBucket(env).delete(asset.object_key).catch(() => {});
}
async function requireEditor(env, wheel, accountId) { const account = await loadAccountById(env, accountId); if (!account || account.status !== "active") throw new AuthFailure(401, "authentication_required", "Sign in to manage wheel images."); const master = accessForAccount(account).isMasterAdmin; const assignment = await requireDb(env).prepare("SELECT role, active FROM wheel_access WHERE wheel_id = ? AND account_id = ?").bind(wheel.id, accountId).first(); if (!master && !(assignment?.active && new Set(["owner", "editor"]).has(assignment.role))) throw new AuthFailure(403, "wheel_media_forbidden", "Owner or editor access is required."); if (wheel.editing_locked && !master) throw new AuthFailure(423, "wheel_edit_locked", "Wheel editing is locked by Admin."); }
async function mayViewHidden(env, wheel, accountId) { if (!accountId) return false; const account = await loadAccountById(env, accountId); if (!account || account.status !== "active") return false; if (accessForAccount(account).isMasterAdmin) return true; const row = await requireDb(env).prepare("SELECT active FROM wheel_access WHERE wheel_id = ? AND account_id = ?").bind(wheel.wheel_id, accountId).first(); return Boolean(row?.active); }
async function enforceMediaRateLimit(env, identifier, category, limit, windowSeconds) { const secret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || ""); if (!secret) throw new AuthFailure(503, "rate_limit_not_configured", "Wheel media protection is not configured."); const db = requireDb(env); const keyHash = await hmacSha256(secret, `wheels\n${category}\n${clean(identifier, 160)}`); const row = await db.prepare("SELECT * FROM wheel_rate_limits WHERE key_hash = ? AND category = ?").bind(keyHash, category).first(); const now = Date.now(); const expired = !row || now - Date.parse(row.window_started_at) >= windowSeconds * 1000; const count = expired ? 1 : Number(row.request_count || 0) + 1; const timestamp = nowIso(now); const blockedUntil = count > limit ? new Date(now + Math.min(windowSeconds, 900) * 1000).toISOString() : null; await db.prepare(`INSERT INTO wheel_rate_limits (key_hash, category, window_started_at, request_count, blocked_until, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key_hash, category) DO UPDATE SET window_started_at=excluded.window_started_at,request_count=excluded.request_count,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at`).bind(keyHash, category, expired ? timestamp : row.window_started_at, count, blockedUntil, timestamp).run(); if (blockedUntil || (row?.blocked_until && Date.parse(row.blocked_until) > now)) throw new AuthFailure(429, "wheel_rate_limited", "Too many wheel media changes. Try again shortly."); }
function projectAsset(row) { return { id: row.id, purpose: row.purpose, url: `/api/wheels/media/${encodeURIComponent(row.id)}`, contentType: row.content_type, byteSize: Number(row.byte_size), width: row.width == null ? null : Number(row.width), height: row.height == null ? null : Number(row.height), sha256: row.sha256, fileName: row.original_filename || undefined, animationCapable: row.content_type === "image/gif", createdAt: row.created_at }; }
function requireDb(env) { const db = env?.THIRDRAILIFY_COMMERCE_DB; if (!db || typeof db.prepare !== "function") throw new AuthFailure(503, "wheels_database_not_configured", "Wheel authority is not configured."); return db; }
function requireBucket(env) { const bucket = env?.[MEDIA_BINDING]; if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function" || typeof bucket.delete !== "function") throw new AuthFailure(503, "wheel_media_not_configured", "Wheel image storage is not configured."); return bucket; }
function normalizePurpose(value) { const purpose = clean(value, 20).replace(/-/g, "_"); if (!PURPOSES.has(purpose)) throw new AuthFailure(400, "wheel_media_purpose_invalid", "The wheel image purpose is invalid."); return purpose; }
function normalizeType(value) { const type = String(value || "").split(";", 1)[0].trim().toLowerCase(); return type === "image/jpg" || type === "image/pjpeg" ? "image/jpeg" : type === "image/x-ms-bmp" ? "image/bmp" : type; }
function numericSvgDimension(value) { const match = String(value || "").match(/^([0-9]+(?:\.[0-9]+)?)(?:px)?$/i); return match ? Number(match[1]) : 0; }
function cleanFilename(value, extension) { const name = String(value || `segment-image.${extension}`).replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 120); return name || `segment-image.${extension}`; }
function audit(db, wheelId, actorId, eventType, metadata, timestamp) { return db.prepare("INSERT INTO wheel_audit_events (id,wheel_id,actor_account_id,event_type,metadata_json,created_at) VALUES (?,?,?,?,?,?)").bind(randomId(), wheelId, actorId, eventType, JSON.stringify(metadata), timestamp); }
function clean(value, max) { return cleanText(value, max); }
function ascii(bytes, start, end) { return String.fromCharCode(...bytes.slice(start, end)); }
function u24le(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) >>> 0; }
function u32be(bytes, offset) { return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0; }
function i32le(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)); }
async function digestHex(bytes) { const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export { LIMITS as WHEEL_MEDIA_LIMITS };
