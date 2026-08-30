import { proxyPublicIngest } from "../../../_shared/public-ingest-proxy.js";

export function onRequest({ request, env }) {
  return proxyPublicIngest(request, env, "/api/community/discord/ingest", 96 * 1024);
}
