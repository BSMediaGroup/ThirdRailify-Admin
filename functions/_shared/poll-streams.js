import { AuthFailure } from './auth-core.js';

export function rumbleStreamUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' || !['rumble.com', 'www.rumble.com'].includes(url.hostname) || url.port || url.username || url.password || !/^\/(?:v[a-z0-9]+(?:-[^/]+)?(?:\.html)?|embed\/v[a-z0-9]+\/?)$/i.test(url.pathname) || url.href.length > 2000) return null;
    url.hostname = 'rumble.com'; url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

export function validateStreamUrl(value) {
  if (value === '' || value === null || value === undefined) return null;
  const url = rumbleStreamUrl(value);
  if (!url) throw new AuthFailure(400, 'poll_stream_url_invalid', 'Enter an HTTPS Rumble video or stream link.');
  return url;
}

export async function detectedPollStreams(env, pollId) {
  const db = env.THIRDRAILIFY_COMMERCE_DB;
  const evidence = await db.prepare(`SELECT DISTINCT livestream_id FROM poll_rumble_event_fingerprints WHERE poll_id=?
    UNION SELECT DISTINCT livestream_id FROM poll_credit_lots WHERE poll_id=? AND committed>0 AND livestream_id IS NOT NULL LIMIT 100`).bind(pollId, pollId).all();
  const ids = new Set((evidence.results || []).map(row => String(row.livestream_id)));
  if (!ids.size) return { ok: true, items: [], message: 'No Rumble votes have been detected for this Poll yet. You can enter a link manually.' };
  const origin = new URL(env.THIRDRAILIFY_PUBLIC_ORIGIN).origin;
  const responses = await Promise.allSettled(['/api/watch', '/api/watch/episodes'].map(async path => {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Watch feed unavailable');
    const text = await response.text(); if (text.length > 2_000_000) throw new Error('Watch feed too large');
    return JSON.parse(text);
  }));
  const matches = new Map();
  for (const result of responses) {
    if (result.status !== 'fulfilled') continue;
    const data = result.value;
    const candidates = [...(Array.isArray(data.items) ? data.items : []), ...(Array.isArray(data.liveNow) ? data.liveNow : []), data.primary, data.latest, data.upcoming];
    for (const item of candidates.slice(0, 100)) {
      if (item?.platform !== 'rumble') continue;
      const url = rumbleStreamUrl(item.watchUrl);
      const embed = rumbleStreamUrl(item.embedUrl);
      const streamId = embed?.match(/\/embed\/v([a-z0-9]+)\/?$/i)?.[1] || String(item.contentId || '');
      if (url && ids.has(streamId)) matches.set(url, { url, title: String(item.title || 'Detected Rumble stream').slice(0, 240) });
    }
  }
  return { ok: true, items: [...matches.values()], message: matches.size ? 'Choose a stream detected from this Poll?s votes, then save.' : 'Votes were detected, but their stream link is not in the Watch feed or archive. Enter the link manually.' };
}
