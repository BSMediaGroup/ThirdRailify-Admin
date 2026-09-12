import { ingestPaidSnapshot } from '../../../_shared/poll-credits.js';
import { ingestIntelligence } from '../../../_shared/rumble-intelligence.js';
import { AuthFailure, errorResponse, jsonResponse } from "../../../_shared/auth-core.js";
import { botAutomationRules, ingestAutomationEvents } from '../../../_shared/automation-core.js';
import { botActivePoll, botDesiredConfig, ingestRumbleVotes, readPollJson, recordBotHeartbeat, synchronizeBotDesiredConfig, verifyBotServiceRequest } from "../../../_shared/polls-core.js";

const PREFIX = "/api/internal/bot";
export async function onRequest({ request, env }) {
  try {
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET") {
      await verifyBotServiceRequest(request, env, new Uint8Array());
      if (path === "control") {
        // One authenticated envelope, with independent failures and unchanged projections.
        const entries = await Promise.all([
          ["config", () => botDesiredConfig(env)],
          ["poll", () => botActivePoll(env)],
          ["rules", () => botAutomationRules(env, true)],
        ].map(async ([name, read]) => {
          try { return [name, { status: 200, body: await read() }]; }
          catch (error) {
            const failure = errorResponse(error, request, env);
            return [name, { status: failure.status, body: await failure.json(), retryAfter: failure.headers.get('Retry-After') }];
          }
        }));
        return response({ ok: true, version: 1, ...Object.fromEntries(entries) });
      }
      if (path === "config") return response(await botDesiredConfig(env));
      if (path === "poll") return response(await botActivePoll(env));
      if (path === "rules") return response(await botAutomationRules(env));
      if (path === "rules-v2") return response(await botAutomationRules(env, true));
    }
    if (request.method === "POST") {
      const { body, raw } = await readPollJson(request, path === 'subscriber-observations' ? 2 * 1024 * 1024 : ['votes', 'events', 'poll-credits'].includes(path) ? 128 * 1024 : 32 * 1024); await verifyBotServiceRequest(request, env, raw);
      if (path === 'subscriber-observations') return response(await ingestIntelligence(env, body));
      if (path === "config") return response(await synchronizeBotDesiredConfig(env, body));
      if (path === "heartbeat") return response(await recordBotHeartbeat(env, body));
      if (path === "poll-credits") return response(await ingestPaidSnapshot(env, body));
      if (path === "votes") return response(await ingestRumbleVotes(env, body));
      if (path === "events") return response(await ingestAutomationEvents(env, body));
    }
    throw new AuthFailure(404, "bot_route_not_found", "The bot service route was not found.");
  } catch (error) { return errorResponse(error, request, env); }
}
function response(payload) { return jsonResponse(payload, { headers: { "Cache-Control": "no-store" } }); }
