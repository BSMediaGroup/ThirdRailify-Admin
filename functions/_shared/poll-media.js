import { AuthFailure, accessForAccount, cleanText, hmacSha256, loadAccountById, nowIso, randomId } from "./auth-core.js";
import { publicMediaUrl } from "./media-origin.js";
import { sanitizeWheelMedia } from "./wheel-media.js";

const MEDIA_BINDING = "THIRDRAILIFY_PROFILE_MEDIA";
const TYPES = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"]]);
const LIMITS = Object.freeze({ banner: 8 * 1024 * 1024, option: 4 * 1024 * 1024 });

export async function uploadPollMedia(env, slugValue, purposeValue, optionIdValue, accountIdValue, bytesValue, declaredType, filenameValue = "") {
  const slug = clean(slugValue, 80); const purpose = normalizePurpose(purposeValue); const optionId = purpose === "option" ? clean(optionIdValue, 180) : null; const accountId = clean(accountIdValue, 160);
  const db = requireDb(env); const poll = await managedPoll(env, slug, accountId);
  if (purpose === "option") {
    const option = await db.prepare("SELECT id FROM poll_options WHERE id=? AND poll_id=?").bind(optionId, poll.id).first();
    if (!option) throw new AuthFailure(404, "poll_option_not_found", "That Poll option was not found.");
  }
  await mediaRateLimit(env, accountId, "poll_media_upload", 30, 3600);
  const bytes = new Uint8Array(bytesValue || []);
  if (bytes.byteLength > LIMITS[purpose]) throw new AuthFailure(413, "poll_media_too_large", `Choose a ${purpose} image no larger than ${LIMITS[purpose] / 1024 / 1024} MB.`);
  const image = sanitize(bytes, declaredType, purpose);
  const hash = await digestHex(image.bytes); const id = randomId(); const timestamp = nowIso(); const bucket = requireBucket(env);
  const objectKey = `polls/${poll.id}/${purpose}${optionId ? `/${optionId}` : ""}/${hash}-${id}.${TYPES.get(image.contentType)}`;
  const previous = await db.prepare(`SELECT id,object_key FROM poll_media_assets WHERE poll_id=? AND purpose=? AND lifecycle='active' AND (?='banner' OR poll_option_id=?) LIMIT 1`).bind(poll.id, purpose, purpose, optionId).first();
  await bucket.put(objectKey, image.bytes, { httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { kind: `poll-${purpose}`, schema: "thirdrailify-poll-media-v1" } });
  try {
    await db.batch([
      db.prepare(`UPDATE poll_media_assets SET lifecycle='deleted',deleted_at=?,updated_at=? WHERE poll_id=? AND purpose=? AND lifecycle='active' AND (?='banner' OR poll_option_id=?)`).bind(timestamp, timestamp, poll.id, purpose, purpose, optionId),
      db.prepare(`INSERT INTO poll_media_assets (id,poll_id,poll_option_id,purpose,object_key,sha256,content_type,byte_size,width,height,original_filename,lifecycle,uploaded_by_account_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`).bind(id, poll.id, optionId, purpose, objectKey, hash, image.contentType, image.bytes.byteLength, image.width, image.height, filename(filenameValue), accountId, timestamp, timestamp),
      audit(db, poll.id, accountId, "poll_media_uploaded", { assetId: id, purpose, optionId, replacedAssetId: previous?.id || null }, timestamp),
    ]);
  } catch (error) { await bucket.delete(objectKey).catch(() => {}); throw error; }
  if (previous?.object_key) await bucket.delete(previous.object_key).catch(() => {});
  return { ok: true, asset: project({ id, purpose, poll_option_id: optionId, content_type: image.contentType, byte_size: image.bytes.byteLength, width: image.width, height: image.height, sha256: hash, original_filename: filename(filenameValue), created_at: timestamp }, env, false) };
}

export async function removePollMedia(env, slugValue, purposeValue, optionIdValue, accountIdValue) {
  const slug = clean(slugValue, 80); const purpose = normalizePurpose(purposeValue); const optionId = purpose === "option" ? clean(optionIdValue, 180) : null; const accountId = clean(accountIdValue, 160);
  const db = requireDb(env); const poll = await managedPoll(env, slug, accountId); await mediaRateLimit(env, accountId, "poll_media_remove", 40, 3600);
  const asset = await db.prepare(`SELECT * FROM poll_media_assets WHERE poll_id=? AND purpose=? AND lifecycle='active' AND (?='banner' OR poll_option_id=?) LIMIT 1`).bind(poll.id, purpose, purpose, optionId).first();
  if (!asset) return { ok: true, removed: false, purpose, optionId };
  const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE poll_media_assets SET lifecycle='deleted',deleted_at=?,updated_at=? WHERE id=? AND lifecycle='active'").bind(timestamp, timestamp, asset.id),
    audit(db, poll.id, accountId, "poll_media_removed", { assetId: asset.id, purpose, optionId }, timestamp),
  ]);
  await requireBucket(env).delete(asset.object_key).catch(() => {});
  return { ok: true, removed: true, purpose, optionId };
}

