import assert from "node:assert/strict";
import test from "node:test";
import { getSteamGame, parseSteamLookupInput, searchSteamGames, steamAppIdFromUrl } from "../functions/_shared/steam-store.js";

const IMAGE = "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/292030/capsule_616x353.jpg";

test("Steam title search normalizes whitespace, preserves multiple candidates, caps output, and caches", async () => {
  let calls = 0; const cache = memoryCache();
  const fetchImpl = async (url) => { calls += 1; const parsed = new URL(url); assert.equal(parsed.hostname, "store.steampowered.com"); assert.equal(parsed.searchParams.get("term"), "witcher"); return json({ total: 20, items: Array.from({ length: 20 }, (_, index) => ({ type: "app", name: `Witcher candidate ${index + 1}`, id: 292030 + index, tiny_image: IMAGE, platforms: { windows: true, mac: index === 0 }, price: { final: 999 } })) }); };
  const first = await searchSteamGames("  witcher   ", { fetchImpl, cache });
  const second = await searchSteamGames("witcher", { fetchImpl, cache });
  assert.equal(first.results.length, 12); assert.equal(first.results[0].name, "Witcher candidate 1"); assert.equal(first.results[1].name, "Witcher candidate 2");
  assert.deepEqual(first.results[0].platforms, ["windows", "mac"]); assert.equal("price" in first.results[0], false); assert.equal(JSON.stringify(first).includes("final"), false);
  assert.equal(first.cache, "miss"); assert.equal(second.cache, "hit"); assert.equal(calls, 1);
});

test("Steam search validates input and rejects malformed or failed provider responses", async () => {
  assert.deepEqual(parseSteamLookupInput("292030"), { kind: "app", appId: "292030" });
  assert.deepEqual(parseSteamLookupInput("https://store.steampowered.com/app/292030/The_Witcher_3/"), { kind: "app", appId: "292030" });
  assert.equal(steamAppIdFromUrl("https://store.steampowered.com/app/292030/"), "292030");
  assert.throws(() => parseSteamLookupInput("x"), (error) => error.code === "steam_query_too_short");
  assert.throws(() => parseSteamLookupInput("http://store.steampowered.com/app/292030/"), (error) => error.code === "steam_url_invalid");
  assert.throws(() => steamAppIdFromUrl("https://store.steampowered.com.evil.test/app/292030/"), (error) => error.code === "steam_url_invalid");
  const malformedFallback = await searchSteamGames("witcher", { fetchImpl: async () => json({ unexpected: true }) }); assert.equal(malformedFallback.provider, "embedded_steam_catalogue_fallback"); assert.ok(malformedFallback.results.some((item) => item.appId === "292030"));
  const timeoutFallback = await searchSteamGames("witcher", { fetchImpl: async () => { throw new DOMException("aborted", "AbortError"); } }); assert.equal(timeoutFallback.provider, "embedded_steam_catalogue_fallback"); assert.ok(timeoutFallback.results.some((item) => item.appId === "292030"));
  const empty = await searchSteamGames("zzzz-no-match", { fetchImpl: async () => json({ total: 0, items: [] }) }); assert.deepEqual(empty.results, []);
});

