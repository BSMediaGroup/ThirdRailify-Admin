import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import { adminGamingPayload, gamingSchemaState, mutateGaming, publicGamingRotation, uploadGamingArtwork } from "../functions/_shared/gaming-core.js";
import { hmacSha256, sha256 } from "../functions/_shared/auth-core.js";
import { onRequest as gamingAdminApi } from "../functions/api/admin/gaming/[[path]].js";
import { enforceIgdbProviderLimit } from "../functions/_shared/igdb.js";

test("0032 preserves seeds and rotation; IGDB mappings save, clear and reject unsafe URLs", async t => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await insertMaster(harness.authDb);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev" });
  const before = await publicGamingRotation(env); assert.equal(before.items.length, 4); assert.ok(before.items.every(game => game.igdb === null));
  const game = { id: "gaming-witcher", title: "WITCHER", igdbId: "1942", igdbUrl: "https://www.igdb.com/games/the-witcher-3-wild-hunt", steamAppId: "292030", steamState: "verified" };
  const saved = await mutateGaming(env, "gaming-master", { action: "update", game });
  assert.deepEqual(saved.games.find(item => item.id === game.id).igdb, { id: "1942", url: game.igdbUrl });
  const after = await publicGamingRotation(env); assert.deepEqual(after.items.map(item => item.id), before.items.map(item => item.id)); assert.equal(after.items[0].steam.appId, "292030"); assert.equal(after.items[0].igdb.id, "1942");
  for (const igdbUrl of ["http://www.igdb.com/games/game", "https://u:p@www.igdb.com/games/game", "https://www.igdb.com:444/games/game", "https://www.igdb.com.evil.test/games/game"]) await assert.rejects(mutateGaming(env, "gaming-master", { action: "update", game: { ...game, igdbUrl } }), { code: "gaming_igdb_mapping_invalid" });
  await assert.rejects(mutateGaming(env, "gaming-master", { action: "update", game: { ...game, igdbId: "" } }), { code: "gaming_igdb_mapping_invalid" });
  await mutateGaming(env, "gaming-master", { action: "update", game: { ...game, igdbId: "", igdbUrl: "" } });
  assert.equal((await publicGamingRotation(env)).items[0].igdb, null);
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==", "base64"));
  env.THIRDRAILIFY_PROFILE_MEDIA = memoryBucket();
  await uploadGamingArtwork(env, "gaming-master", game.id, png, "image/png", "curated.png");
  const remoteArtworkUrl = "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1234.jpg";
  let payload = await mutateGaming(env, "gaming-master", { action: "update", game: { ...game, remoteArtworkUrl } });
  assert.equal(payload.games.find(item => item.id === game.id).artwork.source, "uploaded");
  payload = await mutateGaming(env, "gaming-master", { action: "update", game: { ...game, remoteArtworkUrl, useRemoteArtwork: true } });
  assert.equal(payload.games.find(item => item.id === game.id).artwork.url, remoteArtworkUrl);
  assert.equal((await harness.commerceDb.prepare("SELECT lifecycle FROM gaming_media_assets WHERE game_id=?").bind(game.id).first()).lifecycle, "retired");
});

test("IGDB routes enforce gaming.view, private responses, soft configuration failure and atomic shared throttling", async t => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await insertMaster(harness.authDb); await insertAccount(harness.authDb, "gaming-user", "user", "none");
  const env = commerceEnvironment(harness, { THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev" });
  const auth = await sessionRequest(harness.authDb, env, "gaming-master", "igdb-master-token");
  const request = cookie => new Request(`${env.THIRDRAILIFY_ADMIN_ORIGIN}/api/admin/gaming/igdb/search?q=witcher`, { headers: { Cookie: cookie } });
  const missing = await gamingAdminApi({ env, request: request(auth.cookie) }); assert.equal(missing.status, 503); assert.equal((await missing.json()).error, "igdb_not_configured");
  const regular = await sessionRequest(harness.authDb, env, "gaming-user", "igdb-user-token");
  assert.equal((await gamingAdminApi({ env, request: request(regular.cookie), data: { igdbFetch: () => assert.fail("unauthorized provider request") } })).status, 403);
  assert.equal((await gamingAdminApi({ env, request: request(""), data: { igdbFetch: () => assert.fail("anonymous provider request") } })).status, 401);
  env.IGDB_CLIENT_ID = "fixture-client"; env.IGDB_CLIENT_SECRET = "fixture-secret";
  const data = { gamingCache: memoryCache(), igdbFetch: async url => url.includes("oauth2/token") ? Response.json({ access_token: "fixture-token", expires_in: 3600, token_type: "bearer" }) : Response.json([{ id: 1942, name: "Witcher", url: "https://www.igdb.com/games/witcher" }]) };
  const result = await gamingAdminApi({ env, request: request(auth.cookie), data }); assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store"); const body = await result.text(); assert.doesNotMatch(body, /fixture-token|fixture-secret|access_token/);
  await harness.authDb.prepare("DELETE FROM auth_rate_limits WHERE category='gaming_igdb_provider'").run();
  const attempts = await Promise.allSettled([enforceIgdbProviderLimit(env), enforceIgdbProviderLimit(env), enforceIgdbProviderLimit(env)]);
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 2); assert.equal(attempts.find(value => value.status === "rejected").reason.code, "igdb_rate_limited");
});

