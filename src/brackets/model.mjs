export const FORMAT = 'thirdrailify-bracket-v1';
export const uid = (prefix = 'id') => `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value, max) => String(value ?? '').trim().slice(0, max);

export function generate(size = 16, title = 'Untitled season') {
  check([4, 8, 16, 32, 64].includes(size), 'Choose 4, 8, 16, 32 or 64 slots.');
  const rounds = [];
  for (let r = 0; r < Math.log2(size); r++) {
    rounds[r] = Array.from({ length: size / 2 ** (r + 1) }, (_, position) => ({
      id: uid('match'), round: r, position, notes: '', description: '',
      slots: [0, 1].map(side => ({ id: uid('slot'), kind: r ? 'winner' : 'placeholder', ref: r ? rounds[r - 1][position * 2 + side].id : null })),
    }));
  }
  return { format: FORMAT, title, size, contenders: [], matches: rounds.flat(), presentation: { title, slug: '', season: '', intro: '', description: '', accent: '#efc65c', feature: null, cover: null } };
}

export function validate(input) {
  check(input?.format === FORMAT, 'Unsupported bracket format.');
  check([4, 8, 16, 32, 64].includes(input.size), 'Unsupported bracket size.');
  check(Array.isArray(input.contenders) && input.contenders.length <= 256, 'Keep the bench below 257 contenders.');
  check(Array.isArray(input.matches) && input.matches.length === input.size - 1, 'A single elimination tree must have one fewer matches than slots.');
  const ids = new Set();
  const identity = id => { check(typeof id === 'string' && /^[a-zA-Z0-9_-]{8,90}$/.test(id) && !ids.has(id), 'IDs must be valid and unique.'); ids.add(id); return id; };
  const contenders = input.contenders.map(c => ({ id: identity(c.id), name: text(c.name, 160), seed: c.seed == null || c.seed === '' ? null : Number(c.seed), description: text(c.description, 1000), notes: text(c.notes, 4000), tags: text(c.tags, 300), image: c.image || null }));
  const seeds = new Set();
  for (const c of contenders) { check(c.name.length > 0, 'Every contender needs a name.'); if (c.seed !== null) { check(Number.isInteger(c.seed) && c.seed >= 1 && c.seed <= input.size && !seeds.has(c.seed), 'Seeds must be distinct and within the field size.'); seeds.add(c.seed); } }
  const matches = input.matches.map(m => ({ id: identity(m.id), round: m.round, position: m.position, notes: text(m.notes, 4000), description: text(m.description, 1000), slots: Array.isArray(m.slots) ? m.slots.map(s => ({ id: identity(s.id), kind: s.kind, ref: s.ref || null })) : [] }));
  const positions = new Set(), placed = new Set(), upstream = new Set();
  for (const m of matches) {
    check(Number.isInteger(m.round) && m.round >= 0 && m.round < Math.log2(input.size), 'Invalid round.');
    check(Number.isInteger(m.position) && m.position >= 0 && m.position < input.size / 2 ** (m.round + 1), 'Invalid match position.');
    const key = `${m.round}:${m.position}`; check(!positions.has(key), 'Duplicate match position.'); positions.add(key);
    check(m.slots.length === 2, 'Each match needs two input slots.');
    for (const [side, s] of m.slots.entries()) {
      if (m.round === 0) {
        check(['contender', 'bye', 'placeholder'].includes(s.kind), 'Starting slots require a contender, explicit bye or placeholder.');
        if (s.kind === 'contender') { check(contenders.some(c => c.id === s.ref) && !placed.has(s.ref), 'A starting contender must exist and may be placed only once.'); placed.add(s.ref); }
        else check(s.ref === null, 'Empty slots cannot reference a contender.');
      } else {
        const source = matches.find(x => x.id === s.ref);
        check(s.kind === 'winner' && source?.round === m.round - 1 && source.position === m.position * 2 + side && !upstream.has(s.ref), 'Winner slots must follow the preceding round exactly once.'); upstream.add(s.ref);
      }
    }
    check(!m.slots.every(s => s.kind === 'bye'), 'A match cannot contain two byes.');
  }
  const p = input.presentation || {};
  check(/^#[a-f0-9]{6}$/i.test(p.accent || '#efc65c'), 'Choose a six-digit accent colour.');
  for (const asset of [...contenders.map(c => c.image), p.feature, p.cover]) check(!asset || /^[a-zA-Z0-9_-]{8,90}$/.test(asset), 'Artwork must use a saved asset reference.');
  return { format: FORMAT, size: input.size, title: text(input.title, 140) || 'Untitled season', contenders, matches, presentation: { title: text(p.title, 140), slug: text(p.slug, 80), season: text(p.season, 160), intro: text(p.intro, 500), description: text(p.description, 4000), accent: p.accent || '#efc65c', feature: p.feature || null, cover: p.cover || null } };
}

export function opponents(graph, match, decisions = []) {
  return match.slots.map(s => {
    const id = s.kind === 'contender' ? s.ref : s.kind === 'winner' ? decisions.find(d => d.matchId === s.ref)?.winnerId : null;
    return graph.contenders.find(c => c.id === id) || null;
  });
}
export function descendants(graph, id) {
  const found = [];
  for (let cursor = id; cursor;) { const next = graph.matches.find(m => m.slots.some(s => s.kind === 'winner' && s.ref === cursor)); if (!next) break; found.push(next.id); cursor = next.id; }
  return found;
}
export function safeGraph(graph) {
  const used = new Set(graph.matches.flatMap(m => m.slots.filter(s => s.kind === 'contender').map(s => s.ref)));
  return { ...graph, title: graph.presentation.title, contenders: graph.contenders.filter(c => used.has(c.id)).map(({ id, name, seed, description, image }) => ({ id, name, seed, description, image })), matches: graph.matches.map(({ id, round, position, slots, description }) => ({ id, round, position, slots, description })) };
}
export function duplicate(input) {
  const graph = validate(input), map = new Map();
  for (const value of [...graph.contenders, ...graph.matches, ...graph.matches.flatMap(m => m.slots)]) map.set(value.id, uid('copy'));
  return validate({ ...graph, title: `${graph.title} (copy)`, presentation: { ...graph.presentation, slug: '' }, contenders: graph.contenders.map(c => ({ ...c, id: map.get(c.id), image: null })), matches: graph.matches.map(m => ({ ...m, id: map.get(m.id), slots: m.slots.map(s => ({ ...s, id: map.get(s.id), ref: map.get(s.ref) || null })) })) });
}
export function referenceTemplate() {
  const rows = [
    [1, 'Batman: The Animated Series', 32], [16, 'Johnny Bravo', 20],
    [9, 'Spider-Man: The Animated Series', 102], [8, 'Gargoyles', 99],
    [5, 'Rugrats', 20], [12, 'Doug', 11],
    [13, 'Rocko’s Modern Life', 13], [4, 'Hey Arnold!', 4],
    [3, 'Animaniacs', 40], [14, 'CatDog', 20],
    [11, 'Dexter’s Laboratory', 11], [6, 'The Powerpuff Girls', 14],
    [7, 'Courage the Cowardly Dog', 15], [10, 'Aaahh!!! Real Monsters', 8],
    [15, 'X-Men: The Animated Series', null], [2, 'The Angry Beavers', null],
  ];
  const graph = generate(16, 'Reference sample — private historical draft');
  graph.contenders = rows.map(([seed, name]) => ({ id: uid('contender'), seed, name, notes: '', tags: '', description: '', image: null }));
  graph.matches.filter(m => m.round === 0).forEach((m, i) => { m.slots.forEach((s, j) => { s.kind = 'contender'; s.ref = graph.contenders[i * 2 + j].id; }); });
  const historical = graph.matches.filter(m => m.round === 0).slice(0, 7).map((m, i) => ({ matchId: m.id, winnerId: graph.contenders[i * 2 + (i === 5 ? 1 : 0)].id, scores: rows.slice(i * 2, i * 2 + 2).map(r => r[2]), source: 'historical', reason: 'Transcribed from the supplied TRO sample bracket; historical manual result, not Poll votes.' }));
  return { graph: validate(graph), historical };
}
