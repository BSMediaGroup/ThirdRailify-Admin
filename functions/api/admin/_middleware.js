const SOURCES = new Map([
  ['/api/admin/status', 'status'], ['/api/admin/analytics', 'analytics'],
  ['/api/admin/commerce/overview', 'commerce'], ['/api/admin/watch', 'watch'],
  ['/api/admin/goats/overview', 'goats'], ['/api/admin/banner', 'banner'],
  ['/api/admin/automations', 'automations'],
]);

// Existing route handlers retain authentication, authorization and error bodies.
// No request/response payload, account identifier, SQL or credential is logged here.
export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  const component = SOURCES.get(path);
  if (!component || !['GET', 'POST'].includes(context.request.method)) return context.next();
  const reference = crypto.randomUUID(); const start = Date.now();
  try {
    const original = await context.next();
    const response = new Response(original.body, original);
    response.headers.set('X-Overview-Reference', reference);
    response.headers.set('Cache-Control', 'no-store');
    if (!response.ok) console.warn(JSON.stringify({event:'overview_source_check',component,operation:context.request.method,reference,status:response.status,code:'http_error',durationMs:Date.now()-start}));
    return response;
  } catch {
    console.error(JSON.stringify({event:'overview_source_check',component,operation:context.request.method,reference,code:'unexpected_internal_failure',durationMs:Date.now()-start}));
    return Response.json({ok:false,error:'unexpected_internal_failure',message:'The check could not be completed.'},{status:500,headers:{'Cache-Control':'no-store','X-Overview-Reference':reference}});
  }
}
