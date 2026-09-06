import assert from "node:assert/strict";
import test from "node:test";
import { getIgdbAccessToken, searchIgdbGames, getIgdbGame, normalizeIgdbGame, findIgdbGamesBySteam } from "../functions/_shared/igdb.js";
import { normalizeIgdbUrl } from "../functions/_shared/igdb-mapping.js";

const environment = () => ({ IGDB_CLIENT_ID: "fixture-client", IGDB_CLIENT_SECRET: "fixture-secret" });
const token = () => Response.json({ access_token: "fixture-bearer", token_type: "bearer", expires_in: 100 });
const fixture = (id = 1942, name = "The Witcher 3: Wild Hunt") => ({ id, name, url: `https://www.igdb.com/games/witcher-${id}`, summary: "A curated candidate.", first_release_date: 1431993600, cover: { image_id: "co1234" }, genres: [{ name: "RPG" }], platforms: [{ name: "PC" }], involved_companies: [{ developer: true, company: { name: "Developer" } }, { publisher: true, company: { name: "Publisher" } }], external_games: [{ uid: "292030", url: "https://store.steampowered.com/app/292030/", external_game_source: { name: "Steam" } }] });
function cacheFixture() { const values = new Map(); return { values, async match(request) { return values.get(request.url)?.clone(); }, async put(request, response) { values.set(request.url, response.clone()); } }; }
const provider = (handler) => async (url, init) => url.includes("oauth2/token") ? token() : handler(url, init);

test("missing credentials fail softly without network access", async () => {
  await assert.rejects(searchIgdbGames("witcher", { env: {}, fetchImpl: () => assert.fail("network") }), { code: "igdb_not_configured" });
});
test("application tokens are acquired, coalesced, cached and renewed before expiry", async () => {
  const env = environment(); let calls = 0; let now = 1000;
  const options = { env, now: () => now, fetchImpl: async (url, init) => { calls++; assert.equal(url, "https://id.twitch.tv/oauth2/token"); assert.equal(init.redirect, "manual"); const body = new URLSearchParams(init.body); assert.equal(body.get("grant_type"), "client_credentials"); assert.equal(body.get("client_secret"), env.IGDB_CLIENT_SECRET); return token(); } };
  assert.deepEqual(await Promise.all([getIgdbAccessToken(options), getIgdbAccessToken(options)]), ["fixture-bearer", "fixture-bearer"]);
  now = 89000; await getIgdbAccessToken(options); assert.equal(calls, 1);
  now = 92000; await getIgdbAccessToken(options); assert.equal(calls, 2);
});
test("normalization retains disambiguation, cover, canonical URL and same-record Steam evidence", () => {
  const result = normalizeIgdbGame(fixture());
  assert.equal(result.id, "1942"); assert.equal(result.releaseDate, "2015-05-19"); assert.deepEqual(result.genres, ["RPG"]); assert.deepEqual(result.platforms, ["PC"]);
  assert.equal(result.developer, "Developer"); assert.equal(result.publisher, "Publisher"); assert.deepEqual(result.steamAppIds, ["292030"]);
  assert.equal(result.artworkUrl, "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1234.jpg");
  assert.deepEqual(normalizeIgdbGame({ ...fixture(), external_games: [{ uid: "292030", external_game_source: { name: "GOG" } }, { uid: "292030", url: "https://evil.test/app/292030/", external_game_source: { name: "Steam" } }] }).steamAppIds, []);
  const minimal = normalizeIgdbGame({ id: 1, name: "Unknown", url: "https://www.igdb.com/games/unknown" });
  assert.equal(minimal.artworkUrl, null); assert.equal(minimal.releaseDate, null); assert.equal(minimal.developer, ""); assert.deepEqual(minimal.steamAppIds, []);
  assert.deepEqual(normalizeIgdbGame({ ...fixture(), external_games: [{ uid: "292030", external_game_source: { name: 42 } }] }).steamAppIds, []);
  assert.throws(() => normalizeIgdbGame({ ...fixture(), id: { toString: "invalid" } }), { code: "igdb_response_invalid" });
  assert.equal(normalizeIgdbGame({ ...fixture(), cover: { image_id: "../../bad" } }).artworkUrl, null);
});
test("search keeps multiple candidates, escapes query syntax, and caches only normalized metadata", async () => {
  const cache = cacheFixture(); let calls = 0;
  const options = { env: environment(), cache, fetchImpl: provider(async (url, init) => { calls++; assert.equal(url, "https://api.igdb.com/v4/games"); assert.equal(init.headers.Authorization, "Bearer fixture-bearer"); assert.match(init.body, /search "witcher \\\"edition\\\""; limit 12;/); assert.doesNotMatch(init.body, /fields \*/); return Response.json([fixture(), fixture(2, "The Witcher 2")]); }) };
  const result = await searchIgdbGames('witcher "edition"', options); assert.equal(result.results.length, 2); assert.equal(result.cache, "miss");
  assert.equal((await searchIgdbGames('witcher "edition"', options)).cache, "hit"); assert.equal(calls, 1);
  for (const [key, response] of cache.values) { assert.doesNotMatch(key, /fixture-secret|fixture-bearer/); assert.doesNotMatch(await response.clone().text(), /fixture-secret|fixture-bearer|external_games/); assert.equal(response.headers.get("cache-control"), "max-age=1200"); }
});
test("empty search, exact ID details and exact Steam cross-reference remain distinct", async () => {
  const options = { env: environment(), cache: cacheFixture(), fetchImpl: provider(async (_url, init) => { if (init.body.includes('search "empty"')) return Response.json([]); if (init.body.includes('where external_games.uid')) { assert.match(init.body, /external_game_source.name = "Steam"/); return Response.json([fixture(), { ...fixture(2), external_games: [] }]); } return Response.json([fixture()]); }) };
  assert.deepEqual((await searchIgdbGames("empty", options)).results, []);
  assert.equal((await getIgdbGame("1942", options)).id, "1942"); assert.equal((await getIgdbGame("1942", options)).cache, "hit");
  assert.deepEqual((await findIgdbGamesBySteam("292030", options)).results.map(item => item.id), ["1942"]);
  await assert.rejects(getIgdbGame("2", options), { code: "igdb_not_found" });
  await assert.rejects(getIgdbGame("1; fields *;", options), { code: "igdb_id_invalid" });
});
test("provider auth rejection renews once and never leaks provider error bodies", async () => {
  for (const recover of [true, false]) {
    let tokenCalls = 0; let gameCalls = 0;
    const options = { env: environment(), fetchImpl: async (url) => { if (url.includes("oauth2/token")) { tokenCalls++; return token(); } gameCalls++; return recover && gameCalls === 2 ? Response.json([fixture()]) : new Response("fixture-secret fixture-bearer", { status: 401 }); } };
    if (recover) assert.equal((await getIgdbGame("1942", options)).id, "1942");
    else await assert.rejects(getIgdbGame("1942", options), error => error.code === "igdb_auth_failed" && !/fixture-/.test(error.message));
    assert.equal(tokenCalls, 2); assert.equal(gameCalls, 2);
  }
  await assert.rejects(getIgdbAccessToken({ env: environment(), fetchImpl: async () => new Response("secret", { status: 400 }) }), { code: "igdb_unavailable" });
});
test("timeouts, malformed data, oversized data and provider throttling fail boundedly", async () => {
  for (const [response, code] of [[() => new Response("busy", { status: 429 }), "igdb_rate_limited"], [() => Response.json({ error: "bad" }), "igdb_response_invalid"], [() => Response.json([{ id: 2 }]), "igdb_response_invalid"], [() => new Response("<html/>", { headers: { "Content-Type": "text/html" } }), "igdb_response_invalid"], [() => new Response("x".repeat(300000), { headers: { "Content-Type": "application/json" } }), "igdb_response_invalid"]]) {
    await assert.rejects(searchIgdbGames("witcher", { env: environment(), fetchImpl: provider(async () => response()) }), { code });
  }
  await assert.rejects(searchIgdbGames("witcher", { env: environment(), timeoutMs: 5, fetchImpl: provider((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))) }), { code: "igdb_timeout" });
});
test("canonical URLs reject deceptive hosts, credentials, ports, query strings and non-listings", () => {
  assert.equal(normalizeIgdbUrl("https://www.igdb.com/games/the-witcher-3-wild-hunt"), "https://www.igdb.com/games/the-witcher-3-wild-hunt");
  for (const value of ["http://www.igdb.com/games/game", "https://user:pass@www.igdb.com/games/game", "https://www.igdb.com:444/games/game", "https://www.igdb.com.evil.test/games/game", "https://igdb.com/games/game", "https://www.igdb.com/search?q=game", "https://www.igdb.com/games/game?x=y", "https://www.igdb.com/games/game#hash"]) assert.equal(normalizeIgdbUrl(value), null, value);
});

