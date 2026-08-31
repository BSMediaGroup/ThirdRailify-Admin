import { AuthFailure, errorResponse, jsonResponse } from "../../../_shared/auth-core.js";
import { botActivePoll, botDesiredConfig, ingestRumbleVotes, readPollJson, recordBotHeartbeat, synchronizeBotDesiredConfig, verifyBotServiceRequest } from "../../../_shared/polls-core.js";

const PREFIX = "/api/internal/bot";
export async function onRequest({ request, env }) {
  try {
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (request.method === "GET") {
      await verifyBotServiceRequest(request, env, new Uint8Array());
      if (path === "config") return response(await botDesiredConfig(env));
      if (path === "poll") return response(await botActivePoll(env));
    }
    if (request.method === "POST") {
      const { body, raw } = await readPollJson(request, path === "votes" ? 128 * 1024 : 32 * 1024); await verifyBotServiceRequest(request, env, raw);
      if (path === "config") return response(await synchronizeBotDesiredConfig(env, body));
      if (path === "heartbeat") return response(await recordBotHeartbeat(env, body));
      if (path === "votes") return response(await ingestRumbleVotes(env, body));
    }
    throw new AuthFailure(404, "bot_route_not_found", "The bot service route was not found.");
  } catch (error) { return errorResponse(error, request, env); }
}
function response(payload) { return jsonResponse(payload, { headers: { "Cache-Control": "no-store" } }); }
