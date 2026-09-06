import { AuthFailure, hmacSha256 } from "./auth-core.js";
import { normalizeIgdbId, normalizeIgdbUrl } from "./igdb-mapping.js";

const FIELDS = "id,name,url,summary,first_release_date,cover.image_id,genres.name,platforms.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,external_games.uid,external_games.url,external_games.external_game_source.name";
// Isolate-local, environment-scoped tokens never enter the Cache API or a response.
const tokens = new WeakMap();
const pendingTokens = new WeakMap();
export const igdbProviderStatus = (env) => ({ configured: Boolean(env?.IGDB_CLIENT_ID && env?.IGDB_CLIENT_SECRET) });
function credentials(env) {
  if (!igdbProviderStatus(env).configured) throw new AuthFailure(503, "igdb_not_configured", "IGDB LOOKUP NOT CONFIGURED. Steam and manual editing remain available.");
}
const fail = (status, code, message) => new AuthFailure(status, `igdb_${code}`, `${message} Manual editing remains available.`);

export async function enforceIgdbProviderLimit(env) {
  const key = await hmacSha256(env.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET, "gaming_igdb_provider:shared");
  const stamp = new Date().toISOString(); const cutoff = new Date(Date.now() - 1000).toISOString();
  // One atomic counter for the application, independent of account/IP/isolate.
  const row = await env.THIRDRAILIFY_AUTH_DB.prepare(`INSERT INTO auth_rate_limits
    (key_hash, category, window_started_at, attempt_count, blocked_until, updated_at)
    VALUES (?, 'gaming_igdb_provider', ?, 1, NULL, ?)
    ON CONFLICT(key_hash, category) DO UPDATE SET
    attempt_count = CASE WHEN window_started_at <= ? THEN 1 ELSE attempt_count + 1 END,
    window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END,
    updated_at = excluded.updated_at RETURNING attempt_count`).bind(key, stamp, stamp, cutoff, cutoff).first();
  if (!row || row.attempt_count > 2) throw new AuthFailure(429, "igdb_rate_limited", "IGDB is busy. Try again shortly. Manual editing remains available.", { "Retry-After": "1" });
}

export async function getIgdbAccessToken({ env, fetchImpl = fetch, now = Date.now, timeoutMs = 4500 } = {}) {
  credentials(env);
  const cached = tokens.get(env);
  if (cached && cached.expiresAt > now()) return cached.token;
  if (pendingTokens.has(env)) return pendingTokens.get(env);
  const pending = (async () => {
    const data = await requestJson("https://id.twitch.tv/oauth2/token", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.IGDB_CLIENT_ID, client_secret: env.IGDB_CLIENT_SECRET, grant_type: "client_credentials" }).toString(),
    }, { fetchImpl, timeoutMs });
    if (typeof data?.access_token !== "string" || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.token_type?.toLowerCase() !== "bearer") throw fail(502, "response_invalid", "IGDB authentication returned invalid data.");
    console.info("igdb_token_acquired");
    tokens.set(env, { token: data.access_token, expiresAt: now() + Math.max(0, data.expires_in - Math.min(60, data.expires_in / 10)) * 1000 });
    return data.access_token;
  })();
  pendingTokens.set(env, pending);
  try { return await pending; } finally { pendingTokens.delete(env); }
}

async function requestJson(url, init, { fetchImpl = fetch, timeoutMs = 4500 }) {
  const controller = new AbortController();
  const stage = url === "https://id.twitch.tv/oauth2/token" ? "authentication" : "games";
  let providerStatus = null;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Workers supports manual/follow; reject 3xx below without forwarding credentials.
    const response = await fetchImpl(url, { ...init, method: "POST", redirect: "manual", signal: controller.signal });
    providerStatus = response.status;
    if (!response.ok && stage === "authentication") {
      console.warn("igdb_authentication_rejected", { status: providerStatus, reason: await authenticationFailureCategory(response) });
    }
    if (response.status === 401 || response.status === 403) throw fail(502, "auth_failed", "IGDB authentication was rejected.");
    if (response.status === 429) throw fail(429, "rate_limited", "IGDB is busy. Try again shortly.");
    if (!response.ok) throw fail(502, "unavailable", "IGDB lookup is unavailable.");
    if (!response.headers.get("content-type")?.includes("application/json")) throw fail(502, "response_invalid", "IGDB returned invalid data.");
    const reader = response.body?.getReader(); if (!reader) throw fail(502, "response_invalid", "IGDB returned empty data.");
    const chunks = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 256 * 1024) { await reader.cancel(); throw fail(502, "response_invalid", "IGDB returned too much data."); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    console.warn("igdb_request_failed", { stage, status: providerStatus, code: error instanceof AuthFailure ? error.code : controller.signal.aborted ? "igdb_timeout" : "igdb_response_invalid" });
    if (error instanceof AuthFailure) throw error;
    if (controller.signal.aborted || error?.name === "AbortError") throw fail(504, "timeout", "IGDB lookup timed out.");
    throw fail(502, "response_invalid", "IGDB returned unavailable or invalid data.");
  } finally { clearTimeout(timer); }
}

