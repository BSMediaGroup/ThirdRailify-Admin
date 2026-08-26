import { AuthClientError, type AuthConfig, type SessionPayload } from "./types";

const OAUTH_ORIGINS = new Set(["https://discord.com", "https://accounts.google.com", "https://github.com", "https://x.com"]);

export async function fetchAuthConfig() {
  return fetchJson<AuthConfig>("/api/auth/config", { method: "GET", credentials: "include" });
}
export async function fetchSession() {
  return fetchJson<SessionPayload>("/api/auth/session", { method: "GET", credentials: "include" });
}
export async function submitAuth(path: string, body: Record<string, unknown>) {
  return fetchJson<SessionPayload & { authorizationUrl?: string }>(`/api/auth/${path}`, {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
export async function endSession(csrfToken: string) {
  return fetchJson<SessionPayload>("/api/auth/logout", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: "{}",
  });
}
export function validatedAuthorizationUrl(value: string) {
  const url = new URL(value);
  if (!OAUTH_ORIGINS.has(url.origin) || url.protocol !== "https:") throw new AuthClientError(502, "oauth_url_invalid", "The provider returned an invalid authorization URL.");
  return url.toString();
}
export async function adminApi<T>(path: string, init: RequestInit = {}) {
  return fetchJson<T>(path, { ...init, credentials: "include", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) } });
}
async function fetchJson<T>(input: RequestInfo | URL, init: RequestInit) {
  const response = await fetch(input, { ...init, cache: "no-store", redirect: "error" });
  const payload = await response.json().catch(() => null) as (T & { error?: string; message?: string }) | null;
  if (!response.ok || !payload) throw new AuthClientError(response.status, payload?.error || "auth_unavailable", payload?.message || "The account service is unavailable.");
  return payload;
}
