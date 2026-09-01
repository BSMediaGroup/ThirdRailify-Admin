import { AuthFailure, cleanText, nowIso, randomId, writeAudit } from "./auth-core.js";
import { sanitizeWheelMedia } from "./wheel-media.js";

const BUCKET = "THIRDRAILIFY_PROFILE_MEDIA";
const IMAGE_TYPES = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/bmp", "bmp"]]);

export async function adminGamingPayload(env, access) {
  const db = requireDb(env);
  const rows = await db.prepare(`SELECT g.*, r.position, r.added_to_rotation_at,
    a.id AS media_id, a.content_type AS media_content_type, a.width AS media_width, a.height AS media_height
    FROM gaming_games g
    LEFT JOIN gaming_rotation r ON r.game_id = g.id
    LEFT JOIN gaming_media_assets a ON a.id = g.artwork_asset_id AND a.lifecycle = 'active'
    ORDER BY CASE WHEN r.position IS NULL THEN 1 ELSE 0 END, r.position, g.updated_at DESC, g.display_title COLLATE NOCASE`).all();
  const games = (rows.results || []).map((row) => projectGame(row, env, true));
  return {
    ok: true,
    authority: "Commerce D1",
    access,
    steamCatalogue: { configured: Boolean(String(env?.STEAM_WEB_API_KEY || "")), implemented: false, method: "IStoreService/GetAppList", message: String(env?.STEAM_WEB_API_KEY || "") ? "A server-side Steam key is present, but no local catalogue index is enabled. Use Search Steam, then verify the App ID or Store URL manually." : "Steam catalogue lookup is not configured. Use Search Steam, then paste an App ID or Store URL." },
    games,
    rotation: games.filter((game) => game.rotation.inRotation).sort((a, b) => a.rotation.position - b.rotation.position),
    summary: {
      rotation: games.filter((game) => game.rotation.inRotation).length,
      library: games.length,
      missingArtwork: games.filter((game) => !game.artwork.url).length,
      missingSteam: games.filter((game) => game.steam.state !== "verified").length,
    },
    checkedAt: nowIso(),
  };
}

export async function publicGamingRotation(env) {
  const rows = await requireDb(env).prepare(`SELECT g.*, r.position, r.added_to_rotation_at,
    a.id AS media_id, a.content_type AS media_content_type, a.width AS media_width, a.height AS media_height
    FROM gaming_rotation r JOIN gaming_games g ON g.id = r.game_id
    LEFT JOIN gaming_media_assets a ON a.id = g.artwork_asset_id AND a.lifecycle = 'active'
    WHERE g.archived_at IS NULL ORDER BY r.position, g.display_title COLLATE NOCASE`).all();
  return {
    ok: true,
    schema: "thirdrailify-gaming-rotation-v1",
    items: (rows.results || []).map((row) => {
      const game = projectGame(row, env, false);
      return { id: game.id, title: game.title, platform: game.platform, description: game.description, genre: game.genre, artworkUrl: game.artwork.url, steam: game.steam.state === "verified" ? { appId: game.steam.appId, storeUrl: game.steam.storeUrl } : null, position: game.rotation.position };
    }),
    updatedAt: (rows.results || []).reduce((latest, row) => String(row.updated_at) > latest ? String(row.updated_at) : latest, "" ) || null,
  };
}

export async function mutateGaming(env, actorAccountId, input) {
  const action = cleanText(input?.action, 40);
  if (action === "create") return createGame(env, actorAccountId, input.game || {}, Boolean(input.inRotation));
  if (action === "update") return updateGame(env, actorAccountId, input.game || {});
  if (action === "add_to_rotation") return addToRotation(env, actorAccountId, input.gameId);
  if (action === "remove_from_rotation") return removeFromRotation(env, actorAccountId, input.gameId);
  if (action === "move") return moveRotation(env, actorAccountId, input.gameId, input.direction);
  if (action === "archive" || action === "restore") return setArchived(env, actorAccountId, input.gameId, action === "archive");
  throw new AuthFailure(400, "gaming_action_invalid", "Choose a supported Gaming action.");
}

