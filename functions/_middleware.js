const OLD_ADMIN_HOST = "thirdrailify-admin.pages.dev";
const ADMIN_ORIGIN = "https://admin.thirdrailify.com";

export function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return context.next();
  const url = new URL(request.url);
  if (context.env?.THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE !== "true" || url.hostname !== OLD_ADMIN_HOST || url.pathname.startsWith("/api/")) {
    return context.next();
  }
  const location = new URL(`${url.pathname}${url.search}`, ADMIN_ORIGIN);
  return new Response(null, {
    status: 301,
    headers: {
      Location: location.href,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
