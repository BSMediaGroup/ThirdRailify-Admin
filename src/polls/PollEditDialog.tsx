import { PollStreamField } from './PollStreamField';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Lightbox } from '../brackets/Lightbox';
import type { AdminPoll } from './admin-client';
import { pollAdminRequest } from './admin-request';
import '../brackets/brackets.css';
import './poll-edit.css';

export type EditablePoll = AdminPoll & { presentationType?: string; bracketLink?: unknown; credits?: { unresolved: number } };

export function PollEditDialog({ poll, onClose, onSaved }: { poll: EditablePoll; onClose: () => void; onSaved: () => void }) {
  const { csrfToken, hasCapability } = useAuth();
  const [draft, setDraft] = useState(poll);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canManage = hasCapability('polls.manage');
  const locked = poll.state === 'open' || poll.totalVotes > 0 || Boolean(poll.credits?.unresolved) || Boolean(poll.bracketLink);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!csrfToken || !canManage || busy) return;
    setBusy(true); setError('');
    try {
      await pollAdminRequest(`/api/admin/polls/${encodeURIComponent(poll.slug)}/save`, csrfToken, {
        revision: poll.revision, title: draft.title, description: draft.description,
        webVotingMode: draft.webVotingMode, streamUrl: draft.streamUrl || null,
        ...(locked ? {} : { options: draft.options }),
      });
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save Poll.'); }
    finally { setBusy(false); }
  }
  return <Lightbox title="Edit Poll" onClose={onClose} pending={busy}>
    <form className="poll-edit-form" onSubmit={event => void save(event)}>
      {error ? <p role="alert">{error}</p> : null}
      <fieldset disabled={busy || !canManage}>
        <label>Poll title<input required maxLength={140} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
        <label>Description<textarea value={draft.description || ''} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
        <PollStreamField value={draft.streamUrl || ''} onChange={streamUrl => setDraft({ ...draft, streamUrl })} slug={poll.slug} disabled={busy || !canManage} /><label>Who can vote<select value={draft.webVotingMode} onChange={e => setDraft({ ...draft, webVotingMode: e.target.value as AdminPoll['webVotingMode'] })}><option value="anyone">Anyone</option><option value="signed_in">Signed-in accounts</option></select></label>
        {locked ? <p>Options and triggers are protected while voting is open or voting history exists. Poll title, description and voting policy can still be edited.</p> : null}
        {draft.options.map((option, index) => <div className="poll-edit-option" key={option.id}>
          <label>Option {index + 1}<input required maxLength={160} disabled={locked} value={option.label} onChange={e => setDraft({ ...draft, options: draft.options.map((item, i) => i === index ? { ...item, label: e.target.value } : item) })} /></label>
          <label>Trigger for {option.label}<input required maxLength={64} disabled={locked} value={option.trigger} onChange={e => setDraft({ ...draft, options: draft.options.map((item, i) => i === index ? { ...item, trigger: e.target.value } : item) })} /></label>
        </div>)}
      </fieldset>
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !canManage}>{busy ? 'Saving...' : 'Save Poll'}</button></footer>
    </form>
  </Lightbox>;
}
