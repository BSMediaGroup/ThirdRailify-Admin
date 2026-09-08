// Mirrored verbatim in Admin. Values only; no CSS, URLs or mechanics RNG.
export const FEATURE_COMPONENTS = Object.freeze(['preset', 'fill', 'icons', 'edge', 'effects']);
export const FEATURE_ICONS = Object.freeze(['star', 'medallion', 'incoming', 'lightning', 'gift', 'coin', 'burst']);
export const FEATURE_EFFECTS = Object.freeze(['sparkles', 'shine', 'dazzle', 'pulse']);
export const FEATURE_PRESETS = Object.freeze({
  subscriber: { label: 'Subscriber · crimson', components: { preset: 'subscriber', fill: { colors: ['#690E27', '#EF3654'] }, icons: ['star'], edge: { color: '#FF9AAA', placement: 'outer' } } },
  raid: { label: 'Raid · emerald', components: { preset: 'raid', fill: { colors: ['#075B43', '#9ADC39'] }, icons: ['incoming'], edge: { color: '#BDFA78', placement: 'outer' } } },
  gift: { label: 'Gift · violet', components: { preset: 'gift', fill: { colors: ['#492079', '#DB41D3'] }, icons: ['gift'], edge: { color: '#F4ABFF', placement: 'outer' } } },
  rant: { label: 'Rant · gold', components: { preset: 'rant', fill: { colors: ['#88500D', '#FFC64E'] }, icons: ['coin'], edge: { color: '#FFE7A0', placement: 'outer' } } },
});
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const object = v => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const fail = () => { throw new Error('Choose supported entrant appearance values, hex colours and bounded effect settings.'); };
const keys = (v, allowed) => { if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) fail(); };
const hex = v => { if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) fail(); return v.toUpperCase(); };
const bounded = (v, lo, hi) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fail(); return v; };
export function normalizeFeatureComponents(value) {
  keys(value, FEATURE_COMPONENTS); const result = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null) { result[key] = null; continue; }
    if (key === 'preset') { if (!own(FEATURE_PRESETS, v)) fail(); result[key] = v; }
    if (key === 'fill') { keys(v, ['colors']); if (!Array.isArray(v.colors) || v.colors.length !== 2) fail(); result[key] = { colors: v.colors.map(hex) }; }
    if (key === 'icons') { if (!Array.isArray(v) || v.length > 2 || new Set(v).size !== v.length || v.some(x => !FEATURE_ICONS.includes(x))) fail(); result[key] = [...v]; }
    if (key === 'edge') { keys(v, ['color', 'placement']); if (!['inner', 'outer', 'both'].includes(v.placement)) fail(); result[key] = { color: hex(v.color), placement: v.placement }; }
    if (key === 'effects') { keys(v, ['kinds', 'intensity', 'speed', 'density']); if (!Array.isArray(v.kinds) || v.kinds.length > 4 || new Set(v.kinds).size !== v.kinds.length || v.kinds.some(x => !FEATURE_EFFECTS.includes(x))) fail(); result[key] = { kinds: [...v.kinds], intensity: bounded(v.intensity, .1, .6), speed: bounded(v.speed, .5, 1.5), density: bounded(v.density, 1, 4) }; }
  }
  return result;
}
export function normalizeAppearance(value) {
  if (value == null) return null;
  keys(value, ['version', 'manual', 'automatic']); if (value.version !== 1) fail();
  const result = { version: 1, manual: normalizeFeatureComponents(value.manual || {}) };
  if (value.automatic) {
    keys(value.automatic, FEATURE_COMPONENTS); result.automatic = {};
    for (const [key, item] of Object.entries(value.automatic)) {
      keys(item, ['value', 'source', 'at', 'key']);
      const normalized = normalizeFeatureComponents({ [key]: item.value });
      if (item.at !== undefined && (typeof item.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.at) || !Number.isFinite(Date.parse(item.at)))) fail();
      if (item.key !== undefined && (typeof item.key !== 'string' || !/^[a-f0-9]{64}$/.test(item.key))) fail();
      result.automatic[key] = { value: normalized[key], source: 'automation', ...(item.at ? { at: item.at, key: item.key } : {}) };
    }
  }
  return result;
}
export function effectiveAppearance(entry) {
  const a = entry?.appearance; const result = {}, sources = {};
  for (const key of FEATURE_COMPONENTS) {
    if (own(a?.manual, key)) { result[key] = a.manual[key]; sources[key] = 'manual'; }
    else if (key === 'fill' && (entry?.style || entry?.colour)) { sources[key] = 'manual'; }
    else if (own(a?.automatic, key)) { result[key] = a.automatic[key].value; sources[key] = 'automatic'; }
    else sources[key] = 'wheel';
  }
  return { ...result, sources };
}
export function publicAppearance(value) {
  const a = normalizeAppearance(value); if (!a) return null;
  if (a.automatic) for (const key of Object.keys(a.automatic)) a.automatic[key] = { value: a.automatic[key].value, source: 'automation' };
  return a;
}
export function portableAppearance(entry) {
  if (!entry.appearance) return undefined;
  const effective = effectiveAppearance(entry);
  const components = Object.fromEntries(FEATURE_COMPONENTS.filter(k => Object.hasOwn(effective, k)).map(k => [k, effective[k]]));
  return { version: 1, manual: normalizeFeatureComponents(components) };
}
export function applyAutomaticAppearance(previous, components, event, eventKey) {
  if (!components) return previous;
  // Decoration carries no badge claim. Subscriber automation requires positive paid evidence.
  if (event.eventType === 'rumble.subscribe' && !(event.evidence?.amountCents > 0)) return previous;
  const a = normalizeAppearance(previous) || { version: 1, manual: {} };
  const automatic = { ...a.automatic }; const at = new Date(event.providerEventAt).toISOString();
  for (const [key, value] of Object.entries(normalizeFeatureComponents(components))) {
    const prior = automatic[key];
    if (!prior?.at || at > prior.at || (at === prior.at && eventKey > prior.key)) automatic[key] = { value, source: 'automation', at, key: eventKey };
  }
  return { ...a, automatic };
}
