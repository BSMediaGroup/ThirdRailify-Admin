const inFlight = new Map<string, Promise<unknown>>();

export function coordinatedJsonGet<T>(url: string, nonJsonMessage: string, fallbackMessage: string): Promise<T> {
  const existing = inFlight.get(url);
  if (existing) return existing as Promise<T>;
  const pending = fetch(url, { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } })
    .then(async response => {
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(nonJsonMessage);
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || fallbackMessage);
      return body as T;
    })
    .finally(() => { if (inFlight.get(url) === pending) inFlight.delete(url); });
  inFlight.set(url, pending);
  return pending;
}
