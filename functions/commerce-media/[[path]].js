import { errorResponse } from "../_shared/auth-core.js";
import { commerceMediaResponse } from "../_shared/commerce-media.js";

export async function onRequest({ request, env }) {
  try { return await commerceMediaResponse(request, env); }
  catch (error) { return errorResponse(error, request, env); }
}
