import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useAdminToast } from '../components/AdminToasts';
import { pollAdminRequest } from './admin-request';
import type { AdminPoll } from './admin-client';
export function DeletePollButton({ poll, onDeleted }: { poll: AdminPoll; onDeleted: () => void }) {
  const { csrfToken, hasCapability } = useAuth();
  const { showToast } = useAdminToast();
  const [busy, setBusy] = useState(false);
  if (!hasCapability('polls.manage')) return null;
  const remove = async () => {
    if (!csrfToken || !window.confirm(`Permanently delete “${poll.title}”? Its votes, reset history and artwork will be removed. This cannot be undone.`)) return;
    setBusy(true);
    try {
      const result = await pollAdminRequest<{ mediaCleanupPending?: boolean }>(`/api/admin/polls/${encodeURIComponent(poll.slug)}/delete`, csrfToken, { revision: poll.revision, confirmSlug: poll.slug });
      showToast(result.mediaCleanupPending ? 'Poll deleted. Some stored artwork still needs cleanup.' : 'The Poll and its results were permanently deleted.', { title: 'Poll deleted' });
      onDeleted();
    } catch (error) { showToast(error instanceof Error ? error.message : 'Deletion failed.', { title: 'Poll could not be deleted', tone: 'warning' }); }
    finally { setBusy(false); }
  };
  return <button className="poll-delete" disabled={busy || poll.state === 'open'} title={poll.state === 'open' ? 'Close this Poll before deleting' : undefined} type="button" onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete Poll'}</button>;
}