test("real Workers Request accepts IGDB transport options and redirects never forward credentials", async t => {
  const { Miniflare } = await import("miniflare");
  const mf = new Miniflare({ modules: true, compatibilityDate: "2026-08-11", script: `export default { async fetch(request) { const { url, init } = await request.json(); try { const outgoing = new Request(url, init); return Response.json({ redirect: outgoing.redirect }); } catch { return Response.json({ error: "request_construction_failed" }, { status: 500 }); } } }` });
  t.after(() => mf.dispose());
  let calls = 0;
  const options = { env: environment(), fetchImpl: async (url, init) => {
    calls++;
    const { signal: _signal, ...transport } = init;
    const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ url, init: transport }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { redirect: "manual" });
    return url.includes("oauth2/token") ? token() : Response.json([fixture()]);
  } };
  assert.equal((await searchIgdbGames("witcher", options)).results.length, 1);
  assert.equal(calls, 2);
  for (const redirectStage of ["authentication", "games"]) {
    let redirectedCalls = 0;
    await assert.rejects(searchIgdbGames("witcher", { env: environment(), fetchImpl: async (url, init) => {
      redirectedCalls++;
      assert.equal(init.redirect, "manual");
      if (redirectStage === "games" && url.includes("oauth2/token")) return token();
      return new Response(null, { status: 302, headers: { Location: "https://untrusted.invalid/" } });
    } }), { code: "igdb_unavailable" });
    assert.equal(redirectedCalls, redirectStage === "authentication" ? 1 : 2);
  }
});
