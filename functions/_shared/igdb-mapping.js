export function normalizeIgdbUrl(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    // IGDB uses repeated hyphens for legitimate duplicate-slug suffixes (e.g. --1).
    if (url.protocol !== "https:" || url.hostname !== "www.igdb.com" || url.username || url.password || url.port || url.search || url.hash || !/^\/games\/[a-z0-9]+(?:-+[a-z0-9]+)*\/?$/.test(url.pathname)) return null;
    return url.toString();
  } catch { return null; }
}

export function normalizeIgdbId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value ?? "");
  return /^[1-9]\d{0,11}$/.test(id) ? id : null;
}