test("Steam title search falls back to the independent Community endpoint when Store egress fails", async () => {
  const seen = []; const cache = memoryCache();
  const fetchImpl = async (url) => {
    const parsed = new URL(url); seen.push(parsed.hostname);
    if (parsed.hostname === "store.steampowered.com") return unavailable();
    assert.equal(parsed.hostname, "steamcommunity.com");
    assert.equal(decodeURIComponent(parsed.pathname), "/actions/SearchApps/witcher");
    return json([{ appid: "292030", name: "The Witcher 3: Wild Hunt", icon: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/292030/capsule_184x69.jpg" }, { appid: "20920", name: "The Witcher 2", icon: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/20920/capsule_184x69.jpg" }]);
  };
  const first = await searchSteamGames("witcher", { fetchImpl, cache });
  const second = await searchSteamGames("witcher", { fetchImpl, cache });
  assert.equal(first.provider, "steam_community_search_fallback");
  assert.deepEqual(first.results.map((item) => [item.appId, item.name]), [["292030", "The Witcher 3: Wild Hunt"], ["20920", "The Witcher 2"]]);
  assert.match(first.results[0].artworkUrl, /^https:\/\/shared\.akamai\.steamstatic\.com\//);
  assert.equal(first.cache, "miss"); assert.equal(second.cache, "hit");
  assert.deepEqual(seen, ["store.steampowered.com", "steamcommunity.com"]);
});

test("Steam app resolution falls back to the Community app page without inventing metadata", async () => {
  const seen = [];
  const header = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/292030/header.jpg?t=fixture";
  const fetchImpl = async (url) => {
    const parsed = new URL(url); seen.push(parsed.hostname);
    if (parsed.hostname === "store.steampowered.com") return unavailable();
    assert.equal(parsed.hostname, "steamcommunity.com"); assert.equal(parsed.pathname, "/app/292030");
    return html(`<html><head><meta property="og:title" content="Steam Community :: The Witcher 3: Wild Hunt"><meta property="og:image" content="${header.replace("&", "&amp;")}"></head></html>`);
  };
  const game = await getSteamGame("292030", { fetchImpl, cache: memoryCache() });
  assert.equal(game.provider, "steam_community_fallback"); assert.equal(game.name, "The Witcher 3: Wild Hunt");
  assert.equal(game.artworkUrl, header); assert.equal(game.headerArtworkUrl, header);
  assert.equal(game.description, ""); assert.deepEqual(game.genres, []); assert.deepEqual(game.platforms, []);
  assert.equal(game.officialCatalogue, null); assert.deepEqual(seen, ["store.steampowered.com", "steamcommunity.com"]);
});

test("Steam title search uses the embedded verified catalogue when both Steam hosts reject edge egress", async () => {
  const seen = []; const cache = memoryCache();
  const fetchImpl = async (url) => {
    const parsed = new URL(url); seen.push(parsed.hostname);
    return unavailable();
  };
  const first = await searchSteamGames("witcher", { fetchImpl, cache });
  const second = await searchSteamGames("witcher 3", { fetchImpl, cache });
  assert.equal(first.provider, "embedded_steam_catalogue_fallback"); assert.ok(first.results.some((item) => item.appId === "20920")); assert.ok(first.results.some((item) => item.appId === "292030"));
  assert.equal(first.results[0].artworkUrl, null); assert.deepEqual(second.results.map((item) => item.appId), ["292030"]);
  assert.deepEqual(seen, ["store.steampowered.com", "steamcommunity.com", "store.steampowered.com", "steamcommunity.com"]);
});

test("Steam app resolution uses truthful embedded catalogue metadata when both Steam hosts reject edge egress", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url); seen.push(parsed.hostname);
    return unavailable();
  };
  const game = await getSteamGame("292030", { fetchImpl, cache: memoryCache() });
  assert.equal(game.provider, "embedded_steam_catalogue_fallback"); assert.equal(game.appId, "292030"); assert.match(game.name, /Witcher 3/i);
  assert.equal(game.developer, "CD PROJEKT RED"); assert.equal(game.publisher, "CD PROJEKT RED"); assert.deepEqual(game.genres, []);
  assert.equal(game.description, ""); assert.equal(game.artworkUrl, null);
  assert.deepEqual(seen, ["store.steampowered.com", "steamcommunity.com"]);
});

test("Steam app resolution normalizes verified metadata, actual artwork, and optional official catalogue evidence", async () => {
  const seen = [];
  const fetchImpl = async (url) => { const parsed = new URL(url); seen.push(parsed.hostname); if (parsed.hostname === "partner.steam-api.com") { assert.ok(parsed.searchParams.get("key")); return json({ response: { apps: [{ appid: 292030, name: "The Witcher 3" }] } }); } return json({ "292030": { success: true, data: { type: "game", name: "The Witcher 3: Wild Hunt", steam_appid: 292030, capsule_image: IMAGE, header_image: IMAGE, short_description: "A story-driven <b>open world</b> RPG.", developers: ["CD PROJEKT RED"], publishers: ["CD PROJEKT RED"], platforms: { windows: true, mac: false, linux: true }, genres: [{ description: "RPG" }, { description: "Adventure" }], release_date: { date: "18 May, 2015" }, prices: { secret: "not projected" } } } }); };
  const game = await getSteamGame("292030", { env: { STEAM_WEB_API_KEY: "fixture-key" }, fetchImpl, cache: memoryCache() });
  assert.equal(game.appId, "292030"); assert.equal(game.storeUrl, "https://store.steampowered.com/app/292030/"); assert.equal(game.artworkUrl, IMAGE); assert.equal(game.description, "A story-driven open world RPG."); assert.equal(game.genre, "RPG / Adventure"); assert.equal(game.developer, "CD PROJEKT RED"); assert.deepEqual(game.platforms, ["windows", "linux"]); assert.equal(game.officialCatalogue.verified, true);
  assert.equal(JSON.stringify(game).includes("fixture-key"), false); assert.equal(JSON.stringify(game).includes("prices"), false); assert.deepEqual(seen, ["store.steampowered.com", "partner.steam-api.com"]);
});

function json(value, init = {}) { return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json", ...init.headers } }); }
function html(value) { return new Response(value, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }); }
function unavailable() { return new Response("upstream unavailable", { status: 502, headers: { "Content-Type": "text/plain" } }); }
function memoryCache() { const values = new Map(); return { async match(request) { const value = values.get(request.url); return value ? value.clone() : undefined; }, async put(request, response) { values.set(request.url, response.clone()); } }; }
