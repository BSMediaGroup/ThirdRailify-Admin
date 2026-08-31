import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  automationsStatus,
  botActivePoll,
  changePollLifecycle,
  changePollVisibility,
  createPoll,
  getCreatorRumbleDiscovery,
  getPollCreatorAccess,
  getPublicPoll,
  ingestRumbleVotes,
  listPublicPolls,
  mutatePollCreatorGrant,
  recordBotHeartbeat,
  submitWebVote,
  synchronizeBotDesiredConfig,
  updateAutomationConfig,
  updatePoll,
  verifyBotServiceRequest,
  verifyPublicPollRequest,
} from "../functions/_shared/polls-core.js";
import { onRequest as pollRequest, publicRead } from "../functions/api/polls/[[path]].js";
import { normalizePollTrigger } from "../functions/_shared/poll-normalization.js";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";

const HMAC_SECRET = "poll-test-secret-with-enough-entropy";

test("Poll migration, lifecycle, one-current-vote semantics, lease conflict, and ingestion dedupe", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(() => harness.dispose());
  const env = commerceEnvironment(harness, {
    THIRDRAILIFY_POLL_VOTER_SECRET: HMAC_SECRET,
    THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: HMAC_SECRET,
    THIRDRAILIFY_BOT_ADMIN_SECRET: HMAC_SECRET,
  });
  await account(harness.authDb, "creator-one", "Creator One");
  await account(harness.authDb, "creator-two", "Creator Two");
  await harness.commerceDb.prepare("INSERT INTO poll_creator_grants (account_id,active,may_create_polls,granted_by_account_id,created_at,updated_at) VALUES (?,1,1,NULL,?,?)")
    .bind("creator-one", new Date().toISOString(), new Date().toISOString()).run();
  await harness.commerceDb.prepare("INSERT INTO poll_creator_grants (account_id,active,may_create_polls,granted_by_account_id,created_at,updated_at) VALUES (?,1,1,NULL,?,?)")
    .bind("creator-two", new Date().toISOString(), new Date().toISOString()).run();
  assert.equal((await getPollCreatorAccess(env, "creator-one")).canCreate, true);

  const first = await createPoll(env, "creator-one", pollInput("Primary live choice"));
  assert.equal(first.poll.state, "draft");
  const open = await changePollLifecycle(env, "creator-one", first.poll.slug, { revision: first.poll.revision, action: "open" });
  assert.equal(open.poll.state, "open");
  const botPoll = (await botActivePoll(env)).activePoll;
  assert.equal(botPoll.id, open.poll.id);
  assert.deepEqual(botPoll.options, open.poll.options.map((option) => ({ id: option.id, normalizedTrigger: option.normalizedTrigger })));

  const actor = { namespace: "web_anonymous", key: "anonymous:fixture", label: null };
  const optionOne = open.poll.options[0].id;
  const optionTwo = open.poll.options[1].id;
  assert.equal((await submitWebVote(env, actor, open.poll.slug, { optionId: optionOne })).vote.repeated, false);
  assert.equal((await submitWebVote(env, actor, open.poll.slug, { optionId: optionOne })).vote.repeated, true);
  const changed = await submitWebVote(env, actor, open.poll.slug, { optionId: optionTwo });
  assert.equal(changed.vote.changed, true);
  assert.equal(changed.poll.totalVotes, 1);
  assert.equal(changed.poll.options.find((item) => item.id === optionTwo).votes, 1);

  const second = await createPoll(env, "creator-two", pollInput("Conflicting live choice"));
  await assert.rejects(
    changePollLifecycle(env, "creator-two", second.poll.slug, { revision: second.poll.revision, action: "open" }),
    (error) => error.code === "rumble_source_poll_conflict",
  );

  const event = {
    eventFingerprint: "a".repeat(64),
    sourceScope: "user:sample-owner",
    livestreamId: "sample-live",
    actorKey: "viewer-one",
    actorLabel: "Viewer One",
    optionId: optionOne,
    providerEventAt: new Date(Date.now() + 1000).toISOString(),
  };
  const accepted = await ingestRumbleVotes(env, { pollId: open.poll.id, pollRevision: open.poll.revision, events: [event] });
  assert.equal(accepted.accepted, 1);
  const duplicate = await ingestRumbleVotes(env, { pollId: open.poll.id, pollRevision: open.poll.revision, events: [event] });
  assert.equal(duplicate.duplicate, 1);

  const disabled = await updatePoll(env, "creator-one", open.poll.slug, { revision: open.poll.revision, rumbleEnabled: false });
  assert.equal((await botActivePoll(env)).activePoll, null);
  const openedSecond = await changePollLifecycle(env, "creator-two", second.poll.slug, { revision: second.poll.revision, action: "open" });
  await changePollLifecycle(env, "creator-two", second.poll.slug, { revision: openedSecond.poll.revision, action: "close" });
  const closed = await changePollLifecycle(env, "creator-one", open.poll.slug, { revision: disabled.poll.revision, action: "close" });
  assert.equal(closed.poll.state, "closed");
  assert.equal((await botActivePoll(env)).activePoll, null);
  await assert.rejects(submitWebVote(env, actor, open.poll.slug, { optionId: optionOne }), (error) => error.code === "poll_not_open");
});

