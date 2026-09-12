import { commerceMediaResponse } from "../../../../_shared/commerce-media.js";
import { errorResponse } from "../../../../_shared/auth-core.js";

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const match = /^\/api\/public\/commerce\/media\/([a-f0-9]{64}\.(?:jpg|png|webp))$/.exec(url.pathname);
  if (!match || url.search) return new Response("Image unavailable", { status: 404 });
  url.pathname = `/commerce-media/${match[1]}`;
  try { return await commerceMediaResponse(new Request(url, request), env); }
  catch (error) { return errorResponse(error, request, env); }
}
