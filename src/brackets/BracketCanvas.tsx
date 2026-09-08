import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { opponents, descendants, type Match } from './model.mjs';
import type { Bracket } from './types';
import './brackets.css';
import { statusLabel } from './status';

type Edge = { id: string; from: string; to: string; slot: number; d: string };
export function BracketCanvas({ bracket, onSelect, onEdit, onFocusContender, selected, mediaBase = '/api/brackets/media/' }: {
  bracket: Bracket; onSelect?: (m: Match) => void; onEdit?: (m: Match) => void;
  onFocusContender?: (id: string) => void; selected?: string; mediaBase?: string;
}) {
  const { graph, decisions, sources, needsReview = [] } = bracket;
  const [zoom, setZoom] = useState(1), [round, setRound] = useState(0), [query, setQuery] = useState('');
  const [focused, setFocused] = useState(''), [pendingFocus, setPendingFocus] = useState(''), [message, setMessage] = useState('');
  const [fullscreen, setFullscreen] = useState(false), [edges, setEdges] = useState<Edge[]>([]);
  const viewport = useRef<HTMLDivElement>(null), shell = useRef<HTMLElement>(null), tree = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const statusId = useId();
  const rounds = Array.from({ length: Math.log2(graph.size) }, (_, i) => i);
  const activeMatch = focused || selected, path = activeMatch ? [activeMatch, ...descendants(graph, activeMatch)] : [];
  const measure = useCallback(() => {
    const element = tree.current; if (!element) return;
    const bounds = element.getBoundingClientRect(), scale = bounds.width / element.offsetWidth || 1;
    const next: Edge[] = [];
    for (const match of graph.matches) {
      const target = element.querySelector<HTMLElement>(`[data-match="${match.id}"]`);
      if (!target?.getClientRects().length) continue;
      match.slots.forEach((slot, index) => {
        if (slot.kind !== 'winner') return;
        const source = element.querySelector<HTMLElement>(`[data-match="${slot.ref}"]`);
        const opponent = target.querySelectorAll<HTMLElement>('.bracket-opponent')[index];
        if (!source?.getClientRects().length || !opponent) return;
        const a = source.getBoundingClientRect(), b = opponent.getBoundingClientRect();
        const x1 = (a.right - bounds.left) / scale, y1 = (a.top + a.height / 2 - bounds.top) / scale;
        const x2 = (b.left - bounds.left) / scale, y2 = (b.top + b.height / 2 - bounds.top) / scale, middle = (x1 + x2) / 2;
        next.push({ id: slot.id, from: slot.ref!, to: match.id, slot: index, d: `M ${x1} ${y1} H ${middle} V ${y2} H ${x2}` });
      });
    }
    setEdges(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, [graph.matches]);
  useLayoutEffect(() => {
    const element = tree.current; if (!element) return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    element.querySelectorAll('.bracket-match').forEach(card => observer.observe(card));
    const frame = requestAnimationFrame(measure);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [measure, zoom, round, decisions]);
  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    const frame = requestAnimationFrame(() => {
      const card = tree.current?.querySelector<HTMLElement>(`[data-match="${pendingFocus}"]`), container = viewport.current;
      if (card && container) {
        const a = card.getBoundingClientRect(), b = container.getBoundingClientRect();
        container.scrollTo({ left: container.scrollLeft + a.left - b.left - (container.clientWidth - a.width) / 2, top: container.scrollTop + a.top - b.top - (container.clientHeight - a.height) / 2, behavior: 'instant' });
        if (!document.fullscreenElement && !shell.current?.closest('dialog')) window.scrollBy({ top: a.top - Math.max(100, (window.innerHeight - a.height) / 2), behavior: 'instant' });
        card.focus({ preventScroll: true });
      }
      setPendingFocus('');
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingFocus, round]);
  const focus = () => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) { setMessage('Enter a contender name to find their match.'); return; }
    const candidates = graph.contenders.filter(c => c.name.toLocaleLowerCase().includes(term));
    const contender = candidates.find(c => c.name.toLocaleLowerCase() === term) || candidates[0];
    if (!contender) { setMessage(`No contender matches "${query.trim()}".`); return; }
    const matches = graph.matches.filter(m => opponents(graph, m, decisions).some(c => c?.id === contender.id));
    const match = matches.find(m => !decisions.some(d => d.matchId === m.id)) || matches.at(-1);
    if (!match) { onFocusContender?.(contender.id); setMessage(`${contender.name} is on the Ideas bench and has not been placed in a match.`); return; }
    setRound(match.round); setFocused(match.id); setPendingFocus(match.id); onSelect?.(match);
    setMessage(`${contender.name}: round ${match.round + 1}, match ${match.position + 1}.${candidates.length > 1 ? ' Refine the name for another contender.' : ''}`);
  };
  const fit = () => {
    if (!viewport.current || !tree.current) return;
    setZoom(Math.max(.1, Math.min(1, (viewport.current.clientWidth - 32) / tree.current.offsetWidth, document.fullscreenElement === shell.current ? (viewport.current.clientHeight - 32) / tree.current.offsetHeight : 1)));
    viewport.current.scrollTo(0, 0);
  };
  return <section ref={shell} className="bracket-canvas-shell" style={{ '--bracket-accent': graph.presentation.accent } as CSSProperties} aria-label="Season bracket">
    <div className="bracket-toolbar"><div>
      <button onClick={() => setZoom(z => Math.max(.1, z - .1))} aria-label="Zoom out">&#8722;</button><output>{Math.round(zoom * 100)}%</output>
      <button onClick={() => setZoom(z => Math.min(1.5, z + .1))} aria-label="Zoom in">+</button><button onClick={fit}>Fit view</button>
      <button onClick={() => { setZoom(1); setFocused(''); setMessage(''); viewport.current?.scrollTo(0, 0); }}>Reset view</button>
      <button onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : shell.current?.requestFullscreen())?.catch(() => setMessage('Fullscreen is unavailable in this browser.')); }}>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>
      <button onClick={() => window.print()}>Print</button></div>
      <div><input aria-label="Find contender" aria-describedby={statusId} placeholder="Find a contender" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); focus(); } }} /><button onClick={focus}>Focus</button></div>
    </div>
    <p id={statusId} className="bracket-focus-status" role="status" hidden={!message}>{message}</p>
    <div className="bracket-round-tabs" role="tablist" aria-label="Choose round">{rounds.map(r => <button key={r} role="tab" aria-selected={round === r} onClick={() => setRound(r)}>{r === rounds.length - 1 ? 'Final' : `Round ${r + 1}`}</button>)}</div>
    <div ref={viewport} className="bracket-viewport" tabIndex={0} aria-label="Bracket canvas. Scroll or drag empty space to pan."
      onPointerDown={e => { if (e.pointerType === 'touch' || (e.target as HTMLElement).closest('button,input,a')) return; pan.current = { x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (pan.current) { e.currentTarget.scrollLeft = pan.current.left + pan.current.x - e.clientX; e.currentTarget.scrollTop = pan.current.top + pan.current.y - e.clientY; } }} onPointerUp={() => { pan.current = null; }} onPointerCancel={() => { pan.current = null; }}>
      <div ref={tree} className="bracket-tree" style={{ zoom } as CSSProperties}>
        <svg className="bracket-connectors" aria-hidden="true">{edges.map(edge => <path key={edge.id} data-from={edge.from} data-to={edge.to} data-slot={edge.slot} d={edge.d} className={path.includes(edge.from) && path.includes(edge.to) ? 'is-path' : ''} />)}</svg>
        {rounds.map(r => <div key={r} className={`bracket-round ${round === r ? 'is-mobile-round' : ''}`}><h3>{r === rounds.length - 1 ? 'The final' : `Round ${r + 1}`}</h3><div className="bracket-round-matches">{graph.matches.filter(m => m.round === r).sort((a,b) => a.position - b.position).map(m => {
          const pair = opponents(graph, m, decisions), d = decisions.find(x => x.matchId === m.id), source = sources[m.id], review = needsReview.includes(m.id);
          return <div className="bracket-match-space" key={m.id}><div className="bracket-match-card">
            <button data-match={m.id} className={`bracket-match ${path.includes(m.id) ? 'is-path' : ''} ${review ? 'needs-review' : ''}`} onClick={() => { setFocused(''); onSelect?.(m); }} onDoubleClick={() => onEdit?.(m)}>
              <span className={`bracket-match-kicker${onEdit ? ' has-editor' : ''}`}>Match {m.position + 1}<span>{review ? 'Needs review' : d ? d.source === 'poll' ? 'Confirmed result' : d.source === 'bye' ? 'Bye' : 'Manual result' : statusLabel(source?.state)}</span></span>
              {pair.map((c, i) => { const winner = d?.winnerId === c?.id && !!c && !review; return <span key={m.slots[i].id} className={`bracket-opponent ${winner ? 'is-winner' : d && c && !review ? 'is-eliminated' : ''}`}><span className="bracket-seed">{c?.seed ?? '\u00b7'}</span>{winner ? <span className="bracket-winner-feature" title="Winner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 3h10v6a5 5 0 0 1-10 0V3ZM7 5H3v2a4 4 0 0 0 5 4M17 5h4v2a4 4 0 0 1-5 4M12 14v4M8 21v-3h8v3M6 21h12" /></svg></span> : null}{c?.image ? <img src={mediaBase + c.image} alt="" /> : <span className="bracket-monogram" aria-hidden="true">{c?.name.slice(0,1) || '?'}</span>}<span className="bracket-name">{c?.name || (m.slots[i].kind === 'bye' ? 'Bye' : m.slots[i].kind === 'winner' ? `Winner of match ${(graph.matches.find(x => x.id === m.slots[i].ref)?.position || 0) + 1}` : 'Unassigned')} {winner ? <small>WINNER</small> : null}</span><strong>{source?.scores && c ? source.scores[c.id] ?? '\u2014' : d?.scores[i] ?? '\u2014'}</strong>{winner ? <span className="bracket-winner-sparkles" aria-hidden="true">{Array.from({ length: 6 }, (_, star) => <i key={star} style={{ '--spark-index': star } as CSSProperties} />)}</span> : null}</span>; })}
            </button>
            {onEdit ? <button className="bracket-match-edit" aria-label={`Edit round ${r + 1} match ${m.position + 1}`} title="Edit matchup" onClick={() => onEdit(m)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m4 16 11-11 4 4L8 20H4zM13 7l4 4" /></svg></button> : null}
          </div></div>;
        })}</div></div>)}
      </div>
    </div>
  </section>;
}