test("closed Poll listing is independent from lifecycle, paginated, and owner/Admin visibility remains authorized", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(() => harness.dispose());
  const env = commerceEnvironment(harness, {
    THIRDRAILIFY_POLL_VOTER_SECRET: HMAC_SECRET,
    THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: HMAC_SECRET,
  });
  await account(harness.authDb, "history-owner", "History Owner");
  await account(harness.authDb, "history-other", "History Other");
  await account(harness.authDb, "history-admin", "History Admin", { role: "admin", adminLevel: "full" });
  await harness.commerceDb.prepare("INSERT INTO poll_creator_grants (account_id,active,may_create_polls,granted_by_account_id,created_at,updated_at) VALUES (?,1,1,NULL,?,?)")
    .bind("history-owner", new Date().toISOString(), new Date().toISOString()).run();

  const draft = await createPoll(env, "history-owner", { ...pollInput("History draft"), rumbleEnabled: false });
  assert.equal((await listPublicPolls(env, { view: "open" })).items.length, 0);
  assert.equal((await listPublicPolls(env, { view: "closed" })).items.length, 0);

  const opened = await changePollLifecycle(env, "history-owner", draft.poll.slug, { revision: draft.poll.revision, action: "open" });
  assert.equal(opened.poll.public, true);
  assert.equal((await listPublicPolls(env, { view: "open" })).items[0].id, opened.poll.id);
  const closed = await changePollLifecycle(env, "history-owner", opened.poll.slug, { revision: opened.poll.revision, action: "close" });
  assert.equal(closed.poll.state, "closed");
  assert.equal(closed.poll.public, true, "close preserves public listing");
  const olderDraft = await createPoll(env, "history-owner", { ...pollInput("Older history Poll"), rumbleEnabled: false });
  const olderOpen = await changePollLifecycle(env, "history-owner", olderDraft.poll.slug, { revision: olderDraft.poll.revision, action: "open" });
  const olderClosed = await changePollLifecycle(env, "history-owner", olderOpen.poll.slug, { revision: olderOpen.poll.revision, action: "close" });
  await harness.commerceDb.prepare("UPDATE polls SET closed_at=? WHERE id=?").bind("2026-09-01T02:00:00.000Z", closed.poll.id).run();
  await harness.commerceDb.prepare("UPDATE polls SET closed_at=? WHERE id=?").bind("2026-09-01T01:00:00.000Z", olderClosed.poll.id).run();
  const closedPage = await listPublicPolls(env, { view: "closed", page: 1, pageSize: 1 });
  assert.equal(closedPage.items[0].id, closed.poll.id);
  assert.deepEqual({ page: closedPage.page, pageSize: closedPage.pageSize, total: closedPage.total, totalPages: closedPage.totalPages }, { page: 1, pageSize: 1, total: 2, totalPages: 2 });
  assert.equal((await listPublicPolls(env, { view: "closed", page: 2, pageSize: 1 })).items[0].id, olderClosed.poll.id);
  await changePollLifecycle(env, "history-owner", olderClosed.poll.slug, { revision: olderClosed.poll.revision, action: "archive" });

  await assert.rejects(changePollVisibility(env, "history-other", closed.poll.slug, { revision: closed.poll.revision, public: false }), (error) => error.code === "poll_owner_required");
  const hidden = await changePollVisibility(env, "history-owner", closed.poll.slug, { revision: closed.poll.revision, public: false });
  assert.equal(hidden.poll.state, "closed");
  assert.equal(hidden.poll.public, false);
  assert.equal((await listPublicPolls(env, { view: "closed" })).items.length, 0);
  await assert.rejects(getPublicPoll(env, closed.poll.slug), (error) => error.code === "poll_not_found");
  assert.equal((await getPublicPoll(env, closed.poll.slug, "history-owner", true)).poll.id, closed.poll.id);

  const shown = await changePollVisibility(env, "history-admin", closed.poll.slug, { revision: hidden.poll.revision, public: true });
  assert.equal(shown.poll.public, true);
  assert.equal((await listPublicPolls(env, { view: "closed", search: "history draft" })).items.length, 1);
  const archived = await changePollLifecycle(env, "history-admin", closed.poll.slug, { revision: shown.poll.revision, action: "archive" });
  assert.equal(archived.poll.state, "archived");
  assert.equal(archived.poll.public, false);
  assert.equal((await listPublicPolls(env, { view: "closed" })).items.length, 0);
});

