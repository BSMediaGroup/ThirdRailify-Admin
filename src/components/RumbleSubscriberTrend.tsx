import { useEffect, useId, useRef, useState } from 'react';
import { AdminIcon } from './AdminIcon';
import '../styles/rumble-subscriber-trend.css';

type Series = 'total' | 'paid' | 'gifted' | 'mixed' | 'unknown';
type Point = Record<Series, number> & { at: string; provenance: string };
type Trend = { from: string; to: string; bucketSeconds: number; points: Point[] };
const series: { key: Series; label: string; color: string; dash?: string }[] = [
  { key: 'total', label: 'Total subscribers', color: '#7cde48' },
  { key: 'paid', label: 'Self-paid only', color: '#36d7b2' },
  { key: 'gifted', label: 'Gifted only', color: '#d6f6ac', dash: '8 4' },
  { key: 'mixed', label: 'Self-paid + gifted', color: '#74baf8', dash: '3 4' },
  { key: 'unknown', label: 'Unknown / needs review', color: '#dda8ed', dash: '2 6' },
];
const ranges = ['24h', '7d', '30d', '90d'] as const;
const stamp = (at: string) => new Date(at).toLocaleString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC';

export function RumbleSubscriberTrend({ source, snapshotId, total, paidTotal, asOf, refreshVersion }: { refreshVersion: number; source: string; snapshotId?: string; total?: number; paidTotal?: number; asOf?: string }) {
  const [range, setRange] = useState<typeof ranges[number]>('7d');
  const [data, setData] = useState<Trend | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState<Set<Series>>(() => new Set(series.map(s => s.key)));
  const [active, setActive] = useState<number | null>(null);
  const id = useId().replaceAll(':', '');
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(1000);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setPlotWidth(Math.max(320, Math.min(1000, entries[0].contentRect.width))));
    if (plotRef.current) observer.observe(plotRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setActive(null); setError('');
    if (!snapshotId) { setLoading(false); return; }
    setLoading(true);
    void fetch(`/api/admin/rumble-intelligence/trend?${new URLSearchParams({ source, snapshotId, range })}`, { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal })
      .then(async response => { if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Subscriber trend did not return JSON.'); const body = await response.json(); if (!response.ok) throw new Error(body.message || 'Subscriber trend unavailable.'); return body as Trend; })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Subscriber trend unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source, snapshotId, range, refreshVersion]);
  const points = data?.points || [];
  const enabled = series.filter(s => visible.has(s.key));
  const maximum = Math.max(4, ...points.flatMap(p => enabled.map(s => p[s.key])));
  const ceiling = Math.ceil(maximum / 4) * 4;
  const from = data ? Date.parse(data.from) : Date.now() - 7 * 86400000;
  const to = data ? Date.parse(data.to) : Date.now();
  const left = plotWidth < 600 ? 36 : 64, right = plotWidth - (plotWidth < 600 ? 16 : 32);
  const x = (p: Point) => left + ((Date.parse(p.at) - from) / Math.max(1, to - from)) * (right - left);
  const y = (value: number) => 218 - value / ceiling * 180;
  const segments: Point[][] = [];
  for (const p of points) { const previous = segments.at(-1)?.at(-1); if (!previous || Date.parse(p.at) - Date.parse(previous.at) > (data?.bucketSeconds || 3600) * 2500) segments.push([]); segments.at(-1)!.push(p); }
  const path = (segment: Point[], key: Series) => segment.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' ');
  const selected = active === null || !enabled.length ? null : points[active];
  const toggle = (key: Series) => setVisible(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  return <section className="ri-trend" aria-label="Rumble subscriber trend" aria-busy={loading}>
    <header className="ri-trend__header">
      <div className="ri-trend__identity"><span className="ri-trend__mark"><AdminIcon name="rumble" size={27} /></span><div><p>RUMBLE AUDIENCE</p><h2>Subscriber growth</h2></div></div>
      <div className="ri-trend__ranges" role="group" aria-label="Subscriber trend timescale">{ranges.map(value => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{value === '24h' ? '24hr' : value}</button>)}</div>
    </header>
    <div className="ri-trend__headline"><div><span>Total current subscribers</span><strong data-testid="subscriber-total">{total === undefined ? '—' : total.toLocaleString()}</strong></div><div className="ri-trend__paid"><span>Total paid subscribers</span><strong data-testid="subscriber-paid-total">{paidTotal === undefined ? '—' : paidTotal.toLocaleString()}</strong><small>Self-paid only + mixed</small></div><p>Distinct API-listed accounts<br /><span>{asOf ? `As of ${stamp(asOf)}` : 'Awaiting a qualified observation'}</span></p></div>
    <p className="ri-trend__legend-label">Show on graph</p>
    <div className="ri-trend__legend" role="group" aria-label="Subscriber chart series">{series.map(s => <button key={s.key} aria-pressed={visible.has(s.key)} onClick={() => toggle(s.key)}><span className="ri-trend__series-check" aria-hidden="true">{visible.has(s.key) ? '✓' : ''}</span><i style={{ background: s.color }} />{s.label}</button>)}</div>
    <div className="ri-trend__plot" ref={plotRef} onMouseLeave={() => setActive(null)}>
      <svg viewBox={`0 0 ${plotWidth} 265`} role="img" aria-label={`Subscriber counts across ${range}; ${points.length} recorded observations`}>
        <title>Rumble subscriber counts</title><desc>Recorded account totals with mutually exclusive paid, gifted, mixed and unknown classifications. Empty periods are not filled. Hover or focus an observation for exact values.</desc>
        <defs><linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6dce38" stopOpacity=".26" /><stop offset="1" stopColor="#6dce38" stopOpacity="0" /></linearGradient><linearGradient id={`${id}-stroke`}><stop stopColor="#48ad2d" /><stop offset=".55" stopColor="#a0f16b" /><stop offset="1" stopColor="#73d03c" /></linearGradient></defs>
        <g className="ri-trend__grid" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <g key={i}><line x1={left} x2={right} y1={y(ceiling * i / 4)} y2={y(ceiling * i / 4)} /><text x={left - 14} y={y(ceiling * i / 4) + 4} textAnchor="end">{ceiling * i / 4}</text></g>)}</g>
        {visible.has('total') && segments.filter(s => s.length > 1).map((segment, i) => <path key={i} d={`${path(segment, 'total')} L${x(segment.at(-1)!)},218 L${x(segment[0])},218 Z`} fill={`url(#${id}-fill)`} />)}
        {enabled.map(s => <g key={s.key}>{segments.map((segment, i) => <path key={i} className={s.key === 'total' ? 'ri-trend__total-line' : ''} d={path(segment, s.key)} fill="none" stroke={s.key === 'total' ? `url(#${id}-stroke)` : s.color} strokeWidth={s.key === 'total' ? 3 : 1.8} strokeDasharray={s.dash} strokeLinecap="round" strokeLinejoin="round" />)}{selected && <circle className="ri-trend__node" cx={x(selected)} cy={y(selected[s.key])} r={s.key === 'total' ? 5 : 3.5} fill={s.color} stroke="#152012" strokeWidth="2" />}</g>)}
        {selected && <line x1={x(selected)} x2={x(selected)} y1="30" y2="220" className="ri-trend__crosshair" />}
        {enabled.length > 0 && points.map((p, index) => <g key={p.at} tabIndex={0} role="button" aria-describedby={active === index ? `${id}-tooltip` : undefined} aria-label={`${stamp(p.at)}: ${series.map(s => `${s.label} ${p[s.key]}`).join(', ')}`} onFocus={() => setActive(index)} onBlur={() => setActive(null)} onMouseEnter={() => setActive(index)} onMouseLeave={e => { if (!(e.relatedTarget instanceof Element) || !e.relatedTarget.closest('.ri-trend__tooltip')) setActive(null); }} onClick={() => setActive(index)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(index); } if (e.key === 'Escape') setActive(null); }}><rect x={x(p) - 5} y="28" width="10" height="194" fill="transparent" /><circle cx={x(p)} cy={y(p[enabled[0].key])} r="8" fill="transparent" className="ri-trend__focus" /></g>)}
        <g className="ri-trend__axis" aria-hidden="true">{(plotWidth < 600 ? [0, 2, 4] : [0, 1, 2, 3, 4]).map(i => <text key={i} x={left + i * (right - left) / 4} y="248" textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>{new Date(from + (to - from) * i / 4).toLocaleString(undefined, { timeZone: 'UTC', ...(range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }) })}</text>)}</g>
      </svg>
      {selected && <div id={`${id}-tooltip`} role="tooltip" className="ri-trend__tooltip" onMouseLeave={() => setActive(null)} style={{ left: `clamp(0px, calc(${x(selected) / plotWidth * 100}% ${x(selected) > plotWidth / 2 ? '- 278px' : '+ 14px'}), max(0px, calc(100% - 264px)))` }}>
        <div className="ri-trend__tooltip-heading"><span>SUBSCRIBER SNAPSHOT</span><strong>{new Date(selected.at).toLocaleString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })} UTC</strong></div>
        <dl>{series.map(s => <div key={s.key} className={s.key === 'total' ? 'ri-trend__tooltip-total' : ''}><dt><i style={{ background: s.color }} />{s.label}</dt><dd>{selected[s.key].toLocaleString()}{s.key !== 'total' && <small>{selected.total ? (selected[s.key] / selected.total * 100).toFixed(1) : '0.0'}%</small>}</dd></div>)}</dl>
        <footer><span>{selected.provenance === 'live' ? 'Bot observation' : 'Historical import'}</span><span>{source}</span></footer>
      </div>}
      {points.length > 0 && !enabled.length && <div className="ri-trend__empty" role="status">All series hidden<small>Select a reporting type above to show it on the graph.</small></div>}
      {!points.length && <div className="ri-trend__empty" role="status">{loading ? 'Loading observed subscriber history…' : error || (snapshotId ? `No recorded observations in the last ${range === '24h' ? '24 hours' : range.slice(0, -1) + ' days'}.` : 'Subscriber history will appear after a qualified observation.')}<small>No estimates or missing periods filled with zero.</small></div>}
    </div>
    <div className="ri-trend__readout" aria-live="polite">{selected ? <><strong>{stamp(selected.at)}</strong><span>{selected.provenance} observation</span>{series.map(s => <span key={s.key} style={{ color: s.color }}>{s.label}: <b>{selected[s.key]}</b></span>)}</> : <><span className="ri-trend__signal" /><strong>{points.length} observed points</strong><span>{range === '24h' || range === '7d' ? 'Latest observation per UTC hour' : 'Latest observation per UTC day'}</span><span>Hover or focus a point for its evidence</span></>}</div>
    <p className="ri-trend__note">Paid, gifted, mixed and unknown are separate account categories that sum to the total. Lines break across observation gaps; subscription dates are never used to invent history.</p>
  </section>;
}
