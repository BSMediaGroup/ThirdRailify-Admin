import { proxyPublicIngest } from "../../_shared/public-ingest-proxy.js";

export function onRequest({ request, env }) {
  return proxyPublicIngest(request, env, "/api/watch/ingest", 64 * 1024);
}