test("bot service HMAC rejects tampering and replay", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(() => harness.dispose());
  const env = commerceEnvironment(harness, { THIRDRAILIFY_BOT_ADMIN_SECRET: HMAC_SECRET });
  const path = "/api/internal/bot/config";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = "request_identifier_12345";
  const digest = await sha256("");
  const signature = await hmac(`${"GET"}\n${path}\n${timestamp}\n${requestId}\n${digest}`);
  const request = new Request(`https://admin.example${path}`, { headers: serviceHeaders(timestamp, requestId, signature) });
  await verifyBotServiceRequest(request, env, new Uint8Array());
  await assert.rejects(verifyBotServiceRequest(request, env, new Uint8Array()), (error) => error.code === "bot_request_replayed");
  const tampered = new Request(`https://admin.example${path}`, { headers: serviceHeaders(timestamp, "request_identifier_67890", "0".repeat(64)) });
  await assert.rejects(verifyBotServiceRequest(tampered, env, new Uint8Array()), (error) => error.code === "bot_signature_invalid");
});

test("public Poll Pages routing, empty and populated reads, service authentication, and failure states stay explicit", async (t) => {
  const routes = JSON.parse(await readFile(new URL("../public/_routes.json", import.meta.url), "utf8"));
  assert.ok(routes.include.includes("/api/polls"));
  assert.ok(routes.include.includes("/api/polls/*"));

  const harness = await createCommerceDatabases();
  t.after(() => harness.dispose());
  const env = commerceEnvironment(harness, {
    THIRDRAILIFY_COMMUNITY_API_SECRET: HMAC_SECRET,
    THIRDRAILIFY_POLL_VOTER_SECRET: HMAC_SECRET,
    THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: HMAC_SECRET,
  });

  const emptyResponse = await publicRead(new Request("https://admin.example/api/polls?view=open&search="), env, "");
  assert.equal(emptyResponse.status, 200);
  assert.match(emptyResponse.headers.get("cache-control") || "", /^public,/);
  assert.deepEqual((await emptyResponse.json()).items, []);

  await account(harness.authDb, "public-reader-fixture", "Public Reader Fixture");
  await harness.commerceDb.prepare("INSERT INTO poll_creator_grants (account_id,active,may_create_polls,granted_by_account_id,created_at,updated_at) VALUES (?,1,1,NULL,?,?)")
    .bind("public-reader-fixture", new Date().toISOString(), new Date().toISOString()).run();
  const created = await createPoll(env, "public-reader-fixture", { ...pollInput("Public route fixture"), rumbleEnabled: false });
  await changePollLifecycle(env, "public-reader-fixture", created.poll.slug, { revision: created.poll.revision, action: "open" });
  const populatedResponse = await publicRead(new Request("https://admin.example/api/polls?view=open&search="), env, "");
  const populated = await populatedResponse.json();
  assert.equal(populatedResponse.status, 200);
  assert.equal(populated.items.length, 1);
  assert.equal(populated.items[0].slug, created.poll.slug);

  await assert.rejects(listPublicPolls({}, { view: "open" }), (error) => error.code === "polls_database_not_configured");
  await assert.rejects(
    listPublicPolls({ THIRDRAILIFY_COMMERCE_DB: { prepare() { throw new Error("poll query failed"); } } }, { view: "open" }),
    /poll query failed/,
  );

  const path = "/api/polls/internal/access";
  const raw = JSON.stringify({ accountId: "" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = "public_poll_request_12345";
  const signature = await hmac(`POST\n${path}\n${timestamp}\n${requestId}\n${await sha256(raw)}`);
  const signed = new Request(`https://admin.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...serviceHeaders(timestamp, requestId, signature) },
    body: raw,
  });
  await verifyPublicPollRequest(signed.clone(), env, raw);
  const replay = await pollRequest({ request: signed, env });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, "service_request_replayed");

  const requestIdTwo = "public_poll_request_67890";
  const signatureTwo = await hmac(`POST\n${path}\n${timestamp}\n${requestIdTwo}\n${await sha256(raw)}`);
  const accepted = await pollRequest({ request: new Request(`https://admin.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...serviceHeaders(timestamp, requestIdTwo, signatureTwo) },
    body: raw,
  }), env });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.deepEqual(await accepted.json(), { ok: true, authenticated: false, canCreate: false, canManageAll: false });

  const rejected = await pollRequest({ request: new Request(`https://admin.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...serviceHeaders(timestamp, "public_poll_request_99999", "0".repeat(64)) },
    body: raw,
  }), env });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).error, "poll_signature_invalid");
});

test("creator grants, ownership, option locks, signed voting, and desired/applied config stay fail closed", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(() => harness.dispose());
  const env = commerceEnvironment(harness, {
    THIRDRAILIFY_POLL_VOTER_SECRET: HMAC_SECRET,
    THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: HMAC_SECRET,
  });
  await account(harness.authDb, "unapproved", "Unapproved Creator");
  await account(harness.authDb, "owner", "Poll Owner");
  await account(harness.authDb, "intruder", "Other Creator");
  await account(harness.authDb, "master", "Master Admin", { role: "admin", adminLevel: "master" });

  await assert.rejects(createPoll(env, "unapproved", pollInput("Denied")), (error) => error.code === "poll_creator_not_approved");
  await mutatePollCreatorGrant(env, "master", { accountId: "owner", action: "approve" });
  await mutatePollCreatorGrant(env, "master", { accountId: "intruder", action: "approve" });

  const created = await createPoll(env, "owner", {
    ...pollInput("Authority fixture"),
    rumbleEnabled: false,
    options: [{ label: "One" }, { label: "Two" }],
    webVotingMode: "signed_in",
  });
  assert.deepEqual(created.poll.options.map((option) => option.trigger), ["1", "2"]);
  const duplicateTitle = await createPoll(env, "owner", { ...pollInput("Authority fixture"), rumbleEnabled: false });
  assert.equal(duplicateTitle.poll.slug, "authority-fixture-2");
  await assert.rejects(updatePoll(env, "intruder", created.poll.slug, { revision: created.poll.revision, title: "Taken over" }), (error) => error.code === "poll_owner_required");

  const adminEdit = await updatePoll(env, "master", created.poll.slug, { revision: created.poll.revision, title: "Admin-reviewed fixture" });
  const opened = await changePollLifecycle(env, "owner", created.poll.slug, { revision: adminEdit.poll.revision, action: "open" });
  await assert.rejects(updatePoll(env, "owner", created.poll.slug, {
    revision: opened.poll.revision,
    options: opened.poll.options.map((option) => ({ id: option.id, label: option.label, trigger: option.trigger })),
  }), (error) => error.code === "poll_structure_locked");
  await assert.rejects(submitWebVote(env, { namespace: "web_anonymous", key: "anonymous:test" }, created.poll.slug, { optionId: opened.poll.options[0].id }), (error) => error.code === "authentication_required");
  await assert.rejects(changePollLifecycle(env, "owner", created.poll.slug, { revision: adminEdit.poll.revision, action: "close" }), (error) => error.code === "poll_revision_conflict");

  const desired = await updateAutomationConfig(env, "master", { revision: 1, desiredState: { discord: { enabled: true }, rumble: { enabled: true, pollIntervalSeconds: 15 } } });
  assert.equal(desired.config.desiredRevision, 2);
  await assert.rejects(updateAutomationConfig(env, "master", { revision: 1, desiredState: {} }), (error) => error.code === "config_revision_conflict");
  await recordBotHeartbeat(env, {
    startupInstanceId: "instance_identifier_12345",
    botVersion: "1.1.0",
    desiredRevision: 2,
    appliedRevision: 2,
    runtime: { discordConnected: true, counters: { accepted: 4 }, secret: "must-not-project", rumbleDiscovery: {
      provider: "rumble", source: { scope: "user:1sl8zm", type: "user", id: "1sl8zm", displayName: "ThirdRailify" },
      providerResponseAt: "2026-08-31T21:48:24Z", observedAt: new Date().toISOString(),
      livestreams: [{ id: "safe-live", title: "Third Railify Live", isLive: true, watchingNow: 22, stream_key: "never", server_url: "never" }],
      stream_key: "never-project",
    } },
  });
  const status = await automationsStatus(env);
  assert.equal(status.runtime.state, "online");
  assert.equal(status.runtime.appliedRevision, 2);
  assert.equal(status.runtime.secret, undefined);
  assert.equal(JSON.stringify(status).includes("must-not-project"), false);
  const discovery = await getCreatorRumbleDiscovery(env, "owner");
  assert.equal(discovery.source.scope, "user:1sl8zm");
  assert.equal(discovery.livestreams[0].title, "Third Railify Live");
  assert.equal(JSON.stringify(discovery).includes("stream_key"), false);
  assert.equal(JSON.stringify(discovery).includes("server_url"), false);
  await assert.rejects(getCreatorRumbleDiscovery(env, "unapproved"), (error) => error.code === "poll_creator_not_approved");
  await harness.commerceDb.prepare("UPDATE bot_runtime_heartbeat SET heartbeat_at=? WHERE singleton_id=1")
    .bind(new Date(Date.now() - 90_000).toISOString()).run();
  const staleDiscovery = await getCreatorRumbleDiscovery(env, "owner");
  assert.equal(staleDiscovery.botState, "stale");
  assert.equal(staleDiscovery.source.scope, "user:1sl8zm");
  await harness.commerceDb.prepare("UPDATE bot_runtime_heartbeat SET heartbeat_at=? WHERE singleton_id=1")
    .bind(new Date(Date.now() - 240_000).toISOString()).run();
  const offlineDiscovery = await getCreatorRumbleDiscovery(env, "owner");
  assert.equal(offlineDiscovery.botState, "offline");
  assert.equal(offlineDiscovery.message, "Rumble source discovery temporarily unavailable.");
  const slashSync = await synchronizeBotDesiredConfig(env, { revision: 2, desiredState: { discord: {}, rumble: { enabled: false, intervalSeconds: 90, pollIntervalSeconds: 15 } } });
  assert.equal(slashSync.revision, 3);
  assert.equal(slashSync.desiredState.rumble.intervalSeconds, 90);
  await assert.rejects(synchronizeBotDesiredConfig(env, { revision: 2, desiredState: {} }), (error) => error.code === "config_revision_conflict");

  await assert.rejects(createPoll(env, "owner", { ...pollInput("Collision"), options: [{ label: "One", trigger: "Ａ" }, { label: "Two", trigger: "a" }] }), (error) => error.code === "poll_trigger_collision");
  await assert.rejects(createPoll(env, "owner", { ...pollInput("Bad tint"), theme: { accent: "timestamp-1788174504" } }), (error) => error.code === "poll_theme_invalid");
});

test("JavaScript Poll normalization follows the canonical cross-language fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../ThirdRailify/tests/fixtures/poll-normalization-v1.json", import.meta.url), "utf8"));
  for (const vector of fixture.vectors) assert.equal(normalizePollTrigger(vector.input), vector.normalized);
});

function pollInput(title) {
  return {
    title,
    description: "A deterministic local Poll fixture.",
    webVotingMode: "anyone",
    rumbleEnabled: true,
    rumbleSourceScope: "user:sample-owner",
    livestreamMode: "automatic",
    requestedIntervalSeconds: 15,
    options: [{ label: "One", trigger: "1" }, { label: "Two", trigger: "CARROT" }],
  };
}

async function account(db, id, name, { role = "user", adminLevel = "none" } = {}) {
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,'test')")
    .bind(id, `${id}@example.test`, name, role, adminLevel, now, now, now).run();
}

function serviceHeaders(timestamp, requestId, signature) {
  return { "X-ThirdRailify-Timestamp": timestamp, "X-ThirdRailify-Request-Id": requestId, "X-ThirdRailify-Signature": signature };
}

async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(HMAC_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return Buffer.from(bytes).toString("base64url");
}