export async function uploadGamingArtwork(env, actorAccountId, gameIdValue, bytes, contentType, filename = "") {
  const gameId = identifier(gameIdValue); const db = requireDb(env); const game = await requireGame(db, gameId);
  const image = sanitizeWheelMedia(new Uint8Array(bytes || []), contentType, "centre");
  if (!IMAGE_TYPES.has(image.contentType)) throw new AuthFailure(415, "gaming_artwork_format_invalid", "Use PNG, JPG, WebP, or BMP artwork.");
  const bucket = requireBucket(env); const id = randomId(); const stamp = nowIso(); const sha = await digestHex(image.bytes);
  const objectKey = `gaming/${game.id}/${sha}-${id}.${IMAGE_TYPES.get(image.contentType)}`;
  const previous = game.artwork_asset_id ? await db.prepare("SELECT id, object_key FROM gaming_media_assets WHERE id = ? AND lifecycle = 'active'").bind(game.artwork_asset_id).first() : null;
  await bucket.put(objectKey, image.bytes, { httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { sha256: sha, purpose: "gaming_cover" } });
  try {
    await db.batch([
      ...(previous ? [db.prepare("UPDATE gaming_media_assets SET lifecycle = 'retired', retired_at = ? WHERE id = ?").bind(stamp, previous.id)] : []),
      db.prepare(`INSERT INTO gaming_media_assets (id, game_id, object_key, sha256, content_type, byte_size, width, height, original_filename, lifecycle, uploaded_by_account_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).bind(id, game.id, objectKey, sha, image.contentType, image.bytes.byteLength, image.width, image.height, cleanText(filename, 180) || null, actorAccountId, stamp),
      db.prepare("UPDATE gaming_games SET artwork_asset_id = ?, remote_artwork_url = NULL, updated_at = ? WHERE id = ?").bind(id, stamp, game.id),
    ]);
  } catch (error) { await bucket.delete(objectKey).catch(() => {}); throw error; }
  if (previous?.object_key) await bucket.delete(previous.object_key).catch(() => {});
  await audit(env, actorAccountId, "gaming_artwork_changed", game.id, { source: "upload", assetId: id, contentType: image.contentType, width: image.width, height: image.height });
  return adminGamingPayload(env, await accessForActor(env, actorAccountId));
}

export async function removeGamingArtwork(env, actorAccountId, gameIdValue) {
  const db = requireDb(env); const game = await requireGame(db, identifier(gameIdValue)); const stamp = nowIso();
  const asset = game.artwork_asset_id ? await db.prepare("SELECT * FROM gaming_media_assets WHERE id = ? AND lifecycle = 'active'").bind(game.artwork_asset_id).first() : null;
  await db.batch([
    db.prepare("UPDATE gaming_games SET artwork_asset_id = NULL, remote_artwork_url = NULL, updated_at = ? WHERE id = ?").bind(stamp, game.id),
    ...(asset ? [db.prepare("UPDATE gaming_media_assets SET lifecycle = 'retired', retired_at = ? WHERE id = ?").bind(stamp, asset.id)] : []),
  ]);
  if (asset?.object_key) await requireBucket(env).delete(asset.object_key).catch(() => {});
  await audit(env, actorAccountId, "gaming_artwork_changed", game.id, { source: "removed" });
  return adminGamingPayload(env, await accessForActor(env, actorAccountId));
}

export async function gamingMediaResponse(env, assetIdValue, request) {
  const id = identifier(assetIdValue); const row = await requireDb(env).prepare(`SELECT a.* FROM gaming_media_assets a JOIN gaming_games g ON g.id = a.game_id WHERE a.id = ? AND a.lifecycle = 'active' AND g.artwork_asset_id = a.id LIMIT 1`).bind(id).first();
  if (!row) throw new AuthFailure(404, "gaming_artwork_not_found", "This Gaming artwork was not found.");
  const object = await requireBucket(env).get(row.object_key); if (!object) throw new AuthFailure(404, "gaming_artwork_not_found", "This Gaming artwork was not found.");
  return new Response(request.method === "HEAD" ? null : object.body, { headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": row.content_type, "Cross-Origin-Resource-Policy": "cross-origin", ETag: `\"${row.sha256}\"`, "X-Content-Type-Options": "nosniff" } });
}

async function createGame(env, actor, input, inRotation) {
  const db = requireDb(env); const game = validateGame(input, false); const id = randomId(); const stamp = nowIso();
  await db.prepare(`INSERT INTO gaming_games (id, display_title, normalized_title, canonical_slug, platform_label, short_description, genre, developer, publisher, steam_app_id, steam_store_url, steam_mapping_state, metadata_provenance, remote_artwork_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, game.title, game.normalizedTitle, game.slug, game.platform, game.description, game.genre, game.developer, game.publisher, game.steamAppId, game.steamStoreUrl, game.steamState, game.provenance, game.remoteArtworkUrl, stamp, stamp).run();
  await audit(env, actor, "gaming_game_created", id, { title: game.title });
  if (inRotation) await addToRotation(env, actor, id, false);
  return { ...await adminGamingPayload(env, await accessForActor(env, actor)), mutation: { gameId: id } };
}

async function updateGame(env, actor, input) {
  const db = requireDb(env); const id = identifier(input.id); const before = await requireGame(db, id); const game = validateGame(input, true); const stamp = nowIso();
  await db.prepare(`UPDATE gaming_games SET display_title=?, normalized_title=?, canonical_slug=?, platform_label=?, short_description=?, genre=?, developer=?, publisher=?, steam_app_id=?, steam_store_url=?, steam_mapping_state=?, metadata_provenance=?, remote_artwork_url=?, updated_at=? WHERE id=?`)
    .bind(game.title, game.normalizedTitle, game.slug, game.platform, game.description, game.genre, game.developer, game.publisher, game.steamAppId, game.steamStoreUrl, game.steamState, game.provenance, game.remoteArtworkUrl, stamp, id).run();
  await audit(env, actor, "gaming_game_edited", id, { title: game.title, steamChanged: before.steam_app_id !== game.steamAppId || before.steam_store_url !== game.steamStoreUrl, artworkChanged: before.remote_artwork_url !== game.remoteArtworkUrl });
  return adminGamingPayload(env, await accessForActor(env, actor));
}

async function addToRotation(env, actor, gameIdValue, payload = true) {
  const db = requireDb(env); const id = identifier(gameIdValue); const game = await requireGame(db, id); if (game.archived_at) throw new AuthFailure(409, "gaming_game_archived", "Restore this game before adding it to Current Rotation.");
  const existing = await db.prepare("SELECT game_id FROM gaming_rotation WHERE game_id = ?").bind(id).first(); if (existing) throw new AuthFailure(409, "gaming_rotation_duplicate", "This game is already in Current Rotation.");
  const last = await db.prepare("SELECT COALESCE(MAX(position), 0) AS position FROM gaming_rotation").first(); const position = Number(last.position || 0) + 1;
  await db.prepare("INSERT INTO gaming_rotation (game_id, position, added_to_rotation_at) VALUES (?, ?, ?)").bind(id, position, nowIso()).run();
  await audit(env, actor, "gaming_rotation_added", id, { position });
  return payload ? adminGamingPayload(env, await accessForActor(env, actor)) : null;
}

async function removeFromRotation(env, actor, gameIdValue) {
  const db = requireDb(env); const id = identifier(gameIdValue); await requireGame(db, id); const row = await db.prepare("SELECT position FROM gaming_rotation WHERE game_id = ?").bind(id).first();
  if (!row) throw new AuthFailure(409, "gaming_rotation_missing", "This game is not in Current Rotation.");
  await db.batch([db.prepare("DELETE FROM gaming_rotation WHERE game_id = ?").bind(id), db.prepare("UPDATE gaming_rotation SET position = position - 1 WHERE position > ?").bind(row.position)]);
  await audit(env, actor, "gaming_rotation_removed", id, { previousPosition: row.position });
  return adminGamingPayload(env, await accessForActor(env, actor));
}

async function moveRotation(env, actor, gameIdValue, directionValue) {
  const db = requireDb(env); const id = identifier(gameIdValue); const direction = directionValue === "up" ? -1 : directionValue === "down" ? 1 : 0; if (!direction) throw new AuthFailure(400, "gaming_direction_invalid", "Choose Move Up or Move Down.");
  const row = await db.prepare("SELECT position FROM gaming_rotation WHERE game_id = ?").bind(id).first(); if (!row) throw new AuthFailure(404, "gaming_rotation_missing", "This game is not in Current Rotation.");
  const target = Number(row.position) + direction; const other = await db.prepare("SELECT game_id FROM gaming_rotation WHERE position = ?").bind(target).first(); if (!other) return adminGamingPayload(env, await accessForActor(env, actor));
  const temporary = Number((await db.prepare("SELECT COALESCE(MAX(position), 0) AS maximum FROM gaming_rotation").first()).maximum || 0) + 1000;
  await db.batch([db.prepare("UPDATE gaming_rotation SET position = ? WHERE game_id = ?").bind(temporary, id), db.prepare("UPDATE gaming_rotation SET position = ? WHERE game_id = ?").bind(row.position, other.game_id), db.prepare("UPDATE gaming_rotation SET position = ? WHERE game_id = ?").bind(target, id)]);
  await audit(env, actor, "gaming_rotation_reordered", id, { from: row.position, to: target });
  return adminGamingPayload(env, await accessForActor(env, actor));
}

async function setArchived(env, actor, gameIdValue, archived) {
  const db = requireDb(env); const id = identifier(gameIdValue); await requireGame(db, id); const stamp = nowIso();
  if (archived) { const row = await db.prepare("SELECT position FROM gaming_rotation WHERE game_id = ?").bind(id).first(); if (row) await db.batch([db.prepare("DELETE FROM gaming_rotation WHERE game_id = ?").bind(id), db.prepare("UPDATE gaming_rotation SET position = position - 1 WHERE position > ?").bind(row.position)]); }
  await db.prepare("UPDATE gaming_games SET archived_at = ?, updated_at = ? WHERE id = ?").bind(archived ? stamp : null, stamp, id).run();
  await audit(env, actor, archived ? "gaming_game_archived" : "gaming_game_restored", id, {});
  return adminGamingPayload(env, await accessForActor(env, actor));
}

function validateGame(input, requireId) {
  if (requireId) identifier(input.id);
  const title = cleanText(input.title, 120); if (!title) throw new AuthFailure(400, "gaming_title_required", "Display title is required.");
  const platform = cleanText(input.platform, 80) || "PC via Steam"; const description = cleanText(input.description, 600); const genre = cleanText(input.genre, 120);
  const developer = cleanText(input.developer, 120) || null; const publisher = cleanText(input.publisher, 120) || null;
  let steamAppId = cleanText(input.steamAppId, 20) || null; let steamStoreUrl = normalizeSteamUrl(input.steamStoreUrl, steamAppId);
  if (steamStoreUrl) steamAppId = steamStoreUrl.match(/\/app\/(\d+)\//)?.[1] || steamAppId;
  if (steamAppId && !/^\d{1,12}$/.test(steamAppId)) throw new AuthFailure(400, "gaming_steam_app_invalid", "Steam App ID must contain digits only.");
  if (steamAppId && !steamStoreUrl) steamStoreUrl = `https://store.steampowered.com/app/${steamAppId}/`;
  if (steamStoreUrl && steamAppId && !steamStoreUrl.includes(`/app/${steamAppId}/`)) throw new AuthFailure(400, "gaming_steam_mismatch", "Steam App ID and Store URL must refer to the same app.");
  const steamState = input.steamState === "verified" && steamAppId ? "verified" : input.steamState === "manual_override" && steamAppId ? "manual_override" : "unverified";
  const provenance = input.provenance === "steam_verified" && steamState === "verified" ? "steam_verified" : input.provenance === "manual_override" ? "manual_override" : "manual";
  const remoteArtworkUrl = normalizeImageUrl(input.remoteArtworkUrl);
  return { title, normalizedTitle: title.toLocaleLowerCase("en-AU"), slug: slugify(input.slug || title), platform, description, genre, developer, publisher, steamAppId, steamStoreUrl, steamState, provenance, remoteArtworkUrl };
}

function normalizeSteamUrl(value, appId) { const raw = cleanText(value, 500); if (!raw) return null; let url; try { url = new URL(raw); } catch { throw new AuthFailure(400, "gaming_steam_url_invalid", "Use a valid Steam Store app URL."); } const match = url.pathname.match(/^\/app\/(\d+)(?:\/|$)/); if (url.protocol !== "https:" || url.hostname !== "store.steampowered.com" || !match) throw new AuthFailure(400, "gaming_steam_url_invalid", "Use an official Steam Store app URL."); if (appId && match[1] !== appId) throw new AuthFailure(400, "gaming_steam_mismatch", "Steam App ID and Store URL must refer to the same app."); return `https://store.steampowered.com/app/${match[1]}/`; }
function normalizeImageUrl(value) { const raw = cleanText(value, 1000); if (!raw) return null; let url; try { url = new URL(raw); } catch { throw new AuthFailure(400, "gaming_artwork_url_invalid", "Use a valid HTTPS artwork URL."); } const allowedHosts = new Set(["cdn.thirdrailify.com", "shared.fastly.steamstatic.com"]); if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.has(url.hostname.toLowerCase())) throw new AuthFailure(400, "gaming_artwork_url_invalid", "Use an approved public HTTPS artwork URL or upload the cover to Media."); return url.toString(); }
function slugify(value) { const slug = cleanText(value, 120).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100); return slug || null; }
function projectGame(row, env, admin) { const mediaUrl = row.media_id ? `${configuredAdminOrigin(env)}/api/gaming/media/${encodeURIComponent(row.media_id)}` : null; return { id: row.id, title: row.display_title, slug: row.canonical_slug, platform: row.platform_label, description: row.short_description, genre: row.genre, developer: row.developer, publisher: row.publisher, steam: { appId: row.steam_app_id, storeUrl: row.steam_store_url, state: row.steam_mapping_state, provenance: row.metadata_provenance }, artwork: { url: mediaUrl || row.remote_artwork_url || null, source: mediaUrl ? "uploaded" : row.remote_artwork_url ? "remote" : "fallback", assetId: admin ? row.media_id || null : undefined, width: admin ? row.media_width || null : undefined, height: admin ? row.media_height || null : undefined }, rotation: { inRotation: row.position != null, position: row.position == null ? null : Number(row.position), addedAt: row.added_to_rotation_at || null }, archived: Boolean(row.archived_at), archivedAt: row.archived_at || null, createdAt: row.created_at, updatedAt: row.updated_at }; }
function configuredAdminOrigin(env) { const value = String(env?.THIRDRAILIFY_ADMIN_ORIGIN || "https://admin.thirdrailify.com"); try { return new URL(value).origin; } catch { return "https://admin.thirdrailify.com"; } }
function identifier(value) { const id = cleanText(value, 120); if (!/^[a-z0-9][a-z0-9-]{2,119}$/i.test(id)) throw new AuthFailure(400, "gaming_id_invalid", "The game identifier is invalid."); return id; }
async function requireGame(db, id) { const row = await db.prepare("SELECT * FROM gaming_games WHERE id = ?").bind(id).first(); if (!row) throw new AuthFailure(404, "gaming_game_not_found", "This game was not found."); return row; }
function requireDb(env) { if (!env?.THIRDRAILIFY_COMMERCE_DB?.prepare) throw new AuthFailure(503, "gaming_database_not_configured", "Gaming catalogue storage is not configured."); return env.THIRDRAILIFY_COMMERCE_DB; }
function requireBucket(env) { if (!env?.[BUCKET]?.put || !env?.[BUCKET]?.get || !env?.[BUCKET]?.delete) throw new AuthFailure(503, "gaming_media_not_configured", "Gaming artwork storage is not configured."); return env[BUCKET]; }
async function accessForActor(env, actor) { const { loadAccountById } = await import("./auth-core.js"); const { effectiveAdminAccess } = await import("./admin-capabilities.js"); return effectiveAdminAccess(env, await loadAccountById(env, actor)); }
async function audit(env, actor, eventType, gameId, metadata) { await writeAudit(env, { actorAccountId: actor, targetAccountId: null, eventType, provider: "gaming", result: "success", metadata: { gameId, ...metadata } }); }
async function digestHex(bytes) { const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
