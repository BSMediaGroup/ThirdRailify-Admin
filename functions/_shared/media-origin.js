import { normalizeOrigin } from "./auth-core.js";

const PUBLIC_MEDIA_PATHS = [
  /^\/commerce-media\/[a-f0-9]{64}\.(?:jpg|png|webp)$/,
  /^\/u\/[a-f0-9]{20}\/avatar\/[a-f0-9]{64}\.(?:jpg|png|webp)$/,
  /^\/poll-media\/[a-f0-9-]{16,80}$/,
];

export function publicMediaOrigin(env) {
  return normalizeOrigin(env?.THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN)
    || normalizeOrigin(env?.THIRDRAILIFY_PROFILE_MEDIA_ORIGIN)
    || normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN);
}

export function publicMediaUrl(env, pathname) {
  const origin = publicMediaOrigin(env);
  return origin?.startsWith("https://") && String(pathname || "").startsWith("/") ? `${origin}${pathname}` : null;
}

export function isPublicMediaPath(pathname) {
  return PUBLIC_MEDIA_PATHS.some((pattern) => pattern.test(String(pathname || "")));
}

export function canonicalPublicMediaUrl(value, env) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { return value; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return value;
  const trusted = new Set(["admin.thirdrailify.com", "thirdrailify-admin.pages.dev", "cdn.thirdrailify.com"]);
  if (!trusted.has(url.hostname.toLowerCase()) || !isPublicMediaPath(url.pathname)) return value;
  return publicMediaUrl(env, url.pathname) || value;
}