async function authenticationFailureCategory(response) {
  // Classify a small error body without logging or returning provider-supplied text.
  const reader = response.body?.getReader();
  if (!reader) return "unclassified";
  const chunks = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4096) { await reader.cancel(); return "unclassified"; } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const message = typeof body?.message === "string" ? body.message.toLowerCase() : "";
    if (message.includes("invalid client secret")) return "invalid_client_secret";
    if (message.includes("invalid client")) return "invalid_client_id";
    if (message.includes("grant")) return "invalid_grant";
    if (message.includes("missing")) return "missing_parameter";
  } catch { /* Never expose raw provider text or decoding errors. */ }
  return "unclassified";
}

async function gamesQuery(body, options) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getIgdbAccessToken(options);
    await options.beforeRequest?.();
    try {
      const data = await requestJson("https://api.igdb.com/v4/games", { headers: { "Client-ID": options.env.IGDB_CLIENT_ID, Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "text/plain" }, body }, options);
      if (!Array.isArray(data) || data.length > 12) throw fail(502, "response_invalid", "IGDB returned invalid game records.");
      return data.map(normalizeIgdbGame);
    } catch (error) { if (error.code !== "igdb_auth_failed" || attempt) throw error; tokens.delete(options.env); }
  }
}

async function cachedQuery(key, body, ttl, options) {
  credentials(options.env);
  const cache = options.cache ?? globalThis.caches?.default;
  const request = new Request(`https://igdb-cache.thirdrailify.invalid/v1/${encodeURIComponent(key)}`);
  try { const hit = await cache?.match(request); if (hit) return { results: await hit.json(), cache: "hit" }; } catch { /* Cache failures do not disable lookup. */ }
  const results = await gamesQuery(`fields ${FIELDS}; ${body}`, options);
  try { await cache?.put(request, Response.json(results, { headers: { "Cache-Control": `max-age=${ttl}` } })); } catch { /* Best effort metadata cache. */ }
  return { results, cache: "miss" };
}

export async function searchIgdbGames(value, options = {}) {
  const query = typeof value === "string" ? value.trim() : "";
  if (query.length < 2 || query.length > 120 || /[\x00-\x1f]/.test(query)) throw fail(400, "query_invalid", "Enter a title between 2 and 120 characters.");
  return { query, ...await cachedQuery(`search:${query.toLowerCase()}`, `search ${JSON.stringify(query)}; limit 12;`, 1200, options) };
}
export async function findIgdbGamesBySteam(value, options = {}) {
  const appId = normalizeIgdbId(value); if (!appId) throw fail(400, "id_invalid", "Use a numeric Steam App ID.");
  const data = await cachedQuery(`steam:${appId}`, `where external_games.uid = "${appId}" & external_games.external_game_source.name = "Steam"; limit 12;`, 1200, options);
  // Both predicates must be corroborated on the same expanded external record.
  return { ...data, results: data.results.filter(game => game.steamAppIds.includes(appId)) };
}
export async function getIgdbGame(value, options = {}) {
  const id = normalizeIgdbId(value); if (!id) throw fail(400, "id_invalid", "Use a numeric IGDB ID.");
  const data = await cachedQuery(`game:${id}`, `where id = ${id}; limit 1;`, 43200, options);
  if (data.results.length !== 1 || data.results[0].id !== id) throw fail(404, "not_found", "This IGDB game was not found.");
  return { ...data.results[0], cache: data.cache };
}

export function normalizeIgdbGame(raw) {
  const text = (value, max = 120) => typeof value === "string" ? value.replace(/<[^>]*>/g, "").trim().slice(0, max) : "";
  const names = (values) => Array.isArray(values) ? [...new Set(values.map(value => text(value?.name)).filter(Boolean))].slice(0, 20) : [];
  const id = normalizeIgdbId(raw?.id); const name = text(raw?.name); const url = normalizeIgdbUrl(raw?.url);
  if (!id || !name || !url) throw fail(502, "response_invalid", "IGDB returned an invalid game listing.");
  const companies = Array.isArray(raw.involved_companies) ? raw.involved_companies : [];
  const imageId = typeof raw.cover?.image_id === "string" && /^[A-Za-z0-9_]{1,100}$/.test(raw.cover.image_id) ? raw.cover.image_id : null;
  const date = typeof raw.first_release_date === "number" ? new Date(raw.first_release_date * 1000) : null;
  const steamAppIds = [...new Set((Array.isArray(raw.external_games) ? raw.external_games : []).flatMap(external => {
    if (typeof external?.external_game_source?.name !== "string" || external.external_game_source.name.toLowerCase() !== "steam") return [];
    const appId = normalizeIgdbId(external.uid); if (!appId) return [];
    if (external.url) { try { const link = new URL(external.url); if (link.protocol !== "https:" || link.hostname !== "store.steampowered.com" || link.username || link.password || link.port || !link.pathname.startsWith(`/app/${appId}/`)) return []; } catch { return []; } }
    return [appId];
  }))].slice(0, 12);
  return { id, name, url, description: text(raw.summary, 600), artworkUrl: imageId ? `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${imageId}.jpg` : null, genres: names(raw.genres), platforms: names(raw.platforms), developer: names(companies.filter(value => value?.developer === true).map(value => value.company)).join(" / ").slice(0, 120), publisher: names(companies.filter(value => value?.publisher === true).map(value => value.company)).join(" / ").slice(0, 120), releaseDate: date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null, steamAppIds };
}
