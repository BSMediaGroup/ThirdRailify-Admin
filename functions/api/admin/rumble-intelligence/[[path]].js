import { AuthFailure, errorResponse, jsonResponse, normalizeOrigin, requireCsrf } from '../../../_shared/auth-core.js';
import { requireAdminCapability } from '../../../_shared/admin-capabilities.js';
import { readPollJson } from '../../../_shared/polls-core.js';
import { PRIMARY_SOURCE, hash, ingestIntelligence, intelligencePerson, intelligenceReport, projectProvider, validateObservation } from '../../../_shared/rumble-intelligence.js';

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/admin\/rumble-intelligence\/?/, '').replace(/\/$/, '');
    const origin = request.headers.get('origin');
    if ((origin || request.method !== 'GET') && normalizeOrigin(origin) !== normalizeOrigin(env.THIRDRAILIFY_ADMIN_ORIGIN)) throw new AuthFailure(403, 'origin_not_allowed', 'Admin origin required.');
    if (request.method === 'GET' && (!path || path === 'person')) {
      await requireAdminCapability(env, request, 'rumble_intelligence.view');
      if (path === 'person') return response(await intelligencePerson(env, url.searchParams.get('source') || PRIMARY_SOURCE, url.searchParams.get('name')));
      return response(await intelligenceReport(env, url.searchParams.get('source') || PRIMARY_SOURCE));
    }
    if (request.method === 'POST' && ['import/preview', 'import/commit'].includes(path)) {
      const session = await requireAdminCapability(env, request, 'rumble_intelligence.manage');
      await requireCsrf(request, session);
      const { body } = await readPollJson(request, 2 * 1024 * 1024);
      const projected = projectProvider(body.snapshot);
      if (projected.source !== PRIMARY_SOURCE) throw new AuthFailure(400, 'import_source_mismatch', 'This import accepts ThirdRailify only. Keep other sources separate.');
      const v = await validateObservation(projected, 'historical');
      const previewFingerprint = await hash(['import-preview-v1', v.id, v.setId, v.metadata]);
      if (path === 'import/preview') return response({ ok: true, observationId: v.id, previewFingerprint, source: v.source, providerAt: v.providerAt, qualified: v.qualified, metadata: v.metadata });
      if (body.observationId !== v.id || body.previewFingerprint !== previewFingerprint) throw new AuthFailure(409, 'import_preview_required', 'Preview this exact snapshot before committing.');
      return response(await ingestIntelligence(env, projected, { provenance: 'historical', accountId: session.accountId }));
    }
    throw new AuthFailure(404, 'intelligence_route_not_found', 'Unknown subscriber report route.');
  } catch (error) { return errorResponse(error, request, env); }
}
function response(value) { return jsonResponse(value, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
