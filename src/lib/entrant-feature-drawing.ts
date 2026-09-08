import { effectiveAppearance, type FeatureComponents, type FeatureIcon } from './entrant-appearance.mjs';

// Curated vector primitives in the same 24-unit coordinate system as site icons.
export const FEATURE_PATHS: Record<FeatureIcon, string> = {
  star: 'M12 2 15 8.5 22 9.5 17 14.5 18.2 22 12 18.5 5.8 22 7 14.5 2 9.5 9 8.5Z',
  medallion: 'M12 2A8 8 0 1 1 11.99 2 M7 17 5 23 12 20 19 23 17 17 M12 6 14 10 18 11 15 14 16 18 12 16 8 18 9 14 6 11 10 10Z',
  incoming: 'M3 3 11 11 7 11 7 14 16 14 16 5 13 5 13 9 5 1Z M3 19 21 19 21 23 3 23Z',
  lightning: 'M14 1 3 14 10 14 8 23 21 9 14 9Z',
  gift: 'M3 10 21 10 21 22 3 22Z M1 6 23 6 23 10 1 10Z M12 6C4 6 4 0 8 1C11 1 12 6 12 6C12 6 13 1 16 1C20 0 20 6 12 6 M12 6 12 22',
  coin: 'M12 2A10 10 0 1 1 11.99 2 M12 5 12 19 M16 7H10C6 7 6 12 11 12H13C18 12 18 17 13 17H8',
  burst: 'M12 1 15 7 21 3 18 10 24 12 18 15 21 22 14 18 12 24 9 18 2 22 6 15 0 12 6 9 3 2 10 6Z',
};
export function wedgePath(start: number, end: number, radius: number, inner: number) {
  const path = new Path2D(); path.arc(0, 0, radius, start - Math.PI / 2, end - Math.PI / 2); path.arc(0, 0, inner, end - Math.PI / 2, start - Math.PI / 2, true); path.closePath(); return path;
}
export function drawFeatureFill(ctx: CanvasRenderingContext2D, feature: FeatureComponents, start: number, end: number, radius: number, inner: number) {
  if (!feature.fill) return;
  const mid = (start + end) / 2 - Math.PI / 2;
  const gradient = ctx.createLinearGradient(Math.cos(mid) * inner, Math.sin(mid) * inner, Math.cos(mid) * radius, Math.sin(mid) * radius);
  gradient.addColorStop(0, feature.fill.colors[0]); gradient.addColorStop(.65, feature.fill.colors[1]); gradient.addColorStop(1, feature.fill.colors[0]);
  ctx.fillStyle = gradient; ctx.fill(wedgePath(start, end, radius, inner));
}
export function featureGlyphLayout(feature: FeatureComponents, start: number, end: number, radius: number, inner: number) {
  const icons = feature.icons || []; if (!icons.length) return null;
  const span = end - start;
  const size = Math.min(26, Math.max(12, radius * .09), 2 * (inner + radius * .1) * Math.sin(Math.min(Math.PI, span) / 2) / 1.35);
  if (size < 12) return null;
  const first = inner + size * .75 + 4;
  const positions = icons.map((icon, index) => ({ icon, radius: first + index * (size + 5) }));
  const textStart = positions[positions.length - 1].radius + size / 2 + 7;
  if (textStart > radius * .85) return null;
  return { size, positions, textStart };
}
export function fitFeatureLabel(text: string, maxWidth: number, measure: (text: string) => number) {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (measure(singleLine) <= maxWidth) return singleLine;
  if (measure('…') > maxWidth) return '';
  const characters = Array.from(singleLine); let low = 0, high = characters.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (measure(characters.slice(0, mid).join('') + '…') <= maxWidth) low = mid; else high = mid - 1; }
  return characters.slice(0, low).join('').trimEnd() + '…';
}
export function drawFeatureMarks(ctx: CanvasRenderingContext2D, feature: FeatureComponents, start: number, end: number, radius: number, inner: number) {
  if (!feature.edge && !feature.icons?.length && !feature.effects?.kinds.length) return null;
  ctx.save(); ctx.clip(wedgePath(start, end, radius - 1, inner + 1));
  if (feature.edge) {
    ctx.strokeStyle = feature.edge.color; ctx.lineWidth = Math.max(2, radius * .012);
    for (const r of feature.edge.placement === 'both' ? [radius * .96, inner * 1.12] : [feature.edge.placement === 'inner' ? inner * 1.12 : radius * .96]) { ctx.beginPath(); ctx.arc(0, 0, r, start - Math.PI / 2, end - Math.PI / 2); ctx.stroke(); }
  }
  // Glyphs and text share one radial baseline. Text is truncated into the remaining width.
  const layout = featureGlyphLayout(feature, start, end, radius, inner);
  if (layout) for (const { icon, radius: glyphRadius } of layout.positions) {
    const angle = (start + end) / 2 - Math.PI / 2;
    ctx.save(); ctx.translate(Math.cos(angle) * glyphRadius, Math.sin(angle) * glyphRadius); ctx.rotate(angle); ctx.scale(layout.size / 24, layout.size / 24); ctx.translate(-12, -12);
    ctx.fillStyle = '#FFF2D3'; ctx.strokeStyle = '#211325'; ctx.lineWidth = 1.2; const glyph = new Path2D(FEATURE_PATHS[icon]); ctx.fill(glyph, 'evenodd'); ctx.stroke(glyph); ctx.restore();
  }
  ctx.restore();
  return layout;
}
type Segment = { entry: { id: string; appearance?: Parameters<typeof effectiveAppearance>[0]['appearance']; style?: unknown; colour?: string | null }; start: number; end: number };
export function buildFeatureEffects(segments: readonly Segment[], radius: number, inner: number) {
  return segments.map(segment => {
    const feature = effectiveAppearance(segment.entry); const fx = feature.effects;
    if (!fx?.kinds.length) return null;
    const seed = [...segment.entry.id].reduce((s, c) => (Math.imul(s, 31) + c.charCodeAt(0)) >>> 0, 2166136261);
    const span = segment.end - segment.start;
    // Aggregate particles follow angular area, bounded across the entire Wheel.
    const count = Math.min(12, Math.floor(span / (Math.PI * 2) * 48 * fx.density / 4));
    return { id: segment.entry.id, fx, seed, span, start: segment.start, path: wedgePath(segment.start, segment.end, radius * .96, inner * 1.12), count };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
}
export function drawFeatureEffects(ctx: CanvasRenderingContext2D, items: ReturnType<typeof buildFeatureEffects>, radius: number, inner: number, time: number, reduced: boolean) {
  for (const item of items) {
    const { fx, seed, start, span, path, count } = item; const phase = reduced ? 1 : time / 1000 * fx.speed + (seed % 1000) / 97;
    ctx.save(); ctx.clip(path);
    if (fx.kinds.includes('pulse')) { ctx.globalAlpha = fx.intensity * (.07 + .035 * Math.sin(phase * 1.2)); ctx.fillStyle = '#FFF7DF'; ctx.fill(path); }
    if (fx.kinds.includes('shine')) {
      const angle = start - Math.PI / 2 + span * ((Math.sin(phase * .4) + 1) / 2); const x = Math.cos(angle) * radius * .7, y = Math.sin(angle) * radius * .7;
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius * .27); g.addColorStop(0, '#FFF7DE'); g.addColorStop(1, '#FFF7DE00'); ctx.globalAlpha = fx.intensity * .28; ctx.fillStyle = g; ctx.fill(path);
    }
    if (fx.kinds.includes('sparkles') || fx.kinds.includes('dazzle')) for (let n = 0; n < count; n++) {
      const unit = ((seed + n * 2654435761) >>> 0) / 4294967296; const angle = start - Math.PI / 2 + span * (.05 + .9 * unit);
      const r = inner + (radius - inner) * (.2 + .65 * ((unit * 7.13) % 1)); const brightness = reduced ? .4 : Math.pow((Math.sin(phase * 1.4 + n * 2.4) + 1) / 2, 4);
      const size = Math.max(1.2, Math.min(4, radius * .012)) * (.5 + brightness);
      ctx.globalAlpha = fx.intensity * brightness; ctx.fillStyle = '#FFF8E3'; ctx.save(); ctx.translate(Math.cos(angle) * r, Math.sin(angle) * r);
      ctx.beginPath(); ctx.moveTo(0, -size * 1.6); ctx.quadraticCurveTo(size * .18, -size * .18, size, 0); ctx.quadraticCurveTo(size * .18, size * .18, 0, size * 1.6); ctx.quadraticCurveTo(-size * .18, size * .18, -size, 0); ctx.quadraticCurveTo(-size * .18, -size * .18, 0, -size * 1.6); ctx.fill();
      if (fx.kinds.includes('dazzle')) { ctx.globalAlpha *= .35; ctx.beginPath(); ctx.arc(size * 2, -size, size * .4, 0, Math.PI * 2); ctx.fill(); } ctx.restore();
    }
    ctx.restore();
  }
}
