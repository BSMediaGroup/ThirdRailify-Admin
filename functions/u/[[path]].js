import { errorResponse } from "../_shared/auth-core.js";
import { profileMediaResponse } from "../_shared/profile-media.js";

export async function onRequest({ request, env }) {
  try {
    return await profileMediaResponse(request, env);
  } catch (error) {
    return errorResponse(error, request, env);
  }
}
