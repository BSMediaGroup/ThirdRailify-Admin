import { AuthFailure, cleanText } from "./auth-core.js";
import { STEAM_FALLBACK_CATALOGUE } from "./steam-fallback-catalogue.js";

const SEARCH_ENDPOINT = "https://store.steampowered.com/api/storesearch/";
const DETAILS_ENDPOINT = "https://store.steampowered.com/api/appdetails";
const COMMUNITY_SEARCH_ENDPOINT = "https://steamcommunity.com/actions/SearchApps/";
const COMMUNITY_APP_ENDPOINT = "https://steamcommunity.com/app/";
const OFFICIAL_CATALOGUE_ENDPOINT = "https://partner.steam-api.com/IStoreService/GetAppList/v1/";
const STORE_ORIGIN = "https://store.steampowered.com";
const SEARCH_TTL = 10 * 60;
const DETAILS_TTL = 12 * 60 * 60;
const TIMEOUT_MS = 4_500;
const SEARCH_LIMIT = 12;
const SEARCH_MAX_BYTES = 512 * 1024;
const DETAILS_MAX_BYTES = 2 * 1024 * 1024;
const STEAM_IMAGE_HOSTS = new Set(["shared.fastly.steamstatic.com", "shared.akamai.steamstatic.com"]);
const PROVIDER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function steamProviderStatus(env) {
  return {
    available: true,
    method: "Steam Store with Community and embedded verified catalogue fallbacks",
    officialCatalogueConfigured: Boolean(String(env?.STEAM_WEB_API_KEY || "")),
    officialMethod: "IStoreService/GetAppList",
  };
}

export function parseSteamLookupInput(value) {
  const raw = cleanText(value, 500);
  if (!raw) throw new AuthFailure(400, "steam_query_required", "Enter a Steam title, App ID, or Store URL.");
  if (/^\d{1,12}$/.test(raw)) return { kind: "app", appId: raw };
  if (/^https?:\/\//i.test(raw)) return { kind: "app", appId: steamAppIdFromUrl(raw) };
  const query = raw.replace(/\s+/g, " ").trim();
  if (query.length < 2) throw new AuthFailure(400, "steam_query_too_short", "Enter at least 2 characters to search Steam.");
  if (query.length > 80) throw new AuthFailure(400, "steam_query_too_long", "Keep the Steam search to 80 characters or fewer.");
  return { kind: "search", query };
}

export function steamAppIdFromUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw invalidSteamUrl(); }
  const match = url.pathname.match(/^\/app\/(\d{1,12})(?:\/|$)/);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "store.steampowered.com" || url.port || url.username || url.password || !match) throw invalidSteamUrl();
  return match[1];
}

export async function searchSteamGames(queryValue, { fetchImpl = fetch, cache = globalThis.caches?.default, limit = SEARCH_LIMIT } = {}) {
  const parsed = parseSteamLookupInput(queryValue);
  if (parsed.kind !== "search") throw new AuthFailure(400, "steam_search_title_required", "Use the App resolver for a Steam App ID or Store URL.");
  const limitValue = Math.max(1, Math.min(SEARCH_LIMIT, Number(limit) || SEARCH_LIMIT));
  const cacheKey = cacheRequest("search", parsed.query.toLocaleLowerCase("en-AU"));
  const cached = await readCache(cache, cacheKey);
  if (cached) return { ...cached, cache: "hit" };
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("term", parsed.query);
  url.searchParams.set("l", "english");
  url.searchParams.set("cc", "AU");
  let result;
  const providerFailures = [];
  try {
    const payload = await providerJson(url, fetchImpl, SEARCH_MAX_BYTES, "Store search");
    if (!payload || !Array.isArray(payload.items) || !Number.isFinite(Number(payload.total))) throw invalidProviderResponse("Store search");
    result = { query: parsed.query, results: payload.items.slice(0, limitValue).map(normalizeSteamSearchResult).filter(Boolean), provider: "steam_store_best_effort" };
  } catch (error) {
    if (!isProviderFailure(error)) throw error;
    providerFailures.push(error);
    safeProviderFallback("store_search", error);
  }
  if (!result) {
    try { result = await searchSteamCommunity(parsed.query, fetchImpl, limitValue); }
    catch (communityFailure) { providerFailures.push(communityFailure); safeProviderFallback("community_search", communityFailure); }
  }
  if (!result) {
    result = searchEmbeddedSteamCatalogue(parsed.query, limitValue);
  }
  await writeCache(cache, cacheKey, result, SEARCH_TTL);
  return { ...result, cache: "miss" };
}