test("Gaming migration seeds the permanent library and ordered Current Rotation", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const schema = await gamingSchemaState(harness.commerceDb); assert.equal(schema.compatible, true); assert.deepEqual(schema.missingTables, []); assert.deepEqual(schema.missingColumns, []); assert.deepEqual(schema.missingIndexes, []);
  const tables = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gaming_%' ORDER BY name").all(); assert.deepEqual(tables.results.map((row) => row.name), ["gaming_games", "gaming_media_assets", "gaming_rotation"]);
  const indexes = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'gaming_%' ORDER BY name").all(); assert.deepEqual(indexes.results.map((row) => row.name), ["gaming_games_archive_index", "gaming_games_slug_unique", "gaming_games_steam_app_unique", "gaming_games_title_index", "gaming_media_game_index", "gaming_rotation_position_unique"]);
  const games = await harness.commerceDb.prepare("SELECT display_title, steam_app_id FROM gaming_games ORDER BY created_at, rowid").all();
  assert.deepEqual(games.results.map((row) => row.display_title), ["WITCHER", "LUMINARY", "SUPER MARIO WORLD", "PARTY ANIMAL"]);
  assert.equal(games.results.find((row) => row.display_title === "LUMINARY").steam_app_id, "1648360");
  assert.deepEqual((await harness.commerceDb.prepare("SELECT game_id FROM gaming_rotation ORDER BY position").all()).results.map((row) => row.game_id), ["gaming-witcher", "gaming-luminary", "gaming-super-mario-world", "gaming-party-animal"]);
  assert.deepEqual((await harness.commerceDb.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("Pages routes the public Gaming rotation projection through Functions", async () => {
  const routes = JSON.parse(await readFile(new URL("../public/_routes.json", import.meta.url), "utf8"));
  assert.ok(routes.include.includes("/api/gaming/rotation"));
  assert.ok(routes.include.includes("/api/gaming/media/*"));
});

test("missing 0028 reports the explicit Gaming migration state without fake data", async (t) => {
  const harness = await createCommerceDatabases({ commerceMigrationCount: 27 }); t.after(harness.dispose); await insertMaster(harness.authDb);
  const state = await gamingSchemaState(harness.commerceDb); assert.equal(state.compatible, false); assert.deepEqual(state.missingTables, ["gaming_games", "gaming_media_assets", "gaming_rotation"]);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev" }); const auth = await sessionRequest(harness.authDb, env, "gaming-master", "missing-migration-token");
  const response = await gamingAdminApi({ request: new Request("https://thirdrailify-admin.pages.dev/api/admin/gaming", { headers: { Cookie: auth.cookie } }), env }); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ok: false, error: "gaming_migration_required", message: "Gaming database migration required." });
  await assert.rejects(gamingSchemaState({ prepare() { throw new Error("database unavailable"); } }), (error) => error.code === "gaming_query_failed");
});

test("manual games remain historical through remove and re-add while public order follows D1", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await insertMaster(harness.authDb);
  const env = commerceEnvironment(harness, { THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev" });
  const created = await mutateGaming(env, "gaming-master", { action: "create", inRotation: false, game: { title: "Manual Mystery", platform: "PC", description: "Curated without provider metadata.", genre: "Mystery" } });
  const manual = created.games.find((game) => game.title === "Manual Mystery"); assert.ok(manual); assert.equal(manual.steam.appId, null); assert.equal(manual.artwork.url, null);
  await mutateGaming(env, "gaming-master", { action: "add_to_rotation", gameId: manual.id });
  await assert.rejects(mutateGaming(env, "gaming-master", { action: "add_to_rotation", gameId: manual.id }), (error) => error.code === "gaming_rotation_duplicate");
  const removed = await mutateGaming(env, "gaming-master", { action: "remove_from_rotation", gameId: manual.id });
  assert.equal(removed.games.find((game) => game.id === manual.id).rotation.inRotation, false); assert.equal(removed.games.length, 5);
  const readded = await mutateGaming(env, "gaming-master", { action: "add_to_rotation", gameId: manual.id }); assert.equal(readded.rotation.at(-1).id, manual.id);
  await mutateGaming(env, "gaming-master", { action: "move", gameId: manual.id, direction: "up" });
  const projection = await publicGamingRotation(env); assert.equal(projection.items.at(-2).id, manual.id); assert.equal("archivedAt" in projection.items[0], false);
});

test("Gaming validation rejects unsafe mappings and uploaded cover uses the existing R2 authority", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await insertMaster(harness.authDb); const bucket = memoryBucket();
  const env = commerceEnvironment(harness, { THIRDRAILIFY_ADMIN_ORIGIN: "https://thirdrailify-admin.pages.dev", THIRDRAILIFY_PROFILE_MEDIA: bucket });
  await assert.rejects(mutateGaming(env, "gaming-master", { action: "create", game: { title: "Unsafe", remoteArtworkUrl: "javascript:alert(1)" } }), (error) => error.code === "gaming_artwork_url_invalid");
  await assert.rejects(mutateGaming(env, "gaming-master", { action: "create", game: { title: "Mismatch", steamAppId: "10", steamStoreUrl: "https://store.steampowered.com/app/20/" } }), (error) => error.code === "gaming_steam_mismatch");
  await assert.rejects(mutateGaming(env, "gaming-master", { action: "create", game: { title: "Credentials", steamStoreUrl: "https://user:pass@store.steampowered.com/app/20/" } }), (error) => error.code === "gaming_steam_url_invalid");
  await assert.rejects(mutateGaming(env, "gaming-master", { action: "create", game: { title: "Deceptive", steamStoreUrl: "https://store.steampowered.com.evil.test/app/20/" } }), (error) => error.code === "gaming_steam_url_invalid");
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==", "base64"));
  const payload = await uploadGamingArtwork(env, "gaming-master", "gaming-witcher", png, "image/png", "cover.png");
  assert.match(payload.games.find((game) => game.id === "gaming-witcher").artwork.url, /^https:\/\/thirdrailify-admin\.pages\.dev\/api\/gaming\/media\//); assert.equal(bucket.objects.size, 1);
  assert.equal((await adminGamingPayload(env, payload.access)).summary.missingArtwork, 2);
});

test("Gaming Admin API gives Full Admin default view/manage, preserves read-only denial, and blocks regular users", async (t) => {
  const harness=await createCommerceDatabases();t.after(harness.dispose);await insertMaster(harness.authDb);await insertAccount(harness.authDb,"gaming-full","admin","full");await insertAccount(harness.authDb,"gaming-user","user","none");const env=commerceEnvironment(harness,{THIRDRAILIFY_ADMIN_ORIGIN:"https://thirdrailify-admin.pages.dev"});
  const full=await sessionRequest(harness.authDb,env,"gaming-full","full-token");const read=await gamingAdminApi({request:new Request("https://thirdrailify-admin.pages.dev/api/admin/gaming",{headers:{Cookie:full.cookie}}),env});assert.equal(read.status,200);
  const steam=await gamingAdminApi({request:new Request("https://thirdrailify-admin.pages.dev/api/admin/gaming/steam/search?q=witcher",{headers:{Cookie:full.cookie}}),env,data:{gamingCache:memoryCache(),gamingFetch:async()=>new Response(JSON.stringify({total:2,items:[{type:"app",name:"The Witcher 3",id:292030,tiny_image:"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/292030/capsule.jpg",platforms:{windows:true}},{type:"app",name:"The Witcher 2",id:20920,tiny_image:null,platforms:{windows:true}}]}),{headers:{"Content-Type":"application/json"}})}});assert.equal(steam.status,200);const steamPayload=await steam.json();assert.deepEqual(steamPayload.results.map((item)=>item.appId),["292030","20920"]);assert.equal(steam.headers.get("cache-control"),"no-store");
  const fallback=await gamingAdminApi({request:new Request("https://thirdrailify-admin.pages.dev/api/admin/gaming/steam/search?q=witcher",{headers:{Cookie:full.cookie}}),env,data:{gamingCache:memoryCache(),gamingFetch:async()=>new Response("unavailable",{status:502,headers:{"Content-Type":"text/plain"}})}});assert.equal(fallback.status,200);const fallbackPayload=await fallback.json();assert.equal(fallbackPayload.provider,"embedded_steam_catalogue_fallback");assert.ok(fallbackPayload.results.some((item)=>item.appId==="292030"));
  const directUrl=encodeURIComponent("https://store.steampowered.com/app/292030/The_Witcher_3/");const resolved=await gamingAdminApi({request:new Request(`https://thirdrailify-admin.pages.dev/api/admin/gaming/steam/search?q=${directUrl}`,{headers:{Cookie:full.cookie}}),env,data:{gamingCache:memoryCache(),gamingFetch:async(url)=>{assert.match(url,/\/api\/appdetails\?/);return new Response(JSON.stringify({"292030":{success:true,data:{type:"game",name:"The Witcher 3",steam_appid:292030,short_description:"RPG",platforms:{windows:true},genres:[],developers:[],publishers:[]}}}),{headers:{"Content-Type":"application/json"}});}}});assert.equal(resolved.status,200);const resolvedPayload=await resolved.json();assert.equal(resolvedPayload.mode,"app");assert.equal(resolvedPayload.result.appId,"292030");assert.equal((await harness.authDb.prepare("SELECT attempt_count FROM auth_rate_limits WHERE category='gaming_steam_lookup'").first()).attempt_count,3);
  const write=await gamingAdminApi({request:new Request("https://thirdrailify-admin.pages.dev/api/admin/gaming",{method:"POST",headers:{Cookie:full.cookie,Origin:env.THIRDRAILIFY_ADMIN_ORIGIN,"Content-Type":"application/json","X-CSRF-Token":full.csrf},body:JSON.stringify({action:"create",game:{title:"Capability Test"}})}),env});assert.equal(write.status,200);
  const stamp="2026-09-01T00:00:00.000Z";await harness.authDb.prepare("INSERT INTO admin_role_capability_denials (role,capability,denied_by_account_id,created_at,updated_at) VALUES ('full','gaming.manage','gaming-master',?,?)").bind(stamp,stamp).run();
  assert.equal((await gamingAdminApi({request:new Request("https://thirdrailify-admin.pages.dev/api/admin/gaming",{headers:{Cookie:full.cookie}}),env})).status,200);
  assert.equal((await gamingAdminApi({request:new Request("https://thirdrailify-admin.pages.dev/api/admin/gaming",{method:"POST",headers:{Cookie:full.cookie,Origin:env.THIRDRAILIFY_ADMIN_ORIGIN,"Content-Type":"application/json","X-CSRF-Token":full.csrf},body:JSON.stringify({action:"archive",gameId:"gaming-witcher"})}),env})).status,403);
  const regular=await sessionRequest(harness.authDb,env,"gaming-user","user-token");assert.equal((await gamingAdminApi({request:new Request("https://thirdrailify-admin.pages.dev/api/admin/gaming",{headers:{Cookie:regular.cookie}}),env})).status,403);
});

async function insertMaster(db) { const stamp = "2026-09-01T00:00:00.000Z"; await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,?,?,?,?,?)").bind("gaming-master", "gaming-master@example.test", "Gaming Master", "admin", "master", "active", stamp, stamp, stamp, "test").run(); }
async function insertAccount(db,id,role,level){const stamp="2026-09-01T00:00:00.000Z";await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id,`${id}@example.test`,id,role,level,"active",stamp,stamp,stamp,"test").run();}
async function sessionRequest(db,env,accountId,token){const csrf=await hmacSha256(env.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET,`csrf:${token}`);const stamp=new Date().toISOString();await db.prepare("INSERT INTO sessions (id,account_id,token_hash,csrf_token_hash,created_at,expires_at,last_seen_at,source_origin) VALUES (?,?,?,?,?,?,?,?)").bind(`session-${accountId}`,accountId,await sha256(token),await sha256(csrf),stamp,new Date(Date.now()+3600000).toISOString(),stamp,env.THIRDRAILIFY_ADMIN_ORIGIN).run();return{cookie:`thirdrailify_session=${token}`,csrf};}
function memoryBucket(){const objects=new Map();return{objects,async put(key,value,options){objects.set(key,{bytes:new Uint8Array(value),options});},async get(key){const item=objects.get(key);return item?{body:item.bytes,size:item.bytes.byteLength}:null;},async delete(key){objects.delete(key);}};}
function memoryCache(){const objects=new Map();return{async match(request){return objects.get(request.url)?.clone();},async put(request,response){objects.set(request.url,response.clone());}};}
