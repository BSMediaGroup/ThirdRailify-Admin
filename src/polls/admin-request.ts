import { fetchWithReadRetry } from './read-retry';
export async function pollAdminRequest<T>(path: string, csrf = '', body?: unknown): Promise<T> {
  const response = await fetchWithReadRetry(path, { credentials: 'include', cache: 'no-store', method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.message || 'Poll authority is unavailable.');
  return payload;
}
