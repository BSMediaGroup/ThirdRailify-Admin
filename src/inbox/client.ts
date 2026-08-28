export type InboxMessage = {
  id: string; category: string; sourceType: string; sourceId: string; title: string; preview: string;
  body: string; actionUrl: string | null; actionLabel: string | null; createdAt: string;
  resolvedAt: string | null; readAt: string | null; unread: boolean;
};

export type InboxSummary = {
  ok: true;
  unread: number;
  actionable: { goats: { submissions: number; comments: number; emailFailures: number; total: number }; total: number };
  latest: InboxMessage[];
};

export async function getInboxSummary() { return request<InboxSummary>("/api/admin/inbox/summary"); }
export async function getInboxMessages(unread = false) { return request<{ ok: true; items: InboxMessage[]; total: number }>(`/api/admin/inbox?unread=${unread}`); }
export async function markInboxRead(id: string, csrfToken: string) { return request<{ ok: true }>(`/api/admin/inbox/${encodeURIComponent(id)}/read`, "POST", {}, csrfToken); }
export async function markAllInboxRead(csrfToken: string) { return request<{ ok: true }>("/api/admin/inbox/read-all", "POST", {}, csrfToken); }

async function request<T>(url: string, method = "GET", body?: Record<string, unknown>, csrfToken = "") {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(url, { method, credentials: "include", headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const payload = await response.json().catch(() => null) as (T & { message?: string }) | null;
  if (!response.ok || !payload) throw new Error(payload?.message || "The Admin inbox is unavailable.");
  return payload;
}
