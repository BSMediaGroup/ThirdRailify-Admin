const OLD_ADMIN_HOST = "thirdrailify-admin.pages.dev";
const ADMIN_ORIGIN = "https://admin.thirdrailify.com";
const MEDIA_ORIGIN = "https://cdn.thirdrailify.com";
const PUBLIC_MEDIA_PATH = /^(?:\/commerce-media\/[a-f0-9]{64}\.(?:jpg|png|webp)|\/u\/[a-f0-9]{20}\/avatar\/[a-f0-9]{64}\.(?:jpg|png|webp))$/;

export function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return context.next();
  const url = new URL(request.url);
  if (context.env?.THIRDRAILIFY_DOMAIN_CUTOVER_ACTIVE === "true" && PUBLIC_MEDIA_PATH.test(url.pathname) && new Set([OLD_ADMIN_HOST, "admin.thirdrailify.com"]).has(url.hostname)) {
    const location = new URL(url.pathname, context.env?.THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN || MEDIA_ORIGIN);
    return new Response(null, { status: 301, headers: { Location: location.href, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  }
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
