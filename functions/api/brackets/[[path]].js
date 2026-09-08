import { errorResponse } from '../../_shared/auth-core.js';
import { publicBrackets, bracketMedia } from '../../_shared/brackets-core.js';
export async function onRequest({ request, env }) {
  try {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname.replace(/^\/api\/brackets\/?/, '');
    if (path.startsWith('media/')) return bracketMedia(env, path.slice(6));
    return Response.json(await publicBrackets(env, path), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return errorResponse(e, request, env); }
}
