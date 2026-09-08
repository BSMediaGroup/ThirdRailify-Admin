import { AbootPollFields } from '../polls/AbootPollFields';
import { useAdminToast } from '../components/AdminToasts';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { getAdminPolls, mutatePollLifecycle, mutatePollVisibility, type AdminPoll } from '../polls/admin-client';
import { pollAdminRequest } from '../polls/admin-request';
import '../styles/polls-admin.css';
import '../styles/poll-workspaces.css';

type ImageAsset = { id: string; url: string };
type Matchup = Omit<AdminPoll, 'options'> & { bracketLink?: { bracketId: string; matchId: string; title: string; round: number; position: number }; presentationType?: string; presentation?: { colors?: string[]; context?: string | null; featuredOrder?: number }; credits?: { unresolved: number }; media?: { banner?: ImageAsset }; options: Array<AdminPoll['options'][number] & { description?: string; image?: ImageAsset }> };
const empty = { livestreamMode: 'automatic', livestreamId: '', title: '', description: '', rumbleEnabled: false, rumbleSourceScope: '', presentationType: 'abootnothing', presentation: { colors: ['#f3c928', '#a9b7da'], context: '', featuredOrder: 0 }, options: [{ label: 'Side one', trigger: '1', description: '' }, { label: 'Side two', trigger: '2', description: '' }] };
export function AbootNothingPage() {
  const editorRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const editSlug = searchParams.get('edit') || '';
  const returnBracket = searchParams.get('bracket') || '';


  const { showToast } = useAdminToast();
  const { csrfToken, hasCapability } = useAuth(); const canManage = hasCapability('polls.manage');
  const [discovery, setDiscovery] = useState<{ source: { scope: string; displayName: string } | null; livestreams: Array<{ id: string; title: string; isLive: boolean }> } | null>(null);
  useEffect(() => { void pollAdminRequest<NonNullable<typeof discovery>>("/api/admin/polls/discovery").then(setDiscovery).catch(() => setDiscovery(null)); }, []);
  const [items, setItems] = useState<Matchup[]>([]), [selected, setSelected] = useState<Matchup | null>(null), [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    editorRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [editing]);
  const closeEditor = () => {
    setEditing(false);
    setError('');
    if (editSlug) setSearchParams(current => { const next = new URLSearchParams(current); next.delete('edit'); return next; }, { replace: true });
  };
  const [pendingArtwork, setPendingArtwork] = useState<Record<string, File>>({}), [artworkPreviews, setArtworkPreviews] = useState<Record<string, string>>({});
  useEffect(() => { const previews = Object.fromEntries(Object.entries(pendingArtwork).map(([key, file]) => [key, URL.createObjectURL(file)])); setArtworkPreviews(previews); return () => Object.values(previews).forEach(URL.revokeObjectURL); }, [pendingArtwork]);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState(empty), [state, setState] = useState('all'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setLoading(true); setLoadError(''); try { const p = await getAdminPolls(state, 'abootnothing'); setItems((p.items as Matchup[]).filter(p => p.presentationType === 'abootnothing')); } catch (e) { setLoadError(e instanceof Error ? e.message : 'Unable to load matchups.'); } finally { setLoading(false); } }, [state]);
  useEffect(() => { void load(); }, [load]);
  const edit = (poll: Matchup | null) => { setPendingArtwork({}); setSelected(poll); setEditing(true); setDraft(poll ? { ...empty, ...poll, description: poll.description || '', rumbleSourceScope: poll.rumbleSourceScope || '', presentationType: 'abootnothing', presentation: { colors: poll.presentation?.colors || empty.presentation.colors, context: poll.presentation?.context || '', featuredOrder: poll.presentation?.featuredOrder || 0 }, options: poll.options.map(o => ({ ...o, description: o.description || '' })) } : structuredClone(empty)); };
  useEffect(() => { if (!editSlug) return; void pollAdminRequest<{ poll: Matchup }>("/api/admin/polls/" + encodeURIComponent(editSlug)).then(p => { setSelected(p.poll); setEditing(true); setDraft({ ...empty, ...p.poll, description: p.poll.description || '', rumbleSourceScope: p.poll.rumbleSourceScope || '', presentationType: 'abootnothing', presentation: { colors: p.poll.presentation?.colors || empty.presentation.colors, context: p.poll.presentation?.context || '', featuredOrder: p.poll.presentation?.featuredOrder || 0 }, options: p.poll.options.map(o => ({ ...o, description: o.description || '' })) }); }).catch(e => setError(e.message)); }, [editSlug]);
  const action = async (fn: () => Promise<unknown>, title = 'Matchup updated') => { setBusy(true); setError(''); try { await fn(); showToast('Changes saved.', { title }); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save matchup.'); } finally { setBusy(false); } };
  const uploadArtwork = async (target: Matchup, file: File, key: string): Promise<Matchup> => {
    const form = new FormData(); form.set('image', file);
    const url = `/api/admin/polls/${target.slug}/media/${key === 'banner' ? 'banner' : `option/${target.options[Number(key)].id}`}`;
    const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken || '' }, body: form });
    const result = await response.json(); if (!response.ok) throw new Error(result.message || 'Artwork upload failed. Your selection is retained; save to retry.');
    const value = await pollAdminRequest<{ poll: Matchup }>(`/api/admin/polls/${target.slug}`);
    setSelected(value.poll);
    setPendingArtwork(current => { const next = { ...current }; delete next[key]; return next; });
    return value.poll;
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void action(async () => {
      const value = await pollAdminRequest<{ poll: Matchup }>(`/api/admin/polls/${selected ? `${selected.slug}/save` : 'create'}`, csrfToken || '', { ...draft, options: selected?.state === 'open' ? undefined : draft.options, revision: selected?.revision });
      let saved = (await pollAdminRequest<{ poll: Matchup }>(`/api/admin/polls/${value.poll.slug}`)).poll;
      // Retain the new identity immediately: failed uploads retry this draft.
      setSelected(saved);
      setDraft(current => ({ ...current, options: current.options.map((option, i) => ({ ...option, id: saved.options[i].id })) }));
      for (const [key, file] of Object.entries(pendingArtwork)) saved = await uploadArtwork(saved, file, key);
      edit(saved);
    }, 'Matchup saved');
  };
  const chooseArtwork = (file: File, key: string) => {
    setPendingArtwork(current => ({ ...current, [key]: file }));
    if (selected) void action(async () => {
      const saved = await uploadArtwork(selected, file, key);
      // Uploading artwork must not overwrite unsaved text or settings.
      setDraft(current => ({ ...current, options: current.options.map((option, i) => ({ ...option, image: saved.options[i].image })) }));
    }, 'Artwork saved');
  };
  const locked = Boolean(selected?.bracketLink) || selected?.state === 'open' || Boolean(selected?.totalVotes || selected?.credits?.unresolved);
  return <div className="poll-admin aboot-admin"><header className="poll-heading"><div><p className="eyebrow">THE THIRD RAIL · CONTENT & OPERATIONS</p><h1>Aboot Nothing</h1><Link to="/polls/abootnothing/brackets">Matchup Studio</Link>{returnBracket ? <Link to={`/polls/abootnothing/brackets/${encodeURIComponent(returnBracket)}`}>Return to bracket</Link> : null}<p>Two opposing subjects. One Poll, shared votes and a permanent matchup history.</p></div><div><button className="primary-button" disabled={!canManage || busy} onClick={() => edit(null)}>Create matchup</button><Link to="/automations#poll-voting">Voting policy & reconciliation</Link></div></header>{error && !editing ? <div className="poll-workspace-alert" role="alert"><strong>Unable to save matchup</strong><p>{error}</p></div> : null}
    <section className="poll-panel aboot-library" aria-busy={loading}><header><div><h2>Matchup library</h2><p>Create, manage and revisit your matchups.</p></div><label>Matchups<select value={state} onChange={e => setState(e.target.value)}><option value="all">All matchups</option><option value="open">Current</option><option value="closed">Past</option><option value="draft">Drafts</option><option value="archived">Archived</option></select></label></header><div className="poll-workspace-body">{loadError ? <div className="poll-workspace-alert" role="alert"><strong>Unable to load matchups</strong><p>{loadError}</p><button type="button" onClick={() => void load()}>Try again</button></div> : null}<div className="aboot-admin-grid">{items.map(p => <article key={p.id}><div className="aboot-admin-versus">{p.options.map((o, i) => <div key={o.id} style={{ borderColor: p.presentation?.colors?.[i] }} >{o.image ? <img src={`/api/admin/polls/media/${o.image.id}`} alt="" /> : null}<strong>{o.label}</strong></div>)}<b>VS</b></div><h2>{p.title}</h2><p>{p.state === "draft" && !p.openedAt ? "Upcoming" : p.state} · {p.public ? 'Listed' : 'Hidden'} · {p.totalVotes} votes · {p.credits?.unresolved ?? 'Unknown'} awaiting allocation</p><div className="poll-actions">{p.openedAt ? <button disabled={!canManage || busy} onClick={() => { if (window.confirm('Reset to Upcoming? Current results will be retained in history, votes will start at zero, and unallocated credits will be discarded.')) void action(() => mutatePollLifecycle(csrfToken || '', p, 'reset'), 'Matchup reset to Upcoming'); }}>Reset to Upcoming</button> : null}<button disabled={!canManage || busy} onClick={() => edit(p)}>Edit Poll</button>{p.state === 'open' ? <button disabled={!canManage || busy} onClick={() => void action(() => mutatePollLifecycle(csrfToken || '', p, 'close'))}>Close</button> : p.state !== 'archived' ? <button disabled={!canManage || busy} onClick={() => void action(() => mutatePollLifecycle(csrfToken || '', p, 'open'))}>Open</button> : null}{p.state === 'closed' ? <button disabled={!canManage || busy} onClick={() => void action(() => mutatePollVisibility(csrfToken || '', p, !p.public))}>{p.public ? 'Hide' : 'List'}</button> : null}{['draft', 'closed'].includes(p.state) ? <button disabled={!canManage || busy} onClick={() => void action(() => mutatePollLifecycle(csrfToken || '', p, 'archive'))}>Archive</button> : null}{p.state === 'archived' ? <button disabled={!canManage || busy} onClick={() => void action(() => mutatePollLifecycle(csrfToken || '', p, 'restore'))}>Restore draft</button> : null}<a href={`https://thirdrailify.com/polls/${p.slug}`} target="_blank" rel="noopener noreferrer">Public detail</a></div></article>)}</div>{!items.length && !loadError ? <div className="poll-workspace-empty"><span className="aboot-empty-mark" aria-hidden="true">VS</span><strong>{loading ? 'Loading matchups...' : 'No matchups in this view'}</strong><p>{loading ? 'Fetching your matchup library.' : 'Start with two opposing subjects, then add artwork and open the vote when you are ready.'}</p>{!loading ? <button type="button" className="primary-button" disabled={!canManage || busy} onClick={() => edit(null)}>Create your first matchup</button> : null}</div> : null}</div></section>
    {editing ? <dialog ref={dialogRef} className="aboot-editor-dialog" aria-modal="true" aria-labelledby="aboot-editor-title" data-admin-toast-host onCancel={event => { event.preventDefault(); if (!busy) closeEditor(); }}><form ref={editorRef} className="poll-panel aboot-matchup-editor" onSubmit={save}><header><h2 id="aboot-editor-title">{selected ? 'Edit matchup' : 'New matchup'}</h2>{selected?.bracketLink ? <Link to={`/polls/abootnothing/brackets/${selected.bracketLink.bracketId}`}>Bracket: {selected.bracketLink.title} ? Round {selected.bracketLink.round + 1}, match {selected.bracketLink.position + 1}</Link> : null}<button type="button" disabled={busy} onClick={closeEditor}>Close editor</button></header><div className="poll-workspace-body">{error ? <div className="poll-workspace-alert" role="alert"><strong>Unable to save matchup</strong><p>{error}</p></div> : null}<div className="poll-policy-fields"><AbootPollFields title={draft.title} options={draft.options} locked={locked} onTitle={title => setDraft({ ...draft, title })} onTrigger={(index, trigger) => setDraft({ ...draft, options: draft.options.map((o,i) => i === index ? { ...o, trigger } : o) })} /><label>Context / episode<input maxLength={160} value={draft.presentation.context} onChange={e => setDraft({ ...draft, presentation: { ...draft.presentation, context: e.target.value } })} /></label><label>Description<textarea maxLength={2000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
    {selected?.state === 'open' ? <p>Subject names, descriptions and triggers stay fixed while voting is open. Colours and artwork can still be updated.</p> : null}<div className="aboot-admin-grid">{draft.options.map((option, i) => <fieldset key={i}><legend>Opposing item {i + 1}</legend><label>Name<input required disabled={locked} maxLength={160} value={option.label} onChange={e => setDraft({ ...draft, options: draft.options.map((o, n) => n === i ? { ...o, label: e.target.value } : o) })} /></label><label>Description<input disabled={selected?.state === 'open'} maxLength={240} value={option.description} onChange={e => setDraft({ ...draft, options: draft.options.map((o, n) => n === i ? { ...o, description: e.target.value } : o) })} /></label><label>Feature colour<input type="color" value={draft.presentation.colors[i]} onChange={e => setDraft({ ...draft, presentation: { ...draft.presentation, colors: draft.presentation.colors.map((c, n) => n === i ? e.target.value : c) } })} /></label>{artworkPreviews[String(i)] || selected?.options[i]?.image ? <img className="aboot-admin-preview" src={artworkPreviews[String(i)] || `/api/admin/polls/media/${selected!.options[i].image!.id}`} alt={`${option.label} artwork`} /> : null}<label>Square artwork<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!canManage || busy} onChange={e => { const file = e.target.files?.[0]; if (file) chooseArtwork(file, String(i)); e.target.value = ''; }} /></label></fieldset>)}</div>
    <label>Cover image<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!canManage || busy} onChange={e => { const file = e.target.files?.[0]; if (file) chooseArtwork(file, 'banner'); e.target.value = ''; }} /></label>{artworkPreviews.banner || selected?.media?.banner ? <img className="aboot-admin-preview" src={artworkPreviews.banner || `/api/admin/polls/media/${selected!.media!.banner!.id}`} alt="Matchup cover" /> : null}<small>{Object.keys(pendingArtwork).length ? `${Object.keys(pendingArtwork).length} image(s) selected. Save matchup to upload any pending artwork.` : 'Choose artwork at any time. New matchup images upload when you save.'}</small><label>Featured order (0 = automatic)<input type="number" min={0} max={999} value={draft.presentation.featuredOrder} onChange={e => setDraft({ ...draft, presentation: { ...draft.presentation, featuredOrder: Number(e.target.value) } })} /></label><label><input type="checkbox" disabled={selected?.state === 'open'} checked={draft.rumbleEnabled} onChange={e => setDraft({ ...draft, rumbleEnabled: e.target.checked })} />Rumble ordinary chat</label><label>Detected source<select disabled={selected?.state === 'open'} value={draft.rumbleSourceScope === discovery?.source?.scope ? draft.rumbleSourceScope : ''} onChange={e => setDraft({ ...draft, rumbleSourceScope: e.target.value })}><option value="">Custom source / discovery unavailable</option>{discovery?.source ? <option value={discovery.source.scope}>{discovery.source.displayName} ({discovery.source.scope})</option> : null}</select></label><label>Stream selection<select disabled={selected?.state === 'open'} value={draft.livestreamMode === 'automatic' ? '' : draft.livestreamId} onChange={e => setDraft({ ...draft, livestreamMode: e.target.value ? 'exact' : 'automatic', livestreamId: e.target.value })}><option value="">Automatic (one detected live stream)</option>{discovery?.livestreams.filter(s => s.isLive).map(s => <option key={s.id} value={s.id}>{s.title} ({s.id})</option>)}{draft.livestreamId && !discovery?.livestreams.some(s => s.id === draft.livestreamId) ? <option value={draft.livestreamId}>{draft.livestreamId}</option> : null}</select></label><label>Rumble source<input disabled={selected?.state === 'open'} value={draft.rumbleSourceScope} placeholder="user:… or channel:…" onChange={e => setDraft({ ...draft, rumbleSourceScope: e.target.value })} /></label></div></div><footer className="aboot-editor-actions"><span>{busy ? "Saving changes..." : "Changes are saved when you select Save matchup."}</span><button type="button" disabled={busy} onClick={closeEditor}>Done</button><button className="primary-button" disabled={busy || !canManage}>Save matchup</button></footer></form></dialog> : null}
  </div>;
}