export async function getSteamGame(appValue, { env = {}, fetchImpl = fetch, cache = globalThis.caches?.default } = {}) {
  const appId = /^\d{1,12}$/.test(String(appValue || "")) ? String(appValue) : steamAppIdFromUrl(appValue);
  const cacheKey = cacheRequest("app", appId);
  let normalized = await readCache(cache, cacheKey);
  let cacheState = "hit";
  if (!normalized) {
    const url = new URL(DETAILS_ENDPOINT);
    url.searchParams.set("appids", appId);
    url.searchParams.set("l", "english");
    url.searchParams.set("cc", "AU");
    const providerFailures = [];
    try {
      const payload = await providerJson(url, fetchImpl, DETAILS_MAX_BYTES, "Store details");
      const envelope = payload?.[appId];
      if (!envelope?.success || !envelope.data) throw new AuthFailure(404, "steam_app_not_found", "Steam did not return a public Store listing for that App ID.");
      normalized = normalizeSteamGame(envelope.data, appId);
      if (!normalized) throw invalidProviderResponse("Store details");
    } catch (error) {
      if (!isProviderFailure(error)) throw error;
      providerFailures.push(error);
      safeProviderFallback("store_details", error);
    }
    if (!normalized) {
      try { normalized = await getSteamCommunityGame(appId, fetchImpl); }
      catch (communityFailure) { providerFailures.push(communityFailure); safeProviderFallback("community_details", communityFailure); }
    }
    if (!normalized) {
      normalized = getEmbeddedSteamGame(appId);
      if (!normalized) throw allProviderFailure(providerFailures);
    }
    await writeCache(cache, cacheKey, normalized, DETAILS_TTL);
    cacheState = "miss";
  }
  const officialCatalogue = String(env?.STEAM_WEB_API_KEY || "") ? await verifyOfficialCatalogueApp(appId, env.STEAM_WEB_API_KEY, fetchImpl) : null;
  return { ...normalized, officialCatalogue, cache: cacheState };
}

export function normalizeSteamSearchResult(item) {
  const appId = digits(item?.id);
  const name = cleanText(item?.name, 160);
  if (!appId || !name) return null;
  return {
    appId,
    name,
    storeUrl: `${STORE_ORIGIN}/app/${appId}/`,
    artworkUrl: steamImageUrl(item?.tiny_image),
    type: cleanText(item?.type, 40) || null,
    platforms: platformNames(item?.platforms),
    releaseDate: null,
  };
}

export function normalizeSteamGame(data, expectedAppId) {
  const appId = digits(data?.steam_appid);
  const name = cleanText(data?.name, 160);
  if (!appId || appId !== String(expectedAppId) || !name) return null;
  const genres = Array.isArray(data?.genres) ? data.genres.map((entry) => cleanText(entry?.description, 80)).filter(Boolean).slice(0, 8) : [];
  const developers = stringList(data?.developers);
  const publishers = stringList(data?.publishers);
  return {
    appId,
    name,
    storeUrl: `${STORE_ORIGIN}/app/${appId}/`,
    artworkUrl: steamImageUrl(data?.capsule_image) || steamImageUrl(data?.header_image),
    headerArtworkUrl: steamImageUrl(data?.header_image),
    type: cleanText(data?.type, 40) || null,
    description: plainProviderText(data?.short_description, 600),
    genres,
    genre: genres.join(" / "),
    developers,
    developer: developers.join(", "),
    publishers,
    publisher: publishers.join(", "),
    platforms: platformNames(data?.platforms),
    releaseDate: cleanText(data?.release_date?.date, 80) || null,
    provider: "steam_store_best_effort",
  };
}

async function searchSteamCommunity(query, fetchImpl, limit) {
  const url = new URL(`${COMMUNITY_SEARCH_ENDPOINT}${encodeURIComponent(query)}`);
  const payload = await providerJson(url, fetchImpl, SEARCH_MAX_BYTES, "Community search");
  if (!Array.isArray(payload)) throw invalidProviderResponse("Community search");
  return {
    query,
    results: payload.slice(0, limit).map(normalizeSteamCommunitySearchResult).filter(Boolean),
    provider: "steam_community_search_fallback",
  };
}

function normalizeSteamCommunitySearchResult(item) {
  const appId = digits(item?.appid);
  const name = cleanText(item?.name, 160);
  if (!appId || !name) return null;
  return {
    appId,
    name,
    storeUrl: `${STORE_ORIGIN}/app/${appId}/`,
    artworkUrl: steamImageUrl(item?.icon),
    type: "app",
    platforms: [],
    releaseDate: null,
  };
}