export async function pollMediaResponse(env, assetIdValue, request, accountIdValue = "") {
  const assetId = clean(assetIdValue, 80); const accountId = clean(accountIdValue, 160); const db = requireDb(env);
  const row = await db.prepare(`SELECT a.*,p.owner_account_id,p.state,p.is_public FROM poll_media_assets a JOIN polls p ON p.id=a.poll_id WHERE a.id=? AND a.lifecycle='active' LIMIT 1`).bind(assetId).first();
  if (!row) throw new AuthFailure(404, "poll_media_not_found", "The Poll image was not found.");
  const publicVisible = Boolean(row.is_public) && new Set(["open", "closed"]).has(row.state);
  if (!publicVisible && !await mayManage(env, row, accountId)) throw new AuthFailure(404, "poll_media_not_found", "The Poll image was not found.");
  const object = await requireBucket(env).get(row.object_key);
  if (!object) throw new AuthFailure(404, "poll_media_not_found", "The Poll image was not found.");
  const headers = new Headers({ "Cache-Control": publicVisible ? "public, max-age=31536000, immutable" : "private, no-store", "Content-Type": row.content_type, "Cross-Origin-Resource-Policy": "same-origin", ETag: `\"${row.sha256}\"`, "X-Content-Type-Options": "nosniff" });
  const size = Number(object.size || row.byte_size); if (size > 0) headers.set("Content-Length", String(size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

export function projectPollMediaAsset(row, env, isPublic) { return row?.id ? project(row, env, isPublic) : null; }

function sanitize(bytes, declaredType, purpose) {
  try {
    const image = sanitizeWheelMedia(bytes, declaredType, purpose === "banner" ? "background" : "centre");
    if (!TYPES.has(image.contentType)) throw new Error("unsupported");
    return image;
  } catch (error) {
    if (error instanceof AuthFailure && error.code === "wheel_media_too_large") throw new AuthFailure(413, "poll_media_too_large", `Choose a ${purpose} image within the supported size limit.`);
    throw new AuthFailure(415, "poll_media_format_invalid", "Use a valid JPG, PNG, or WebP image with decodable dimensions.");
  }
}
function project(row, env, isPublic) { const path = `/poll-media/${encodeURIComponent(row.id)}`; return { id: row.id, purpose: row.purpose, optionId: row.poll_option_id || null, url: isPublic ? publicMediaUrl(env, path) || `/api/polls/media/${encodeURIComponent(row.id)}` : `/api/polls/media/${encodeURIComponent(row.id)}`, contentType: row.content_type, byteSize: Number(row.byte_size), width: Number(row.width), height: Number(row.height), sha256: row.sha256, fileName: row.original_filename || undefined, createdAt: row.created_at }; }
async function managedPoll(env, slug, accountId) { const db = requireDb(env); const poll = await db.prepare("SELECT * FROM polls WHERE public_slug=? LIMIT 1").bind(slug).first(); if (!poll) throw new AuthFailure(404, "poll_not_found", "This Poll was not found."); if (!await mayManage(env, poll, accountId)) throw new AuthFailure(403, "poll_owner_required", "Only the owner or an Admin may manage this Poll."); return poll; }
async function mayManage(env, poll, accountId) { if (!accountId) return false; if (poll.owner_account_id === accountId) return true; const row = await loadAccountById(env, accountId); return Boolean(row && row.status === "active" && accessForAccount(row).isAdmin && new Set(["full", "master"]).has(row.admin_level)); }
async function mediaRateLimit(env, accountId, category, limit, seconds) { const secret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || ""); if (!secret) throw new AuthFailure(503, "rate_limit_not_configured", "Poll media protection is not configured."); const db = requireDb(env); const keyHash = await hmacSha256(secret, `poll-media\n${category}\n${accountId}`); const row = await db.prepare("SELECT * FROM poll_rate_limits WHERE key_hash=? AND category=?").bind(keyHash, category).first(); const now = Date.now(); const expired = !row || now - Date.parse(row.window_started_at) >= seconds * 1000; const count = expired ? 1 : Number(row.request_count || 0) + 1; const timestamp = nowIso(now); const blocked = count > limit ? nowIso(now + Math.min(seconds, 900) * 1000) : null; await db.prepare(`INSERT INTO poll_rate_limits (key_hash,category,window_started_at,request_count,blocked_until,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(key_hash,category) DO UPDATE SET window_started_at=excluded.window_started_at,request_count=excluded.request_count,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at`).bind(keyHash, category, expired ? timestamp : row.window_started_at, count, blocked, timestamp).run(); if (blocked || (row?.blocked_until && Date.parse(row.blocked_until) > now)) throw new AuthFailure(429, "poll_media_rate_limited", "Too many Poll image changes. Try again shortly."); }
function audit(db, pollId, actorId, eventType, metadata, timestamp) { return db.prepare("INSERT INTO poll_activity_events (id,poll_id,actor_account_id,event_type,result,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(`pae_${randomId()}`, pollId, actorId, eventType, "success", JSON.stringify(metadata), timestamp); }
function requireDb(env) { const db = env?.THIRDRAILIFY_COMMERCE_DB; if (!db || typeof db.prepare !== "function") throw new AuthFailure(503, "polls_database_not_configured", "Poll authority is not configured."); return db; }
function requireBucket(env) { const bucket = env?.[MEDIA_BINDING]; if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function" || typeof bucket.delete !== "function") throw new AuthFailure(503, "poll_media_not_configured", "Poll image storage is not configured."); return bucket; }
function normalizePurpose(value) { const purpose = clean(value, 20); if (!new Set(["banner", "option"]).has(purpose)) throw new AuthFailure(400, "poll_media_purpose_invalid", "The Poll image purpose is invalid."); return purpose; }
function filename(value) { return cleanText(String(value || "poll-image").replace(/[\\/:*?\"<>|]/g, "-"), 120) || "poll-image"; }
function clean(value, maximum) { return cleanText(value, maximum); }
async function digestHex(bytes) { const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export { LIMITS as POLL_MEDIA_LIMITS };
