import { AuthFailure, errorResponse, requireCsrf, normalizeOrigin } from '../../../_shared/auth-core.js';
import { requireAdminCapability } from '../../../_shared/admin-capabilities.js';
import { readPollJson } from '../../../_shared/polls-core.js';
import { bracketLibrary, adminBracket, createBracket, mutateBracket, pollPicker, correctionPreview, uploadBracketMedia, bracketMedia, createMatchPoll } from '../../../_shared/brackets-core.js';

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url), parts = url.pathname.replace(/^\/api\/admin\/brackets\/?/, '').split('/').filter(Boolean);
    const session = await requireAdminCapability(env, request, request.method === 'GET' ? 'polls.view' : 'polls.manage');
    let payload;
    if (request.method === 'GET') {
      if (!parts.length) payload = await bracketLibrary(env, url.searchParams.get('search'), url.searchParams.get('archived') === 'true');
      else if (parts[0] === 'poll-picker') payload = await pollPicker(env, session.accountId, url.searchParams.get('search'), url.searchParams.get('page'));
      else if (parts[0] === 'media') return bracketMedia(env, parts[1], true);
      else if (parts[1] === 'correction') payload = await correctionPreview(env, parts[0], url.searchParams.get('matchId'), session.accountId);
      else if (parts.length === 1) payload = await adminBracket(env, parts[0], session.accountId);
      else throw new AuthFailure(404, 'bracket_route_missing', 'This route was not found.');
    } else if (request.method === 'POST') {
      if (normalizeOrigin(request.headers.get('origin')) !== normalizeOrigin(env.THIRDRAILIFY_ADMIN_ORIGIN)) throw new AuthFailure(403, 'origin_not_allowed', 'Use the same-origin Admin workspace.');
      await requireCsrf(request, session);
      if (parts[1] === 'media') {
        const raw = await request.arrayBuffer(); if (raw.byteLength > 9 * 1024 * 1024) throw new AuthFailure(413, 'image_too_large', 'Choose an image below 8 MB.');
        const form = await new Request(request.url, { method: 'POST', headers: request.headers, body: raw }).formData(), file = form.get('image');
        if (!file || typeof file === 'string') throw new AuthFailure(400, 'image_required', 'Choose an image.');
        payload = await uploadBracketMedia(env, parts[0], session.accountId, await file.arrayBuffer(), file.type);
      } else {
        const { body } = await readPollJson(request, 256 * 1024);
        if (parts[0] === 'create') payload = await createBracket(env, session.accountId, body);
        else if (parts[1] === 'create-poll') payload = await createMatchPoll(env, parts[0], session.accountId, body);
        else if (parts.length === 1) payload = await mutateBracket(env, parts[0], session.accountId, body);
        else throw new AuthFailure(404, 'bracket_route_missing', 'This route was not found.');
      }
    } else throw new AuthFailure(405, 'method_not_allowed', 'Use GET or POST.');
    return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return errorResponse(e instanceof AuthFailure ? e : new AuthFailure(400, 'bracket_invalid', e.message || 'The bracket could not be saved.'), request, env); }
}