async function getSteamCommunityGame(appId, fetchImpl) {
  const url = new URL(`${COMMUNITY_APP_ENDPOINT}${appId}`);
  url.searchParams.set("l", "english");
  const html = await providerText(url, fetchImpl, DETAILS_MAX_BYTES, "Community app page", "text/html");
  const name = communityTitle(html);
  if (!name) throw new AuthFailure(404, "steam_app_not_found", "Steam did not return a public listing for that App ID.");
  const artworkUrl = communityHeaderArtwork(html, appId);
  return {
    appId,
    name,
    storeUrl: `${STORE_ORIGIN}/app/${appId}/`,
    artworkUrl,
    headerArtworkUrl: artworkUrl,
    type: "game",
    description: "",
    genres: [],
    genre: "",
    developers: [],
    developer: "",
    publishers: [],
    publisher: "",
    platforms: [],
    releaseDate: null,
    provider: "steam_community_fallback",
  };
}

function searchEmbeddedSteamCatalogue(query, limit) {
  const normalizedQuery = searchableText(query);
  const candidates = STEAM_FALLBACK_CATALOGUE.map(normalizeEmbeddedSearchResult).filter(Boolean).filter((item) => searchableText(item.name).includes(normalizedQuery));
  candidates.sort((left, right) => steamSpySearchRank(left.name, normalizedQuery) - steamSpySearchRank(right.name, normalizedQuery) || left.name.localeCompare(right.name, "en"));
  return { query, results: candidates.slice(0, limit), provider: "embedded_steam_catalogue_fallback" };
}

function normalizeEmbeddedSearchResult(item) { const appId = digits(item?.appId); const name = cleanText(item?.name, 160); return appId && name ? { appId, name, storeUrl: `${STORE_ORIGIN}/app/${appId}/`, artworkUrl: null, type: "app", platforms: [], releaseDate: null } : null; }
function steamSpySearchRank(name, query) { const searchableName = searchableText(name); if (searchableName === query) return 0; if (searchableName.startsWith(query) || searchableName.startsWith(`the ${query}`)) return 1; return 10 + Math.max(0, searchableName.indexOf(query)); }

function getEmbeddedSteamGame(appId) {
  const payload = STEAM_FALLBACK_CATALOGUE.find((item) => item.appId === appId);
  const name = cleanText(payload?.name, 160);
  if (!payload || !name) return null;
  const genres = splitProviderList(payload.genre, 8, 80);
  const developers = splitProviderList(payload.developer, 8, 120);
  const publishers = splitProviderList(payload.publisher, 8, 120);
  return {
    appId,
    name,
    storeUrl: `${STORE_ORIGIN}/app/${appId}/`,
    artworkUrl: null,
    headerArtworkUrl: null,
    type: "game",
    description: "",
    genres,
    genre: genres.join(" / "),
    developers,
    developer: developers.join(", "),
    publishers,
    publisher: publishers.join(", "),
    platforms: [],
    releaseDate: null,
    provider: "embedded_steam_catalogue_fallback",
  };
}

async function verifyOfficialCatalogueApp(appId, keyValue, fetchImpl) {
  const url = new URL(OFFICIAL_CATALOGUE_ENDPOINT);
  url.searchParams.set("key", String(keyValue));
  url.searchParams.set("input_json", JSON.stringify({ last_appid: Math.max(0, Number(appId) - 1), max_results: 1, include_games: true, include_dlc: true, include_software: true, include_videos: true, include_hardware: true }));
  try {
    const payload = await providerJson(url, fetchImpl, SEARCH_MAX_BYTES, "official catalogue");
    const apps = payload?.response?.apps;
    const match = Array.isArray(apps) ? apps.find((item) => String(item?.appid) === appId) : null;
    return match ? { verified: true, method: "IStoreService/GetAppList", name: cleanText(match.name, 160) || null } : { verified: false, method: "IStoreService/GetAppList", name: null };
  } catch {
    return { verified: false, method: "IStoreService/GetAppList", name: null };
  }
}

async function providerJson(url, fetchImpl, maxBytes, operation) {
  const text = await providerText(url, fetchImpl, maxBytes, operation, "application/json");
  try { return JSON.parse(text); }
  catch { throw invalidProviderResponse(operation); }
}

async function providerText(url, fetchImpl, maxBytes, operation, expectedContentType) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url.toString(), { method: "GET", headers: { Accept: expectedContentType === "application/json" ? "application/json" : "text/html,application/xhtml+xml", "Accept-Language": "en-AU,en;q=0.9", "User-Agent": PROVIDER_USER_AGENT }, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new AuthFailure(502, "steam_provider_unavailable", "Steam lookup is temporarily unavailable. Manual entry is still available.");
    if (!String(response.headers.get("content-type") || "").toLowerCase().includes(expectedContentType)) throw invalidProviderResponse(operation);
    return await boundedText(response, maxBytes);
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new AuthFailure(504, "steam_provider_timeout", "Steam lookup timed out. Manual entry is still available.");
    throw new AuthFailure(502, "steam_provider_unavailable", "Steam lookup is temporarily unavailable. Manual entry is still available.");
  } finally { clearTimeout(timeout); }
}

