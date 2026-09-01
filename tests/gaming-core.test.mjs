import assert from "node:assert/strict";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import { adminGamingPayload, mutateGaming, publicGamingRotation, uploadGamingArtwork } from "../functions/_shared/gaming-core.js";
import { hmacSha256, sha256 } from "../functions/_shared/auth-core.js";
import { onRequest as gamingAdminApi } from "../functions/api/admin/gaming/[[path]].js";

test("Gaming migration seeds the permanent library and ordered Current Rotation", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const games = await harness.commerceDb.prepare("SELECT display_title, steam_app_id FROM gaming_games ORDER BY created_at, rowid").all();
  assert.deepEqual(games.results.map((row) => row.display_title), ["WITCHER", "LUMINARY", "SUPER MARIO WORLD", "PARTY ANIMAL"]);
  assert.equal(games.results.find((row) => row.display_title === "LUMINARY").steam_app_id, "1648360");
  assert.deepEqual((await harness.commerceDb.prepare("SELECT game_id FROM gaming_rotation ORDER BY position").all()).results.map((row) => row.game_id), ["gaming-witcher", "gaming-luminary", "gaming-super-mario-world", "gaming-party-animal"]);
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
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==", "base64"));
  const payload = await uploadGamingArtwork(env, "gaming-master", "gaming-witcher", png, "image/png", "cover.png");
  assert.match(payload.games.find((game) => game.id === "gaming-witcher").artwork.url, /^https:\/\/thirdrailify-admin\.pages\.dev\/api\/gaming\/media\//); assert.equal(bucket.objects.size, 1);
  assert.equal((await adminGamingPayload(env, payload.access)).summary.missingArtwork, 2);
});

test("Gaming Admin API gives Full Admin default view/manage, preserves read-only denial, and blocks regular users", async (t) => {
  const harness=await createCommerceDatabases();t.after(harness.dispose);await insertMaster(harness.authDb);await insertAccount(harness.authDb,"gaming-full","admin","full");await insertAccount(harness.authDb,"gaming-user","user","none");const env=commerceEnvironment(harness,{THIRDRAILIFY_ADMIN_ORIGIN:"https://thirdrailify-admin.pages.dev"});
  const full=await sessionRequest(harness.authDb,env,"gaming-full","full-token");const read=await gamingAdminApi({request:new Request("https://thirdrailify-admin.pages.dev/api/admin/gaming",{headers:{Cookie:full.cookie}}),env});assert.equal(read.status,200);
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