async function boundedText(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new AuthFailure(502, "steam_response_too_large", "Steam returned more data than the lookup accepts.");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new AuthFailure(502, "steam_response_too_large", "Steam returned more data than the lookup accepts.");
    return text;
  }
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > maxBytes) { await reader.cancel(); throw new AuthFailure(502, "steam_response_too_large", "Steam returned more data than the lookup accepts."); } chunks.push(value); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function steamImageUrl(value) { const raw = cleanText(value, 1000); if (!raw) return null; try { const url = new URL(raw); return url.protocol === "https:" && !url.username && !url.password && !url.port && STEAM_IMAGE_HOSTS.has(url.hostname.toLowerCase()) ? url.toString() : null; } catch { return null; } }
function communityTitle(html) { const tags = String(html || "").match(/<meta\b[^>]*>/gi) || []; for (const tag of tags) { const property = attribute(tag, "property"); if (property?.toLowerCase() !== "og:title") continue; const title = decodeProviderHtml(attribute(tag, "content")).replace(/^Steam Community\s*::\s*/i, "").replace(/\s*::\s*Steam Community$/i, "").trim(); if (title) return cleanText(title, 160); } return null; }
function communityHeaderArtwork(html, appId) { const urls = String(html || "").match(/https:\/\/(?:shared\.fastly|shared\.akamai)\.steamstatic\.com\/[^"'<>\s]+/gi) || []; for (const raw of urls) { const value = decodeProviderHtml(raw); if (!value.includes(`/store_item_assets/steam/apps/${appId}/`) || !/\/header(?:_[^/?]+)?\.jpg(?:\?|$)/i.test(value)) continue; const safe = steamImageUrl(value); if (safe) return safe; } return null; }
function attribute(tag, name) { const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i")); return match?.[1] || ""; }
function decodeProviderHtml(value) { return String(value || "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">"); }
function invalidProviderResponse(operation) { return new AuthFailure(502, "steam_response_invalid", `Steam ${operation} returned an unusable response. Manual entry is still available.`); }
function isProviderFailure(error) { return error instanceof AuthFailure && ["steam_provider_timeout", "steam_provider_unavailable", "steam_response_invalid", "steam_response_too_large"].includes(error.code); }
function allProviderFailure(failures) { if (failures.length && failures.every((error) => error?.code === "steam_provider_timeout")) return new AuthFailure(504, "steam_provider_timeout", "Steam lookup timed out across every provider path. Manual entry is still available."); return new AuthFailure(502, "steam_provider_unavailable", "Steam lookup is temporarily unavailable across every provider path. Manual entry is still available."); }
function safeProviderFallback(operation, error) { console.warn("steam_provider_fallback", { operation, reason: cleanText(error?.code, 80) || "provider_failure" }); }
function searchableText(value) { return cleanText(value, 160).toLocaleLowerCase("en-AU").replace(/\s+/g, " ").trim(); }
function splitProviderList(value, limit, max) { return String(value || "").split(",").map((item) => cleanText(item, max)).filter(Boolean).slice(0, limit); }
function platformNames(value) { return ["windows", "mac", "linux"].filter((name) => value?.[name] === true); }
function stringList(value) { return Array.isArray(value) ? value.map((entry) => cleanText(entry, 120)).filter(Boolean).slice(0, 8) : []; }
function digits(value) { const raw = String(value ?? ""); return /^\d{1,12}$/.test(raw) ? raw : null; }
function plainProviderText(value, max) { return cleanText(String(value || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"), max); }
function invalidSteamUrl() { return new AuthFailure(400, "steam_url_invalid", "Use an exact https://store.steampowered.com/app/... URL."); }
function cacheRequest(kind, value) { return new Request(`https://steam-cache.thirdrailify.invalid/${kind}/${encodeURIComponent(value)}`); }
async function readCache(cache, key) { if (!cache?.match) return null; try { const response = await cache.match(key); return response ? JSON.parse(await response.text()) : null; } catch { return null; } }
async function writeCache(cache, key, value, ttl) { if (!cache?.put) return; try { await cache.put(key, new Response(JSON.stringify(value), { headers: { "Cache-Control": `max-age=${ttl}`, "Content-Type": "application/json" } })); } catch {} }
